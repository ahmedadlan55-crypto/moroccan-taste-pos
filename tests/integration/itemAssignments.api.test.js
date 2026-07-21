/**
 * Sprint 3 D3 — item↔warehouse ASSIGNMENTS (membership, independent of stock).
 *   GET/PUT /api/inventory/v2/items/:id/assignments  (WAREHOUSE_SCOPE_ENFORCE=1)
 *
 * Covers:
 *   • GET empty → []; PUT a set → replace/upsert; GET reflects it (+ mainWarehouseId).
 *   • is_main ≤ 1 per item (two mains → 422).
 *   • cross-branch / out-of-scope warehouse → 403 (guardWh; branchId is never
 *     trusted from the client).
 *   • non-existent warehouse → 422; inactive warehouse → 422.
 *   • RBAC: a non-BACKOFFICE role (sales) → 403 on PUT.
 *   • saving assignments NEVER touches warehouse_stock balances (qty/avg_cost);
 *     nor does the item master PATCH.
 *
 * ISOLATED DB: pinned to moroccan_taste_pos_test BEFORE db/connection loads; a
 * full server.js is spawned (test DB, ENFORCE=1) so the real scope middleware
 * runs. Run: npm run test:item-assignments   (MySQL must be up)
 */
'use strict';

// ── ISOLATED TEST DB — must be set before db/connection.js is required ────────
process.env.DB_NAME = process.env.TEST_DB_NAME || 'moroccan_taste_pos_test';
process.env.MYSQL_DATABASE = process.env.DB_NAME;
process.env.MYSQLDATABASE = process.env.DB_NAME;
delete process.env.DATABASE_URL;
delete process.env.MYSQL_URL;
try { require('dotenv').config(); } catch (_) {}
process.env.DB_NAME = process.env.TEST_DB_NAME || 'moroccan_taste_pos_test';
process.env.MYSQL_DATABASE = process.env.DB_NAME;
process.env.MYSQLDATABASE = process.env.DB_NAME;

const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = Number(process.env.IA_TEST_PORT || 3273);
const BASE = { host: '127.0.0.1', port: PORT };
const IT = '/api/inventory/v2/items';
const ITEM = 'ITEM-D3A1';
const WH_A = 'WH-D3A', WH_A2 = 'WH-D3A2', WH_B = 'WH-D3B', WH_INACT = 'WH-D3INACT';
const U_MGR = 'd3a_mgr', U_SALES = 'd3a_sales';

let _p = 0, _f = 0;
function check(name, cond, extra) { if (cond) { _p++; console.log('  ✅', name); } else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 300) : ''); } }

function req(method, path, token, body) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ ...BASE, method, path, headers: h }, (resp) => {
      let b = ''; resp.on('data', (c) => (b += c));
      resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: resp.statusCode, body: j }); });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.code }));
    r.setTimeout(12000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
async function waitForServer() { for (let i = 0; i < 120; i++) { const r = await req('GET', '/api/version'); if (r.status) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }
async function waitForSchema() {
  for (let i = 0; i < 120; i++) {
    try {
      const [c] = await db.query("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='item_warehouse_assignments'");
      if (Number(c[0].n) > 0) return true;
    } catch (_) {}
    await new Promise((z) => setTimeout(z, 500));
  }
  return false;
}
function tok(id, u, role, dev) { return jwt.sign({ id, username: u, role, isDeveloper: !!dev, tokenVersion: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' }); }
async function stockRow() { const [r] = await db.query('SELECT qty, avg_cost FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [WH_A, ITEM]); return r[0] || null; }

async function cleanup() {
  for (const [s, p] of [
    ['DELETE FROM item_warehouse_assignments WHERE item_id=?', [ITEM]],
    ["DELETE FROM inv_tx_events WHERE doc_type='item' AND doc_id=?", [ITEM]],
    ['DELETE FROM warehouse_stock WHERE item_id=?', [ITEM]],
    ['DELETE FROM inv_items WHERE id=?', [ITEM]],
    ['DELETE uwa FROM user_warehouse_access uwa JOIN users u ON u.id=uwa.user_id WHERE u.username IN (?,?)', [U_MGR, U_SALES]],
    ['DELETE FROM users WHERE username IN (?,?)', [U_MGR, U_SALES]],
    ['DELETE FROM warehouses WHERE id IN (?,?,?,?)', [WH_A, WH_A2, WH_B, WH_INACT]],
  ]) { try { await db.query(s, p); } catch (_) {} }
}
async function seed() {
  await cleanup();
  await db.query('INSERT INTO warehouses (id,code,name,type,branch_id,is_active) VALUES (?,?,?,?,?,1)', [WH_A, 'D3A', 'مستودع أ', 'branch', 'BR-A']);
  await db.query('INSERT INTO warehouses (id,code,name,type,branch_id,is_active) VALUES (?,?,?,?,?,1)', [WH_A2, 'D3A2', 'مستودع أ2', 'branch', 'BR-A']);
  await db.query('INSERT INTO warehouses (id,code,name,type,branch_id,is_active) VALUES (?,?,?,?,?,1)', [WH_B, 'D3B', 'مستودع ب', 'branch', 'BR-B']);
  await db.query('INSERT INTO warehouses (id,code,name,type,branch_id,is_active) VALUES (?,?,?,?,?,0)', [WH_INACT, 'D3IN', 'مستودع معطّل', 'branch', 'BR-A']);
  await db.query("INSERT INTO inv_items (id, name, sku, sku_norm, unit, cost, stock, min_stock, active, kind, version) VALUES (?,?,?,?,?,?,0,0,1,'raw',1)",
    [ITEM, 'D3A صنف', 'ITEM-D3A1', 'ITEM-D3A1', 'حبة', 5]);
  await db.query('INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty, avg_cost) VALUES (?,?,?,?,?)', ['WS-D3A', WH_A, ITEM, 10, 5]);
  const ids = {};
  for (const [u, role] of [[U_MGR, 'manager'], [U_SALES, 'sales']]) {
    await db.query('INSERT INTO users (username,password,role) VALUES (?,?,?)', [u, 'disabled', role]);
    const [r] = await db.query('SELECT id FROM users WHERE username=?', [u]); ids[u] = r[0].id;
  }
  // Both users scoped to WH-A (+ mgr also WH-A2). NOBODY scoped to WH-B.
  for (const w of [WH_A, WH_A2]) await db.query('INSERT INTO user_warehouse_access (user_id,warehouse_id,created_by) VALUES (?,?,?)', [ids[U_MGR], w, 'test']);
  await db.query('INSERT INTO user_warehouse_access (user_id,warehouse_id,created_by) VALUES (?,?,?)', [ids[U_SALES], WH_A, 'test']);
  return ids;
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  const [[{ db: liveDb }]] = await db.query('SELECT DATABASE() AS db');
  if (liveDb !== 'moroccan_taste_pos_test') {
    console.error('REFUSING TO RUN — connected DB is "' + liveDb + '", expected moroccan_taste_pos_test');
    process.exit(2);
  }
  console.log('\n═══ D3 — item↔warehouse assignments (ENFORCE=1, DB: ' + liveDb + ') ═══\n');

  let exitCode = 0;
  const server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), WAREHOUSE_SCOPE_ENFORCE: '1', DB_NAME: 'moroccan_taste_pos_test', MYSQL_DATABASE: 'moroccan_taste_pos_test', DATABASE_URL: '', MYSQL_URL: '' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }
    if (!(await waitForSchema())) { console.error('item_warehouse_assignments migration did not appear'); process.exit(2); }

    const ids = await seed();
    const admin = tok(0, 'd3a_admin', 'admin', true);
    const mgr = tok(ids[U_MGR], U_MGR, 'manager');
    const sales = tok(ids[U_SALES], U_SALES, 'sales');
    const stockBefore = await stockRow();

    // ── GET empty ─────────────────────────────────────────────────────────────
    const g0 = await req('GET', `${IT}/${ITEM}/assignments`, mgr);
    check('GET assignments (empty) → 200 data=[] mainWarehouseId=null', g0.status === 200 && Array.isArray(g0.body.data) && g0.body.data.length === 0 && g0.body.mainWarehouseId === null, g0.body);

    // ── PUT a valid set (WH-A main + WH-A2) ───────────────────────────────────
    const p1 = await req('PUT', `${IT}/${ITEM}/assignments`, mgr, { assignments: [{ warehouseId: WH_A, isMain: true }, { warehouseId: WH_A2 }] });
    check('PUT valid set → 200 saved, mainWarehouseId=WH-A', p1.status === 200 && p1.body && p1.body.status === 'saved' && p1.body.mainWarehouseId === WH_A && p1.body.data.assignments.length === 2, p1.body);
    const g1 = await req('GET', `${IT}/${ITEM}/assignments`, mgr);
    const gm = (g1.body.data || []).find((a) => a.warehouseId === WH_A);
    check('GET reflects the set: WH-A present, isMain=true, branchId derived', gm && gm.isMain === true && gm.branchId === 'BR-A', gm);

    // ── two mains → 422 ───────────────────────────────────────────────────────
    const twoMain = await req('PUT', `${IT}/${ITEM}/assignments`, mgr, { assignments: [{ warehouseId: WH_A, isMain: true }, { warehouseId: WH_A2, isMain: true }] });
    check('two is_main flags → 422 VALIDATION_ERROR', twoMain.status === 422 && twoMain.body && twoMain.body.code === 'VALIDATION_ERROR', { st: twoMain.status, code: twoMain.body && twoMain.body.code });

    // ── cross-branch / out-of-scope warehouse → 403 ───────────────────────────
    const cross = await req('PUT', `${IT}/${ITEM}/assignments`, mgr, { assignments: [{ warehouseId: WH_A }, { warehouseId: WH_B }] });
    check('assigning a cross-branch / out-of-scope warehouse → 403', cross.status === 403, { st: cross.status, body: cross.body });
    // the rejected write must not have changed the persisted set (still 2 rows, no WH-B)
    const gAfterCross = await req('GET', `${IT}/${ITEM}/assignments`, mgr);
    const hasB = (gAfterCross.body.data || []).some((a) => a.warehouseId === WH_B);
    check('the 403 did not persist WH-B', !hasB && (gAfterCross.body.data || []).length === 2, gAfterCross.body && gAfterCross.body.data);

    // ── non-existent + inactive warehouse (admin: global scope, reaches the check) ─
    const ghost = await req('PUT', `${IT}/${ITEM}/assignments`, admin, { assignments: [{ warehouseId: 'WH-GHOST-D3' }] });
    check('non-existent warehouse → 422 VALIDATION_ERROR', ghost.status === 422 && ghost.body && ghost.body.code === 'VALIDATION_ERROR', { st: ghost.status, code: ghost.body && ghost.body.code });
    const inact = await req('PUT', `${IT}/${ITEM}/assignments`, admin, { assignments: [{ warehouseId: WH_INACT }] });
    check('inactive warehouse → 422 VALIDATION_ERROR', inact.status === 422 && inact.body && inact.body.code === 'VALIDATION_ERROR', { st: inact.status, code: inact.body && inact.body.code });

    // ── RBAC: sales (not BACKOFFICE) → 403 ────────────────────────────────────
    const salesPut = await req('PUT', `${IT}/${ITEM}/assignments`, sales, { assignments: [{ warehouseId: WH_A }] });
    check('sales role PUT assignments → 403 (RBAC: BACKOFFICE only)', salesPut.status === 403, salesPut.status);

    // ── replace semantics: empty set removes all ──────────────────────────────
    const clear = await req('PUT', `${IT}/${ITEM}/assignments`, mgr, { assignments: [] });
    check('PUT empty set → 200 (replace to none)', clear.status === 200 && clear.body.data.assignments.length === 0, clear.body);
    const gClear = await req('GET', `${IT}/${ITEM}/assignments`, mgr);
    check('GET after clear → []', (gClear.body.data || []).length === 0, gClear.body);

    // ── warehouse_stock balances untouched throughout ─────────────────────────
    const stockAfter = await stockRow();
    check('warehouse_stock qty + avg_cost unchanged by all assignment writes', stockBefore && stockAfter && Number(stockAfter.qty) === Number(stockBefore.qty) && Number(stockAfter.avg_cost) === Number(stockBefore.avg_cost), { before: stockBefore, after: stockAfter });

    // ── item master PATCH also never touches warehouse_stock ──────────────────
    const [vr] = await db.query('SELECT version FROM inv_items WHERE id=?', [ITEM]);
    const patch = await req('PATCH', `${IT}/${ITEM}`, mgr, { cost: 9, expectedVersion: Number(vr[0].version) });
    check('item master PATCH (cost) → 200', patch.status === 200, patch.body);
    const stockAfterPatch = await stockRow();
    check('item master edit did NOT change warehouse_stock', stockAfterPatch && Number(stockAfterPatch.qty) === Number(stockBefore.qty) && Number(stockAfterPatch.avg_cost) === Number(stockBefore.avg_cost), { before: stockBefore, after: stockAfterPatch });
  } catch (e) {
    _f++; exitCode = 1; console.error('  ❌ FATAL', (e && e.stack) || e);
  } finally {
    try { server.kill(); } catch (_) {}
    try { await cleanup(); } catch (_) {}
  }
  console.log('\n  ' + _p + ' passed, ' + _f + ' failed\n');
  if (_f > 0) exitCode = 1;
  try { await db.end(); } catch (_) {}
  process.exit(exitCode);
})();
