/**
 * Phase 4A — Replenishment integration test (ENFORCE=1).
 *
 * Seeds warehouse + items + per-warehouse rules + outbound movements and verifies
 * the advisory recommendation engine through /api/inventory/v2/replenishment:
 *   • recommendedQty = max(reorderQty, target − onHand)  (target = maxStock or RP+RQ)
 *   • daysOfCover = onHand / avgDailyOutbound, NULL when no outbound (never /0)
 *   • stockoutRisk tiers; no-rule items fall back to inv_items.min_stock as RP
 *   • summary counts; warehouse scope (out-of-scope rows excluded)
 *   • NEVER creates a PO (advisory only).
 *
 * Run: node tests/integration/replenishment.api.test.js
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = Number(process.env.REP_TEST_PORT || 3253);
const BASE = { host: '127.0.0.1', port: PORT };
const WH = 'WH-REP', WC = 'WH-REP-C';
const I1 = 'REP-I1', I2 = 'REP-I2', I3 = 'REP-I3', I4 = 'REP-I4';
const U = 'rep_mgr', U_OUT = 'rep_out';
const R = '/api/inventory/v2/replenishment';

let _p = 0, _f = 0;
function check(name, cond, extra) { if (cond) { _p++; console.log('  ✅', name); } else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); } }
function near(a, b, tol) { return Math.abs(Number(a) - Number(b)) <= (tol == null ? 0.02 : tol); }

function req(method, path, token) {
  return new Promise((resolve) => {
    const h = { Accept: 'application/json' }; if (token) h.Authorization = 'Bearer ' + token;
    const r = http.request({ ...BASE, method, path, headers: h }, (resp) => { let b = ''; resp.on('data', (c) => (b += c)); resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: resp.statusCode, body: j }); }); });
    r.on('error', (e) => resolve({ status: 0, error: e.code })); r.setTimeout(8000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); }); r.end();
  });
}
async function waitForServer() { for (let i = 0; i < 90; i++) { const r = await req('GET', '/api/version'); if (r.status) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }
function tok(id, u, role) { return jwt.sign({ id, username: u, role }, process.env.JWT_SECRET, { expiresIn: '1h' }); }
function row(body, item) { return (body.data || []).find((r) => r.itemId === item); }

async function cleanup() {
  for (const [s, p] of [
    ['DELETE FROM warehouse_item_rules WHERE item_id IN (?,?,?,?)', [I1, I2, I3, I4]],
    ['DELETE FROM inventory_movements WHERE warehouse_id IN (?,?)', [WH, WC]],
    ['DELETE FROM warehouse_stock WHERE warehouse_id IN (?,?)', [WH, WC]],
    ['DELETE FROM inv_items WHERE id IN (?,?,?,?)', [I1, I2, I3, I4]],
    ['DELETE uwa FROM user_warehouse_access uwa JOIN users u ON u.id=uwa.user_id WHERE u.username IN (?,?)', [U, U_OUT]],
    ['DELETE FROM warehouses WHERE id IN (?,?)', [WH, WC]],
    ['DELETE FROM users WHERE username IN (?,?)', [U, U_OUT]],
  ]) { try { await db.query(s, p); } catch (_) {} }
}
async function seed() {
  await cleanup();
  await db.query('INSERT INTO warehouses (id,code,name,type,is_active,is_main) VALUES (?,?,?,?,1,1)', [WH, 'REP', 'مستودع التوصيات', 'main']);
  await db.query('INSERT INTO warehouses (id,code,name,type,is_active) VALUES (?,?,?,?,1)', [WC, 'REPC', 'مستودع آخر', 'branch']);
  // I1: onHand 5, full rule, heavy outbound. I2: onHand 100, rule, no outbound. I3: onHand 8, NO rule, min_stock 10.
  for (const [it, q, minStock] of [[I1, 5, 0], [I2, 100, 0], [I3, 8, 10]]) {
    await db.query('INSERT INTO inv_items (id,name,sku,sku_norm,category,unit,cost,min_stock,active) VALUES (?,?,?,?,?,?,?,?,1)', [it, 'صنف ' + it, it, it.toUpperCase(), 'خام', 'كجم', 5, minStock]);
    await db.query('INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost) VALUES (?,?,?,?,?)', ['WS-' + it, WH, it, q, 5]);
  }
  await db.query('INSERT INTO warehouse_item_rules (id,warehouse_id,item_id,min_qty,reorder_point,reorder_qty,max_stock,safety_stock,lead_time_days,is_enabled,version) VALUES (?,?,?,?,?,?,?,?,?,1,1)', ['WIR-1', WH, I1, 5, 10, 20, 50, 5, 7]);
  await db.query('INSERT INTO warehouse_item_rules (id,warehouse_id,item_id,min_qty,reorder_point,reorder_qty,max_stock,safety_stock,lead_time_days,is_enabled,version) VALUES (?,?,?,?,?,?,?,?,?,1,1)', ['WIR-2', WH, I2, 0, 10, 20, 0, 0, 7]);
  // I4: INACTIVE, onHand 5 below reorderPoint 10 — an ACTIVE item would recommend 45,
  // but inactive must yield recommendedQty 0 + reorderStatus 'inactive_balance' (close 4A).
  await db.query('INSERT INTO inv_items (id,name,sku,sku_norm,category,unit,cost,min_stock,active) VALUES (?,?,?,?,?,?,?,?,0)', [I4, 'صنف معطّل ' + I4, I4, I4.toUpperCase(), 'خام', 'كجم', 5, 0]);
  await db.query('INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost) VALUES (?,?,?,?,?)', ['WS-' + I4, WH, I4, 5, 5]);
  await db.query('INSERT INTO warehouse_item_rules (id,warehouse_id,item_id,min_qty,reorder_point,reorder_qty,max_stock,safety_stock,lead_time_days,is_enabled,version) VALUES (?,?,?,?,?,?,?,?,?,1,1)', ['WIR-4', WH, I4, 5, 10, 20, 50, 5, 7]);
  // I1 outbound: 60 units 10 days ago → avgDaily = 60/30 = 2 → daysOfCover = 5/2 = 2.5
  await db.query("INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, warehouse_id, reference_type) VALUES (?, DATE_SUB(NOW(), INTERVAL 10 DAY), ?, '', 'out', 60, ?, 'manual')", ['MVR1', I1, WH]);
  const ids = {};
  for (const [u, role] of [[U, 'manager'], [U_OUT, 'manager']]) {
    await db.query('INSERT INTO users (username,password,role) VALUES (?,?,?)', [u, 'disabled', role]);
    const [r] = await db.query('SELECT id FROM users WHERE username=?', [u]); ids[u] = r[0].id;
  }
  await db.query('INSERT INTO user_warehouse_access (user_id,warehouse_id,created_by) VALUES (?,?,?)', [ids[U], WH, 'test']);
  await db.query('INSERT INTO user_warehouse_access (user_id,warehouse_id,created_by) VALUES (?,?,?)', [ids[U_OUT], WC, 'test']);
  return ids;
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n═══ Replenishment — integration (ENFORCE=1) ═══\n');
  const ids = await seed();
  const mgr = tok(ids[U], U, 'manager');
  const out = tok(ids[U_OUT], U_OUT, 'manager');
  const server = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), WAREHOUSE_SCOPE_ENFORCE: '1' }, stdio: ['ignore', 'ignore', 'ignore'] });
  let exitCode = 0;
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }

    const list = await req('GET', `${R}?warehouseId=${WH}`, mgr);
    check('replenishment list → 4 rows', list.status === 200 && (list.body.data || []).length === 4, { st: list.status, n: (list.body.data || []).length });
    const r1 = row(list.body, I1), r2 = row(list.body, I2), r3 = row(list.body, I3), r4 = row(list.body, I4);
    check('I4 INACTIVE → recommendedQty 0 + reorderStatus inactive_balance + isActive false', r4 && r4.recommendedQty === 0 && r4.reorderStatus === 'inactive_balance' && r4.isActive === false, r4 && { rq: r4.recommendedQty, s: r4.reorderStatus, a: r4.isActive });
    check('I1 recommendedQty 45 (max(20, 50−5))', r1 && near(r1.recommendedQty, 45), r1);
    check('I1 daysOfCover 2.5 (5 / (60/30))', r1 && near(r1.daysOfCover, 2.5), r1 && r1.daysOfCover);
    check('I1 reorderStatus critical (onHand 5 ≤ safety 5), risk high (cover 2.5 < lead 7)', r1 && r1.reorderStatus === 'critical' && r1.stockoutRisk === 'high', r1 && { s: r1.reorderStatus, risk: r1.stockoutRisk });
    check('I2 daysOfCover NULL (no outbound — no divide by 0)', r2 && r2.daysOfCover === null && r2.recommendedQty === 0 && r2.reorderStatus === 'ok' && r2.stockoutRisk === 'unknown', r2);
    check('I3 (NO rule) falls back to min_stock 10 → recommendedQty 2, status reorder', r3 && near(r3.recommendedQty, 2) && r3.reorderStatus === 'reorder' && r3.hasRule === false, r3);

    const summary = await req('GET', `${R}/summary?warehouseId=${WH}`, mgr);
    check('summary → reorderItems 2 (I1 + I3)', summary.status === 200 && summary.body.data.reorderItems === 2, summary.body && summary.body.data);
    check('summary recommendedValue > 0', summary.body.data && summary.body.data.recommendedValue > 0, summary.body && summary.body.data);

    const risk = await req('GET', `${R}?warehouseId=${WH}&risk=high`, mgr);
    check('risk=high filter → only I1', risk.status === 200 && (risk.body.data || []).length === 1 && risk.body.data[0].itemId === I1, risk.body && risk.body.data);

    // Scope: a user scoped to WC sees no WH rows
    const outList = await req('GET', `${R}?warehouseId=${WH}`, out);
    check('out-of-scope user sees 0 WH rows (scope enforced)', outList.status === 200 && (outList.body.data || []).length === 0, { st: outList.status, n: (outList.body.data || []).length });
    const outAll = await req('GET', R, out);
    check('out-of-scope user unfiltered list excludes WH rows', outAll.status === 200 && !(outAll.body.data || []).some((r) => r.warehouseId === WH), outAll.body && (outAll.body.data || []).map((r) => r.warehouseId));

    // CSV export
    const exp = await new Promise((resolve) => { const r = http.request({ ...BASE, method: 'GET', path: `${R}/export?warehouseId=${WH}`, headers: { Authorization: 'Bearer ' + mgr } }, (resp) => { let b = ''; resp.on('data', (c) => (b += c)); resp.on('end', () => resolve({ status: resp.statusCode, ct: resp.headers['content-type'], body: b })); }); r.end(); });
    check('CSV export → text/csv with rows', exp.status === 200 && /text\/csv/.test(exp.ct || '') && /الصنف/.test(exp.body), { st: exp.status, ct: exp.ct });

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
