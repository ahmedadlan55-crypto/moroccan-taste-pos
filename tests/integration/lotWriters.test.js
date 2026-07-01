/**
 * Phase 4B — Legacy/raw stock writers + lots (ENFORCE off; lib + HTTP).
 *
 * Proves the autocommit writers honor the lot ledger:
 *   • deductWarehouseStock (the shared chokepoint used by SALES, WASTE and the
 *     legacy adjust) is now LOT-AWARE + SELF-ATOMIC: a tracked deduction FEFO-
 *     allocates lots and keeps Σ(lot)=stock; an untracked one is unchanged.
 *   • the legacy PO receive BLOCKS tracked items (WRITER_NOT_LOT_AWARE) and
 *     inactive items — they must go through the warehouse-v2 receipt.
 *
 * Run: node tests/integration/lotWriters.test.js  (NOT in `npm test`)
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');
const { deductWarehouseStock } = require('../../lib/stockRecompute');

const PORT = Number(process.env.LOTW_TEST_PORT || 3273);
const BASE = { host: '127.0.0.1', port: PORT };
const W = 'WH-4BW';
const T = 'LOTW-TRACK', UN = 'LOTW-UNTRACK', IN = 'LOTW-INACT';
const ADMIN = 'lotw_admin';

let _p = 0, _f = 0;
function check(name, cond, extra) { if (cond) { _p++; console.log('  ✅', name); } else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); } }
function dplus(days) { return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10); }
function req(method, path, token, body) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json' }; if (token) h.Authorization = 'Bearer ' + token;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ ...BASE, method, path, headers: h }, (resp) => { let b = ''; resp.on('data', (c) => (b += c)); resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: resp.statusCode, body: j }); }); });
    r.on('error', (e) => resolve({ status: 0, error: e.code })); r.setTimeout(9000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
async function waitForServer() { for (let i = 0; i < 90; i++) { const r = await req('GET', '/api/version'); if (r.status) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }
function tok(id, u, role, dev) { return jwt.sign({ id, username: u, role, isDeveloper: !!dev }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

async function stockQty(item) { const [r] = await db.query('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [W, item]); return r.length ? Number(r[0].qty) : 0; }
async function lotBal(item, lotId) { const [r] = await db.query('SELECT qty FROM warehouse_lot_balances WHERE warehouse_id=? AND lot_id=?', [W, lotId]); return r.length ? Number(r[0].qty) : 0; }
async function lotSum(item) { const [r] = await db.query('SELECT COALESCE(SUM(qty),0) s FROM warehouse_lot_balances WHERE warehouse_id=? AND item_id=?', [W, item]); return Number(r[0].s); }
async function invOk(item) { return Math.abs(await lotSum(item) - await stockQty(item)) < 0.001; }

async function cleanup() {
  for (const [s, p] of [
    ['DELETE FROM inventory_lot_movements WHERE warehouse_id=?', [W]],
    ['DELETE FROM warehouse_lot_balances WHERE warehouse_id=?', [W]],
    ['DELETE FROM inventory_lots WHERE item_id IN (?,?,?)', [T, UN, IN]],
    ['DELETE FROM inventory_movements WHERE warehouse_id=?', [W]],
    ['DELETE FROM warehouse_stock WHERE warehouse_id=?', [W]],
    ['DELETE FROM purchases WHERE id LIKE ?', ['PUR-LOTW%']],
    ['DELETE FROM inv_items WHERE id IN (?,?,?)', [T, UN, IN]],
    ['DELETE FROM warehouses WHERE id=?', [W]],
    ['DELETE FROM users WHERE username=?', [ADMIN]],
  ]) { try { await db.query(s, p); } catch (_) {} }
}
async function seed() {
  await cleanup();
  await db.query('INSERT INTO warehouses (id,code,name,type,is_active,is_main) VALUES (?,?,?,?,1,1)', [W, '4BW', 'مستودع الكتّاب', 'main']);
  await db.query("INSERT INTO inv_items (id,name,category,unit,cost,active) VALUES (?,?,?,?,?,1)", [T, 'مُتتبع', 'خام', 'كجم', 5]);
  await db.query("INSERT INTO inv_items (id,name,category,unit,cost,active) VALUES (?,?,?,?,?,1)", [UN, 'بلا تتبع', 'خام', 'كجم', 5]);
  await db.query("INSERT INTO inv_items (id,name,category,unit,cost,active) VALUES (?,?,?,?,?,0)", [IN, 'معطّل', 'خام', 'كجم', 5]);
}
async function seedTrackedLots() {
  await db.query("INSERT INTO inventory_lots (id,item_id,lot_number,lot_norm,expiry_date,lifecycle_status,unit_cost,version) VALUES ('LW-A',?,?,?,?, 'active',5,1)", [T, 'LW-A', 'LW-A', dplus(20)]);
  await db.query("INSERT INTO inventory_lots (id,item_id,lot_number,lot_norm,expiry_date,lifecycle_status,unit_cost,version) VALUES ('LW-B',?,?,?,?, 'active',5,1)", [T, 'LW-B', 'LW-B', dplus(120)]);
  await db.query("INSERT INTO warehouse_lot_balances (id,warehouse_id,lot_id,item_id,qty) VALUES ('BW-A',?,?,?,30)", [W, 'LW-A', T]);
  await db.query("INSERT INTO warehouse_lot_balances (id,warehouse_id,lot_id,item_id,qty) VALUES ('BW-B',?,?,?,50)", [W, 'LW-B', T]);
  await db.query("INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost) VALUES ('WSW-T',?,?,80,5)", [W, T]);
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n═══ Legacy/raw writers + lots ═══\n');
  await seed();
  const admin = tok(0, ADMIN, 'admin', true);
  const server = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'ignore'] });
  let exitCode = 0;
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }
    await db.query("UPDATE inv_items SET tracking_mode='expiry' WHERE id=?", [T]);
    await seedTrackedLots();

    // 1) deductWarehouseStock (SALES/WASTE/legacy-adjust) is lot-aware (FEFO).
    await deductWarehouseStock(db, W, T, 40, { referenceType: 'sale', referenceId: 'INV-TEST-1', reason: 'بيع' });
    check('deductWarehouseStock FEFO: LW-A 30→0, LW-B 50→40', (await lotBal(T, 'LW-A')) === 0 && (await lotBal(T, 'LW-B')) === 40, { A: await lotBal(T, 'LW-A'), B: await lotBal(T, 'LW-B') });
    check('tracked deduction kept the invariant (Σlot=stock=40)', (await stockQty(T)) === 40 && (await invOk(T)), { stock: await stockQty(T), lot: await lotSum(T) });

    // 2) untracked deduction is unchanged (no lot rows).
    await db.query("INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost) VALUES ('WSW-U',?,?,20,5)", [W, UN]);
    await deductWarehouseStock(db, W, UN, 5);
    check('untracked deduction works, no lot rows', (await stockQty(UN)) === 15 && (await lotSum(UN)) === 0, { stock: await stockQty(UN), lot: await lotSum(UN) });

    // 3) legacy PO receive BLOCKS a tracked item (WRITER_NOT_LOT_AWARE).
    await db.query("INSERT INTO purchases (id, purchase_date, supplier_name, status, items_json) VALUES (?, NOW(), 'مورد', 'draft', ?)", ['PUR-LOTW-T', JSON.stringify([{ id: T, name: 'مُتتبع', qty: 5, unitPrice: 5, unit: 'كجم' }])]);
    const recT = await req('POST', '/api/purchases/receive/PUR-LOTW-T', admin, { warehouseId: W });
    check('legacy PO receive of a tracked item → 422 WRITER_NOT_LOT_AWARE', recT.status === 422 && (recT.body && recT.body.code === 'WRITER_NOT_LOT_AWARE'), { st: recT.status, code: recT.body && recT.body.code });
    check('blocked PO receive did NOT add stock for the tracked item', (await stockQty(T)) === 40, await stockQty(T));

    // 4) legacy PO receive BLOCKS an inactive item.
    await db.query("INSERT INTO purchases (id, purchase_date, supplier_name, status, items_json) VALUES (?, NOW(), 'مورد', 'draft', ?)", ['PUR-LOTW-IN', JSON.stringify([{ id: IN, name: 'معطّل', qty: 5, unitPrice: 5, unit: 'كجم' }])]);
    const recI = await req('POST', '/api/purchases/receive/PUR-LOTW-IN', admin, { warehouseId: W });
    check('legacy PO receive of an inactive item → 422', recI.status === 422, { st: recI.status, code: recI.body && recI.body.code });

    // 5) untracked PO receive still works (regression).
    await db.query("INSERT INTO purchases (id, purchase_date, supplier_name, status, items_json) VALUES (?, NOW(), 'مورد', 'draft', ?)", ['PUR-LOTW-U', JSON.stringify([{ id: UN, name: 'بلا تتبع', qty: 10, unitPrice: 5, unit: 'كجم' }])]);
    const recU = await req('POST', '/api/purchases/receive/PUR-LOTW-U', admin, { warehouseId: W });
    check('untracked PO receive → success, stock 15→25', (recU.status === 200 || recU.status === 201) && (await stockQty(UN)) === 25, { st: recU.status, stock: await stockQty(UN) });

    // 6) Phase 5A (RC) — legacy /stock-update BLOCKS tracked items (no lot capture).
    const su = await req('POST', '/api/inventory/stock-update', admin, { itemId: T, itemName: 'مُتتبع', type: 'in', qty: 7, reason: 'اختبار', warehouseId: W });
    check('legacy stock-update on a tracked item → 422 WRITER_NOT_LOT_AWARE', su.status === 422 && su.body && su.body.code === 'WRITER_NOT_LOT_AWARE', { st: su.status, code: su.body && su.body.code });
    check('blocked stock-update did NOT change stock or movements', (await stockQty(T)) === 40 && (await invOk(T)), { stock: await stockQty(T) });
    const suU = await req('POST', '/api/inventory/stock-update', admin, { itemId: UN, itemName: 'بلا تتبع', type: 'in', qty: 5, reason: 'اختبار', warehouseId: W });
    check('legacy stock-update on an untracked item still works (25→30)', suU.status === 200 && (await stockQty(UN)) === 30, { st: suU.status, stock: await stockQty(UN) });

    // 7) Phase 5A (RC) — legacy /stocktakes BLOCKS tracked items (per-lot counting is v2-only).
    const stkT = await req('POST', '/api/inventory/stocktakes', admin, { warehouseId: W, items: [{ id: T, name: 'مُتتبع', countedQty: 99 }] });
    check('legacy stocktake incl. a tracked item → 422 WRITER_NOT_LOT_AWARE', stkT.status === 422 && stkT.body && stkT.body.code === 'WRITER_NOT_LOT_AWARE', { st: stkT.status, code: stkT.body && stkT.body.code });
    check('blocked legacy stocktake did NOT set tracked stock', (await stockQty(T)) === 40 && (await invOk(T)), { stock: await stockQty(T) });

  } catch (e) { _f++; exitCode = 1; console.error('  ❌ FATAL', e && e.stack || e); }
  finally { try { server.kill(); } catch (_) {} try { await cleanup(); } catch (_) {} }
  console.log('\n  ' + _p + ' passed, ' + _f + ' failed\n');
  if (_f > 0) exitCode = 1;
  try { await db.end(); } catch (_) {}
  process.exit(exitCode);
})();
