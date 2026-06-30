/**
 * Phase 2A.2 — Warehouse Scope integration test (real API, two scoped users).
 *
 * Boots server.js as a child process with WAREHOUSE_SCOPE_ENFORCE=1 against the
 * local DB, seeds two warehouses + two scoped users (A→WH-A, B→WH-B) + one
 * unscoped user, mints JWTs directly (the app's verifyToken just jwt.verify's
 * them), and asserts cross-warehouse isolation end-to-end. Seeds are prefixed
 * and cleaned up in a finally block.
 *
 * Run: node tests/integration/warehouseScope.api.test.js   (NOT in `npm test`)
 *      Requires the local DB to be reachable (.env) and a free PORT.
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = Number(process.env.SCOPE_TEST_PORT || 3199);
const BASE = { host: '127.0.0.1', port: PORT };
const WH_A = 'WH-SCOPETEST-A';
const WH_B = 'WH-SCOPETEST-B';
const ITEM = 'SCOPETEST-ITEM';
const USERS = { a: 'scopetest_a', b: 'scopetest_b', none: 'scopetest_none' };

let _pass = 0, _fail = 0;
function check(name, cond, extra) {
  if (cond) { _pass++; console.log('  ✅', name); }
  else { _fail++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); }
}

function req(method, path, token, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ ...BASE, method, path, headers }, (resp) => {
      let b = ''; resp.on('data', (c) => (b += c));
      resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: resp.statusCode, body: j, raw: b }); });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.code || e.message }));
    r.setTimeout(8000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) r.write(data);
    r.end();
  });
}

async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    const r = await req('GET', '/api/version');
    if (r.status) return true;
    await new Promise((z) => setTimeout(z, 500));
  }
  return false;
}

async function cleanup() {
  const stmts = [
    ['DELETE FROM user_warehouse_access WHERE warehouse_id IN (?,?)', [WH_A, WH_B]],
    ['DELETE FROM warehouse_stock WHERE warehouse_id IN (?,?)', [WH_A, WH_B]],
    ['DELETE FROM inv_items WHERE id = ?', [ITEM]],
    ['DELETE FROM warehouses WHERE id IN (?,?)', [WH_A, WH_B]],
    ['DELETE FROM users WHERE username IN (?,?,?)', [USERS.a, USERS.b, USERS.none]],
  ];
  for (const [sql, p] of stmts) { try { await db.query(sql, p); } catch (_) {} }
}

async function seed() {
  await cleanup();
  // Warehouses
  for (const [id, code, name] of [[WH_A, 'STA', 'Scope Test A'], [WH_B, 'STB', 'Scope Test B']]) {
    await db.query('INSERT INTO warehouses (id, code, name, type, is_active) VALUES (?,?,?,?,1)', [id, code, name, 'branch']);
  }
  // One item present in BOTH warehouses (to prove distribution filtering).
  await db.query('INSERT INTO inv_items (id, name, category, unit, cost, min_stock, active) VALUES (?,?,?,?,?,?,1)',
    [ITEM, 'Scope Test Item', 'test', 'pcs', 5, 2]);
  await db.query('INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty, avg_cost, first_added_date) VALUES (?,?,?,?,?,NOW())', ['WS-' + WH_A + '-' + ITEM, WH_A, ITEM, 10, 5]);
  await db.query('INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty, avg_cost, first_added_date) VALUES (?,?,?,?,?,NOW())', ['WS-' + WH_B + '-' + ITEM, WH_B, ITEM, 20, 5]);
  // Users (password unused — tokens are signed directly).
  const ids = {};
  for (const key of ['a', 'b', 'none']) {
    await db.query('INSERT INTO users (username, password, role) VALUES (?,?,?)', [USERS[key], 'disabled', 'manager']);
    const [r] = await db.query('SELECT id FROM users WHERE username = ?', [USERS[key]]);
    ids[key] = r[0].id;
  }
  // Grants: A→WH-A, B→WH-B, none→(nothing).
  await db.query('INSERT INTO user_warehouse_access (user_id, warehouse_id, created_by) VALUES (?,?,?)', [ids.a, WH_A, 'test']);
  await db.query('INSERT INTO user_warehouse_access (user_id, warehouse_id, created_by) VALUES (?,?,?)', [ids.b, WH_B, 'test']);
  return ids;
}

function tok(id, username, role) {
  return jwt.sign({ id, username, role, isDeveloper: false }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing (.env) — cannot run'); process.exit(2); }
  console.log('\n═══ Warehouse Scope — integration (ENFORCE=1) ═══\n');

  const ids = await seed();
  const tokenA = tok(ids.a, USERS.a, 'manager');
  const tokenB = tok(ids.b, USERS.b, 'manager');
  const tokenNone = tok(ids.none, USERS.none, 'manager');
  const tokenAdmin = tok(0, 'scopetest_admin', 'admin');

  const server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), WAREHOUSE_SCOPE_ENFORCE: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  let exitCode = 0;
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }

    // ── access-scope per user ──────────────────────────────────────────────
    const scA = await req('GET', '/api/inventory/access-scope', tokenA);
    check('A access-scope: enforced + not global', scA.body && scA.body.enforced === true && scA.body.allWarehousesAccess === false, scA.body);
    check('A access-scope: sees ONLY WH-A', scA.body && (scA.body.accessibleWarehouses || []).map((w) => w.id).sort().join(',') === WH_A, scA.body && scA.body.accessibleWarehouses);
    const scAdmin = await req('GET', '/api/inventory/access-scope', tokenAdmin);
    check('admin access-scope: allWarehousesAccess=true', scAdmin.body && scAdmin.body.allWarehousesAccess === true);
    const scNone = await req('GET', '/api/inventory/access-scope', tokenNone);
    check('no-grant access-scope: empty + not global', scNone.body && scNone.body.allWarehousesAccess === false && (scNone.body.accessibleWarehouses || []).length === 0, scNone.body && scNone.body.accessibleWarehouses);

    // ── isolation on lists/aggregates ──────────────────────────────────────
    const sumA = await req('GET', '/api/inventory/warehouses-summary', tokenA);
    const sumIds = sumA.body && (sumA.body.warehouses || []).map((w) => w.id);
    check('A warehouses-summary: only WH-A (B excluded)', Array.isArray(sumIds) && sumIds.includes(WH_A) && !sumIds.includes(WH_B), sumIds);

    const gridA = await req('GET', '/api/inventory/grid?pageSize=100', tokenA);
    const gridWh = gridA.body && (gridA.body.rows || []).map((r) => r.warehouseId || r.warehouse_id);
    check('A grid (no ?wh): rows only from WH-A', Array.isArray(gridWh) && gridWh.length > 0 && gridWh.every((w) => w === WH_A), gridWh);
    check('A grid pagination total does not count WH-B rows', gridA.body && gridA.body.total === (gridWh ? gridWh.length : -1), gridA.body && gridA.body.total);

    const gridB = await req('GET', '/api/inventory/grid?warehouseId=' + WH_B + '&pageSize=100', tokenA);
    check('A grid ?wh=WH-B → 403 (generic, no existence leak)', gridB.status === 403 && gridB.body && gridB.body.code === 'WAREHOUSE_ACCESS_DENIED', { status: gridB.status, body: gridB.body });
    check('A 403 body never names WH-B', gridB.raw && gridB.raw.indexOf(WH_B) === -1);

    const distA = await req('GET', '/api/inventory/items/' + ITEM + '/warehouses', tokenA);
    const distIds = Array.isArray(distA.body) ? distA.body.map((r) => r.warehouseId) : null;
    check('A item distribution: only WH-A (B hidden)', Array.isArray(distIds) && distIds.includes(WH_A) && !distIds.includes(WH_B), distIds);

    const movA = await req('GET', '/api/inventory/movements?warehouseId=' + WH_B, tokenA);
    check('A movements ?wh=WH-B → 403', movA.status === 403, { status: movA.status });

    // userB sees only WH-B
    const distB = await req('GET', '/api/inventory/items/' + ITEM + '/warehouses', tokenB);
    const distBIds = Array.isArray(distB.body) ? distB.body.map((r) => r.warehouseId) : null;
    check('B item distribution: only WH-B', Array.isArray(distBIds) && distBIds.includes(WH_B) && !distBIds.includes(WH_A), distBIds);

    // ── mutations require access ───────────────────────────────────────────
    const trAB = await req('POST', '/api/erp/warehouse-transfers', tokenA,
      { fromWarehouseId: WH_A, toWarehouseId: WH_B, items: [{ itemId: ITEM, qty: 1 }] });
    check('A transfer A→B → 403 (no dest access)', trAB.status === 403, { status: trAB.status, body: trAB.body });
    const trBA = await req('POST', '/api/erp/warehouse-transfers', tokenA,
      { fromWarehouseId: WH_B, toWarehouseId: WH_A, items: [{ itemId: ITEM, qty: 1 }] });
    check('A transfer B→A → 403 (no source access)', trBA.status === 403, { status: trBA.status, body: trBA.body });

    const adjB = await req('POST', '/api/inventory/adjustments', tokenA,
      { warehouseId: WH_B, reason: 'damaged', items: [{ id: ITEM, qty: 1 }] });
    check('A adjustment on WH-B → 403', adjB.status === 403, { status: adjB.status, body: adjB.body });

    const stB = await req('POST', '/api/stocktake-pro/', tokenA, { warehouseId: WH_B, notes: 'x' });
    check('A stocktake on WH-B → 403', stB.status === 403, { status: stB.status, body: stB.body });

    // admin can act / see across
    const sumAdmin = await req('GET', '/api/inventory/warehouses-summary', tokenAdmin);
    const adminIds = sumAdmin.body && (sumAdmin.body.warehouses || []).map((w) => w.id);
    check('admin warehouses-summary: sees BOTH WH-A and WH-B', Array.isArray(adminIds) && adminIds.includes(WH_A) && adminIds.includes(WH_B));

    // no-grant user sees nothing
    const sumNone = await req('GET', '/api/inventory/warehouses-summary', tokenNone);
    const noneIds = sumNone.body && (sumNone.body.warehouses || []).map((w) => w.id);
    check('no-grant warehouses-summary: empty', Array.isArray(noneIds) && noneIds.length === 0, noneIds);
    const gridNone = await req('GET', '/api/inventory/grid?pageSize=100', tokenNone);
    check('no-grant grid: zero rows', gridNone.body && (gridNone.body.rows || []).length === 0 && gridNone.body.total === 0, gridNone.body && gridNone.body.total);

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('Total: ' + (_pass + _fail) + ' | Passed: ' + _pass + ' | Failed: ' + _fail);
    console.log('═══════════════════════════════════════════════════════════');
    exitCode = _fail > 0 ? 1 : 0;
  } catch (e) {
    console.error('FATAL', e);
    exitCode = 2;
  } finally {
    try { server.kill(); } catch (_) {}
    await cleanup();
  }
  process.exit(exitCode);
})();
