/**
 * Warehouse Scope ENFORCEMENT suite (Phase 2A.2 hardening proof).
 *
 * Two spawned servers against the local .env DB:
 *
 *   1) ENFORCE server (PORT 3242, WAREHOUSE_SCOPE_ENFORCE=1) proves:
 *      (a) a non-admin CANNOT READ a warehouse not granted to them —
 *          lists are scoped (only granted rows / zero rows for no grants),
 *          direct per-warehouse reads answer 403 WAREHOUSE_ACCESS_DENIED
 *          and never name the forbidden warehouse;
 *      (b) the same non-admin CANNOT WRITE (create/mutate/delete) against a
 *          non-granted warehouse (403, and the DB row count is unchanged);
 *      (c) the SAME user CAN read + write their GRANTED warehouse through the
 *          exact same endpoints (create 201 → detail 200 → patch 200 → delete 200);
 *      (d) ADMIN keeps global scope with the flag ON (sees + writes BOTH).
 *
 *   2) SHADOW server (PORT 3243, WAREHOUSE_SCOPE_ENFORCE unset/0) proves:
 *      (e) the same denied calls PASS (200/201) but the middleware logs
 *          '[wh-scope shadow]' lines (captured from the child's stdio —
 *          console.warn emits on stderr).
 *
 * Endpoints exercised (scope, not RBAC — the probe role 'manager' passes every
 * role gate on these routes: v2 docs create/patch/post are BACKOFFICE
 * [admin,manager,employee,custody], approve/delete are MGR [admin,manager]):
 *   • GET  /api/inventory/access-scope                (scope introspection)
 *   • GET  /api/inventory/warehouses-summary          (list — whScopeClause)
 *   • GET  /api/inventory/grid[?warehouseId=]         (list + direct read guard)
 *   • GET  /api/inventory/items/:id/warehouses        (distribution — scoped)
 *   • GET  /api/inventory/movements?warehouseId=      (direct read guard)
 *   • GET  /api/inventory/v2/adjustments[/:id]        (v2 list + detail guard)
 *   • POST/PATCH/DELETE /api/inventory/v2/adjustments (v2 writes — guardWh)
 *   • POST /api/erp/warehouse-transfers               (guardTransfer both ends)
 *   • POST /api/inventory/adjustments (legacy)        (guardWh)
 *   • POST /api/stocktake-pro/                        (guardWh)
 *
 * Self-contained + self-cleaning: seeds two tagged warehouses (WH-SCOPE-A
 * granted / WH-SCOPE-B not granted), one item + stock in both, users
 * scope_probe_user (manager, granted A) and scope_probe_none (manager, no
 * grants); admin = existing users.id=1 (fallback: synthetic id 0). All doc
 * writes carry the WHSCOPE-TEST tag; the finally block deletes everything.
 *
 * Run: npm run test:warehouse-scope   (NOT in `npm test`)
 *      Requires the local DB (.env) and free ports 3242/3243.
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT_ENFORCE = Number(process.env.SCOPE_TEST_PORT || 3242);
const PORT_SHADOW = Number(process.env.SCOPE_SHADOW_PORT || 3243);
const WH_A = 'WH-SCOPE-A'; // granted to the probe user
const WH_B = 'WH-SCOPE-B'; // NOT granted
const ITEM = 'WHSCOPE-ITEM';
const TAG = 'WHSCOPE-TEST';
const PROBE = 'scope_probe_user';
const NONE = 'scope_probe_none';
const V2ADJ = '/api/inventory/v2/adjustments';

let _pass = 0, _fail = 0;
function check(name, cond, extra) {
  if (cond) { _pass++; console.log('  ✅', name); }
  else { _fail++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); }
}

function req(port, method, path, token, body) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (resp) => {
      let b = ''; resp.on('data', (c) => (b += c));
      resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: resp.statusCode, body: j, raw: b }); });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.code || e.message }));
    r.setTimeout(10000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) r.write(data);
    r.end();
  });
}

// 240s budget — the first boot may run schema migrations.
async function waitUp(port) {
  for (let i = 0; i < 240; i++) {
    const r = await req(port, 'GET', '/api/version');
    if (r.status) return true;
    await new Promise((z) => setTimeout(z, 1000));
  }
  return false;
}

function spawnServer(port, enforceFlag) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), WAREHOUSE_SCOPE_ENFORCE: enforceFlag },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = { out: '', err: '' };
  child.stdout.on('data', (d) => { log.out += d; });
  child.stderr.on('data', (d) => { log.err += d; });
  return { child, log };
}

async function adjCount(wh) {
  const [r] = await db.query('SELECT COUNT(*) AS n FROM inv_adjustments WHERE warehouse_id=?', [wh]);
  return Number(r[0].n);
}

async function cleanup() {
  const stmts = [
    // v2 docs created by the write tests (both warehouses are test-exclusive;
    // every doc also carries the WHSCOPE-TEST tag in notes/reason).
    ['DELETE e FROM inv_tx_events e JOIN inv_adjustments d ON d.id=e.doc_id WHERE d.warehouse_id IN (?,?)', [WH_A, WH_B]],
    ['DELETE i FROM inv_adjustment_items i JOIN inv_adjustments d ON d.id=i.adjustment_id WHERE d.warehouse_id IN (?,?)', [WH_A, WH_B]],
    ['DELETE FROM inv_adjustments WHERE warehouse_id IN (?,?)', [WH_A, WH_B]],
    ['DELETE FROM user_warehouse_access WHERE warehouse_id IN (?,?)', [WH_A, WH_B]],
    ['DELETE FROM warehouse_stock WHERE warehouse_id IN (?,?)', [WH_A, WH_B]],
    ['DELETE FROM inv_items WHERE id = ?', [ITEM]],
    ['DELETE FROM warehouses WHERE id IN (?,?)', [WH_A, WH_B]],
    ['DELETE FROM users WHERE username IN (?,?)', [PROBE, NONE]],
  ];
  for (const [sql, p] of stmts) { try { await db.query(sql, p); } catch (_) {} }
}

async function seed() {
  await cleanup();
  await db.query('INSERT INTO warehouses (id, code, name, type, is_active) VALUES (?,?,?,?,1)', [WH_A, 'WSCA', 'اختبار نطاق A', 'branch']);
  await db.query('INSERT INTO warehouses (id, code, name, type, is_active) VALUES (?,?,?,?,1)', [WH_B, 'WSCB', 'اختبار نطاق B', 'branch']);
  await db.query('INSERT INTO inv_items (id, name, category, unit, cost, min_stock, active) VALUES (?,?,?,?,?,?,1)', [ITEM, 'صنف اختبار النطاق', 'خام', 'pcs', 5, 1]);
  await db.query('INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty, avg_cost, first_added_date) VALUES (?,?,?,?,?,NOW())', ['WS-' + WH_A, WH_A, ITEM, 10, 5]);
  await db.query('INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty, avg_cost, first_added_date) VALUES (?,?,?,?,?,NOW())', ['WS-' + WH_B, WH_B, ITEM, 20, 5]);
  const ids = {};
  for (const u of [PROBE, NONE]) {
    // password never used — tokens are signed directly against JWT_SECRET.
    await db.query('INSERT INTO users (username, password, role, active, token_version) VALUES (?,?,?,1,1)', [u, 'disabled', 'manager']);
    const [r] = await db.query('SELECT id FROM users WHERE username = ?', [u]);
    ids[u] = r[0].id;
  }
  // Grant: probe → WH-A ONLY. NONE gets nothing (empty scope → default deny).
  await db.query('INSERT INTO user_warehouse_access (user_id, warehouse_id, created_by) VALUES (?,?,?)', [ids[PROBE], WH_A, TAG]);
  return ids;
}

function tok(id, username, role, tokenVersion) {
  return jwt.sign({ id, username, role, tokenVersion: tokenVersion || 1 }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

// Admin = the existing id 1 row (matches its real token_version so the
// session-version gate passes); fallback to a synthetic id-0 admin.
async function adminToken() {
  try {
    const [r] = await db.query('SELECT id, username, role, token_version FROM users WHERE id=1 LIMIT 1');
    if (r.length && String(r[0].role).toLowerCase() === 'admin') return tok(r[0].id, r[0].username, 'admin', Number(r[0].token_version) || 1);
  } catch (_) {}
  return tok(0, 'whscope_admin', 'admin', 1);
}

const adjBody = (wh, counted) => ({ warehouseId: wh, reason: TAG + ' جرد نطاق', notes: TAG, items: [{ itemId: ITEM, countedQty: counted }] });

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing (.env) — cannot run'); process.exit(2); }
  console.log('\n═══ Warehouse Scope — ENFORCE (3242) + SHADOW (3243) ═══\n');

  const ids = await seed();
  const tProbe = tok(ids[PROBE], PROBE, 'manager');
  const tNone = tok(ids[NONE], NONE, 'manager');
  const tAdmin = await adminToken();

  let enforce = null, shadow = null, exitCode = 0;
  try {
    // ════════════════════════════════════════════════════════════════════
    // PHASE 1 — WAREHOUSE_SCOPE_ENFORCE=1
    // ════════════════════════════════════════════════════════════════════
    enforce = spawnServer(PORT_ENFORCE, '1');
    check('enforce server up (' + PORT_ENFORCE + ')', await waitUp(PORT_ENFORCE));
    const E = (m, p, t, b) => req(PORT_ENFORCE, m, p, t, b);

    // ── (d) setup + admin WRITES both warehouses with the flag ON ─────────
    const bDoc = await E('POST', V2ADJ, tAdmin, adjBody(WH_B, 19));
    check('(d) admin create adjustment in WH-B → 201 draft', bDoc.status === 201 && bDoc.body && bDoc.body.status === 'draft', { status: bDoc.status, body: bDoc.body });
    const bId = bDoc.body && bDoc.body.id;
    const aAdminDoc = await E('POST', V2ADJ, tAdmin, adjBody(WH_A, 9));
    check('(d) admin create adjustment in WH-A → 201 draft', aAdminDoc.status === 201, { status: aAdminDoc.status, body: aAdminDoc.body });
    const aAdminId = aAdminDoc.body && aAdminDoc.body.id;

    // ── (a) probe READS: scope introspection + scoped lists ──────────────
    const scP = await E('GET', '/api/inventory/access-scope', tProbe);
    check('(a) probe access-scope: enforced=true, not global', scP.body && scP.body.enforced === true && scP.body.allWarehousesAccess === false, scP.body);
    check('(a) probe access-scope: granted ONLY WH-SCOPE-A', scP.body && (scP.body.accessibleWarehouses || []).map((w) => w.id).join(',') === WH_A, scP.body && scP.body.accessibleWarehouses);

    const sumP = await E('GET', '/api/inventory/warehouses-summary', tProbe);
    const sumIds = sumP.body && (sumP.body.warehouses || []).map((w) => w.id);
    check('(a) probe warehouses-summary: WH-A visible, WH-B excluded', Array.isArray(sumIds) && sumIds.includes(WH_A) && !sumIds.includes(WH_B), sumIds);

    const gridP = await E('GET', '/api/inventory/grid?pageSize=100', tProbe);
    const gridWh = gridP.body && (gridP.body.rows || []).map((r) => r.warehouseId || r.warehouse_id);
    check('(a) probe grid (no filter): rows ONLY from WH-A', Array.isArray(gridWh) && gridWh.length > 0 && gridWh.every((w) => w === WH_A), gridWh);
    check('(a) probe grid total excludes WH-B rows', gridP.body && gridP.body.total === gridWh.length, gridP.body && gridP.body.total);

    const distP = await E('GET', '/api/inventory/items/' + ITEM + '/warehouses', tProbe);
    const distIds = Array.isArray(distP.body) ? distP.body.map((r) => r.warehouseId) : null;
    check('(a) probe item distribution: WH-B hidden', Array.isArray(distIds) && distIds.includes(WH_A) && !distIds.includes(WH_B), distIds);

    const v2ListP = await E('GET', V2ADJ + '?pageSize=100', tProbe);
    const v2Rows = v2ListP.body && (v2ListP.body.data || []);
    check('(a) probe v2 adjustments list: WH-A doc visible, WH-B doc invisible',
      v2ListP.status === 200 && v2Rows.some((r) => r.id === aAdminId) && !v2Rows.some((r) => r.id === bId) && v2Rows.every((r) => r.warehouse_id === WH_A),
      { status: v2ListP.status, rows: v2Rows.map((r) => r.id + ':' + r.warehouse_id) });

    // direct per-warehouse reads → 403 WAREHOUSE_ACCESS_DENIED, no leak
    const gridB = await E('GET', '/api/inventory/grid?warehouseId=' + WH_B + '&pageSize=10', tProbe);
    check('(a) probe grid?warehouseId=WH-B → 403 WAREHOUSE_ACCESS_DENIED', gridB.status === 403 && gridB.body && gridB.body.code === 'WAREHOUSE_ACCESS_DENIED', { status: gridB.status, body: gridB.body });
    check('(a) the 403 body never names WH-B (no existence leak)', gridB.raw && gridB.raw.indexOf(WH_B) === -1, gridB.raw);
    const movB = await E('GET', '/api/inventory/movements?warehouseId=' + WH_B, tProbe);
    check('(a) probe movements?warehouseId=WH-B → 403', movB.status === 403, { status: movB.status });
    const detB = await E('GET', V2ADJ + '/' + bId, tProbe);
    check('(a) probe v2 detail of WH-B doc → 403 WAREHOUSE_ACCESS_DENIED', detB.status === 403 && detB.body && detB.body.code === 'WAREHOUSE_ACCESS_DENIED', { status: detB.status, body: detB.body });

    // no-grant user: empty scope → zero rows everywhere (default deny)
    const sumN = await E('GET', '/api/inventory/warehouses-summary', tNone);
    const noneIds = sumN.body && (sumN.body.warehouses || []).map((w) => w.id);
    check('(a) no-grant warehouses-summary: empty', Array.isArray(noneIds) && noneIds.length === 0, noneIds);
    const gridN = await E('GET', '/api/inventory/grid?pageSize=100', tNone);
    check('(a) no-grant grid: zero rows, total 0', gridN.body && (gridN.body.rows || []).length === 0 && gridN.body.total === 0, gridN.body && gridN.body.total);
    const v2ListN = await E('GET', V2ADJ, tNone);
    check('(a) no-grant v2 adjustments list: zero rows', v2ListN.status === 200 && (v2ListN.body.data || []).length === 0 && v2ListN.body.pagination && v2ListN.body.pagination.total === 0, { status: v2ListN.status, total: v2ListN.body && v2ListN.body.pagination && v2ListN.body.pagination.total });

    // ── (b) probe WRITES against WH-B → 403, nothing persisted ───────────
    const nB = await adjCount(WH_B);
    const wCreate = await E('POST', V2ADJ, tProbe, adjBody(WH_B, 18));
    check('(b) probe v2 create in WH-B → 403 WAREHOUSE_ACCESS_DENIED', wCreate.status === 403 && wCreate.body && wCreate.body.code === 'WAREHOUSE_ACCESS_DENIED', { status: wCreate.status, body: wCreate.body });
    check('(b) denied create persisted NOTHING in WH-B', (await adjCount(WH_B)) === nB, { before: nB, after: await adjCount(WH_B) });
    const wPatch = await E('PATCH', V2ADJ + '/' + bId, tProbe, { expectedVersion: 1, notes: TAG + ' hijack', reason: TAG, items: [{ itemId: ITEM, countedQty: 1 }] });
    check('(b) probe v2 PATCH of WH-B doc → 403', wPatch.status === 403 && wPatch.body && wPatch.body.code === 'WAREHOUSE_ACCESS_DENIED', { status: wPatch.status, body: wPatch.body });
    const wDel = await E('DELETE', V2ADJ + '/' + bId, tProbe);
    check('(b) probe v2 DELETE of WH-B doc → 403 (doc survives)', wDel.status === 403 && (await adjCount(WH_B)) === nB, { status: wDel.status });
    const trAB = await E('POST', '/api/erp/warehouse-transfers', tProbe, { fromWarehouseId: WH_A, toWarehouseId: WH_B, items: [{ itemId: ITEM, qty: 1 }] });
    check('(b) probe transfer A→B → 403 (no dest access)', trAB.status === 403, { status: trAB.status, body: trAB.body });
    const trBA = await E('POST', '/api/erp/warehouse-transfers', tProbe, { fromWarehouseId: WH_B, toWarehouseId: WH_A, items: [{ itemId: ITEM, qty: 1 }] });
    check('(b) probe transfer B→A → 403 (no source access)', trBA.status === 403, { status: trBA.status, body: trBA.body });
    const legacyAdj = await E('POST', '/api/inventory/adjustments', tProbe, { warehouseId: WH_B, reason: TAG, items: [{ id: ITEM, qty: 1 }] });
    check('(b) probe legacy adjustment on WH-B → 403', legacyAdj.status === 403, { status: legacyAdj.status, body: legacyAdj.body });
    const stB = await E('POST', '/api/stocktake-pro/', tProbe, { warehouseId: WH_B, notes: TAG });
    check('(b) probe stocktake-pro on WH-B → 403', stB.status === 403, { status: stB.status, body: stB.body });

    // ── (c) probe READS + WRITES the GRANTED warehouse (same endpoints) ──
    const cCreate = await E('POST', V2ADJ, tProbe, adjBody(WH_A, 9));
    check('(c) probe v2 create in GRANTED WH-A → 201 draft', cCreate.status === 201 && cCreate.body && cCreate.body.status === 'draft', { status: cCreate.status, body: cCreate.body });
    const cId = cCreate.body && cCreate.body.id;
    const cDet = await E('GET', V2ADJ + '/' + cId, tProbe);
    check('(c) probe reads own WH-A doc → 200', cDet.status === 200 && cDet.body && cDet.body.data && cDet.body.data.warehouse_id === WH_A, { status: cDet.status });
    const cPatch = await E('PATCH', V2ADJ + '/' + cId, tProbe, { expectedVersion: 1, notes: TAG + ' معدّل', reason: TAG + ' جرد نطاق', items: [{ itemId: ITEM, countedQty: 8 }] });
    check('(c) probe PATCH own WH-A doc → 200 v2', cPatch.status === 200 && cPatch.body && cPatch.body.version === 2, { status: cPatch.status, body: cPatch.body });
    const gridA = await E('GET', '/api/inventory/grid?warehouseId=' + WH_A + '&pageSize=10', tProbe);
    check('(c) probe grid?warehouseId=WH-A → 200 (direct read of granted)', gridA.status === 200 && (gridA.body.rows || []).length > 0, { status: gridA.status });
    const cDel = await E('DELETE', V2ADJ + '/' + cId, tProbe);
    check('(c) probe DELETE own WH-A draft → 200', cDel.status === 200 && (await db.query('SELECT id FROM inv_adjustments WHERE id=?', [cId]))[0].length === 0, { status: cDel.status, body: cDel.body });

    // ── (d) admin keeps GLOBAL scope with the flag ON ─────────────────────
    const scA = await E('GET', '/api/inventory/access-scope', tAdmin);
    check('(d) admin access-scope: allWarehousesAccess=true (flag ON)', scA.body && scA.body.enforced === true && scA.body.allWarehousesAccess === true, scA.body);
    const sumA = await E('GET', '/api/inventory/warehouses-summary', tAdmin);
    const adminIds = sumA.body && (sumA.body.warehouses || []).map((w) => w.id);
    check('(d) admin warehouses-summary: sees BOTH WH-A and WH-B', Array.isArray(adminIds) && adminIds.includes(WH_A) && adminIds.includes(WH_B), adminIds);
    const v2ListA = await E('GET', V2ADJ + '?pageSize=100', tAdmin);
    const v2A = v2ListA.body && (v2ListA.body.data || []);
    check('(d) admin v2 list: sees docs of BOTH warehouses', v2ListA.status === 200 && v2A.some((r) => r.id === bId) && v2A.some((r) => r.id === aAdminId), { status: v2ListA.status });
    const gridAdmB = await E('GET', '/api/inventory/grid?warehouseId=' + WH_B + '&pageSize=10', tAdmin);
    check('(d) admin grid?warehouseId=WH-B → 200', gridAdmB.status === 200, { status: gridAdmB.status });
    const dDelB = await E('DELETE', V2ADJ + '/' + bId, tAdmin);
    const dDelA = await E('DELETE', V2ADJ + '/' + aAdminId, tAdmin);
    check('(d) admin deletes drafts in BOTH warehouses → 200/200', dDelB.status === 200 && dDelA.status === 200, { b: dDelB.status, a: dDelA.status });

    try { enforce.child.kill(); } catch (_) {}
    enforce = null;

    // ════════════════════════════════════════════════════════════════════
    // PHASE 2 — SHADOW MODE (WAREHOUSE_SCOPE_ENFORCE unset → '0')
    // ════════════════════════════════════════════════════════════════════
    shadow = spawnServer(PORT_SHADOW, '0');
    check('(e) shadow server up (' + PORT_SHADOW + ')', await waitUp(PORT_SHADOW));
    const S = (m, p, t, b) => req(PORT_SHADOW, m, p, t, b);

    const scS = await S('GET', '/api/inventory/access-scope', tProbe);
    check('(e) shadow access-scope: enforced=false (scope still resolved)', scS.body && scS.body.enforced === false && scS.body.allWarehousesAccess === false, scS.body);

    // the very calls denied in phase 1 now PASS…
    const sGridB = await S('GET', '/api/inventory/grid?warehouseId=' + WH_B + '&pageSize=10', tProbe);
    check('(e) shadow: probe grid?warehouseId=WH-B → 200 (would-be denial passes)', sGridB.status === 200 && (sGridB.body.rows || []).length > 0, { status: sGridB.status });
    const sSum = await S('GET', '/api/inventory/warehouses-summary', tProbe);
    const sSumIds = sSum.body && (sSum.body.warehouses || []).map((w) => w.id);
    check('(e) shadow: probe warehouses-summary INCLUDES WH-B (lists unscoped)', Array.isArray(sSumIds) && sSumIds.includes(WH_B), sSumIds);
    const sCreate = await S('POST', V2ADJ, tProbe, adjBody(WH_B, 19));
    check('(e) shadow: probe v2 create in WH-B → 201 (would-be denial passes)', sCreate.status === 201, { status: sCreate.status, body: sCreate.body });

    // …and every would-be denial was shadow-logged by the middleware.
    let logged = false;
    for (let i = 0; i < 10 && !logged; i++) {
      logged = (shadow.log.out + shadow.log.err).indexOf('[wh-scope shadow]') !== -1;
      if (!logged) await new Promise((z) => setTimeout(z, 500));
    }
    check("(e) child stdio carries at least one '[wh-scope shadow]' line", logged,
      logged ? undefined : { tail: (shadow.log.out + shadow.log.err).slice(-800) });
    const shadowLines = (shadow.log.out + shadow.log.err).split(/\r?\n/).filter((l) => l.indexOf('[wh-scope shadow]') !== -1);
    check('(e) shadow log names the probe user + WH-B', shadowLines.some((l) => l.indexOf('user=' + PROBE) !== -1 && l.indexOf(WH_B) !== -1), shadowLines.slice(0, 3));

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('Total: ' + (_pass + _fail) + ' | Passed: ' + _pass + ' | Failed: ' + _fail);
    console.log('═══════════════════════════════════════════════════════════');
    exitCode = _fail > 0 ? 1 : 0;
  } catch (e) {
    console.error('FATAL', e);
    exitCode = 2;
  } finally {
    try { if (enforce) enforce.child.kill(); } catch (_) {}
    try { if (shadow) shadow.child.kill(); } catch (_) {}
    try { await cleanup(); } catch (_) {}
  }
  try { await db.end(); } catch (_) {}
  process.exit(exitCode);
})();
