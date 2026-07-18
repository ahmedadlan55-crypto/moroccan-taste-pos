/**
 * Procurement P2P — end-to-end integration test against the LIVE dev DB.
 * Mounts the /api/procurement router in a minimal Express app with a stub auth
 * (x-test-user header → req.user) + pass-through warehouse scope, then drives:
 *
 *   supplier → PO (10 cartons ×12 = 120 base) → submit → approve (no stock/GL)
 *   → receipt 4 cartons + receipt 6 cartons (post) → stock = 120, GRNI balanced
 *   → over-receipt blocked (422) → supplier invoice → 3-way match → approve (AP)
 *   → payment authorize + pay (allocate) → invoice paid, AP balance = 0
 *   → version conflict + idempotency replay → GL globally balanced.
 *
 * Run: node tests/procurementP2P.integration.test.js
 */
'use strict';

process.env.PROCUREMENT_P2P_ENABLE = '1';
const express = require('express');
const db = require('../db/connection');

let _passed = 0, _failed = 0;
function ok(cond, msg) { if (cond) { _passed++; console.log('  ✅', msg); } else { _failed++; console.log('  ❌', msg); } }
function eqn(a, b, msg, tol = 0.01) { ok(Math.abs(Number(a) - Number(b)) <= tol, `${msg} (got ${a}, want ${b})`); }

// minimal app with stub auth + scope
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const u = String(req.headers['x-test-user'] || 'admin');
    req.user = { id: 1, username: u, role: 'admin' };
    req.guardWh = () => true;
    req.whScopeClause = () => ({ sql: '', params: [] });
    next();
  });
  app.use('/api/procurement', require('../routes/procurement'));
  return app;
}

async function main() {
  const app = buildApp();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  async function call(method, path, body, user, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: Object.assign({ 'content-type': 'application/json', 'x-test-user': user || 'admin' }, headers),
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  }

  // ── seed master data (idempotent, unique ids) ──
  const SUP = 'TEST-P2P-SUP', ITEM = 'TEST-P2P-ITEM', WH = 'TEST-P2P-WH';
  const RUN = Date.now();
  // clean prior + this run's transactional data so the DB never accumulates
  // test residue (GL journals/entries and inventory movements are keyed off
  // rows this same cleanup deletes, so they must go first, via JOIN, before
  // the parent rows disappear out from under them).
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
    await db.query('DELETE FROM purchase_returns WHERE supplier_id=?', [SUP]).catch(() => {});
    await db.query('DELETE FROM inventory_movements WHERE item_id=? OR warehouse_id=?', [ITEM, WH]).catch(() => {});
    await db.query('DELETE FROM inventory_cost_history WHERE item_id=?', [ITEM]).catch(() => {});
    await db.query('DELETE FROM warehouse_stock WHERE item_id = ?', [ITEM]).catch(() => {});
    await db.query('DELETE FROM purchase_lots WHERE inv_item_id = ?', [ITEM]).catch(() => {});
    // Receipt posting bumps inv_items.stock alongside warehouse_stock — wiping
    // the warehouse row without resetting this leaves the item's own stock
    // counter permanently out of sync with Σwarehouse_stock (caught by
    // scripts/procurement/reconcile.js's stock_rollup check).
    await db.query('UPDATE inv_items SET stock=0, cost=0 WHERE id=?', [ITEM]).catch(() => {});
  }
  await cleanup();
  await db.query('INSERT INTO warehouses (id, code, name, is_active) VALUES (?,?,?,1) ON DUPLICATE KEY UPDATE name=VALUES(name)', [WH, 'TWH', 'مستودع اختبار']);
  await db.query('INSERT INTO inv_items (id, name, kind, unit, big_unit, conv_rate, cost, stock, tracking_mode) VALUES (?,?,?,?,?,?,?,?,\'none\') ON DUPLICATE KEY UPDATE name=VALUES(name), stock=0, cost=0', [ITEM, 'مادة اختبار', 'raw', 'حبة', 'كرتون', 12, 0, 0]);
  await db.query('INSERT INTO suppliers (id, name, is_active, payment_terms) VALUES (?,?,1,\'Net30\') ON DUPLICATE KEY UPDATE is_active=1', [SUP, 'مورد اختبار']);

  try {
  console.log('\n── PO create / submit / approve (maker-checker) ──');
  const glBefore = (await db.query('SELECT COUNT(*) c FROM gl_journals'))[0][0].c;
  const poRes = await call('POST', '/api/procurement/orders', {
    supplierId: SUP, warehouseId: WH,
    lines: [{ itemId: ITEM, itemName: 'مادة اختبار', enteredQty: 10, factor: 12, enteredUnitCode: 'كرتون', unitPriceEntered: 120, vatRate: 15 }],
  }, 'maker1');
  ok(poRes.status === 201 && poRes.json.success, 'PO created 201');
  const poId = poRes.json.data.id;
  const poNum = poRes.json.documentNumber;
  ok(/^PO-/.test(poNum), 'PO number issued ' + poNum);

  await call('POST', `/api/procurement/orders/${poId}/submit`, {}, 'maker1');
  const selfApprove = await call('POST', `/api/procurement/orders/${poId}/approve`, {}, 'maker1');
  ok(selfApprove.status === 403, 'maker cannot self-approve (403)');
  const approve = await call('POST', `/api/procurement/orders/${poId}/approve`, {}, 'checker1');
  ok(approve.status === 200 && approve.json.status === 'approved', 'checker approved PO');
  const glAfterApprove = (await db.query('SELECT COUNT(*) c FROM gl_journals'))[0][0].c;
  ok(glAfterApprove === glBefore, 'PO approval posted NO GL journal');
  const [poLines] = await db.query('SELECT id, base_qty FROM po_lines WHERE po_id = ?', [poId]);
  eqn(poLines[0].base_qty, 120, 'PO line base_qty = 120 (10 cartons × 12)');

  console.log('\n── Goods receipts (partial 4 + 6 cartons) ──');
  const r1 = await call('POST', '/api/procurement/receipts', {
    poId, supplierId: SUP, warehouseId: WH,
    lines: [{ itemId: ITEM, itemName: 'مادة اختبار', poLineId: poLines[0].id, enteredQty: 4, factor: 12, unitCost: 120 }],
  }, 'recv1');
  ok(r1.status === 201, 'receipt 1 created');
  await call('POST', `/api/procurement/receipts/${r1.json.data.id}/approve`, {}, 'recv1');
  const post1 = await call('POST', `/api/procurement/receipts/${r1.json.data.id}/post`, {}, 'recv1');
  ok(post1.status === 200 && post1.json.status === 'posted', 'receipt 1 posted');
  ok(post1.json.journalIds.length === 1, 'receipt 1 posted a GRNI journal');

  const r2 = await call('POST', '/api/procurement/receipts', {
    poId, supplierId: SUP, warehouseId: WH,
    lines: [{ itemId: ITEM, itemName: 'مادة اختبار', poLineId: poLines[0].id, enteredQty: 6, factor: 12, unitCost: 120 }],
  }, 'recv1');
  await call('POST', `/api/procurement/receipts/${r2.json.data.id}/approve`, {}, 'recv1');
  await call('POST', `/api/procurement/receipts/${r2.json.data.id}/post`, {}, 'recv1');

  const [ws] = await db.query('SELECT qty FROM warehouse_stock WHERE warehouse_id = ? AND item_id = ?', [WH, ITEM]);
  eqn(ws[0].qty, 120, 'warehouse stock = 120 after 4+6 cartons');
  const [poNow] = await db.query('SELECT status FROM purchase_orders WHERE id = ?', [poId]);
  ok(poNow[0].status === 'fully_received', 'PO rolled up to fully_received');

  console.log('\n── over-receipt guard ──');
  const r3 = await call('POST', '/api/procurement/receipts', {
    poId, supplierId: SUP, warehouseId: WH,
    lines: [{ itemId: ITEM, itemName: 'مادة اختبار', poLineId: poLines[0].id, enteredQty: 1, factor: 12, unitCost: 120 }],
  }, 'recv1');
  await call('POST', `/api/procurement/receipts/${r3.json.data.id}/approve`, {}, 'recv1');
  const overPost = await call('POST', `/api/procurement/receipts/${r3.json.data.id}/post`, {}, 'recv1');
  ok(overPost.status === 422 && overPost.json.code === 'OVER_RECEIPT', 'over-receipt blocked (422 OVER_RECEIPT)');

  console.log('\n── GRNI journal balance ──');
  const [grnJournals] = await db.query("SELECT total_debit, total_credit FROM gl_journals WHERE reference_type='GoodsReceipt' AND reference_id IN (?, ?)", [r1.json.data.id, r2.json.data.id]);
  ok(grnJournals.length === 2, 'two GRNI journals exist');
  for (const j of grnJournals) eqn(j.total_debit, j.total_credit, 'GRNI journal balanced');

  console.log('\n── supplier invoice + 3-way match + approve ──');
  const [grLines] = await db.query('SELECT prl.id, prl.receipt_id FROM purchase_receipt_lines prl WHERE prl.receipt_id IN (?, ?)', [r1.json.data.id, r2.json.data.id]);
  const invRes = await call('POST', '/api/procurement/invoices', {
    supplierId: SUP, invoiceNo: 'INV-TEST-' + RUN, invoiceKind: 'stock', warehouseId: WH, dueDate: '2020-01-01',
    lines: [
      { itemId: ITEM, description: 'مادة', enteredQty: 48, factor: 1, unitPriceEntered: 10, vatRate: 15, grnLineId: grLines[0].id },
      { itemId: ITEM, description: 'مادة', enteredQty: 72, factor: 1, unitPriceEntered: 10, vatRate: 15, grnLineId: grLines[1].id },
    ],
  }, 'ap1');
  ok(invRes.status === 201, 'invoice created');
  const invId = invRes.json.data.id;
  const match = await call('POST', `/api/procurement/invoices/${invId}/match`, {}, 'ap1');
  ok(match.status === 200 && match.json.data.status === 'matched', 'invoice matched (no variance)');
  await call('POST', `/api/procurement/invoices/${invId}/submit`, {}, 'ap1');
  const invApprove = await call('POST', `/api/procurement/invoices/${invId}/approve`, {}, 'ap2');
  ok(invApprove.status === 200 && invApprove.json.status === 'approved', 'invoice approved');
  ok(invApprove.json.journalIds.length === 1, 'invoice posted AP journal');
  const [apJ] = await db.query('SELECT * FROM gl_entries WHERE journal_id = ?', [invApprove.json.journalIds[0]]);
  const apCredit = apJ.filter((e) => e.account_code === '2100').reduce((s, e) => s + Number(e.credit), 0);
  eqn(apCredit, 1380, 'AP credited 1380 (1200 net + 180 VAT)');
  const grniDebit = apJ.filter((e) => e.account_code === '2150').reduce((s, e) => s + Number(e.debit), 0);
  eqn(grniDebit, 1200, 'GRNI debited 1200 (cleared)');
  const vatDebit = apJ.filter((e) => e.account_code === '1290').reduce((s, e) => s + Number(e.debit), 0);
  eqn(vatDebit, 180, 'Input VAT debited 180');

  console.log('\n── payment + allocation + settlement ──');
  const payRes = await call('POST', '/api/procurement/payments', {
    supplierId: SUP, amount: 1380, paymentMethod: 'bank',
    allocations: [{ invoiceId: invId, amount: 1380 }],
  }, 'fin1');
  ok(payRes.status === 201, 'payment created');
  const payId = payRes.json.data.id;
  await call('POST', `/api/procurement/payments/${payId}/authorize`, {}, 'fin1');
  const pay = await call('POST', `/api/procurement/payments/${payId}/pay`, {}, 'fin2');
  ok(pay.status === 200 && pay.json.status === 'paid', 'payment paid');
  const [invFinal] = await db.query('SELECT balance_amount, status FROM supplier_invoices WHERE id = ?', [invId]);
  eqn(invFinal[0].balance_amount, 0, 'invoice balance = 0');
  ok(invFinal[0].status === 'paid', 'invoice status = paid');
  const [apBal] = await db.query('SELECT ap_balance FROM v_supplier_ap_balance WHERE supplier_id = ?', [SUP]);
  eqn((apBal[0] && apBal[0].ap_balance) || 0, 0, 'supplier AP balance = 0 (derived)');

  console.log('\n── version conflict + idempotency replay ──');
  const vc = await call('POST', `/api/procurement/payments/${payId}/close`, { expectedVersion: 999 }, 'fin1');
  ok(vc.status === 409 && vc.json.code === 'VERSION_CONFLICT', 'stale version → 409 VERSION_CONFLICT');
  const idem = 'idem-close-' + RUN;
  const c1 = await call('POST', `/api/procurement/payments/${payId}/close`, {}, 'fin1', { 'idempotency-key': idem });
  const c2 = await call('POST', `/api/procurement/payments/${payId}/close`, {}, 'fin1', { 'idempotency-key': idem });
  ok(c1.status === 200 && c2.status === 200, 'idempotent close replays safely (both 200)');

  console.log('\n── global GL balance ──');
  const [[bal]] = await db.query('SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c FROM gl_entries');
  eqn(bal.d, bal.c, 'global GL debits == credits');
  const [[unbalanced]] = await db.query('SELECT COUNT(*) c FROM gl_journals WHERE ABS(total_debit - total_credit) > 0.01');
  ok(Number(unbalanced.c) === 0, 'zero unbalanced journals');
  } finally {
    // leave the dev DB exactly as clean as we found it — no orphaned GL
    // journals/entries or inventory movements, regardless of pass/fail.
    await cleanup();
  }

  server.close();
  await db.end();
  console.log(`\nProcurement P2P integration: ${_passed} passed, ${_failed} failed`);
  process.exit(_failed ? 1 : 0);
}

main().catch((e) => { console.error('INTEGRATION ERROR:', e.stack || e.message); process.exit(1); });
