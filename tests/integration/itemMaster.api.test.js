/**
 * Phase 4A — Item Master integration test (ENFORCE=1).
 *
 * Drives /api/inventory/v2/items + warehouse-rules end-to-end:
 *   • SKU required + UNIQUE after trim/upper-case (case-only dup rejected).
 *   • PATCH version-guarded; SKU/unit change after movements HARD-BLOCKED.
 *   • editing the GLOBAL cost does NOT touch warehouse_stock.avg_cost (WAC).
 *   • deactivate keeps history; an inactive item is rejected in a NEW v2 document;
 *     reactivate (MGR). No hard-delete path for a historical item.
 *   • warehouse-rule validation + version conflict; scope (out-of-scope → 403).
 *   • two concurrent PATCH → one 200 / one 409; audit rows; RBAC.
 *   • LEGACY COMPAT: legacy POST /api/inventory/items + a sales-style
 *     `UPDATE inv_items SET stock` still work (additive columns didn't break them).
 *
 * Run: node tests/integration/itemMaster.api.test.js
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = Number(process.env.IM_TEST_PORT || 3251);
const BASE = { host: '127.0.0.1', port: PORT };
const WH = 'WH-IM', WC = 'WH-IM-C';
const U_MGR = 'im_mgr', U_EMP = 'im_emp', U_OUT = 'im_out';
const IT = '/api/inventory/v2/items';
const A = '/api/inventory/v2/adjustments';

let _p = 0, _f = 0;
function check(name, cond, extra) { if (cond) { _p++; console.log('  ✅', name); } else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); } }

function req(method, path, token, body, headers) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = Object.assign({ Accept: 'application/json' }, headers || {});
    if (token) h.Authorization = 'Bearer ' + token;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ ...BASE, method, path, headers: h }, (resp) => {
      let b = ''; resp.on('data', (c) => (b += c));
      resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: resp.statusCode, body: j }); });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.code }));
    r.setTimeout(8000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
async function waitForServer() { for (let i = 0; i < 90; i++) { const r = await req('GET', '/api/version'); if (r.status) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }
function tok(id, u, role, dev) { return jwt.sign({ id, username: u, role, isDeveloper: !!dev }, process.env.JWT_SECRET, { expiresIn: '1h' }); }
async function avgCost(item) { const [r] = await db.query('SELECT avg_cost FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [WH, item]); return r.length ? Number(r[0].avg_cost) : null; }

async function cleanup() {
  for (const [s, p] of [
    ["DELETE FROM inv_tx_events WHERE doc_type='item' AND doc_id IN (SELECT id FROM inv_items WHERE sku_norm LIKE 'IMTEST-%')", []],
    ["DELETE FROM warehouse_item_rules WHERE item_id IN (SELECT id FROM inv_items WHERE sku_norm LIKE 'IMTEST-%')", []],
    ["DELETE FROM inventory_movements WHERE warehouse_id IN (?,?)", [WH, WC]],
    ["DELETE FROM warehouse_stock WHERE warehouse_id IN (?,?)", [WH, WC]],
    ["DELETE FROM inv_items WHERE sku_norm LIKE 'IMTEST-%' OR name LIKE 'IMTEST%'", []],
    ['DELETE FROM idempotency_keys WHERE username IN (?,?,?,?)', [U_MGR, U_EMP, U_OUT, 'im_admin']],
    ['DELETE uwa FROM user_warehouse_access uwa JOIN users u ON u.id=uwa.user_id WHERE u.username IN (?,?,?)', [U_MGR, U_EMP, U_OUT]],
    ['DELETE FROM warehouses WHERE id IN (?,?)', [WH, WC]],
    ['DELETE FROM users WHERE username IN (?,?,?)', [U_MGR, U_EMP, U_OUT]],
  ]) { try { await db.query(s, p); } catch (_) {} }
}
async function seed() {
  await cleanup();
  await db.query('INSERT INTO warehouses (id,code,name,type,is_active,is_main) VALUES (?,?,?,?,1,1)', [WH, 'IM', 'مستودع الأصناف', 'main']);
  await db.query('INSERT INTO warehouses (id,code,name,type,is_active) VALUES (?,?,?,?,1)', [WC, 'IMC', 'مستودع آخر', 'branch']);
  const ids = {};
  for (const [u, role] of [[U_MGR, 'manager'], [U_EMP, 'employee'], [U_OUT, 'manager']]) {
    await db.query('INSERT INTO users (username,password,role) VALUES (?,?,?)', [u, 'disabled', role]);
    const [r] = await db.query('SELECT id FROM users WHERE username=?', [u]); ids[u] = r[0].id;
  }
  for (const u of [U_MGR, U_EMP]) await db.query('INSERT INTO user_warehouse_access (user_id,warehouse_id,created_by) VALUES (?,?,?)', [ids[u], WH, 'test']);
  await db.query('INSERT INTO user_warehouse_access (user_id,warehouse_id,created_by) VALUES (?,?,?)', [ids[U_OUT], WC, 'test']);
  return ids;
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n═══ Item Master — integration (ENFORCE=1) ═══\n');
  const ids = await seed();
  const admin = tok(0, 'im_admin', 'admin', true);
  const mgr = tok(ids[U_MGR], U_MGR, 'manager');
  const emp = tok(ids[U_EMP], U_EMP, 'employee');
  const out = tok(ids[U_OUT], U_OUT, 'manager');
  const server = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), WAREHOUSE_SCOPE_ENFORCE: '1' }, stdio: ['ignore', 'ignore', 'ignore'] });
  let exitCode = 0;
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }

    // CREATE
    const c = await req('POST', IT, mgr, { name: 'IMTEST زيت', sku: 'imtest-001', unit: 'لتر', category: 'خام', cost: 5 }, { 'Idempotency-Key': 'im-c1' });
    check('create item → 201 + version 1', c.status === 201 && c.body.version === 1, c.body);
    const id1 = c.body && c.body.id;
    const cDup = await req('POST', IT, mgr, { name: 'IMTEST آخر', sku: '  IMTEST-001 ', unit: 'لتر' });
    check('duplicate SKU differing only by case/space → 422', cDup.status === 422 && cDup.body.code === 'VALIDATION_ERROR', cDup.body && cDup.body.code);
    const cNoSku = await req('POST', IT, mgr, { name: 'IMTEST بلا', unit: 'لتر' });
    check('create without SKU → 422', cNoSku.status === 422, cNoSku.body && cNoSku.body.code);

    // LIST + DETAIL
    const list = await req('GET', `${IT}?q=imtest`, mgr);
    check('list → data + kpis + pagination', list.status === 200 && Array.isArray(list.body.data) && list.body.kpis && list.body.pagination, { st: list.status });
    const detail = await req('GET', `${IT}/${id1}`, mgr);
    check('detail → item + distribution + rules + movements + timeline', detail.status === 200 && detail.body.data && Array.isArray(detail.body.distribution) && Array.isArray(detail.body.rules) && Array.isArray(detail.body.timeline), { st: detail.status });

    // PATCH cost — must NOT touch warehouse WAC
    await db.query('INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost) VALUES (?,?,?,?,?)', ['WS-IM1', WH, id1, 10, 5]);
    const wacBefore = await avgCost(id1);
    const pCost = await req('PATCH', `${IT}/${id1}`, mgr, { cost: 9, expectedVersion: 1 });
    check('PATCH cost → version 2', pCost.status === 200 && pCost.body.version === 2, pCost.body);
    check('global cost edit did NOT change warehouse WAC', (await avgCost(id1)) === wacBefore, { before: wacBefore, after: await avgCost(id1) });

    // SKU change BEFORE movements → OK; then add a movement → SKU/unit change BLOCKED
    const pSku = await req('PATCH', `${IT}/${id1}`, mgr, { sku: 'IMTEST-001B', expectedVersion: 2 });
    check('SKU change before movements → 200', pSku.status === 200, pSku.body);
    await db.query("INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, warehouse_id, reference_type) VALUES (?, NOW(), ?, '', 'in', 1, ?, 'manual')", ['MVIM-' + Math.random().toString(36).slice(2, 8), id1, WH]);
    const pSku2 = await req('PATCH', `${IT}/${id1}`, mgr, { sku: 'IMTEST-001C', expectedVersion: 3 });
    check('SKU change AFTER movements → 422 (hard block)', pSku2.status === 422 && pSku2.body.code === 'VALIDATION_ERROR', pSku2.body && pSku2.body.code);
    const pUnit = await req('PATCH', `${IT}/${id1}`, mgr, { unit: 'كجم', expectedVersion: 3 });
    check('unit change AFTER movements → 422 (hard block)', pUnit.status === 422 && pUnit.body.code === 'VALIDATION_ERROR', pUnit.body && pUnit.body.code);

    // VERSION conflict + concurrency
    const pStale = await req('PATCH', `${IT}/${id1}`, mgr, { name: 'IMTEST محدث', expectedVersion: 1 });
    check('PATCH with stale expectedVersion → 409 VERSION_CONFLICT', pStale.status === 409 && pStale.body.code === 'VERSION_CONFLICT', pStale.body && pStale.body.code);
    const [cc1, cc2] = await Promise.all([
      req('PATCH', `${IT}/${id1}`, mgr, { name: 'IMTEST A', expectedVersion: 3 }),
      req('PATCH', `${IT}/${id1}`, mgr, { name: 'IMTEST B', expectedVersion: 3 }),
    ]);
    check('two concurrent PATCH → one 200 / one 409', [cc1, cc2].filter((x) => x.status === 200).length === 1 && [cc1, cc2].filter((x) => x.status === 409).length === 1, { s1: cc1.status, s2: cc2.status });

    // DEACTIVATE keeps history + blocks new docs + reactivate (MGR / RBAC)
    const [verRow] = await db.query('SELECT version FROM inv_items WHERE id=?', [id1]);
    const empDeact = await req('POST', `${IT}/${id1}/deactivate`, emp, {});
    check('employee deactivate → 403 (RBAC: MGR only)', empDeact.status === 403, empDeact.status);
    const deact = await req('POST', `${IT}/${id1}/deactivate`, mgr, { expectedVersion: Number(verRow[0].version) });
    check('deactivate → inactive', deact.status === 200 && deact.body.status === 'inactive', deact.body);
    const [stillThere] = await db.query('SELECT active FROM inv_items WHERE id=?', [id1]);
    check('deactivate kept the row (history preserved, no hard-delete)', stillThere.length === 1 && Number(stillThere[0].active) === 0, stillThere[0]);
    const useInactive = await req('POST', A, mgr, { warehouseId: WH, reason: 'جرد', items: [{ itemId: id1, countedQty: 3 }] });
    check('inactive item rejected in a NEW v2 document → 422', useInactive.status === 422 && useInactive.body.code === 'VALIDATION_ERROR', useInactive.body && useInactive.body.code);
    const [v2] = await db.query('SELECT version FROM inv_items WHERE id=?', [id1]);
    const react = await req('POST', `${IT}/${id1}/activate`, mgr, { expectedVersion: Number(v2[0].version) });
    check('reactivate (MGR) → active', react.status === 200 && react.body.status === 'active', react.body);

    // WAREHOUSE RULES — validation + version + scope
    const ruleBad = await req('PUT', `${IT}/${id1}/warehouse-rules/${WH}`, mgr, { reorderPoint: 5, reorderQty: 0, isEnabled: true, safetyStock: 0 });
    check('rule with reorderQty 0 while enabled → 422', ruleBad.status === 422 && ruleBad.body.code === 'VALIDATION_ERROR', ruleBad.body && ruleBad.body.code);
    const ruleBad2 = await req('PUT', `${IT}/${id1}/warehouse-rules/${WH}`, mgr, { reorderPoint: 30, reorderQty: 5, maxStock: 20, safetyStock: 0 });
    check('rule with maxStock < reorderPoint → 422', ruleBad2.status === 422, ruleBad2.body && ruleBad2.body.code);
    const rule = await req('PUT', `${IT}/${id1}/warehouse-rules/${WH}`, mgr, { minQty: 5, reorderPoint: 10, reorderQty: 20, maxStock: 50, safetyStock: 5, leadTimeDays: 7, isEnabled: true });
    check('valid rule upsert → 200 version 1', rule.status === 200 && rule.body.version === 1, rule.body);
    const ruleConflict = await req('PUT', `${IT}/${id1}/warehouse-rules/${WH}`, mgr, { reorderPoint: 12, reorderQty: 20, safetyStock: 0, expectedVersion: 99 });
    check('rule PUT with stale expectedVersion → 409', ruleConflict.status === 409 && ruleConflict.body.code === 'VERSION_CONFLICT', ruleConflict.body && ruleConflict.body.code);
    const ruleScope = await req('PUT', `${IT}/${id1}/warehouse-rules/${WC}`, out, { reorderPoint: 5, reorderQty: 5, safetyStock: 0 });
    // U_OUT IS scoped to WC, so this is allowed; instead verify mgr (scoped to WH) CANNOT set WC
    const ruleScopeDenied = await req('PUT', `${IT}/${id1}/warehouse-rules/${WC}`, mgr, { reorderPoint: 5, reorderQty: 5, safetyStock: 0 });
    check('out-of-scope warehouse rule → 403', ruleScopeDenied.status === 403, { mgr: ruleScopeDenied.status, out: ruleScope.status });

    // AUDIT
    const [aud] = await db.query("SELECT action FROM inv_tx_events WHERE doc_type='item' AND doc_id=? ORDER BY created_at", [id1]);
    const actions = aud.map((a) => a.action);
    check('audit timeline has create + edit + deactivate + activate + rule', ['create', 'edit', 'deactivate', 'activate', 'rule'].every((a) => actions.includes(a)), actions);

    // LEGACY COMPAT — legacy create + a sales-style stock update still work
    const legacy = await req('POST', '/api/inventory/items', admin, { name: 'IMTEST قديم', unit: 'حبة', cost: 3, stock: 0, warehouseId: WH });
    check('legacy POST /api/inventory/items still works (additive cols didn\'t break it)', legacy.status === 200 || legacy.status === 201, legacy.status);
    let legacyStockOk = false;
    try { const [lr] = await db.query("SELECT id FROM inv_items WHERE name='IMTEST قديم' LIMIT 1"); if (lr.length) { await db.query('UPDATE inv_items SET stock = stock + 5 WHERE id=?', [lr[0].id]); const [s] = await db.query('SELECT stock FROM inv_items WHERE id=?', [lr[0].id]); legacyStockOk = Number(s[0].stock) === 5; } } catch (_) {}
    check('sales-style `UPDATE inv_items SET stock` still works', legacyStockOk, legacyStockOk);

  } catch (e) {
    _f++; exitCode = 1; console.error('  ❌ FATAL', e && e.stack || e);
  } finally {
    try { server.kill(); } catch (_) {}
    try { await cleanup(); } catch (_) {}
  }
  console.log('\n  ' + _p + ' passed, ' + _f + ' failed\n');
  if (_f > 0) exitCode = 1;
  try { await db.end(); } catch (_) {}
  process.exit(exitCode);
})();
