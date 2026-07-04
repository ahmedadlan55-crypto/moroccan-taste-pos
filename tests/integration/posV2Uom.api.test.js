'use strict';
/* Integration — Cashier V2 Units-of-Measure through the REAL checkout loop
   (upsert → submit → POST /api/sales → complete). Proves the cashier can sell by
   the carton: qty flows to stock/money in BASE units, price = factor × base, the
   entered-unit snapshot lands in sales.items_json (so a return echoes it), GL is
   balanced, a tracked item FEFO-allocates the base qty, and a re-POST with the
   same clientOrderId does NOT double-deduct.
   Base = حبة (factor 1), major = كرتون (1 carton = 12). Run:
     node tests/integration/posV2Uom.api.test.js   (MariaDB on 3307) */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');
const L = require('../../lib/lotLedger');

const PORT = 3996;
const BASE = { host: '127.0.0.1', port: PORT };
const API = '/api/pos/v2';
const WH = 'WH-POSU', M_UNT = 'MENU-POSU', M_TRK = 'MENU-POSU-T', U = 'pos_uom_cash', U_MGR = 'pos_uom_mgr';
let pass = 0, fail = 0; const fails = [];
function check(n, c, x) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, x != null ? '→ ' + JSON.stringify(x).slice(0, 240) : ''); } }
const near = (a, b) => Math.abs(Number(a) - Number(b)) <= 0.02;
const ulid = (n) => 'POSU' + String(n) + Math.random().toString(36).slice(2, 10).toUpperCase();
function req(method, p, token, body, headers) {
  return new Promise((res) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = Object.assign({ Accept: 'application/json' }, headers || {});
    if (token) h.Authorization = 'Bearer ' + token;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ ...BASE, method, path: p, headers: h }, (s) => { let b = ''; s.on('data', (c) => (b += c)); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, body: j, headers: s.headers }); }); });
    r.on('error', () => res({ status: 0 })); r.setTimeout(15000, () => { r.destroy(); res({ status: 0 }); });
    if (data) r.write(data); r.end();
  });
}
async function waitUp() { for (let i = 0; i < 120; i++) { const r = await req('GET', '/api/version'); if (r.status) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }
const tok = (id, username = U, role = 'cashier') => jwt.sign({ id, username, role }, process.env.JWT_SECRET, { expiresIn: '1h' });
async function whStock(item) { const [r] = await db.query('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [WH, item]); return r.length ? Number(r[0].qty) : 0; }

async function cleanup() {
  for (const [s, p] of [
    ["DELETE si FROM sales_items si JOIN sales s ON s.id=si.order_id WHERE s.client_order_id LIKE 'POSU%'", []],
    ["DELETE cn FROM credit_notes cn JOIN sales s ON s.id=cn.original_sale_id WHERE s.client_order_id LIKE 'POSU%'", []],
    ["DELETE e FROM gl_entries e JOIN gl_journals j ON j.id=e.journal_id JOIN sales s ON s.id=j.reference_id WHERE s.client_order_id LIKE 'POSU%'", []],
    ["DELETE j FROM gl_journals j JOIN sales s ON s.id=j.reference_id WHERE s.client_order_id LIKE 'POSU%'", []],
    ["DELETE FROM sales WHERE client_order_id LIKE 'POSU%'", []],
    ["DELETE l FROM pos_order_lines l JOIN pos_orders o ON o.id=l.order_id WHERE o.id LIKE 'POSU%'", []],
    ["DELETE p FROM pos_payments p JOIN pos_orders o ON o.id=p.order_id WHERE o.id LIKE 'POSU%'", []],
    ["DELETE FROM pos_orders WHERE id LIKE 'POSU%'", []],
    ["DELETE FROM shifts WHERE username=?", [U]],
    ["DELETE FROM idempotency_keys WHERE username=?", [U]],
    ["DELETE FROM inventory_lot_movements WHERE warehouse_id=?", [WH]],
    ["DELETE FROM warehouse_lot_balances WHERE warehouse_id=?", [WH]],
    ["DELETE FROM inventory_lots WHERE item_id=?", [M_TRK]],
    ["DELETE FROM inventory_movements WHERE warehouse_id=?", [WH]],
    ["DELETE FROM warehouse_stock WHERE warehouse_id=?", [WH]],
    ["DELETE FROM item_units WHERE item_id IN (?,?)", [M_UNT, M_TRK]],
    ["DELETE FROM item_barcodes WHERE item_id IN (?,?)", [M_UNT, M_TRK]],
    ["DELETE FROM menu WHERE id IN (?,?)", [M_UNT, M_TRK]],
    ["DELETE FROM inv_items WHERE id IN (?,?)", [M_UNT, M_TRK]],
    ["DELETE FROM users WHERE username IN (?,?)", [U, U_MGR]],
    ["DELETE FROM warehouses WHERE id=?", [WH]],
  ]) { try { await db.query(s, p); } catch (_) {} }
}
async function seed() {
  await cleanup();
  await db.query("INSERT INTO warehouses (id,code,name,type,is_active,is_main) VALUES (?,?,?,?,1,1)", [WH, 'POSU', 'مستودع كاشير', 'main']);
  // untracked imported item: base حبة, carton ×12, price 5/base
  await db.query("INSERT INTO menu (id,name,price,category,active,tax_category,production_method,stock) VALUES (?,?,?,?,1,'S','imported',120)", [M_UNT, 'شوكولاتة UoM', 5, 'حلويات']);
  await db.query("INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost,first_added_date) VALUES (?,?,?,?,?,NOW())", ['WSU-1', WH, M_UNT, 120, 2]);
  await db.query("INSERT INTO item_units (id,item_id,unit_name,unit_code,is_base,conversion_to_base,allow_sale) VALUES ('IUU-B',?,'حبة','PCS',1,1,1),('IUU-C',?,'كرتون','CTN',0,12,1)", [M_UNT, M_UNT]);
  await db.query("INSERT INTO item_barcodes (id,item_id,code,code_norm,is_primary,created_by) VALUES ('BCU-B',?,'UOMPCS','UOMPCS',1,'seed'),('BCU-C',?,'UOMCTN','UOMCTN',0,'seed')", [M_UNT, M_UNT]);
  await db.query("UPDATE item_units SET barcode_id='BCU-C' WHERE id='IUU-C'");
  // tracked (expiry) imported item for FEFO: base حبة, carton ×12, price 6/base
  await db.query("INSERT INTO menu (id,name,price,category,active,tax_category,production_method,stock) VALUES (?,?,?,?,1,'S','imported',0)", [M_TRK, 'بسكويت متتبع UoM', 6, 'حلويات']);
  await db.query("INSERT INTO inv_items (id,name,sku,category,unit,cost,active,tracking_mode) VALUES (?,?,?,?,?,4,1,'expiry')", [M_TRK, 'بسكويت متتبع UoM', 'POSU-T', 'حلويات', 'حبة']);
  await db.query("INSERT INTO item_units (id,item_id,unit_name,unit_code,is_base,conversion_to_base,allow_sale) VALUES ('IUT-B',?,'حبة','PCS',1,1,1),('IUT-C',?,'كرتون','CTN',0,12,1)", [M_TRK, M_TRK]);
  await db.query("INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost,first_added_date) VALUES (?,?,?,?,?,NOW())", ['WSU-T', WH, M_TRK, 60, 4]);
  // two lots — L1 expires FIRST (FEFO must pick it before L2)
  await L.openingLot(db, { warehouseId: WH, itemId: M_TRK, qty: 30, lotNumber: 'L1-EARLY', expiryDate: '2026-11-01', unitCost: 4, actor: 'seed', occurredAt: new Date() });
  await L.openingLot(db, { warehouseId: WH, itemId: M_TRK, qty: 30, lotNumber: 'L2-LATE', expiryDate: '2027-05-01', unitCost: 4, actor: 'seed', occurredAt: new Date() });
  const ids = {};
  for (const [u, role] of [[U, 'cashier'], [U_MGR, 'manager']]) {
    await db.query('INSERT INTO users (username,password,role) VALUES (?,?,?)', [u, 'disabled', role]);
    const [r] = await db.query('SELECT id FROM users WHERE username=?', [u]);
    ids[u] = r[0].id;
  }
  return ids;
}

// full checkout: upsert (with unit) → submit → POST /api/sales → complete
async function sell(token, shiftId, orderId, menuId, line) {
  const up = await req('POST', API + '/orders', token, { id: orderId, shiftId, warehouseId: WH, lines: [line] });
  if (up.status !== 201 && up.status !== 200) return { stage: 'upsert', res: up };
  const sub = await req('POST', API + `/orders/${orderId}/submit`, token, { payments: [{ method: 'cash', amount: up.body.data.totals.total }], expectedVersion: up.body.data.version }, { 'Idempotency-Key': 'sub-' + orderId });
  if (sub.status !== 200) return { stage: 'submit', res: sub, totals: up.body.data.totals };
  const payload = sub.body.data.legacyPayload;
  const sale = await req('POST', '/api/sales', token, payload);
  if (sale.status !== 200 && sale.status !== 201) return { stage: 'sale', res: sale, payload };
  const saleId = sale.body && (sale.body.id || (sale.body.data && sale.body.data.id) || sale.body.orderId);
  await req('POST', API + `/orders/${orderId}/complete`, token, { saleId });
  return { stage: 'done', saleId, payload, totals: up.body.data.totals, sale };
}

(async () => {
  const ids = await seed();
  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT), POS_MAX_CASHIER_DISCOUNT_PCT: '10' }, stdio: ['ignore', 'ignore', 'ignore'] });
  const t = tok(ids[U]);
  const mgr = tok(ids[U_MGR], U_MGR, 'manager');
  try {
    if (!(await waitUp())) { console.error('no server'); process.exit(2); }
    console.log('\n═══ Cashier V2 — Units-of-Measure checkout ═══');

    // catalog exposes units + barcode + base availability
    const cat = await req('GET', API + '/catalog', t);
    const item = cat.body && cat.body.data.items.find((i) => i.id === M_UNT);
    check('catalog exposes base+carton units for the item', !!item && Array.isArray(item.units) && item.units.length === 2 && item.units.some((u) => u.unitCode === 'CTN' && u.factor === 12), item && item.units);
    check('catalog carton unit carries its barcode', !!item && item.units.find((u) => u.unitCode === 'CTN').barcode === 'UOMCTN', item && item.units);
    check('catalog exposes base availability (warehouseQty) + basePrice', !!item && item.warehouseQty === 120 && item.basePrice === 5, item && { q: item.warehouseQty, p: item.basePrice });

    const sh = await req('POST', '/api/shifts/open', t, { device: { ua: 'posu' } });
    const shiftId = sh.body && (sh.body.shiftId || (sh.body.data && sh.body.data.shiftId));
    check('shift opened', !!shiftId, sh.body);

    // 1) sell 1 CARTON → base 12 deducted, price = 12 × 5 = 60
    const s1 = await sell(t, shiftId, ulid(1), M_UNT, { menuId: M_UNT, qty: 1, unitFactor: 12, enteredUnitCode: 'CTN', enteredUnitId: 'IUU-C' });
    check('carton sale completes', s1.stage === 'done', s1);
    check('total = 60 (12 × 5, price = factor × base)', near(s1.totals && s1.totals.total, 60), s1.totals);
    check('warehouse stock 120 → 108 (−12 base)', near(await whStock(M_UNT), 108), await whStock(M_UNT));
    const [sj] = await db.query('SELECT items_json FROM sales WHERE id=? LIMIT 1', [s1.saleId]);
    let its = null; try { its = JSON.parse(sj[0].items_json); } catch (_) {}
    check('sales.items_json carries base qty 12 + enteredUnitCode CTN (return echoes it)', its && near(its[0].qty, 12) && its[0].enteredUnitCode === 'CTN' && near(its[0].baseQty, 12), its && its[0]);
    const [gl] = await db.query("SELECT ROUND(SUM(debit),2) d, ROUND(SUM(credit),2) c FROM gl_entries e JOIN gl_journals j ON j.id=e.journal_id WHERE j.reference_id=?", [s1.saleId]);
    check('sale GL balanced (debit = credit)', gl.length && gl[0].d != null && String(gl[0].d) === String(gl[0].c), gl[0]);

    // 2) sell 2 CARTONS → base 24 (108 → 84)
    const s2 = await sell(t, shiftId, ulid(2), M_UNT, { menuId: M_UNT, qty: 2, unitFactor: 12, enteredUnitCode: 'CTN', enteredUnitId: 'IUU-C' });
    check('2 cartons total = 120 (24 × 5)', s2.stage === 'done' && near(s2.totals.total, 120), s2.totals);
    check('warehouse stock 108 → 84 (−24 base)', near(await whStock(M_UNT), 84), await whStock(M_UNT));

    // 3) client baseQty mismatch on upsert → UNIT_CONVERSION_CONFLICT
    const conf = await req('POST', API + '/orders', t, { id: ulid(3), shiftId, warehouseId: WH, lines: [{ menuId: M_UNT, qty: 1, unitFactor: 12, baseQty: 99 }] });
    check('client baseQty mismatch → UNIT_CONVERSION_CONFLICT', conf.status === 409 && conf.body.code === 'UNIT_CONVERSION_CONFLICT', conf.body && conf.body.code);

    // 4) TRACKED item — sell 1 carton (12 base) → FEFO consumes the EARLY lot
    const st = await sell(t, shiftId, ulid(4), M_TRK, { menuId: M_TRK, qty: 1, unitFactor: 12, enteredUnitCode: 'CTN', enteredUnitId: 'IUT-C' });
    check('tracked carton sale completes', st.stage === 'done', st);
    const [lm] = await db.query("SELECT il.lot_number, ABS(ilm.signed_qty) q FROM inventory_lot_movements ilm JOIN inventory_lots il ON il.id=ilm.lot_id WHERE ilm.warehouse_id=? AND ilm.item_id=? AND ilm.reference_type='sale' ORDER BY ilm.id", [WH, M_TRK]);
    check('FEFO consumed 12 base from the EARLY lot (L1)', lm.length && lm[0].lot_number === 'L1-EARLY' && near(lm[0].q, 12), lm);
    check('tracked warehouse stock 60 → 48 (−12 base)', near(await whStock(M_TRK), 48), await whStock(M_TRK));

    // 5) RETURN the first carton sale → base 12 restored, credit note echoes the unit
    const ret = await req('POST', `/api/sales/${s1.saleId}/return`, mgr, { reason: 'إرجاع كرتون', reasonCode: 'return' });
    check('return accepted', ret.status === 200 || ret.status === 201, { st: ret.status, b: ret.body && ret.body.error });
    const [cn] = await db.query('SELECT items_json, total_final FROM credit_notes WHERE original_sale_id=? LIMIT 1', [s1.saleId]);
    let cit = null; try { cit = cn.length ? JSON.parse(cn[0].items_json) : null; } catch (_) {}
    // the credit note reverses the SAME unit (carton) and the SAME base qty (12) —
    // the "return returns the same unit + baseQty" requirement, financially = 12 × 5.
    check('credit note echoes the carton unit + base qty 12', cit && cit[0].enteredUnitCode === 'CTN' && near(cit[0].qty, 12) && near(cit[0].baseQty, 12), cit && cit[0]);
    check('credit note reverses the base value (60 = 12 × 5)', cn.length && near(cn[0].total_final, 60), cn[0] && cn[0].total_final);

    // 6) idempotent re-POST of /api/sales with the same clientOrderId → NO double deduct
    const before = await whStock(M_UNT);
    const replay = await req('POST', '/api/sales', t, s2.payload);
    check('re-POST same clientOrderId → replay (no error)', replay.status === 200 || replay.status === 201 || replay.status === 409, replay.status);
    check('stock unchanged after replay (no double deduction)', near(await whStock(M_UNT), before), { before, after: await whStock(M_UNT) });
  } catch (e) { fail++; fails.push('FATAL ' + e.message); console.error(e); } finally {
    try { server.kill(); } catch (_) {}
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  console.log(`\n${fail === 0 ? '✅' : '❌'} posV2Uom: ${pass} passed, ${fail} failed`);
  if (fails.length) console.log(fails.map((f) => ' - ' + f).join('\n'));
  process.exit(fail === 0 ? 0 : 1);
})();
