/**
 * Phase W6 — Warehouse management (CRUD) integration test (ENFORCE=1).
 *
 * Tests routes/inventory-warehouses.js HERMETICALLY: instead of spawning
 * server.js (which may not have the router mounted yet), it boots a tiny
 * in-process express app with the SAME middleware chain server.js uses:
 *   JWT Bearer auth (jsonwebtoken verify → req.user)
 *   → middleware/warehouseScope.loadWarehouseScope (ENFORCE=1)
 *   → the router at /api/inventory/v2/warehouses.
 *
 * Scenarios:
 *   • RBAC: employee create → 403; manager delete → 403 (admin only).
 *   • create ok (201) + audit row; duplicate code → 409 DUPLICATE_CODE.
 *   • PATCH renames + retypes; PATCH onto a taken code → 409.
 *   • list returns computed stats (item count / qty / value / movements).
 *   • scope enforcement: out-of-scope manager GET /:id → 403; list excludes.
 *   • PUT scope-assignments replaces; GET reflects; non-admin PUT → 403.
 *   • deactivate blocked with non-zero stock (422 Arabic + count), allowed
 *     after zeroing; double-deactivate → 409; activate restores.
 *   • hard delete blocked with stock rows/movements (422 Arabic), allowed for
 *     a clean warehouse; deleted warehouse GET → 404.
 *
 * Run: node tests/integration/warehouses.api.test.js  (NOT in `npm test`)
 * Requires MariaDB from .env (local: port 3307) + JWT_SECRET in .env.
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
// Must be set BEFORE requiring middleware/warehouseScope (read at module load).
process.env.WAREHOUSE_SCOPE_ENFORCE = '1';

const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');
const { loadWarehouseScope } = require('../../middleware/warehouseScope');
const warehousesRouter = require('../../routes/inventory-warehouses');

const PORT = Number(process.env.WH_TEST_PORT || 3213);
const BASE = { host: '127.0.0.1', port: PORT };
const API = '/api/inventory/v2/warehouses';

const WH_A_CODE = 'ADM-A', WH_B_CODE = 'ADM-B';
const ITEM1 = 'WHADM-IT1', ITEM2 = 'WHADM-IT2';
const U_ADM = 'whadm_admin', U_MGR = 'whadm_mgr', U_EMP = 'whadm_emp', U_OUT = 'whadm_out';

let _p = 0, _f = 0;
function check(name, cond, extra) { if (cond) { _p++; console.log('  ✅', name); } else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); } }
function near(a, b, tol) { return Math.abs(Number(a) - Number(b)) <= (tol == null ? 0.02 : tol); }

function req(method, path, token, body) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ ...BASE, method, path, headers: h }, (resp) => {
      let b = ''; resp.on('data', (c) => (b += c));
      resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: resp.statusCode, body: j, raw: b }); });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.code }));
    r.setTimeout(10000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
function tok(id, username, role, dev) { return jwt.sign({ id, username, role, isDeveloper: !!dev }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

async function cleanup() {
  const sqls = [
    ["DELETE e FROM inv_tx_events e JOIN warehouses w ON w.id=e.doc_id WHERE e.doc_type='warehouse' AND w.code IN (?,?)", [WH_A_CODE, WH_B_CODE]],
    ['DELETE m FROM inventory_movements m JOIN warehouses w ON w.id=m.warehouse_id WHERE w.code IN (?,?)', [WH_A_CODE, WH_B_CODE]],
    ['DELETE s FROM warehouse_stock s JOIN warehouses w ON w.id=s.warehouse_id WHERE w.code IN (?,?)', [WH_A_CODE, WH_B_CODE]],
    ['DELETE a FROM user_warehouse_access a JOIN warehouses w ON w.id=a.warehouse_id WHERE w.code IN (?,?)', [WH_A_CODE, WH_B_CODE]],
    ['DELETE a FROM user_warehouse_access a JOIN users u ON u.id=a.user_id WHERE u.username IN (?,?,?,?)', [U_ADM, U_MGR, U_EMP, U_OUT]],
    ['DELETE FROM warehouses WHERE code IN (?,?)', [WH_A_CODE, WH_B_CODE]],
    ['DELETE FROM inv_items WHERE id IN (?,?)', [ITEM1, ITEM2]],
    ['DELETE FROM users WHERE username IN (?,?,?,?)', [U_ADM, U_MGR, U_EMP, U_OUT]],
  ];
  for (const [s, p] of sqls) { try { await db.query(s, p); } catch (_) {} }
}

async function seed() {
  await cleanup();
  // Audit table exists on any booted deploy; create defensively for a bare DB.
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS inv_tx_events (
      id VARCHAR(60) PRIMARY KEY, doc_type VARCHAR(20) NOT NULL, doc_id VARCHAR(60) NOT NULL,
      action VARCHAR(30) NOT NULL, from_status VARCHAR(30), to_status VARCHAR(30),
      actor VARCHAR(100), note VARCHAR(500), payload_json TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_evt_doc (doc_type, doc_id)) ENGINE=InnoDB`);
  } catch (_) {}
  await db.query("INSERT INTO inv_items (id,name,category,unit,cost,active,min_stock) VALUES (?,?,?,?,?,1,0)", [ITEM1, 'صنف اختبار مستودعات 1', 'اختبار', 'كجم', 5]);
  await db.query("INSERT INTO inv_items (id,name,category,unit,cost,active,min_stock) VALUES (?,?,?,?,?,1,0)", [ITEM2, 'صنف اختبار مستودعات 2', 'اختبار', 'كجم', 8]);
  const ids = {};
  for (const [u, role] of [[U_ADM, 'admin'], [U_MGR, 'manager'], [U_EMP, 'employee'], [U_OUT, 'manager']]) {
    await db.query('INSERT INTO users (username,password,role) VALUES (?,?,?)', [u, 'disabled', role]);
    const [r] = await db.query('SELECT id FROM users WHERE username=?', [u]);
    ids[u] = r[0].id;
  }
  return ids;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  // Minimal JWT gate — the same contract as server.js's global /api gate.
  app.use((req, res, next) => {
    const h = req.headers['authorization'];
    if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
    try {
      req.user = jwt.verify(h.split(' ')[1], process.env.JWT_SECRET);
      next();
    } catch (_) {
      return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
    }
  });
  app.use(loadWarehouseScope);
  app.use(API, warehousesRouter);
  return app;
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n═══ Warehouses CRUD V2 — integration (in-process bootstrap, ENFORCE=1) ═══\n');
  const ids = await seed();
  const adm = tok(ids[U_ADM], U_ADM, 'admin');
  const mgr = tok(ids[U_MGR], U_MGR, 'manager');
  const emp = tok(ids[U_EMP], U_EMP, 'employee');
  const out = tok(ids[U_OUT], U_OUT, 'manager');

  const server = buildApp().listen(PORT);
  let WA = null, WB = null;
  try {
    // ── 1) RBAC + validation on create ──────────────────────────────────────
    console.log('▸ create (RBAC + validation + duplicate code)');
    let r = await req('POST', API, emp, { name: 'مستودع ممنوع', code: 'ADM-X' });
    check('employee create → 403 (RBAC)', r.status === 403, r.status);
    r = await req('POST', API, mgr, { code: 'ADM-A' });
    check('create without name → 422 VALIDATION_ERROR', r.status === 422 && r.body && r.body.code === 'VALIDATION_ERROR', r.body);
    r = await req('POST', API, mgr, { name: 'مستودع الإدارة أ', code: 'adm-a', type: 'branch', location: 'الرياض', manager: 'أحمد' });
    check('manager create → 201 + id + code normalized', r.status === 201 && r.body && r.body.success === true && r.body.data && r.body.data.id && r.body.documentNumber === 'ADM-A', r.body);
    WA = r.body && r.body.data && r.body.data.id;
    r = await req('POST', API, mgr, { name: 'مكرر', code: 'ADM-A' });
    check('duplicate code → 409 DUPLICATE_CODE', r.status === 409 && r.body && r.body.code === 'DUPLICATE_CODE', r.body);
    r = await req('POST', API, adm, { name: 'مستودع الإدارة ب', code: WH_B_CODE, type: 'raw' });
    check('admin creates second warehouse → 201', r.status === 201 && r.body && r.body.data && r.body.data.id, r.body);
    WB = r.body && r.body.data && r.body.data.id;
    const [evc] = await db.query("SELECT action FROM inv_tx_events WHERE doc_type='warehouse' AND doc_id=? ORDER BY created_at", [WA]);
    check('audit row written (action=create)', evc.some((e) => e.action === 'create'), evc);

    // ── 2) Scope assignments (admin PUT/GET; non-admin 403) ─────────────────
    console.log('▸ scope assignments');
    r = await req('PUT', API + '/' + WA + '/scope-assignments', mgr, { userIds: [ids[U_MGR]] });
    check('manager PUT scope-assignments → 403 (admin only)', r.status === 403, r.status);
    r = await req('PUT', API + '/' + WA + '/scope-assignments', adm, { userIds: [ids[U_MGR], ids[U_EMP]] });
    check('admin PUT scope-assignments → 200', r.status === 200 && r.body && r.body.success === true, r.body);
    r = await req('PUT', API + '/' + WA + '/scope-assignments', adm, { userIds: [999999999] });
    check('PUT with unknown user → 422', r.status === 422 && r.body && r.body.code === 'VALIDATION_ERROR', r.body);
    r = await req('GET', API + '/' + WA + '/scope-assignments', adm);
    const asg1 = (r.body && r.body.data && r.body.data.assignments) || [];
    check('GET reflects assignments (mgr + emp)', r.status === 200 && asg1.length === 2
      && asg1.some((a) => a.userId === ids[U_MGR]) && asg1.some((a) => a.userId === ids[U_EMP]), asg1);
    check('GET users list marks hasAccess', ((r.body.data.users || []).find((u) => u.id === ids[U_MGR]) || {}).hasAccess === true, r.body.data.users && r.body.data.users.length);
    // Replace: emp only.
    r = await req('PUT', API + '/' + WA + '/scope-assignments', adm, { userIds: [ids[U_EMP], ids[U_MGR]] });
    r = await req('PUT', API + '/' + WA + '/scope-assignments', adm, { userIds: [ids[U_MGR]] });
    r = await req('GET', API + '/' + WA + '/scope-assignments', adm);
    const asg2 = (r.body && r.body.data && r.body.data.assignments) || [];
    check('PUT REPLACES rows (only mgr remains)', asg2.length === 1 && asg2[0].userId === ids[U_MGR], asg2);

    // ── 3) Scope enforcement on reads ───────────────────────────────────────
    console.log('▸ warehouse scope (ENFORCE=1)');
    r = await req('GET', API + '/' + WA, out);
    check('out-of-scope manager GET /:id → 403', r.status === 403 && r.body && r.body.code === 'WAREHOUSE_ACCESS_DENIED', r.body);
    r = await req('GET', API, out);
    const outList = (r.body && r.body.data) || [];
    check('out-of-scope list EXCLUDES the warehouse', r.status === 200 && !outList.some((w) => w.id === WA), outList.map((w) => w.id));
    r = await req('GET', API + '/' + WA, mgr);
    check('in-scope manager GET /:id → 200', r.status === 200 && r.body && r.body.data && r.body.data.id === WA, r.status);

    // ── 4) PATCH ────────────────────────────────────────────────────────────
    console.log('▸ patch');
    r = await req('PATCH', API + '/' + WA, mgr, { name: 'مستودع الإدارة أ — معدل', type: 'production' });
    check('PATCH rename + retype → 200', r.status === 200 && r.body && r.body.success === true, r.body);
    r = await req('GET', API + '/' + WA, mgr);
    check('GET reflects the rename', r.body && r.body.data && r.body.data.name === 'مستودع الإدارة أ — معدل' && r.body.data.type === 'production', r.body && r.body.data && { name: r.body.data.name, type: r.body.data.type });
    r = await req('PATCH', API + '/' + WB, adm, { code: 'ADM-A' });
    check('PATCH onto a taken code → 409 DUPLICATE_CODE', r.status === 409 && r.body && r.body.code === 'DUPLICATE_CODE', r.body);
    r = await req('PATCH', API + '/' + WA, emp, { name: 'x' });
    check('employee PATCH → 403 (RBAC)', r.status === 403, r.status);

    // ── 5) List stats ───────────────────────────────────────────────────────
    console.log('▸ list + stats');
    await db.query('INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost) VALUES (?,?,?,?,?)', ['WS-WHADM-1', WA, ITEM1, 10, 5]);
    await db.query('INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost) VALUES (?,?,?,?,?)', ['WS-WHADM-2', WA, ITEM2, 4, 0]); // avg 0 → falls back to item cost 8
    await db.query("INSERT INTO inventory_movements (id,movement_date,item_id,item_name,type,qty,reason,username,warehouse_id,reference_type,reference_id) VALUES (?,NOW(),?,?,?,?,?,?,?,?,?)",
      ['MV-WHADM-1', ITEM1, 'صنف اختبار مستودعات 1', 'in', 10, 'رصيد افتتاحي', 'seed', WA, 'test_seed', 'seed']);
    r = await req('GET', API, adm);
    const rowA = ((r.body && r.body.data) || []).find((w) => w.id === WA) || {};
    check('list stats: itemCount=2, totalQty=14', rowA.itemCount === 2 && near(rowA.totalQty, 14), rowA);
    check('list stats: totalValue=82 (10×5 WAC + 4×8 fallback)', near(rowA.totalValue, 82), rowA.totalValue);
    check('list stats: movementCount=1 + lastMovementAt set', rowA.movementCount === 1 && !!rowA.lastMovementAt, { c: rowA.movementCount, at: rowA.lastMovementAt });
    check('list totals aggregate', r.body && r.body.totals && r.body.totals.warehouseCount >= 2 && r.body.totals.totalValue >= 82, r.body && r.body.totals);
    r = await req('GET', API + '/' + WA, adm);
    check('detail returns movements (1) + assignments (1)', r.status === 200 && (r.body.movements || []).length === 1 && (r.body.assignments || []).length === 1, { m: (r.body.movements || []).length, a: (r.body.assignments || []).length });

    // ── 6) Deactivate: blocked with stock, allowed after zeroing ────────────
    console.log('▸ deactivate / activate');
    r = await req('POST', API + '/' + WA + '/deactivate', mgr, {});
    check('deactivate with non-zero stock → 422 + Arabic count', r.status === 422 && r.body && r.body.code === 'VALIDATION_ERROR' && /لا يمكن تعطيل المستودع/.test(r.body.error || '') && /2/.test(r.body.error || ''), r.body);
    await db.query('UPDATE warehouse_stock SET qty=0 WHERE warehouse_id=?', [WA]);
    r = await req('POST', API + '/' + WA + '/deactivate', mgr, {});
    check('deactivate after zeroing → 200 status=inactive', r.status === 200 && r.body && r.body.status === 'inactive', r.body);
    r = await req('POST', API + '/' + WA + '/deactivate', mgr, {});
    check('double deactivate → 409 VERSION_CONFLICT (conditional WHERE)', r.status === 409 && r.body && r.body.code === 'VERSION_CONFLICT', r.body);
    const [wrow] = await db.query('SELECT is_active FROM warehouses WHERE id=?', [WA]);
    check('DB is_active=0', wrow.length === 1 && Number(wrow[0].is_active) === 0, wrow);
    r = await req('POST', API + '/' + WA + '/activate', mgr, {});
    check('activate → 200 status=active', r.status === 200 && r.body && r.body.status === 'active', r.body);
    r = await req('POST', API + '/' + WA + '/activate', mgr, {});
    check('double activate → 409 VERSION_CONFLICT', r.status === 409 && r.body && r.body.code === 'VERSION_CONFLICT', r.body);

    // ── 7) Hard delete ──────────────────────────────────────────────────────
    console.log('▸ hard delete (admin only, only when never used)');
    r = await req('DELETE', API + '/' + WA, mgr);
    check('manager DELETE → 403 (admin only)', r.status === 403, r.status);
    r = await req('DELETE', API + '/' + WA, adm);
    check('delete with stock rows/movements → 422 Arabic', r.status === 422 && r.body && /لا يمكن الحذف الصلب/.test(r.body.error || ''), r.body);
    r = await req('DELETE', API + '/' + WB, adm);
    check('delete clean warehouse → 200 deleted', r.status === 200 && r.body && r.body.status === 'deleted', r.body);
    r = await req('GET', API + '/' + WB, adm);
    check('deleted warehouse GET → 404', r.status === 404, r.status);
    const [gone] = await db.query('SELECT id FROM warehouses WHERE id=?', [WB]);
    check('DB row hard-deleted', gone.length === 0, gone);
    const [evd] = await db.query("SELECT action FROM inv_tx_events WHERE doc_type='warehouse' AND doc_id=? AND action='delete'", [WB]);
    check('delete audit row outlives the warehouse', evd.length === 1, evd);

    // ── 8) Audit timeline completeness for WA ───────────────────────────────
    const [evs] = await db.query("SELECT action FROM inv_tx_events WHERE doc_type='warehouse' AND doc_id=?", [WA]);
    const acts = evs.map((e) => e.action);
    check('WA audit trail has create/update/scope_assign/deactivate/activate',
      ['create', 'update', 'scope_assign', 'deactivate', 'activate'].every((a) => acts.indexOf(a) !== -1), acts);
  } finally {
    server.close();
    await cleanup();
    try { await db.end(); } catch (_) {}
  }

  console.log('\n════════════════════════════════');
  console.log(_f === 0 ? `✅ ALL ${_p} CHECKS PASSED` : `❌ ${_f} FAILED / ${_p} passed`);
  console.log('════════════════════════════════\n');
  process.exit(_f === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
