'use strict';
/**
 * tests/o2cServices.integration.test.js — REAL integration test against the local
 * MariaDB (port 3307). Exercises the O2C domain services end-to-end:
 *   customer → credit gate → manual invoice (issue + GL + ZATCA) → collection
 *   (allocate + GL) → over-allocation guard → partial return (credit note + GL) →
 *   idempotency replay → version conflict → reconcile.
 *
 *   node tests/o2cServices.integration.test.js
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

async function main() {
  const tag = 't' + Date.now().toString(36);
  const actor = 'itest';

  // 1) create a credit customer (unique phone + VAT per run so the test is re-runnable)
  const uniqPhone = '05' + String(Date.now()).slice(-8);
  const uniqVat = '3' + String(Date.now()).padStart(13, '0').slice(-13) + '3';
  const customer = await db.withTransaction((c) => CustomerService.create(c, {
    name: 'عميل اختبار ' + tag, phone: uniqPhone,
    customerType: 'B2B', vatNumber: uniqVat, creditLimit: 1000, paymentTerms: 'Net30', creditDays: 30,
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

  const issued = await InvoiceService.issue(draft.id, { actor, idempotencyKey: 'inv-' + tag });
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
  const replay = await InvoiceService.issue(draft.id, { actor, idempotencyKey: 'inv-' + tag });
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

  // 5) over-allocation blocked (invoice outstanding is 180)
  const pay2 = await db.withTransaction((c) => PaymentService.create(c, {
    customerId: customer.id, amount: 500, paymentDate: '2026-07-06', destinationType: 'cash',
    allocations: [{ arDocumentId: draft.id, amount: 500 }],
  }, actor));
  await PaymentService.approve(pay2.id, { actor: 'checker' });
  await throwsCode(() => PaymentService.post(pay2.id, { actor }), 'OVER_ALLOCATION', 'over-allocation blocked');

  // 6) version conflict: stale expectedVersion on cancel of a fresh draft
  const draft2 = await db.withTransaction((c) => InvoiceService.createDraft(c, {
    sourceType: 'manual', customerId: customer.id, issueDate: '2026-07-01', lines: [{ description: 'x', enteredQty: 1, unitPrice: 10, vatRate: 15 }],
  }, actor));
  await throwsCode(() => InvoiceService.cancel(draft2.id, { actor, expectedVersion: 999 }), 'VERSION_CONFLICT', 'stale version → 409');

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
  await db.end();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('INTEGRATION ERROR:', e && e.stack || e); process.exit(1); });
