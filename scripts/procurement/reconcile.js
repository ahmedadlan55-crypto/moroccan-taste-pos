#!/usr/bin/env node
/**
 * scripts/procurement/reconcile.js — READ-ONLY procurement reconciliation.
 *
 * Proves the invariants the P2P migration must hold and prints a before/after
 * style report. Exit code is non-zero if any hard invariant fails (so it can
 * gate a migration/backfill run in CI).
 *
 * Invariants:
 *   1. Σ purchase_lots.qty_remaining (per item·warehouse) == warehouse_stock.qty
 *   2. Σ warehouse_stock.qty (per item)                    == inv_items.stock
 *   3. every gl_journal is balanced (debit == credit)
 *   4. Accounts Payable (2100) balance             == Σ v_supplier_ap_balance
 *   5. every supplier_invoice.balance_amount        == total − Σ allocations
 *   6. orphan / anomaly counts are reported (not necessarily fatal)
 *
 * Usage: node scripts/procurement/reconcile.js [--strict]
 */
'use strict';

const path = require('path');
const db = require(path.join(__dirname, '..', '..', 'db', 'connection'));

const TOL = 0.01;
function money(n) { return Math.round((Number(n) || 0) * 100) / 100; }

async function main({ strict }) {
  const report = { checks: [], counts: {}, ok: true };
  const add = (name, ok, detail) => { report.checks.push({ name, ok, detail }); if (!ok) report.ok = false; };

  // 1. lot invariant (per item · warehouse), only for lots that carry a warehouse
  const [lotRows] = await db.query(`
    SELECT l.inv_item_id AS item_id, l.warehouse_id, SUM(l.qty_remaining) AS lot_qty
      FROM purchase_lots l WHERE l.warehouse_id IS NOT NULL
      GROUP BY l.inv_item_id, l.warehouse_id`);
  let lotViolations = 0;
  for (const r of lotRows) {
    const [[ws]] = await db.query('SELECT COALESCE(qty,0) qty FROM warehouse_stock WHERE item_id=? AND warehouse_id=?', [r.item_id, r.warehouse_id]);
    if (Math.abs(money(r.lot_qty) - money(ws ? ws.qty : 0)) > TOL) lotViolations++;
  }
  add('lot_invariant', lotViolations === 0, `${lotViolations} item·warehouse lot/stock mismatches (of ${lotRows.length} lotted)`);

  // 2. warehouse_stock rollup == inv_items.stock
  const [[rollup]] = await db.query(`
    SELECT COUNT(*) c FROM (
      SELECT i.id, i.stock, COALESCE(SUM(ws.qty),0) AS wh
        FROM inv_items i LEFT JOIN warehouse_stock ws ON ws.item_id=i.id
       WHERE i.deleted_at IS NULL GROUP BY i.id HAVING ABS(i.stock - wh) > ${TOL}
    ) t`);
  add('stock_rollup', Number(rollup.c) === 0, `${rollup.c} items where inv_items.stock ≠ Σ warehouse_stock`);

  // 3. GL journals balanced
  const [[unbal]] = await db.query(`SELECT COUNT(*) c FROM gl_journals WHERE ABS(total_debit - total_credit) > ${TOL}`);
  add('gl_balanced', Number(unbal.c) === 0, `${unbal.c} unbalanced journals`);
  const [[glSum]] = await db.query('SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c FROM gl_entries');
  add('gl_global_balance', Math.abs(money(glSum.d) - money(glSum.c)) <= TOL, `Σdebit=${money(glSum.d)} Σcredit=${money(glSum.c)}`);

  // 4. AP account balance vs derived supplier AP
  const [[apAcc]] = await db.query("SELECT COALESCE(balance,0) b FROM gl_accounts WHERE code=? LIMIT 1", [process.env.PROCUREMENT_AP_ACCOUNT_CODE || '2100']);
  const [[apDerived]] = await db.query('SELECT COALESCE(SUM(ap_balance),0) b FROM v_supplier_ap_balance');
  // NOTE: the GL AP balance also carries legacy (pre-P2P) postings, so this is a
  // reported delta, fatal only under --strict when a fresh/migrated ledger is expected.
  report.counts.apAccountBalance = money(apAcc.b);
  report.counts.apDerivedBalance = money(apDerived.b);
  add('ap_balance_reconciled', !strict || Math.abs(money(apAcc.b) - money(apDerived.b)) <= TOL,
    `GL AP=${money(apAcc.b)} vs derived=${money(apDerived.b)} (delta ${money(apAcc.b - apDerived.b)})`);

  // 5. invoice balance integrity
  const [[invBad]] = await db.query(`
    SELECT COUNT(*) c FROM supplier_invoices si
     WHERE si.status NOT IN ('cancelled','draft')
       AND ABS(si.balance_amount - (si.total_amount - COALESCE((SELECT SUM(allocated_amount) FROM payment_allocations pa WHERE pa.supplier_invoice_id=si.id AND pa.reversed=0),0))) > ${TOL}`);
  add('invoice_balance_integrity', Number(invBad.c) === 0, `${invBad.c} invoices where balance ≠ total − allocations`);

  // Input VAT total
  const [[vat]] = await db.query("SELECT COALESCE(SUM(vat_amount),0) v FROM supplier_invoices WHERE status NOT IN ('cancelled','draft')");
  report.counts.inputVatTotal = money(vat.v);

  // 6. orphans / counts
  const [[orph]] = await db.query("SELECT COUNT(*) c FROM supplier_invoices WHERE (supplier_id IS NULL OR supplier_id='') AND status<>'cancelled'");
  report.counts.invoicesWithoutSupplier = Number(orph.c);
  for (const t of ['suppliers', 'purchase_orders', 'purchase_receipts', 'supplier_invoices', 'payment_records', 'purchase_returns', 'procurement_events']) {
    const [[c]] = await db.query(`SELECT COUNT(*) c FROM ${t}`);
    report.counts[t] = Number(c.c);
  }

  console.log('\n=== Procurement Reconciliation ===');
  for (const c of report.checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name} — ${c.detail}`);
  console.log('\n  counts:', JSON.stringify(report.counts, null, 0));
  console.log(`\n  RESULT: ${report.ok ? 'PASS' : 'FAIL'}`);
  await db.end();
  process.exit(report.ok ? 0 : 1);
}

if (require.main === module) {
  main({ strict: process.argv.includes('--strict') }).catch((e) => { console.error('RECONCILE ERROR:', e.message); process.exit(1); });
}
module.exports = { main };
