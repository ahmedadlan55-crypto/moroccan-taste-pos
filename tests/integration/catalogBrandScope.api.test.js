/**
 * Brand/branch scope fix — integration test (REAL server).
 *
 * Boots server.js and exercises the brand-scoping added to
 * routes/pos-v2.js's GET /catalog, GET /orders and GET /orders/:id:
 *
 *   • a cashier of brand A never sees brand B's menu.brand_id-tagged items
 *     or combos in the catalog,
 *   • the SAME default scoping applies to a supervisor (admin/manager) —
 *     there is no blanket "supervisors see everything" special-case,
 *   • menu.brand_id IS NULL items/combos stay visible to EVERY caller,
 *   • ?brandId=/?allBranches=1 are silently IGNORED unless the caller holds
 *     the new `pos.catalog.viewAllBrands` capability — granting it via a
 *     targeted user_permission_overrides row (self-cleaning) then unlocks
 *     the bypass,
 *   • pos_orders.branch_id is snapshotted at order-creation time and used to
 *     brand-scope GET /orders + GET /orders/:id for supervisors, while a
 *     plain cashier's self-scope (own username only) is completely
 *     unaffected by any of the new query params,
 *   • a pre-migration order with branch_id IS NULL stays visible to every
 *     brand-scoped supervisor.
 *
 * Run: node tests/integration/catalogBrandScope.api.test.js
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = Number(process.env.SCOPEBILI_TEST_PORT || 4002);
const BASE = { host: '127.0.0.1', port: PORT };
const API = '/api/pos/v2';

const BRAND_A = 'BILI-SCOPE-BRAND-A', BRAND_B = 'BILI-SCOPE-BRAND-B';
const BRANCH_A = 'BILI-SCOPE-BRANCH-A', BRANCH_B = 'BILI-SCOPE-BRANCH-B';
const ITEM_A = 'BILI-SCOPE-ITEM-A', ITEM_B = 'BILI-SCOPE-ITEM-B', ITEM_NULL = 'BILI-SCOPE-ITEM-NULL';
const COMBO_A = 'BILI-SCOPE-COMBO-A', COMBO_B = 'BILI-SCOPE-COMBO-B';
const U_CASH_A = 'bili_scope_cash_a', U_CASH_B = 'bili_scope_cash_b', U_MGR_A = 'bili_scope_mgr_a';
const CAP_ID = 'pos.catalog.viewAllBrands';
const ORDER_NULL_BRANCH = 'BILISCOPEORDNULL01';

let _p = 0, _f = 0;
function check(name, cond, extra) { if (cond) { _p++; console.log('  ✅', name); } else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 400) : ''); } }
function ulid(n) { return 'BILISCOPEORD' + String(n) + Math.random().toString(36).slice(2, 8).toUpperCase(); }

function req(method, path, token, body, headers) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = Object.assign({ Accept: 'application/json' }, headers || {});
    if (token) h.Authorization = 'Bearer ' + token;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ ...BASE, method, path, headers: h }, (resp) => {
      let b = ''; resp.on('data', (c) => (b += c));
      resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: resp.statusCode, body: j, headers: resp.headers }); });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.code }));
    r.setTimeout(15000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
async function waitForServer() { for (let i = 0; i < 120; i++) { const r = await req('GET', '/api/version'); if (r.status) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }
function tok(id, username, role) { return jwt.sign({ id, username, role }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

async function cleanup() {
  const sqls = [
    ["DELETE p FROM pos_payments p JOIN pos_orders o ON o.id=p.order_id WHERE o.id LIKE 'BILISCOPEORD%'", []],
    ["DELETE l FROM pos_order_lines l JOIN pos_orders o ON o.id=l.order_id WHERE o.id LIKE 'BILISCOPEORD%'", []],
    ["DELETE FROM pos_orders WHERE id LIKE 'BILISCOPEORD%'", []],
    ['DELETE FROM combo_groups WHERE menu_id IN (?,?)', [COMBO_A, COMBO_B]],
    ['DELETE FROM menu WHERE id IN (?,?,?,?,?)', [ITEM_A, ITEM_B, ITEM_NULL, COMBO_A, COMBO_B]],
    ['DELETE FROM user_permission_overrides WHERE username = ? AND permission_id = ?', [U_MGR_A, CAP_ID]],
    ['DELETE FROM users WHERE username IN (?,?,?)', [U_CASH_A, U_CASH_B, U_MGR_A]],
    ['DELETE FROM branches WHERE id IN (?,?)', [BRANCH_A, BRANCH_B]],
    ['DELETE FROM brands WHERE id IN (?,?)', [BRAND_A, BRAND_B]],
  ];
  for (const [s, p] of sqls) { try { await db.query(s, p); } catch (_) {} }
}

let _createdPermRow = false;
async function seed() {
  await cleanup();
  await db.query('INSERT INTO brands (id, name) VALUES (?,?),(?,?)', [BRAND_A, 'BILI Brand A', BRAND_B, 'BILI Brand B']);
  await db.query('INSERT INTO branches (id, name, brand_id) VALUES (?,?,?),(?,?,?)', [BRANCH_A, 'BILI Branch A', BRAND_A, BRANCH_B, 'BILI Branch B', BRAND_B]);
  await db.query("INSERT INTO menu (id, name, price, category, active, tax_category, brand_id) VALUES (?,?,10,'عام',1,'S',?)", [ITEM_A, 'صنف A', BRAND_A]);
  await db.query("INSERT INTO menu (id, name, price, category, active, tax_category, brand_id) VALUES (?,?,10,'عام',1,'S',?)", [ITEM_B, 'صنف B', BRAND_B]);
  await db.query("INSERT INTO menu (id, name, price, category, active, tax_category, brand_id) VALUES (?,?,10,'عام',1,'S',NULL)", [ITEM_NULL, 'صنف عام']);
  await db.query("INSERT INTO menu (id, name, price, category, active, tax_category, brand_id, is_combo) VALUES (?,?,30,'عام',1,'S',?,1)", [COMBO_A, 'عرض A', BRAND_A]);
  await db.query("INSERT INTO menu (id, name, price, category, active, tax_category, brand_id, is_combo) VALUES (?,?,30,'عام',1,'S',?,1)", [COMBO_B, 'عرض B', BRAND_B]);
  await db.query('INSERT INTO users (username,password,role,branch_id) VALUES (?,?,?,?)', [U_CASH_A, 'disabled', 'cashier', BRANCH_A]);
  await db.query('INSERT INTO users (username,password,role,branch_id) VALUES (?,?,?,?)', [U_CASH_B, 'disabled', 'cashier', BRANCH_B]);
  await db.query('INSERT INTO users (username,password,role,branch_id) VALUES (?,?,?,?)', [U_MGR_A, 'disabled', 'manager', BRANCH_A]);
  const ids = {};
  for (const u of [U_CASH_A, U_CASH_B, U_MGR_A]) {
    const [r] = await db.query('SELECT id FROM users WHERE username=?', [u]);
    ids[u] = r[0].id;
  }
  return ids;
}

async function grantBypassCapability() {
  const [ex] = await db.query('SELECT id FROM permissions_v3 WHERE id = ?', [CAP_ID]);
  if (!ex.length) {
    await db.query('INSERT INTO permissions_v3 (id, category, label_ar, label_en, is_sensitive) VALUES (?,?,?,?,?)',
      [CAP_ID, 'pos', 'عرض كل البراندات في نقطة البيع', 'View all brands in POS', 1]);
    _createdPermRow = true;
  }
  await db.query('INSERT INTO user_permission_overrides (username, permission_id, grant_type) VALUES (?,?,?) ' +
    'ON DUPLICATE KEY UPDATE grant_type=VALUES(grant_type)', [U_MGR_A, CAP_ID, 'grant']);
}
async function revokeBypassCapability() {
  try { await db.query('DELETE FROM user_permission_overrides WHERE username=? AND permission_id=?', [U_MGR_A, CAP_ID]); } catch (_) {}
  if (_createdPermRow) { try { await db.query('DELETE FROM permissions_v3 WHERE id=?', [CAP_ID]); } catch (_) {} }
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n═══ Brand/branch scope fix — integration ═══\n');
  const ids = await seed();
  const cashA = tok(ids[U_CASH_A], U_CASH_A, 'cashier');
  const cashB = tok(ids[U_CASH_B], U_CASH_B, 'cashier');
  const mgrA = tok(ids[U_MGR_A], U_MGR_A, 'manager');

  // NAME_EN_BACKFILL_DISABLE_WORKER=1 — see catalogBilingual.api.test.js; not
  // asserted on here but disabled defensively so it never mutates fixtures
  // mid-run.
  const server = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), NAME_EN_BACKFILL_DISABLE_WORKER: '1' }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }

    // ── 1) Catalog: default scope applies to cashiers AND supervisors alike ──
    console.log('▸ catalog default scope');
    let r = await req('GET', API + '/catalog', cashA);
    let ids1 = (r.body.data.items || []).map((i) => i.id);
    check('cashier A sees brand A + NULL items, never brand B', ids1.includes(ITEM_A) && ids1.includes(ITEM_NULL) && !ids1.includes(ITEM_B), ids1);
    let combos1 = (r.body.data.combos || []).map((c) => c.id);
    check('cashier A sees brand A combo, never brand B combo', combos1.includes(COMBO_A) && !combos1.includes(COMBO_B), combos1);

    r = await req('GET', API + '/catalog', cashB);
    let ids2 = (r.body.data.items || []).map((i) => i.id);
    check('cashier B sees brand B + NULL items, never brand A', ids2.includes(ITEM_B) && ids2.includes(ITEM_NULL) && !ids2.includes(ITEM_A), ids2);

    r = await req('GET', API + '/catalog', mgrA);
    let ids3 = (r.body.data.items || []).map((i) => i.id);
    check('manager (supervisor) of brand A gets the SAME default scope — no blanket bypass', ids3.includes(ITEM_A) && ids3.includes(ITEM_NULL) && !ids3.includes(ITEM_B), ids3);

    // ── 2) allBranches/brandId bypass — ignored without the capability ──
    console.log('▸ bypass gated on capability');
    r = await req('GET', API + '/catalog?allBranches=1', mgrA);
    let ids4 = (r.body.data.items || []).map((i) => i.id);
    check('allBranches=1 WITHOUT capability is silently ignored (still scoped)', !ids4.includes(ITEM_B), ids4);
    r = await req('GET', API + '/catalog?allBranches=1', cashA);
    let ids4b = (r.body.data.items || []).map((i) => i.id);
    check('allBranches=1 as a plain cashier is ALSO ignored (no capability check needed — still scoped)', !ids4b.includes(ITEM_B), ids4b);

    await grantBypassCapability();
    r = await req('GET', API + '/catalog?allBranches=1', mgrA);
    let ids5 = (r.body.data.items || []).map((i) => i.id);
    check('allBranches=1 WITH capability now sees every brand', ids5.includes(ITEM_A) && ids5.includes(ITEM_B) && ids5.includes(ITEM_NULL), ids5);

    r = await req('GET', API + '/catalog?brandId=' + BRAND_B, mgrA);
    let ids6 = (r.body.data.items || []).map((i) => i.id);
    check('brandId=<other brand> WITH capability scopes to THAT brand (+ NULL, still global)', ids6.includes(ITEM_B) && ids6.includes(ITEM_NULL) && !ids6.includes(ITEM_A), ids6);

    // ── 3) Orders: creation snapshots branch_id; self-scope unaffected ──
    console.log('▸ orders brand scope');
    const orderA = ulid(1);
    await req('POST', API + '/orders', cashA, { id: orderA, lines: [{ menuId: ITEM_A, qty: 1 }] });
    const orderB = ulid(2);
    await req('POST', API + '/orders', cashB, { id: orderB, lines: [{ menuId: ITEM_B, qty: 1 }] });

    r = await req('GET', API + '/orders', cashA);
    let oids1 = (r.body.data || []).map((o) => o.id);
    check('cashier A self-scope: sees own order, not cashier B\'s', oids1.includes(orderA) && !oids1.includes(orderB), oids1);
    r = await req('GET', API + '/orders?allBranches=1', cashA);
    let oids1b = (r.body.data || []).map((o) => o.id);
    check('cashier self-scope is UNAFFECTED by allBranches=1 (no capability gate needed)', oids1b.includes(orderA) && !oids1b.includes(orderB), oids1b);

    r = await req('GET', API + '/orders', mgrA);
    let oids2 = (r.body.data || []).map((o) => o.id);
    check('manager A default: brand-scoped to A — sees order A, not order B', oids2.includes(orderA) && !oids2.includes(orderB), oids2);

    r = await req('GET', API + '/orders?allBranches=1', mgrA);
    let oids3 = (r.body.data || []).map((o) => o.id);
    check('manager A + allBranches=1 (capability already granted above) → sees both', oids3.includes(orderA) && oids3.includes(orderB), oids3);

    // Single-order fetch mirrors the list scope, reusing PERMISSION_DENIED.
    r = await req('GET', API + '/orders/' + orderB, mgrA);
    check('manager A fetching brand-B order (no bypass) → PERMISSION_DENIED', r.status === 403 && r.body.code === 'PERMISSION_DENIED', r.body);
    r = await req('GET', API + '/orders/' + orderB + '?allBranches=1', mgrA);
    check('manager A fetching brand-B order WITH allBranches=1 (capability held) → 200', r.status === 200 && r.body.data.id === orderB, r.body);

    // ── 4) NULL branch_id (pre-migration row) stays visible to everyone ──
    console.log('▸ pre-migration NULL branch_id order');
    await db.query(
      "INSERT INTO pos_orders (id, status, order_type, username, subtotal, total, origin, version, branch_id) " +
      "VALUES (?,'open','takeaway',?,0,0,'online',1,NULL)", [ORDER_NULL_BRANCH, U_CASH_B]);
    r = await req('GET', API + '/orders', mgrA);
    let oids4 = (r.body.data || []).map((o) => o.id);
    check('NULL branch_id order visible to brand-scoped supervisor by default', oids4.includes(ORDER_NULL_BRANCH), oids4);
    r = await req('GET', API + '/orders/' + ORDER_NULL_BRANCH, mgrA);
    check('NULL branch_id order single-fetch also allowed', r.status === 200, r.status);
  } finally {
    try { server.kill(); } catch (_) {}
    await revokeBypassCapability();
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  console.log(`\n${_f === 0 ? '✅' : '❌'} catalogBrandScope.api: ${_p} passed, ${_f} failed\n`);
  process.exit(_f === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
