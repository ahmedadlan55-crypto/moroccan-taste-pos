/**
 * services/order-to-cash/O2CReconciliationService.js — read-only integrity checks
 * (spec §10/§Reconcile). Proves the O2C ledger is internally consistent and ties
 * to the GL. Every check is a single ONLY_FULL_GROUP_BY-safe query; nothing is
 * mutated. Returns { pass, checks:[{name, pass, detail, severity}] }.
 *
 * Invariants:
 *   gl_balanced            every gl_journal has Σdebit = Σcredit
 *   invoice_consistency    balance_amount = total_amount − paid_amount (rounded)
 *   no_negative_balance    no invoice balance < 0
 *   no_over_allocation     Σ live allocations ≤ invoice total, per invoice
 *   payment_within_amount  Σ live allocations ≤ payment amount, per payment
 *   no_orphan_allocation   every allocation points at an existing invoice + payment
 *   unique_source          no duplicate (source_type, source_id)
 *   ar_ties_to_gl          O2C open-AR subledger vs GL account 1150 (delta explained)
 */
'use strict';

const db = require('../../db/connection');
const calc = require('../../lib/order-to-cash/calculations');
const money = calc.money;

const AR_CODE = String(process.env.O2C_AR_ACCOUNT_CODE || '1150');

async function run(conn = db) {
  const checks = [];
  const add = (name, pass, detail, severity = 'error') => checks.push({ name, pass: !!pass, detail, severity });

  // 1. GL balanced
  const [glBad] = await conn.query(
    `SELECT j.id, j.journal_number, ROUND(SUM(e.debit),2) AS dr, ROUND(SUM(e.credit),2) AS cr
       FROM gl_journals j JOIN gl_entries e ON e.journal_id = j.id
      GROUP BY j.id, j.journal_number HAVING ABS(dr - cr) > 0.01 LIMIT 20`);
  add('gl_balanced', glBad.length === 0, glBad.length ? `${glBad.length} قيد غير متوازن` : 'كل القيود متوازنة');

  // 2. invoice paid/balance consistency (invoices only — a credit note carries no
  //    paid/balance semantics; it reduces AR via the balance view, not its own row)
  const [incons] = await conn.query(
    `SELECT COUNT(*) AS n FROM ar_documents
      WHERE document_type='invoice' AND ABS(balance_amount - (total_amount - paid_amount)) > 0.01
        AND status NOT IN ('cancelled')`);
  add('invoice_consistency', Number(incons[0].n) === 0, `${incons[0].n} فاتورة برصيد غير متسق`);

  // 3. no negative balance
  const [neg] = await conn.query(
    `SELECT COUNT(*) AS n FROM ar_documents WHERE document_type='invoice' AND balance_amount < -0.01`);
  add('no_negative_balance', Number(neg[0].n) === 0, `${neg[0].n} فاتورة برصيد سالب`);

  // 4. over-allocation per invoice
  const [over] = await conn.query(
    `SELECT d.id FROM ar_documents d
       JOIN (SELECT ar_document_id, SUM(allocated_amount) AS alloc FROM ar_payment_allocations WHERE reversed=0 GROUP BY ar_document_id) a
         ON a.ar_document_id = d.id
      WHERE a.alloc - d.total_amount > 0.01 LIMIT 20`);
  add('no_over_allocation', over.length === 0, `${over.length} فاتورة مُخصّص عليها أكثر من إجماليها`);

  // 5. payment within amount
  const [payOver] = await conn.query(
    `SELECT p.id FROM customer_payments p
       JOIN (SELECT payment_id, SUM(allocated_amount) AS alloc FROM ar_payment_allocations WHERE reversed=0 GROUP BY payment_id) a
         ON a.payment_id = p.id
      WHERE a.alloc - p.amount > 0.01 LIMIT 20`);
  add('payment_within_amount', payOver.length === 0, `${payOver.length} دفعة تخصيصها يتجاوز مبلغها`);

  // 6. orphan allocations
  const [orphan] = await conn.query(
    `SELECT COUNT(*) AS n FROM ar_payment_allocations a
       LEFT JOIN ar_documents d ON d.id = a.ar_document_id
       LEFT JOIN customer_payments p ON p.id = a.payment_id
      WHERE a.reversed=0 AND (d.id IS NULL OR p.id IS NULL)`);
  add('no_orphan_allocation', Number(orphan[0].n) === 0, `${orphan[0].n} تخصيص يتيم`);

  // 7. unique source
  const [dupSrc] = await conn.query(
    `SELECT source_type, source_id, COUNT(*) AS n FROM ar_documents
      WHERE source_id IS NOT NULL GROUP BY source_type, source_id HAVING n > 1 LIMIT 20`);
  add('unique_source', dupSrc.length === 0, `${dupSrc.length} مصدر مكرر`);

  // 8. AR ties to GL 1150 (informational delta — legacy AR also posts here during transition)
  const [[sub]] = [await conn.query(
    `SELECT COALESCE(SUM(CASE WHEN document_type='credit_note' THEN 0 ELSE balance_amount END),0) AS open_ar
       FROM ar_documents WHERE document_type='invoice' AND status IN ('issued','partially_paid')`)];
  const [[gl]] = [await conn.query(
    `SELECT COALESCE(SUM(e.debit - e.credit),0) AS bal
       FROM gl_entries e JOIN gl_accounts a ON a.id = e.account_id WHERE a.code = ?`, [AR_CODE])];
  const subledger = money(sub[0].open_ar);
  const glAr = money(gl[0].bal);
  const delta = money(glAr - subledger);
  add('ar_ties_to_gl', Math.abs(delta) < 0.01,
    `O2C فرعي=${subledger} · GL(${AR_CODE})=${glAr} · فارق=${delta} (الفارق يعود لذمم قديمة خارج O2C إن وُجد)`,
    'warn');

  const hardFail = checks.some((c) => !c.pass && c.severity === 'error');
  return { pass: !hardFail, checks, generatedAt: new Date().toISOString() };
}

module.exports = { run };
