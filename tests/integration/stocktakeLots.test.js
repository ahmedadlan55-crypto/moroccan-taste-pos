/**
 * Phase 4B — Lot-level stocktake (ENFORCE=1).
 *
 * A tracked item is counted PER LOT (Σ per-lot = the line count); an "unknown"
 * lot found during the count is captured via an audited row and created at post.
 * After posting, Σ(lot balances)=warehouse_stock and the per-lot variances net to
 * the item-level variance.
 *
 * Run: node tests/integration/stocktakeLots.test.js  (NOT in `npm test`)
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = Number(process.env.STKL_TEST_PORT || 3274);
const BASE = { host: '127.0.0.1', port: PORT };
const WH = 'WH-4BS';
const T = 'STKL-T';
const U_A = 'stkl_a', U_B = 'stkl_b';
const S = '/api/inventory/v2/stocktakes';

let _p = 0, _f = 0;
function check(name, cond, extra) { if (cond) { _p++; console.log('  ✅', name); } else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); } }
function dplus(days) { return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10); }
function req(method, path, token, body, headers) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = Object.assign({ Accept: 'application/json' }, headers || {});
    if (token) h.Authorization = 'Bearer ' + token;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ ...BASE, method, path, headers: h }, (resp) => { let b = ''; resp.on('data', (c) => (b += c)); resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: resp.statusCode, body: j }); }); });
    r.on('error', (e) => resolve({ status: 0, error: e.code })); r.setTimeout(9000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
async function waitForServer() { for (let i = 0; i < 90; i++) { const r = await req('GET', '/api/version'); if (r.status) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }
function tok(id, u, role) { return jwt.sign({ id, username: u, role }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

async function stockQty() { const [r] = await db.query('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [WH, T]); return r.length ? Number(r[0].qty) : 0; }
async function lotBal(lotId) { const [r] = await db.query('SELECT qty FROM warehouse_lot_balances WHERE warehouse_id=? AND lot_id=?', [WH, lotId]); return r.length ? Number(r[0].qty) : 0; }
async function lotSum() { const [r] = await db.query('SELECT COALESCE(SUM(qty),0) s FROM warehouse_lot_balances WHERE warehouse_id=? AND item_id=?', [WH, T]); return Number(r[0].s); }
async function foundBal() { const [r] = await db.query("SELECT b.qty FROM warehouse_lot_balances b JOIN inventory_lots l ON l.id=b.lot_id WHERE b.warehouse_id=? AND b.item_id=? AND l.lot_norm='FOUND-1'", [WH, T]); return r.length ? Number(r[0].qty) : 0; }

async function cleanup() {
  for (const [s, p] of [
    ['DELETE FROM inv_stocktake_lot_items WHERE item_id=?', [T]],
    ['DELETE i FROM inv_stocktake_items i JOIN inv_stocktakes d ON d.id=i.stocktake_id WHERE d.warehouse_id=?', [WH]],
    ['DELETE e FROM inv_tx_events e JOIN inv_stocktakes d ON d.id=e.doc_id WHERE d.warehouse_id=?', [WH]],
    ['DELETE FROM inv_stocktakes WHERE warehouse_id=?', [WH]],
    ['DELETE i FROM inv_adjustment_items i JOIN inv_adjustments d ON d.id=i.adjustment_id WHERE d.warehouse_id=?', [WH]],
    ['DELETE FROM inv_adjustments WHERE warehouse_id=?', [WH]],
    ['DELETE FROM inventory_lot_movements WHERE warehouse_id=?', [WH]],
    ['DELETE FROM warehouse_lot_balances WHERE warehouse_id=?', [WH]],
    ['DELETE FROM inventory_lots WHERE item_id=?', [T]],
    ['DELETE FROM inventory_movements WHERE warehouse_id=?', [WH]],
    ['DELETE FROM warehouse_stock WHERE warehouse_id=?', [WH]],
    ['DELETE FROM idempotency_keys WHERE username IN (?,?)', [U_A, U_B]],
    ['DELETE uwa FROM user_warehouse_access uwa JOIN users u ON u.id=uwa.user_id WHERE u.username IN (?,?)', [U_A, U_B]],
    ['DELETE FROM inv_items WHERE id=?', [T]],
    ['DELETE FROM warehouses WHERE id=?', [WH]],
    ['DELETE FROM users WHERE username IN (?,?)', [U_A, U_B]],
  ]) { try { await db.query(s, p); } catch (_) {} }
}
async function seed() {
  await cleanup();
  await db.query('INSERT INTO warehouses (id,code,name,type,is_active,is_main) VALUES (?,?,?,?,1,1)', [WH, '4BS', 'مستودع الجرد', 'main']);
  await db.query("INSERT INTO inv_items (id,name,category,unit,cost,min_stock,active) VALUES (?,?,?,?,?,?,1)", [T, 'صنف جرد بدفعات', 'خام', 'كجم', 5, 2]);
  const ids = {};
  for (const [u, role] of [[U_A, 'manager'], [U_B, 'manager']]) {
    await db.query('INSERT INTO users (username,password,role) VALUES (?,?,?)', [u, 'disabled', role]);
    const [r] = await db.query('SELECT id FROM users WHERE username=?', [u]); ids[u] = r[0].id;
    await db.query('INSERT INTO user_warehouse_access (user_id,warehouse_id,created_by) VALUES (?,?,?)', [r[0].id, WH, 'test']);
  }
  return ids;
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n═══ Lot-level stocktake (ENFORCE=1) ═══\n');
  const ids = await seed();
  const ua = tok(ids[U_A], U_A, 'manager');
  const ub = tok(ids[U_B], U_B, 'manager');
  const server = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), WAREHOUSE_SCOPE_ENFORCE: '1', INV_MAKER_CHECKER: '1' }, stdio: ['ignore', 'ignore', 'ignore'] });
  let exitCode = 0;
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }
    await db.query("UPDATE inv_items SET tracking_mode='lot' WHERE id=?", [T]);
    // Seed lot state: A=30, B=50, stock 80.
    await db.query("INSERT INTO inventory_lots (id,item_id,lot_number,lot_norm,expiry_date,lifecycle_status,unit_cost,version) VALUES ('SLA',?,?,?,?, 'active',5,1)", [T, 'SLA', 'SLA', dplus(20)]);
    await db.query("INSERT INTO inventory_lots (id,item_id,lot_number,lot_norm,expiry_date,lifecycle_status,unit_cost,version) VALUES ('SLB',?,?,?,?, 'active',5,1)", [T, 'SLB', 'SLB', dplus(120)]);
    await db.query("INSERT INTO warehouse_lot_balances (id,warehouse_id,lot_id,item_id,qty) VALUES ('BSA',?,?,?,30)", [WH, 'SLA', T]);
    await db.query("INSERT INTO warehouse_lot_balances (id,warehouse_id,lot_id,item_id,qty) VALUES ('BSB',?,?,?,50)", [WH, 'SLB', T]);
    await db.query("INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost) VALUES ('WSS',?,?,80,5)", [WH, T]);

    const c = await req('POST', S, ua, { warehouseId: WH, scopeType: 'items', itemIds: [T], reason: 'جرد بالدفعات' }, { 'Idempotency-Key': 'stkl-c' });
    check('stocktake create → draft', (c.status === 200 || c.status === 201) && c.body && c.body.id, { st: c.status });
    const sid = c.body.id;
    await req('POST', `${S}/${sid}/start`, ua, {});

    // Σ(lot) ≠ countedQty → rejected.
    const bad = await req('PUT', `${S}/${sid}/counts`, ua, { counts: [{ itemId: T, countedQty: 83, lots: [{ lotId: 'SLA', qty: 28 }, { lotId: 'SLB', qty: 50 }] }] });
    check('per-lot Σ (78) ≠ countedQty (83) → 422', bad.status === 422 || (bad.body && bad.body.conflicts && bad.body.conflicts.length) || (bad.body && bad.body.code === 'VALIDATION_ERROR'), { st: bad.status, code: bad.body && bad.body.code });

    // Correct per-lot count: A=28 (lost 2), B=50, found unknown FOUND-1=5 → countedQty 83.
    const put = await req('PUT', `${S}/${sid}/counts`, ua, { counts: [{ itemId: T, countedQty: 83, lots: [{ lotId: 'SLA', qty: 28 }, { lotId: 'SLB', qty: 50 }, { lotNumber: 'FOUND-1', expiryDate: dplus(90), qty: 5 }] }] });
    check('per-lot count accepted (Σ=83)', put.status === 200 && (put.body.conflicts || []).length === 0, put.body && put.body.code);
    const [stli] = await db.query('SELECT COUNT(*) n FROM inv_stocktake_lot_items WHERE stocktake_id=? AND item_id=?', [sid, T]);
    check('3 per-lot count rows stored', Number(stli[0].n) === 3, stli[0]);

    await req('POST', `${S}/${sid}/submit`, ua, {});
    const apSelf = await req('POST', `${S}/${sid}/approve`, ua, {});
    check('maker cannot approve own stocktake (SoD)', apSelf.status === 403, apSelf.status);
    await req('POST', `${S}/${sid}/approve`, ub, {});
    const post = await req('POST', `${S}/${sid}/post`, ua, {}, { 'Idempotency-Key': 'stkl-p' });
    check('stocktake post → 200', post.status === 200, post.body && post.body.code);

    check('lot balances after post: SLA=28, SLB=50, FOUND-1=5', (await lotBal('SLA')) === 28 && (await lotBal('SLB')) === 50 && (await foundBal()) === 5, { A: await lotBal('SLA'), B: await lotBal('SLB'), F: await foundBal() });
    check('warehouse_stock=83 and INVARIANT holds (Σlot=stock)', (await stockQty()) === 83 && Math.abs(await lotSum() - await stockQty()) < 0.001, { stock: await stockQty(), lot: await lotSum() });

  } catch (e) { _f++; exitCode = 1; console.error('  ❌ FATAL', e && e.stack || e); }
  finally { try { server.kill(); } catch (_) {} try { await cleanup(); } catch (_) {} }
  console.log('\n  ' + _p + ' passed, ' + _f + ' failed\n');
  if (_f > 0) exitCode = 1;
  try { await db.end(); } catch (_) {}
  process.exit(exitCode);
})();
