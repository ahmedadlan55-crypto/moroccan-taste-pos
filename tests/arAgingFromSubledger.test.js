#!/usr/bin/env node
'use strict';
/**
 * The A/R ageing reads the receivables SUBLEDGER and ages by DUE DATE.
 *
 * ─── WHAT IT USED TO DO ─────────────────────────────────────────────────────
 * It reconstructed the receivable from the POS order table by GUESSING which
 * orders were on credit:
 *
 *     LOWER(payment_method) LIKE '%kita%' OR LIKE '%credit%'
 *       OR LIKE '%ذمم%' OR LIKE '%آجل%' OR = 'Split' OR = 'Other'
 *
 * Each part of that moved money:
 *
 *   · IT GUESSED. `payment_method` is free text from a cashier UI. A credit
 *     sale spelled any other way was invisible to the ageing; an ordinary
 *     'Other' sale became a debt nobody owed. String matching decided who owed
 *     the company money.
 *
 *   · IT AGED BY ORDER DATE. An invoice on 30-day terms was reported 31 days
 *     overdue the day after it was raised — the difference between "current"
 *     and "chase this customer".
 *
 *   · IT COULD NOT TIE TO THE LEDGER. Nothing linked those rows to the control
 *     account, so the spec's criterion (ageing total = the AR balance on the
 *     balance sheet) was not merely unmet — it was uncheckable.
 */

const path = require('path');

let pass = 0;
const failures = [];
function check(name, ok, extra) {
  if (ok) { pass += 1; return; }
  failures.push(name + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra)));
  console.error('  FAIL ' + name, extra || '');
}

const AS_OF = '2026-03-31';

// The fixture is chosen so DUE-date ageing and ISSUE-date ageing disagree.
//
//   INV-1  issued 2026-01-05, due 2026-03-20  balance 1000
//          by due date  → 11 days  → bucket 0-30      ← correct
//          by issue date → 85 days → bucket 61-90     ← the old answer
//
// A credit note reduces the customer's balance rather than adding to it.
const AR_DOCS = [
  { id: 'D1', document_number: 'INV-1', document_type: 'invoice',
    issue_date: '2026-01-05', due_date: '2026-03-20',
    total_amount: 1000, paid_amount: 0, balance_amount: 1000,
    customer_id: 'C1', customer_name: 'عميل واحد', gl_journal_id: 'J1', customer_phone: '05' },
  { id: 'D2', document_number: 'CN-1', document_type: 'credit_note',
    issue_date: '2026-02-01', due_date: '2026-02-01',
    total_amount: 200, paid_amount: 0, balance_amount: 200,
    customer_id: 'C1', customer_name: 'عميل واحد', gl_journal_id: 'J2', customer_phone: '05' },
  // No terms recorded — must fall back to the issue date AND be counted.
  { id: 'D3', document_number: 'INV-2', document_type: 'invoice',
    issue_date: '2026-03-25', due_date: null,
    total_amount: 500, paid_amount: 0, balance_amount: 500,
    customer_id: 'C2', customer_name: 'عميل اثنان', gl_journal_id: 'J3', customer_phone: '05' },
];

function fakePool({ glBalance = 1300 } = {}) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      seen.push(text);
      if (/^SHOW TABLES LIKE/i.test(text)) return [[]];
      if (/^SHOW COLUMNS/i.test(text)) return [[]];
      if (/FROM ar_documents/i.test(text)) return [AR_DOCS];
      if (/FROM gl_entries/i.test(text)) return [[{ bal: glBalance }]];
      return [[]];
    },
  };
}

function loadRoute(opts) {
  const dbPath = require.resolve(path.join(__dirname, '..', 'db', 'connection.js'));
  const routePath = require.resolve(path.join(__dirname, '..', 'routes', 'erp', 'reports', 'ar-aging.js'));
  const savedDb = require.cache[dbPath];
  delete require.cache[routePath];
  const pool = fakePool(opts);
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: pool };
  let router;
  try { router = require(routePath); }
  finally {
    if (savedDb) require.cache[dbPath] = savedDb; else delete require.cache[dbPath];
    delete require.cache[routePath];
  }
  return { router, pool };
}

async function callAging(opts) {
  const glBoundaries = require('../lib/reports/glBoundaries');
  glBoundaries.resetCanonicalMapCache();
  const { router, pool } = loadRoute(opts);
  const layer = router.stack.find((l) => l.route);
  const handler = layer.route.stack.map((s) => s.handle).pop();
  const req = { query: { asOfDate: AS_OF }, user: { username: 't', role: 'admin' } };
  const res = {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  await handler(req, res, () => {});
  glBoundaries.resetCanonicalMapCache();
  return { body: res.body, pool };
}

(async () => {
  const { body, pool } = await callAging();
  check('handler answered', !!body && body.success, body);

  // ── The source ────────────────────────────────────────────────────────────
  check('reads the AR subledger', pool.seen.some((s) => /FROM ar_documents/i.test(s)));
  check('does NOT read the POS `sales` table',
    !pool.seen.some((s) => /\bFROM sales\b/i.test(s)),
    pool.seen.filter((s) => /FROM \w+/i.test(s)).map((s) => (s.match(/FROM \w+/i) || [])[0]));
  check('does NOT guess credit sales from free text',
    !pool.seen.some((s) => /LIKE '%kita%'|LIKE '%credit%'/i.test(s)));

  // ── Ageing by DUE date, not issue date ────────────────────────────────────
  const c1 = body.customers.find((c) => c.customerId === 'C1');
  const inv1 = c1 && c1.invoices.find((i) => i.reference === 'INV-1');
  check('an invoice is aged from its DUE date', inv1 && inv1.agedFrom === 'due_date', inv1);
  check('…so 11 days after due lands in 0-30, not 85 days in 61-90',
    inv1 && inv1.bucket === '0-30', inv1 && { ageDays: inv1.ageDays, bucket: inv1.bucket });

  // ── A missing due date falls back, and SAYS SO ────────────────────────────
  const c2 = body.customers.find((c) => c.customerId === 'C2');
  const inv2 = c2 && c2.invoices.find((i) => i.reference === 'INV-2');
  check('an invoice with no terms falls back to the issue date',
    inv2 && inv2.agedFrom === 'issue_date', inv2);
  check('…and the response counts how often that happened',
    body.basis && body.basis.rowsAgedByIssueDate === 1, body.basis);
  check('the response declares what it aged by',
    body.basis && body.basis.source === 'ar_documents' && body.basis.agedBy === 'due_date',
    body.basis);

  // ── A credit note REDUCES the balance ─────────────────────────────────────
  const cn = c1 && c1.invoices.find((i) => i.reference === 'CN-1');
  check('a credit note carries a negative receivable', cn && cn.outstanding === -200, cn);
  check('…so the customer owes 1000 − 200 = 800', c1 && Math.abs(c1.total - 800) < 0.005, c1 && c1.total);

  // ── The reconciliation the spec asks for ──────────────────────────────────
  check('reports the ageing total beside the GL control balance',
    !!body.reconciliation, body.reconciliation);
  check('…and flags agreement when they match',
    body.reconciliation && body.reconciliation.isReconciled === true
      && Math.abs(body.reconciliation.difference) < 0.005,
    body.reconciliation);

  // A DIFFERENCE must be visible, never silently absorbed.
  {
    const { body: b2 } = await callAging({ glBalance: 999 });
    check('a break between subledger and ledger is reported, not hidden',
      b2.reconciliation && b2.reconciliation.isReconciled === false
        && Math.abs(b2.reconciliation.difference - (1300 - 999)) < 0.005,
      b2.reconciliation);
    check('…and the ageing total is NOT adjusted to match the ledger',
      Math.abs(b2.grandTotal - 1300) < 0.005, b2.grandTotal);
    // The reconciliation must compare the report's OWN total against the
    // ledger. Quoting the ledger's figure on both sides would make every
    // reconciliation succeed by construction — a check that cannot fail.
    check('…and the reconciliation quotes the report\'s own total, not the ledger\'s',
      b2.reconciliation && Math.abs(b2.reconciliation.agingTotal - b2.grandTotal) < 0.005,
      { agingTotal: b2.reconciliation && b2.reconciliation.agingTotal, grandTotal: b2.grandTotal });
  }

  if (failures.length) {
    console.error('\n' + failures.length + ' failure(s):');
    failures.forEach((f) => console.error('  - ' + f));
    process.exit(1);
  }
  console.log('  ✅ A/R ageing: the subledger, aged by due date, reconciled to the control account');
  console.log(pass + '/' + pass + ' passed');
})().catch((e) => { console.error(e); process.exit(1); });
