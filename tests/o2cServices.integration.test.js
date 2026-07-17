'use strict';
/**
 * tests/o2cServices.integration.test.js — REAL integration test against the local
 * MariaDB (port 3307). Exercises the O2C domain services end-to-end:
 *   customer → credit gate → manual invoice (issue + GL + ZATCA) → collection
 *   (allocate + GL) → over-allocation guard → partial return (credit note + GL) →
 *   idempotency replay → version conflict → reconcile.
 *
 *   node tests/o2cServices.integration.test.js
 *
 * This test posts to the REAL ledger — issuing an invoice, posting a collection
 * and posting a return each write gl_journals/gl_entries that the equity, royalty
 * and AR reports all read. It ran five times with no cleanup at all and left 15
 * journals (40 entries), 16 ar_documents, 10 payments, 5 returns and 5 customers
 * sitting in the company's books. So: fixtures carry deterministic ITEST ids and
 * cleanup() runs both BEFORE fixtures and in a finally.
 */
const db = require('../db/connection');
const CustomerService = require('../services/order-to-cash/CustomerService');
const CreditLimitService = require('../services/order-to-cash/CreditLimitService');
const InvoiceService = require('../services/order-to-cash/InvoiceService');
const PaymentService = require('../services/order-to-cash/CustomerPaymentService');
const ReturnService = require('../services/order-to-cash/SalesReturnService');
const Reconcile = require('../services/order-to-cash/O2CReconciliationService');
const Reporting = require('../services/order-to-cash/O2CReportingService');

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; } else { fail++; console.error('  ✗', m); } }
async function throwsCode(fn, code, m) {
  try { await fn(); fail++; console.error('  ✗ (expected throw ' + code + ')', m); }
  catch (e) { if ((e.rawCode || e.code) === code) pass++; else { fail++; console.error(`  ✗ wrong code (${e.rawCode || e.code} ≠ ${code})`, m, '::', e.message); } }
}

// Deterministic fixture identity. The customer is the ANCHOR: every document
// (invoice, the version-conflict draft, credit note), every payment and — via the
// invoice — every return this test creates carries customer_id, so cleanup finds
// them all by traversal. It cannot address them directly: only CustomerService.create
// honours a caller-supplied id (`data.id || genId()`); InvoiceService/PaymentService/
// ReturnService always mint random 'AR-<epoch>-<rand>' ids of their own.
//
// The previous fixtures were unique-per-run (phone/VAT off Date.now()) precisely so
// the test could re-run WITHOUT cleaning up. Deterministic is the trade: a run that
// fails to clean up now collides loudly on the next run (customers.phone is UNIQUE,
// as is ar_documents.idempotency_key) instead of silently leaking another 3 journals.
const CUST = 'ITEST-O2C-CUST';
const CUST_PHONE = '0555000199';   // customers.phone is UNIQUE — must be cleaned up
const CUST_VAT = '311111111111113'; // 15 digits, or CustomerService._validate rejects it
const IDEM_ISSUE = 'ITEST-O2C-INV-ISSUE'; // ar_documents.idempotency_key is UNIQUE (uq_ar_idem)

// Every table whose row count must be IDENTICAL before and after a run. This is
// the leak detector: cleanup() promises "nothing left behind", and this list is
// how the promise is checked rather than asserted. doc_counters is deliberately
// absent (burnt serials persist by design — see the note at the end of cleanup).
const COUNTED_TABLES = [
  'gl_journals', 'gl_entries', 'ar_documents', 'ar_document_lines',
  'customer_payments', 'ar_payment_allocations', 'sales_returns',
  'sales_return_lines', 'sales_return_line_components', 'customers', 'ar_events',
];
async function tableCounts() {
  const out = {};
  for (const t of COUNTED_TABLES) {
    try { const [r] = await db.query('SELECT COUNT(*) c FROM `' + t + '`'); out[t] = Number(r[0].c); }
    catch (e) { if (e && e.code === 'ER_NO_SUCH_TABLE') out[t] = null; else throw e; }
  }
  return out;
}
function diffCounts(before, after) {
  return COUNTED_TABLES.filter((t) => before[t] !== after[t])
    .map((t) => `${t}: ${before[t]} → ${after[t]}`);
}

async function cleanup() {
  // ONE transaction: a cleanup that dies half-way must leave the graph exactly
  // as it found it, not half-deleted — a partial cleanup is itself residue.
  // Errors are NOT swallowed: the only tolerated failure is a missing table
  // (schema variant); anything else aborts the transaction and fails the run
  // loudly, because "cleanup silently failed" is how ledgers rot.
  await db.withTransaction(async (conn) => {
    const del = async (sql, a) => {
      try { await conn.query(sql, a || []); }
      catch (e) {
        if (e && e.code === 'ER_NO_SUCH_TABLE') return;
        e.message = `cleanup failed on: ${sql.slice(0, 60)}… :: ${e.message}`;
        throw e;
      }
    };
    const sel = async (sql, a) => {
      try { const [r] = await conn.query(sql, a || []); return r; }
      catch (e) { if (e && e.code === 'ER_NO_SUCH_TABLE') return []; throw e; }
    };
    const inList = (n) => Array(n).fill('?').join(',');

  const docIds = (await sel('SELECT id FROM ar_documents WHERE customer_id = ?', [CUST])).map((r) => r.id);
  const payIds = (await sel('SELECT id FROM customer_payments WHERE customer_id = ?', [CUST])).map((r) => r.id);
  const rets = docIds.length
    ? await sel(`SELECT id, credit_note_id FROM sales_returns WHERE original_ar_document_id IN (${inList(docIds.length)})`, docIds)
    : [];
  const retIds = rets.map((r) => r.id);
  // A credit note carries customer_id and so is already in docIds — but pick it up
  // off the return too, so a CN that ever posts without one still gets collected.
  for (const r of rets) if (r.credit_note_id && !docIds.includes(r.credit_note_id)) docIds.push(r.credit_note_id);

  // GL first. lib/order-to-cash/posting.js always sets referenceId to the doc /
  // payment / return id, so matching on reference_id catches every journal the run
  // posted — CustomerInvoice, CustomerInvoiceCOGS, CustomerPayment, CustomerAdvance,
  // SalesReturn, SalesReturnCOGS and any *Reversal — without enumerating
  // reference_type strings that a later feature would silently add to.
  // gl_entries → gl_journals is the one real FK in this graph; children first.
  for (const rid of [...docIds, ...payIds, ...retIds]) {
    for (const j of await sel('SELECT id FROM gl_journals WHERE reference_id = ?', [rid])) {
      await del('DELETE FROM gl_entries WHERE journal_id = ?', [j.id]);
      await del('DELETE FROM gl_journals WHERE id = ?', [j.id]);
    }
    await del('DELETE FROM ar_events WHERE entity_id = ?', [rid]);
  }

  for (const rid of retIds) {
    await del('DELETE FROM sales_return_line_components WHERE return_id = ?', [rid]);
    await del('DELETE FROM sales_return_lines WHERE return_id = ?', [rid]);
    await del('DELETE FROM sales_returns WHERE id = ?', [rid]);
  }

  for (const pid of payIds) await del('DELETE FROM ar_payment_allocations WHERE payment_id = ?', [pid]);
  await del('DELETE FROM ar_payment_allocations WHERE customer_id = ?', [CUST]);
  await del('DELETE FROM customer_payments WHERE customer_id = ?', [CUST]);

  for (const did of docIds) {
    await del('DELETE FROM ar_document_line_components WHERE document_id = ?', [did]);
    await del('DELETE FROM ar_document_lines WHERE document_id = ?', [did]);
    await del('DELETE FROM ar_documents WHERE id = ?', [did]);
  }
  await del('DELETE FROM ar_documents WHERE customer_id = ?', [CUST]);
  await del('DELETE FROM customers WHERE id = ?', [CUST]);
  });
  // doc_counters is deliberately NOT reset: a burnt serial is what a numbering
  // sequence is for, and the counter key is date-derived ('SI-20260701'), so a real
  // invoice issued on that date would share it — resetting could collide a REAL
  // document number. Gaps are correct; the ledger tables above are what must be clean.
}

async function main() {
  const actor = 'itest';

  // 1) create a credit customer (deterministic ITEST identity — cleanup() anchors on it)
  const customer = await db.withTransaction((c) => CustomerService.create(c, {
    id: CUST, name: 'عميل اختبار O2C', phone: CUST_PHONE,
    customerType: 'B2B', vatNumber: CUST_VAT, creditLimit: 1000, paymentTerms: 'Net30', creditDays: 30,
  }, actor));
  ok(customer.id && customer.isActive, 'customer created active');
  ok(customer.derived.arBalance === 0, 'new customer AR balance 0');

  // 2) credit gate — over limit rejected, within limit allowed
  await throwsCode(() => CreditLimitService.assess(db, { customerId: customer.id, creditAmount: 5000, issueDate: '2026-07-01' }),
    'CREDIT_LIMIT_EXCEEDED', 'credit over limit rejected');
  await throwsCode(() => CreditLimitService.assess(db, { customerId: null, creditAmount: 100, issueDate: '2026-07-01' }),
    'CUSTOMER_REQUIRED', 'credit sale requires customer');
  const okAssess = await CreditLimitService.assess(db, { customerId: customer.id, creditAmount: 500, issueDate: '2026-07-01' });
  ok(okAssess.allowed && okAssess.dueDate === '2026-07-31', 'within-limit credit allowed, due date = issue + 30');

  // 3) manual invoice: 1 line @100 x2 @15%, + one 0%-rated line @50 → issue
  const draft = await db.withTransaction((c) => InvoiceService.createDraft(c, {
    documentType: 'invoice', sourceType: 'manual', customerId: customer.id, issueDate: '2026-07-01',
    lines: [
      { description: 'بند خاضع', enteredQty: 2, unitPrice: 100, vatRate: 15 },
      { description: 'بند صفري', enteredQty: 1, unitPrice: 50, vatCategory: 'Z' },
    ],
  }, actor));
  ok(Number(draft.subtotal) === 250 && Number(draft.vat_amount) === 30 && Number(draft.total_amount) === 280, 'invoice totals net250 vat30 total280 (0% stays 0)');
  ok(draft.status === 'draft', 'invoice starts draft');

  const issued = await InvoiceService.issue(draft.id, { actor, idempotencyKey: IDEM_ISSUE });
  ok(issued.toStatus === 'issued', 'invoice issued');
  ok(issued.result.journalIds.length === 1, 'invoice posted one GL journal');
  const invAfter = await db.withTransaction((c) => InvoiceService.getWithLines(c, draft.id));
  ok(invAfter.zatca_uuid && invAfter.zatca_status === 'pending', 'ZATCA stamped (uuid + honest pending, not mock-submitted)');
  ok(Number(invAfter.balance_amount) === 280, 'issued invoice balance = total');

  // GL: AR debit 280, revenue credit 250, VAT credit 30
  const [glLines] = await db.query(
    `SELECT a.code, SUM(e.debit) dr, SUM(e.credit) cr FROM gl_entries e JOIN gl_accounts a ON a.id=e.account_id
      WHERE e.journal_id = ? GROUP BY a.code`, [issued.result.journalIds[0]]);
  const glByCode = {}; glLines.forEach((l) => { glByCode[l.code] = { dr: Number(l.dr), cr: Number(l.cr) }; });
  ok(glByCode['1150'] && glByCode['1150'].dr === 280, 'GL Dr AR 280');
  ok(glByCode['4100'] && glByCode['4100'].cr === 250, 'GL Cr Revenue 250');
  ok(glByCode['2210'] && glByCode['2210'].cr === 30, 'GL Cr Output VAT 30');

  // idempotency replay: re-issue with same key → replayed, no new journal
  const replay = await InvoiceService.issue(draft.id, { actor, idempotencyKey: IDEM_ISSUE });
  ok(replay.replayed === true, 'issue idempotency replay (no double post)');

  // 4) partial collection 100 allocated to the invoice
  const pay = await db.withTransaction((c) => PaymentService.create(c, {
    customerId: customer.id, amount: 100, paymentDate: '2026-07-05', destinationType: 'cash',
    allocations: [{ arDocumentId: draft.id, amount: 100 }],
  }, actor));
  await PaymentService.approve(pay.id, { actor: 'checker' });
  const posted = await PaymentService.post(pay.id, { actor });
  ok(posted.toStatus === 'posted', 'collection posted');
  const invPartial = await db.withTransaction((c) => InvoiceService.getWithLines(c, draft.id));
  ok(Number(invPartial.paid_amount) === 100 && Number(invPartial.balance_amount) === 180 && invPartial.status === 'partially_paid', 'invoice partially_paid, paid 100 / balance 180');

  // 5) over-allocation blocked (invoice outstanding is 180) — and the FORCED
  //    FAILURE leaves ZERO trace. "Blocked" alone is half the contract: a failed
  //    post that still wrote a journal, bumped paid_amount, or logged an event
  //    would corrupt the ledger while reporting an error. Snapshot every counted
  //    table around the failure and require byte-identical counts, plus the
  //    payment still 'approved' and the invoice balance untouched.
  const pay2 = await db.withTransaction((c) => PaymentService.create(c, {
    customerId: customer.id, amount: 500, paymentDate: '2026-07-06', destinationType: 'cash',
    allocations: [{ arDocumentId: draft.id, amount: 500 }],
  }, actor));
  await PaymentService.approve(pay2.id, { actor: 'checker' });
  const beforeFail = await tableCounts();
  await throwsCode(() => PaymentService.post(pay2.id, { actor }), 'OVER_ALLOCATION', 'over-allocation blocked');
  const afterFail = await tableCounts();
  const failDrift = diffCounts(beforeFail, afterFail);
  ok(failDrift.length === 0, 'forced failure wrote NOTHING (' + (failDrift.join(' | ') || 'all counts identical') + ')');
  const [p2row] = await db.query('SELECT status FROM customer_payments WHERE id = ?', [pay2.id]);
  ok(p2row.length && p2row[0].status === 'approved', 'failed post left the payment genuinely approved (state did not move)');
  const invAfterFail = await db.withTransaction((c) => InvoiceService.getWithLines(c, draft.id));
  ok(Number(invAfterFail.paid_amount) === 100 && Number(invAfterFail.balance_amount) === 180, 'failed post left the invoice balance untouched (100/180)');

  // 6) version conflict: stale expectedVersion on cancel of a fresh draft —
  //    same zero-trace requirement.
  const draft2 = await db.withTransaction((c) => InvoiceService.createDraft(c, {
    sourceType: 'manual', customerId: customer.id, issueDate: '2026-07-01', lines: [{ description: 'x', enteredQty: 1, unitPrice: 10, vatRate: 15 }],
  }, actor));
  const beforeVc = await tableCounts();
  await throwsCode(() => InvoiceService.cancel(draft2.id, { actor, expectedVersion: 999 }), 'VERSION_CONFLICT', 'stale version → 409');
  const vcDrift = diffCounts(beforeVc, await tableCounts());
  ok(vcDrift.length === 0, 'version-conflict failure wrote NOTHING (' + (vcDrift.join(' | ') || 'all counts identical') + ')');

  // 7) partial return of the issued invoice (1 of the 2 taxable units).
  // Line order is not guaranteed (random ids) → select the taxable line explicitly.
  const taxableLine = invAfter.lines.find((l) => Number(l.vat_rate) === 15);
  ok(!!taxableLine, 'taxable line located for return');
  const ret = await db.withTransaction((c) => ReturnService.create(c, {
    originalArDocumentId: draft.id, returnDate: '2026-07-07', refundMethod: 'ar_reduction',
    lines: [{ originalLineId: taxableLine.id, returnQty: 1 }],
  }, actor));
  ok(Number(ret.subtotal) === 100 && Number(ret.vat_amount) === 15, 'return proportional net100 vat15 (half of taxable line)');
  await ReturnService.approve(ret.id, { actor: 'checker' });
  const retPosted = await ReturnService.post(ret.id, { actor });
  ok(retPosted.toStatus === 'posted', 'return posted');
  ok(retPosted.result.journalIds.length === 1, 'return posted a credit-note GL journal');
  const [cnDoc] = await db.query("SELECT id, document_type, original_document_id FROM ar_documents WHERE id = ?", [retPosted.result.payload.creditNoteId]);
  ok(cnDoc.length && cnDoc[0].document_type === 'credit_note' && cnDoc[0].original_document_id === draft.id, 'credit note linked to original invoice');
  // ar_reduction CN reduced the ORIGINAL invoice's subledger balance (ties to GL AR):
  // before return balance 180; CN total 115 → paid 215, balance 65
  const invAfterRet = await db.withTransaction((c) => InvoiceService.getWithLines(c, draft.id));
  ok(Number(invAfterRet.paid_amount) === 215 && Number(invAfterRet.balance_amount) === 65, 'ar_reduction CN reduced original invoice balance 180→65 (subledger ties to GL)');

  // over-return blocked (only 1 left on that line)
  await throwsCode(() => db.withTransaction((c) => ReturnService.create(c, {
    originalArDocumentId: draft.id, returnDate: '2026-07-07',
    lines: [{ originalLineId: taxableLine.id, returnQty: 5 }],
  }, actor)), 'OVER_RETURN', 'over-return blocked');

  // 8) reports run (ONLY_FULL_GROUP_BY-safe) + reconcile passes
  for (const t of ['sales-summary', 'sales-by-customer', 'ar-aging', 'open-invoices', 'collections', 'credit-exposure', 'returns', 'zatca-status', 'data-quality']) {
    const rep = await Reporting.run(t, { from: '2026-01-01', to: '2026-12-31' });
    ok(rep && Array.isArray(rep.rows), 'report ' + t + ' returns rows');
  }
  const rec = await Reconcile.run();
  const failed = rec.checks.filter((c) => !c.pass && c.severity === 'error');
  ok(rec.pass, 'reconcile PASS (' + (failed.length ? failed.map((c) => c.name).join(',') : 'all invariants hold') + ')');

  console.log(`\no2cServices.integration: ${pass} passed, ${fail} failed`);
}

(async () => {
  let crashed = null;
  // Before: a run killed mid-way (or an older leaking run) must not fail this one
  // on the UNIQUE phone / idempotency_key.
  await cleanup();
  // The leak detector's baseline. Taken AFTER the initial cleanup so it measures
  // this run only; compared after the final cleanup, so "cleanup works" is a
  // verified count equality, not a comment. Running the FILE twice is therefore
  // also provably residue-free: run 2's baseline equals run 1's final counts.
  const baseline = await tableCounts();
  try {
    await main();
  } catch (e) {
    crashed = e;
    console.error('INTEGRATION ERROR:', (e && e.stack) || e);
  } finally {
    // The ledger is real and these journals feed the equity/royalty/AR reports.
    // However this run ended, it leaves nothing behind — and that is CHECKED.
    try {
      await cleanup();
      const drift = diffCounts(baseline, await tableCounts());
      if (drift.length) {
        fail++;
        console.error('  ✗ RESIDUE after cleanup:', drift.join(' | '));
      } else {
        pass++;
        console.log('  ✓ zero residue: all', COUNTED_TABLES.length, 'table counts identical to baseline');
      }
    } catch (e) {
      fail++;
      console.error('  ✗ CLEANUP FAILED (not swallowed):', (e && e.message) || e);
    }
    await db.end();
  }
  process.exit(fail || crashed ? 1 : 0);
})();
