/**
 * Procurement concurrency proof (live DB, minimal app harness):
 *   • two concurrent receipt POSTs against one PO → total never exceeds ordered
 *   • two concurrent PO approvals → exactly one succeeds
 *   • two concurrent payment executions over one invoice → over-allocation blocked
 *   • idempotency replay (same Idempotency-Key, fired concurrently) → one effect
 *   • stale expectedVersion → 409 VERSION_CONFLICT
 *
 * Run: node tests/procurementConcurrency.integration.test.js
 */
'use strict';

process.env.PROCUREMENT_P2P_ENABLE = '1';
const express = require('express');
const db = require('../db/connection');

let _p = 0, _f = 0;
function ok(c, m) { if (c) { _p++; console.log('  ✅', m); } else { _f++; console.log('  ❌', m); } }

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1, username: String(req.headers['x-test-user'] || 'admin'), role: 'admin' }; req.guardWh = () => true; req.whScopeClause = () => ({ sql: '', params: [] }); next(); });
  app.use('/api/procurement', require('../routes/procurement'));
  return app;
}

async function main() {
  const app = buildApp();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const RUN = Date.now();

  async function call(method, p, body, headers = {}) {
    const res = await fetch(base + p, { method, headers: Object.assign({ 'content-type': 'application/json', 'x-test-user': 'admin' }, headers), body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  }

  const SUP = 'TEST-P2P-SUP', ITEM = 'TEST-P2P-ITEM', WH = 'TEST-P2P-WH';
  // full clean of the shared test supplier's transactional data so the DB is
  // left consistent for reconcile (no orphaned cached balances). Posted
  // receipts leave real gl_journals/gl_entries + inventory_movements behind
  // (this test's own concurrent-receipts scenario posts one of its two 80-qty
  // receipts) — those must go too, or they inflate any global movement/GL
  // count a later test relies on (e.g. inventoryMethod's movementsSinceLastClose).
  async function cleanup() {
    await db.query("DELETE ge FROM gl_entries ge JOIN gl_journals gj ON gj.id=ge.journal_id WHERE gj.reference_type='GoodsReceipt' AND gj.reference_id IN (SELECT id FROM purchase_receipts WHERE supplier_id=?)", [SUP]).catch(() => {});
    await db.query("DELETE FROM gl_journals WHERE reference_type='GoodsReceipt' AND reference_id IN (SELECT id FROM purchase_receipts WHERE supplier_id=?)", [SUP]).catch(() => {});
    await db.query("DELETE ge FROM gl_entries ge JOIN gl_journals gj ON gj.id=ge.journal_id WHERE gj.reference_type='SupplierInvoice' AND gj.reference_id IN (SELECT id FROM supplier_invoices WHERE supplier_id=?)", [SUP]).catch(() => {});
    await db.query("DELETE FROM gl_journals WHERE reference_type='SupplierInvoice' AND reference_id IN (SELECT id FROM supplier_invoices WHERE supplier_id=?)", [SUP]).catch(() => {});
    await db.query("DELETE ge FROM gl_entries ge JOIN gl_journals gj ON gj.id=ge.journal_id WHERE gj.reference_type='SupplierPayment' AND gj.reference_id IN (SELECT id FROM payment_records WHERE supplier_id=?)", [SUP]).catch(() => {});
    await db.query("DELETE FROM gl_journals WHERE reference_type='SupplierPayment' AND reference_id IN (SELECT id FROM payment_records WHERE supplier_id=?)", [SUP]).catch(() => {});
    await db.query('DELETE pa FROM payment_allocations pa JOIN payment_records p ON p.id=pa.payment_id WHERE p.supplier_id=?', [SUP]).catch(() => {});
    await db.query('DELETE FROM payment_records WHERE supplier_id=?', [SUP]).catch(() => {});
    await db.query('DELETE sim FROM supplier_invoice_matches sim JOIN supplier_invoices si ON si.id=sim.invoice_id WHERE si.supplier_id=?', [SUP]).catch(() => {});
    await db.query('DELETE sil FROM supplier_invoice_lines sil JOIN supplier_invoices si ON si.id=sil.invoice_id WHERE si.supplier_id=?', [SUP]).catch(() => {});
    await db.query('DELETE FROM supplier_invoices WHERE supplier_id=?', [SUP]).catch(() => {});
    await db.query('DELETE prl FROM purchase_receipt_lines prl JOIN purchase_receipts pr ON pr.id=prl.receipt_id WHERE pr.supplier_id=?', [SUP]).catch(() => {});
    await db.query('DELETE FROM purchase_receipts WHERE supplier_id=?', [SUP]).catch(() => {});
    await db.query('DELETE pl FROM po_lines pl JOIN purchase_orders po ON po.id=pl.po_id WHERE po.supplier_id=?', [SUP]).catch(() => {});
    await db.query('DELETE FROM purchase_orders WHERE supplier_id=?', [SUP]).catch(() => {});
    await db.query('DELETE FROM inventory_movements WHERE item_id=? OR warehouse_id=?', [ITEM, WH]).catch(() => {});
    await db.query('DELETE FROM inventory_cost_history WHERE item_id=?', [ITEM]).catch(() => {});
    await db.query('DELETE FROM item_cost_history WHERE item_id=?', [ITEM]).catch(() => {});
    await db.query('DELETE FROM warehouse_stock WHERE item_id=?', [ITEM]).catch(() => {});
    await db.query('DELETE FROM purchase_lots WHERE inv_item_id=?', [ITEM]).catch(() => {});
    // Receipt posting bumps inv_items.stock alongside warehouse_stock — wiping
    // the warehouse row without resetting this leaves the item's own stock
    // counter permanently out of sync with Σwarehouse_stock (caught by
    // scripts/procurement/reconcile.js's stock_rollup check).
    await db.query('UPDATE inv_items SET stock=0, cost=0 WHERE id=?', [ITEM]).catch(() => {});
  }
  await cleanup();
  await db.query('INSERT INTO warehouses (id,code,name,is_active) VALUES (?,?,?,1) ON DUPLICATE KEY UPDATE name=VALUES(name)', [WH, 'TWH', 'مستودع اختبار']);
  await db.query("INSERT INTO inv_items (id,name,kind,unit,cost,stock,tracking_mode) VALUES (?,?,?,?,0,0,'none') ON DUPLICATE KEY UPDATE stock=0,cost=0", [ITEM, 'مادة', 'raw', 'حبة']);
  await db.query("INSERT INTO suppliers (id,name,is_active) VALUES (?,?,1) ON DUPLICATE KEY UPDATE is_active=1", [SUP, 'مورد']);

  try {
  // ── concurrent receipts vs one PO (ordered 120; two receipts of 80 each) ──
  console.log('\n── concurrent receipts never exceed PO ──');
  const po = await call('POST', '/api/procurement/orders', { supplierId: SUP, warehouseId: WH, lines: [{ itemId: ITEM, enteredQty: 120, factor: 1, unitPriceEntered: 10, vatRate: 15 }] });
  await call('POST', `/api/procurement/orders/${po.json.data.id}/submit`);
  await call('POST', `/api/procurement/orders/${po.json.data.id}/approve`, {}, { 'x-test-user': 'checker' });
  const [[pl]] = [await db.query('SELECT id FROM po_lines WHERE po_id=?', [po.json.data.id])];
  const poLineId = pl[0].id;
  const mk = async (qty) => { const r = await call('POST', '/api/procurement/receipts', { poId: po.json.data.id, supplierId: SUP, warehouseId: WH, lines: [{ itemId: ITEM, poLineId, enteredQty: qty, factor: 1, unitCost: 10 }] }); await call('POST', `/api/procurement/receipts/${r.json.data.id}/approve`); return r.json.data.id; };
  const g1 = await mk(80), g2 = await mk(80);
  const [r1, r2] = await Promise.all([call('POST', `/api/procurement/receipts/${g1}/post`), call('POST', `/api/procurement/receipts/${g2}/post`)]);
  const successes = [r1, r2].filter((r) => r.status === 200).length;
  const overs = [r1, r2].filter((r) => r.status === 422 && r.json.code === 'OVER_RECEIPT').length;
  ok(successes === 1 && overs === 1, `one receipt posted, one OVER_RECEIPT (posted=${successes}, over=${overs})`);
  const [[ws]] = [await db.query('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [WH, ITEM])];
  ok(Number(ws[0].qty) === 80, `stock = 80 (not 160) — no over-receipt under concurrency (got ${ws[0].qty})`);

  // ── concurrent PO approvals — exactly one succeeds ──
  console.log('\n── concurrent approvals — one winner ──');
  const po2 = await call('POST', '/api/procurement/orders', { supplierId: SUP, warehouseId: WH, lines: [{ itemId: ITEM, enteredQty: 5, factor: 1, unitPriceEntered: 10, vatRate: 0 }] });
  await call('POST', `/api/procurement/orders/${po2.json.data.id}/submit`);
  const [a1, a2] = await Promise.all([
    call('POST', `/api/procurement/orders/${po2.json.data.id}/approve`, { expectedVersion: 2 }, { 'x-test-user': 'c1' }),
    call('POST', `/api/procurement/orders/${po2.json.data.id}/approve`, { expectedVersion: 2 }, { 'x-test-user': 'c2' }),
  ]);
  const approveWins = [a1, a2].filter((r) => r.status === 200).length;
  ok(approveWins === 1, `exactly one approval succeeded (got ${approveWins})`);

  // ── stale version ──
  console.log('\n── stale version → 409 ──');
  const stale = await call('POST', `/api/procurement/orders/${po2.json.data.id}/send`, { expectedVersion: 1 });
  ok(stale.status === 409 && stale.json.code === 'VERSION_CONFLICT', `stale expectedVersion → 409 VERSION_CONFLICT (got ${stale.status}/${stale.json.code})`);

  // ── idempotency replay (concurrent, same key) ──
  console.log('\n── idempotency replay (concurrent) ──');
  const idem = 'idem-send-' + RUN;
  const [s1, s2] = await Promise.all([
    call('POST', `/api/procurement/orders/${po2.json.data.id}/send`, {}, { 'idempotency-key': idem }),
    call('POST', `/api/procurement/orders/${po2.json.data.id}/send`, {}, { 'idempotency-key': idem }),
  ]);
  ok(s1.status === 200 && s2.status === 200, `both idempotent sends → 200/200 (got ${s1.status}/${s2.status})`);
  const [[sendEvents]] = [await db.query("SELECT COUNT(*) c FROM procurement_events WHERE document_id=? AND action='send'", [po2.json.data.id])];
  ok(Number(sendEvents[0].c) === 1, `exactly ONE 'send' event recorded despite concurrent replay (got ${sendEvents[0].c})`);

  // ── concurrent payment over-allocation ──
  console.log('\n── concurrent payments — over-allocation blocked ──');
  // build a fresh approved invoice worth 1000
  await db.query('DELETE pa FROM payment_allocations pa JOIN payment_records p ON p.id=pa.payment_id WHERE p.supplier_id=?', [SUP]).catch(() => {});
  const inv = await call('POST', '/api/procurement/invoices', { supplierId: SUP, invoiceNo: 'INV-CC-' + RUN, invoiceKind: 'non_stock', dueDate: '2020-01-01', lines: [{ itemId: ITEM, description: 'x', enteredQty: 1, factor: 1, unitPriceEntered: 1000, vatRate: 0 }] });
  await call('POST', `/api/procurement/invoices/${inv.json.data.id}/submit`);
  await call('POST', `/api/procurement/invoices/${inv.json.data.id}/approve`, {}, { 'x-test-user': 'ap2' });
  const mkPay = async () => { const r = await call('POST', '/api/procurement/payments', { supplierId: SUP, amount: 1000, paymentMethod: 'bank', allocations: [{ invoiceId: inv.json.data.id, amount: 1000 }] }); await call('POST', `/api/procurement/payments/${r.json.data.id}/authorize`); return r.json.data.id; };
  const p1 = await mkPay(), p2 = await mkPay();
  const [pr1, pr2] = await Promise.all([call('POST', `/api/procurement/payments/${p1}/pay`), call('POST', `/api/procurement/payments/${p2}/pay`)]);
  const payWins = [pr1, pr2].filter((r) => r.status === 200).length;
  const overAlloc = [pr1, pr2].filter((r) => r.status === 422 && r.json.code === 'PAYMENT_OVER_ALLOCATION').length;
  ok(payWins === 1 && overAlloc === 1, `one payment settled, one PAYMENT_OVER_ALLOCATION (paid=${payWins}, over=${overAlloc})`);
  const [[bal]] = [await db.query('SELECT balance_amount FROM supplier_invoices WHERE id=?', [inv.json.data.id])];
  ok(Math.abs(Number(bal[0].balance_amount)) < 0.01, `invoice fully settled once (balance=${bal[0].balance_amount})`);
  } finally {
    await cleanup();
  }

  server.close();
  await db.end();
  console.log(`\nProcurement concurrency: ${_p} passed, ${_f} failed`);
  process.exit(_f ? 1 : 0);
}

main().catch((e) => { console.error('CONCURRENCY ERROR:', e.stack || e.message); process.exit(1); });
