/**
 * Owner B — cashier account validation + readiness diagnostics.
 *
 * Covers:
 *   1) POST /api/auth/users and PUT /api/auth/users/:username reject a
 *      nonexistent/inactive branch, and a nonexistent/inactive warehouse
 *      (explicit override), with the exact {status:422, code} contract from
 *      lib/branchWarehouseValidation.js — and still succeed on a valid pair.
 *   2) GET /api/cashier-readiness (NOT mounted in server.js yet — this test
 *      boots routes/cashier-readiness.js directly, hermetically) correctly
 *      flags a synthesized not-ready cashier (no branch; a revoked pos.use
 *      capability) and a synthesized ready one, with RBAC (admin/manager
 *      only) enforced.
 *
 * Hermetic bootstrap (same style as tests/integration/warehouses.api.test.js):
 * an in-process express app requiring routes/auth.js + routes/cashier-readiness.js
 * directly, rather than spawning the full server.js — both routers verify their
 * own JWT (routes/auth.js's requireAdmin; cashier-readiness's verifyToken),
 * so no separate gate middleware is needed here.
 *
 * Run: node tests/integration/cashierReadiness.api.test.js   (MySQL must be up)
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}

const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const authRouter = require('../../routes/auth');
const cashierReadinessRouter = require('../../routes/cashier-readiness');

const PORT = Number(process.env.CWB_TEST_PORT || 4011);
const BASE = { host: '127.0.0.1', port: PORT };
const PW = 'Itest@12345';

// ── test fixture ids (all prefixed so cleanup is a simple LIKE/IN) ─────────
const ADMIN = 'itest_cwb_admin';
const U_EXISTING = 'itest_cwb_existing';       // target of PUT scenarios
const U_NOBRANCH = 'itest_cwb_cash_nobranch';  // synthesized not-ready (NO_BRANCH)
const U_NOCAP = 'itest_cwb_cash_nocap';        // synthesized not-ready (MISSING_CAP)
const U_READY = 'itest_cwb_cash_ready';        // synthesized ready
const U_MGR = 'itest_cwb_manager';             // RBAC: allowed on readiness endpoint
const U_CASHIER_RBAC = 'itest_cwb_cash_rbac';  // RBAC: forbidden on readiness endpoint

const BR_ACTIVE = 'ITB-CWB-ACTIVE';      // active branch, warehouse_id -> WH_ACTIVE
const BR_INACTIVE = 'ITB-CWB-INACTIVE';  // inactive branch
const BR_NOWH = 'ITB-CWB-NOWH';          // active branch, no warehouse_id
const BR_BOGUS = 'ITB-CWB-DOES-NOT-EXIST';

const WH_ACTIVE = 'ITW-CWB-ACTIVE';
const WH_INACTIVE = 'ITW-CWB-INACTIVE';
const WH_BOGUS = 'ITW-CWB-DOES-NOT-EXIST';

let pass = 0, fail = 0; const fails = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; fails.push(name); console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 300) : ''); }
}

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
    r.setTimeout(10000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
function tok(id, username, role) {
  return jwt.sign({ id, username, role, isDeveloper: false, tokenVersion: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/cashier-readiness', cashierReadinessRouter);
  return app;
}

async function cleanup() {
  const usernames = [ADMIN, U_EXISTING, U_NOBRANCH, U_NOCAP, U_READY, U_MGR, U_CASHIER_RBAC];
  await db.query('DELETE FROM user_permission_overrides WHERE username IN (?)', [usernames]).catch(() => {});
  await db.query('DELETE FROM audit_log WHERE username IN (?)', [usernames]).catch(() => {});
  await db.query('DELETE FROM users WHERE username IN (?)', [usernames]).catch(() => {});
  await db.query('DELETE FROM warehouses WHERE id IN (?)', [[WH_ACTIVE, WH_INACTIVE]]).catch(() => {});
  await db.query('DELETE FROM branches WHERE id IN (?)', [[BR_ACTIVE, BR_INACTIVE, BR_NOWH]]).catch(() => {});
}

async function seed() {
  await cleanup();
  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [ADMIN, hash, 'admin']);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [U_MGR, hash, 'manager']);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [U_CASHIER_RBAC, hash, 'cashier']);
  await db.query(
    'INSERT INTO users (username,password,role,active,branch_id,default_warehouse_id) VALUES (?,?,?,1,NULL,NULL)',
    [U_EXISTING, hash, 'cashier']
  );

  await db.query("INSERT INTO warehouses (id,code,name,is_active) VALUES (?,?,?,1)", [WH_ACTIVE, 'CWBWA', 'مستودع اختبار نشط']);
  await db.query("INSERT INTO warehouses (id,code,name,is_active) VALUES (?,?,?,0)", [WH_INACTIVE, 'CWBWI', 'مستودع اختبار معطل']);

  await db.query("INSERT INTO branches (id,name,is_active,warehouse_id) VALUES (?,?,1,?)", [BR_ACTIVE, 'فرع اختبار نشط', WH_ACTIVE]);
  await db.query("INSERT INTO branches (id,name,is_active,warehouse_id) VALUES (?,?,0,NULL)", [BR_INACTIVE, 'فرع اختبار معطل']);
  await db.query("INSERT INTO branches (id,name,is_active,warehouse_id) VALUES (?,?,1,NULL)", [BR_NOWH, 'فرع اختبار بلا مستودع']);

  // Synthesized NOT-READY cashier: active account, but no branch at all.
  await db.query(
    'INSERT INTO users (username,password,role,active,branch_id,default_warehouse_id) VALUES (?,?,?,1,NULL,NULL)',
    [U_NOBRANCH, hash, 'cashier']
  );

  // Synthesized NOT-READY cashier: valid active branch+warehouse, but pos.use revoked.
  await db.query(
    'INSERT INTO users (username,password,role,active,branch_id,default_warehouse_id) VALUES (?,?,?,1,?,?)',
    [U_NOCAP, hash, 'cashier', BR_ACTIVE, WH_ACTIVE]
  );
  await db.query(
    "INSERT INTO user_permission_overrides (username,permission_id,grant_type) VALUES (?, 'pos.use', 'revoke')",
    [U_NOCAP]
  );

  // Synthesized READY cashier: active account, active branch+warehouse,
  // default role_permissions('cashier') already grants pos.use + pos.shift_close.
  await db.query(
    'INSERT INTO users (username,password,role,active,branch_id,default_warehouse_id) VALUES (?,?,?,1,?,?)',
    [U_READY, hash, 'cashier', BR_ACTIVE, WH_ACTIVE]
  );

  const [ids] = await db.query(
    'SELECT username, id FROM users WHERE username IN (?)',
    [[ADMIN, U_MGR, U_CASHIER_RBAC, U_EXISTING, U_NOBRANCH, U_NOCAP, U_READY]]
  );
  const idOf = {};
  ids.forEach((r) => { idOf[r.username] = r.id; });
  return idOf;
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n═══ Owner B — cashier validation + readiness (hermetic bootstrap) ═══\n');

  const ids = await seed();
  const admin = tok(ids[ADMIN], ADMIN, 'admin');
  const manager = tok(ids[U_MGR], U_MGR, 'manager');
  const cashierRbac = tok(ids[U_CASHIER_RBAC], U_CASHIER_RBAC, 'cashier');

  const server = buildApp().listen(PORT);
  try {
    // ── 1) POST /api/auth/users — branch/warehouse validation ──────────────
    console.log('▸ POST /users branch/warehouse validation');
    let r = await req('POST', '/api/auth/users', admin, {
      username: 'itest_cwb_create_bogus_branch', password: PW, role: 'cashier', branchId: BR_BOGUS
    });
    check('nonexistent branch → 422 BRANCH_NOT_FOUND', r.status === 422 && r.body && r.body.code === 'BRANCH_NOT_FOUND', r.body);

    r = await req('POST', '/api/auth/users', admin, {
      username: 'itest_cwb_create_inactive_branch', password: PW, role: 'cashier', branchId: BR_INACTIVE
    });
    check('inactive branch → 422 BRANCH_INACTIVE', r.status === 422 && r.body && r.body.code === 'BRANCH_INACTIVE', r.body);

    r = await req('POST', '/api/auth/users', admin, {
      username: 'itest_cwb_create_bogus_wh', password: PW, role: 'cashier', branchId: BR_NOWH, defaultWarehouseId: WH_BOGUS
    });
    check('nonexistent explicit warehouse → 422 WAREHOUSE_NOT_FOUND', r.status === 422 && r.body && r.body.code === 'WAREHOUSE_NOT_FOUND', r.body);

    r = await req('POST', '/api/auth/users', admin, {
      username: 'itest_cwb_create_inactive_wh', password: PW, role: 'cashier', branchId: BR_NOWH, defaultWarehouseId: WH_INACTIVE
    });
    check('inactive explicit warehouse → 422 WAREHOUSE_INACTIVE', r.status === 422 && r.body && r.body.code === 'WAREHOUSE_INACTIVE', r.body);

    const CREATED = 'itest_cwb_create_ok';
    r = await req('POST', '/api/auth/users', admin, {
      username: CREATED, password: PW, role: 'cashier', branchId: BR_ACTIVE
    });
    check('valid active branch (auto-derived warehouse) → 200 success', r.status === 200 && r.body && r.body.success === true, r.body);
    const [createdRow] = await db.query('SELECT branch_id, default_warehouse_id FROM users WHERE username=?', [CREATED]);
    check('  …default_warehouse_id auto-derived from branch.warehouse_id', createdRow.length === 1 && createdRow[0].default_warehouse_id === WH_ACTIVE, createdRow[0]);
    await db.query('DELETE FROM users WHERE username=?', [CREATED]);

    // ── 2) PUT /api/auth/users/:username — same validation ─────────────────
    console.log('▸ PUT /users/:username branch/warehouse validation');
    r = await req('PUT', '/api/auth/users/' + U_EXISTING, admin, { branchId: BR_BOGUS });
    check('nonexistent branch → 422 BRANCH_NOT_FOUND', r.status === 422 && r.body && r.body.code === 'BRANCH_NOT_FOUND', r.body);

    r = await req('PUT', '/api/auth/users/' + U_EXISTING, admin, { branchId: BR_INACTIVE });
    check('inactive branch → 422 BRANCH_INACTIVE', r.status === 422 && r.body && r.body.code === 'BRANCH_INACTIVE', r.body);

    r = await req('PUT', '/api/auth/users/' + U_EXISTING, admin, { branchId: BR_NOWH, defaultWarehouseId: WH_BOGUS });
    check('nonexistent explicit warehouse → 422 WAREHOUSE_NOT_FOUND', r.status === 422 && r.body && r.body.code === 'WAREHOUSE_NOT_FOUND', r.body);

    r = await req('PUT', '/api/auth/users/' + U_EXISTING, admin, { branchId: BR_NOWH, defaultWarehouseId: WH_INACTIVE });
    check('inactive explicit warehouse → 422 WAREHOUSE_INACTIVE', r.status === 422 && r.body && r.body.code === 'WAREHOUSE_INACTIVE', r.body);

    const [beforeRow] = await db.query('SELECT branch_id, default_warehouse_id FROM users WHERE username=?', [U_EXISTING]);
    check('  …rejected writes never touched the row (still NULL/NULL)', beforeRow.length === 1 && beforeRow[0].branch_id === null && beforeRow[0].default_warehouse_id === null, beforeRow[0]);

    r = await req('PUT', '/api/auth/users/' + U_EXISTING, admin, { branchId: BR_ACTIVE });
    check('valid active branch → 200 success', r.status === 200 && r.body && r.body.success === true, r.body);
    const [afterRow] = await db.query('SELECT branch_id, default_warehouse_id FROM users WHERE username=?', [U_EXISTING]);
    check('  …default_warehouse_id auto-derived from branch.warehouse_id', afterRow.length === 1 && afterRow[0].default_warehouse_id === WH_ACTIVE, afterRow[0]);

    // ── 3) GET /api/cashier-readiness — RBAC ────────────────────────────────
    console.log('▸ GET /api/cashier-readiness RBAC');
    r = await req('GET', '/api/cashier-readiness', null);
    check('no token → 401', r.status === 401, r.status);
    r = await req('GET', '/api/cashier-readiness', cashierRbac);
    check('cashier role → 403 (admin/manager only)', r.status === 403, r.status);
    r = await req('GET', '/api/cashier-readiness', manager);
    check('manager role → 200 (allowed)', r.status === 200, r.status);

    // ── 4) GET /api/cashier-readiness — diagnostics ─────────────────────────
    console.log('▸ GET /api/cashier-readiness diagnostics');
    r = await req('GET', '/api/cashier-readiness', admin);
    check('200 + success + data array', r.status === 200 && r.body && r.body.success === true && Array.isArray(r.body.data), r.body);
    const data = (r.body && r.body.data) || [];

    const rowNoBranch = data.find((x) => x.username === U_NOBRANCH);
    check('synthesized no-branch cashier is present', !!rowNoBranch, data.map((x) => x.username));
    check('  …ready=false', rowNoBranch && rowNoBranch.ready === false, rowNoBranch);
    check('  …reasons includes NO_BRANCH', rowNoBranch && rowNoBranch.reasons.indexOf('NO_BRANCH') !== -1, rowNoBranch && rowNoBranch.reasons);
    check('  …reasons includes NO_WAREHOUSE too (no branch ⇒ no warehouse)', rowNoBranch && rowNoBranch.reasons.indexOf('NO_WAREHOUSE') !== -1, rowNoBranch && rowNoBranch.reasons);
    check('  …repairAction=ASSIGN_BRANCH', rowNoBranch && rowNoBranch.repairAction === 'ASSIGN_BRANCH', rowNoBranch && rowNoBranch.repairAction);

    const rowNoCap = data.find((x) => x.username === U_NOCAP);
    check('synthesized revoked-capability cashier is present', !!rowNoCap, data.map((x) => x.username));
    check('  …ready=false', rowNoCap && rowNoCap.ready === false, rowNoCap);
    check('  …reasons includes MISSING_CAP:pos.use', rowNoCap && rowNoCap.reasons.indexOf('MISSING_CAP:pos.use') !== -1, rowNoCap && rowNoCap.reasons);
    check('  …reasons does NOT include MISSING_CAP:pos.shift_close (not revoked)', rowNoCap && rowNoCap.reasons.indexOf('MISSING_CAP:pos.shift_close') === -1, rowNoCap && rowNoCap.reasons);
    check('  …branch/warehouse are fine (no NO_BRANCH/NO_WAREHOUSE)', rowNoCap && rowNoCap.reasons.indexOf('NO_BRANCH') === -1 && rowNoCap.reasons.indexOf('NO_WAREHOUSE') === -1, rowNoCap && rowNoCap.reasons);
    check('  …repairAction=GRANT_CAPABILITY', rowNoCap && rowNoCap.repairAction === 'GRANT_CAPABILITY', rowNoCap && rowNoCap.repairAction);

    const rowReady = data.find((x) => x.username === U_READY);
    check('synthesized ready cashier is present', !!rowReady, data.map((x) => x.username));
    check('  …ready=true with zero reasons', rowReady && rowReady.ready === true && rowReady.reasons.length === 0, rowReady);
    check('  …repairAction=null', rowReady && rowReady.repairAction === null, rowReady && rowReady.repairAction);
    check('  …branchId/branchName/warehouseId/warehouseName populated', rowReady && rowReady.branchId === BR_ACTIVE && rowReady.warehouseId === WH_ACTIVE && !!rowReady.branchName && !!rowReady.warehouseName, rowReady);
  } finally {
    server.close();
    await cleanup();
    try { await db.end(); } catch (_) {}
  }

  console.log('\n══════════════════');
  console.log(fail === 0 ? `✅ ALL ${pass} CHECKS PASSED` : `❌ ${fail} FAILED / ${pass} passed`);
  if (fail) console.log(fails.map((f) => '  - ' + f).join('\n'));
  console.log('══════════════════\n');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
