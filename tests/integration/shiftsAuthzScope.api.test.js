/**
 * GET /api/shifts authz + brand scope fix — integration test (REAL server).
 *
 * Before this change GET /api/shifts had NO requireRole/requireCapability
 * guard and NO branch/username filter at all: any authenticated caller,
 * regardless of role, could list EVERY shift in the system — including
 * another cashier's drawer counts and variance. This test proves:
 *
 *   • a plain cashier (and any other non-supervisor role) is ALWAYS
 *     self-scoped to their own username, with no capability gate — same
 *     rule GET /api/pos/v2/orders already applies,
 *   • a supervisor (admin/manager) defaults to their own resolved BRAND
 *     (via the new shifts.branch_id snapshot, populated at OPEN time),
 *   • ?allBranches=1 is silently ignored unless the caller holds
 *     `pos.catalog.viewAllBrands` (the SAME capability introduced for
 *     routes/pos-v2.js — granted here via a targeted, self-cleaning
 *     user_permission_overrides row),
 *   • a pre-migration shift (branch_id IS NULL) stays visible to every
 *     brand-scoped supervisor.
 *
 * Run: node tests/integration/shiftsAuthzScope.api.test.js
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = Number(process.env.SHIFTSCOPE_TEST_PORT || 4003);
const BASE = { host: '127.0.0.1', port: PORT };

const BRAND_A = 'BILI-SHFT-BRAND-A', BRAND_B = 'BILI-SHFT-BRAND-B';
const BRANCH_A = 'BILI-SHFT-BRANCH-A', BRANCH_B = 'BILI-SHFT-BRANCH-B';
const U_CASH_A = 'bili_shft_cash_a', U_CASH_B = 'bili_shft_cash_b';
const U_MGR_A = 'bili_shft_mgr_a', U_EMP_A = 'bili_shft_emp_a';
const CAP_ID = 'pos.catalog.viewAllBrands';
const NULL_BRANCH_SHIFT = 'BILISHFTNULLBR01';

let _p = 0, _f = 0;
function check(name, cond, extra) { if (cond) { _p++; console.log('  ✅', name); } else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 400) : ''); } }

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
    ['DELETE FROM shifts WHERE username IN (?,?,?,?)', [U_CASH_A, U_CASH_B, U_MGR_A, U_EMP_A]],
    ['DELETE FROM shifts WHERE id = ?', [NULL_BRANCH_SHIFT]],
    ['DELETE FROM user_permission_overrides WHERE username = ? AND permission_id = ?', [U_MGR_A, CAP_ID]],
    ['DELETE FROM users WHERE username IN (?,?,?,?)', [U_CASH_A, U_CASH_B, U_MGR_A, U_EMP_A]],
    ['DELETE FROM branches WHERE id IN (?,?)', [BRANCH_A, BRANCH_B]],
    ['DELETE FROM brands WHERE id IN (?,?)', [BRAND_A, BRAND_B]],
  ];
  for (const [s, p] of sqls) { try { await db.query(s, p); } catch (_) {} }
}

let _createdPermRow = false;
async function seed() {
  await cleanup();
  await db.query('INSERT INTO brands (id, name) VALUES (?,?),(?,?)', [BRAND_A, 'BILI Shift Brand A', BRAND_B, 'BILI Shift Brand B']);
  await db.query('INSERT INTO branches (id, name, brand_id) VALUES (?,?,?),(?,?,?)', [BRANCH_A, 'BILI Shift Branch A', BRAND_A, BRANCH_B, 'BILI Shift Branch B', BRAND_B]);
  await db.query('INSERT INTO users (username,password,role,branch_id) VALUES (?,?,?,?)', [U_CASH_A, 'disabled', 'cashier', BRANCH_A]);
  await db.query('INSERT INTO users (username,password,role,branch_id) VALUES (?,?,?,?)', [U_CASH_B, 'disabled', 'cashier', BRANCH_B]);
  await db.query('INSERT INTO users (username,password,role,branch_id) VALUES (?,?,?,?)', [U_MGR_A, 'disabled', 'manager', BRANCH_A]);
  await db.query('INSERT INTO users (username,password,role,branch_id) VALUES (?,?,?,?)', [U_EMP_A, 'disabled', 'employee', BRANCH_A]);
  const ids = {};
  for (const u of [U_CASH_A, U_CASH_B, U_MGR_A, U_EMP_A]) {
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
  console.log('\n═══ GET /api/shifts authz + brand scope — integration ═══\n');
  const ids = await seed();
  const cashA = tok(ids[U_CASH_A], U_CASH_A, 'cashier');
  const cashB = tok(ids[U_CASH_B], U_CASH_B, 'cashier');
  const mgrA = tok(ids[U_MGR_A], U_MGR_A, 'manager');
  const empA = tok(ids[U_EMP_A], U_EMP_A, 'employee');

  const server = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), NAME_EN_BACKFILL_DISABLE_WORKER: '1' }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }

    // ── 0) unauthenticated → 401 (the pre-existing global JWT gate; the
    //    route itself used to have NO guard beyond that at all) ──
    let r = await req('GET', '/api/shifts', null);
    check('no token → 401', r.status === 401, r.status);

    // ── 1) Open real shifts (snapshots branch_id at OPEN time) ──
    console.log('▸ open shifts (branch_id snapshot)');
    r = await req('POST', '/api/shifts/open', cashA, { device: { ua: 'shift-scope-test-a' } });
    const shiftA = r.body && (r.body.shiftId || (r.body.data && r.body.data.shiftId));
    check('cashier A opened a shift', r.status === 200 && !!shiftA, r.body);
    r = await req('POST', '/api/shifts/open', cashB, { device: { ua: 'shift-scope-test-b' } });
    const shiftB = r.body && (r.body.shiftId || (r.body.data && r.body.data.shiftId));
    check('cashier B opened a shift', r.status === 200 && !!shiftB, r.body);
    const [snapRow] = await db.query('SELECT branch_id FROM shifts WHERE id=?', [shiftA]);
    check('shift A was snapshotted with cashier A\'s branch_id', snapRow.length === 1 && snapRow[0].branch_id === BRANCH_A, snapRow[0]);

    // ── 2) Non-supervisors are ALWAYS self-scoped — cashier + employee ──
    console.log('▸ self-scope (non-supervisor)');
    r = await req('GET', '/api/shifts', cashA);
    let sidsA = (r.body || []).map((s) => s.id);
    check('cashier A sees only own shift', sidsA.includes(shiftA) && !sidsA.includes(shiftB), sidsA);
    r = await req('GET', '/api/shifts?allBranches=1', cashA);
    let sidsA2 = (r.body || []).map((s) => s.id);
    check('cashier self-scope UNAFFECTED by allBranches=1 (no capability gate)', sidsA2.includes(shiftA) && !sidsA2.includes(shiftB), sidsA2);
    r = await req('GET', '/api/shifts?username=' + U_CASH_B, cashA);
    let sidsA3 = (r.body || []).map((s) => s.id);
    check('cashier A cannot widen scope via ?username= either — still self-only', !sidsA3.includes(shiftB), sidsA3);
    r = await req('GET', '/api/shifts', empA);
    check('employee role (non-supervisor) is also authorized + self-scoped (empty list, opened no shift)', r.status === 200 && Array.isArray(r.body), r.status);

    // ── 3) Supervisor default: brand-scoped ──
    console.log('▸ supervisor brand scope');
    r = await req('GET', '/api/shifts', mgrA);
    let sidsM1 = (r.body || []).map((s) => s.id);
    check('manager A (brand A) sees shift A by default, not shift B', sidsM1.includes(shiftA) && !sidsM1.includes(shiftB), sidsM1);

    r = await req('GET', '/api/shifts?allBranches=1', mgrA);
    let sidsM2 = (r.body || []).map((s) => s.id);
    check('allBranches=1 WITHOUT the capability is ignored — still brand-scoped', sidsM2.includes(shiftA) && !sidsM2.includes(shiftB), sidsM2);

    await grantBypassCapability();
    r = await req('GET', '/api/shifts?allBranches=1', mgrA);
    let sidsM3 = (r.body || []).map((s) => s.id);
    check('allBranches=1 WITH the capability now sees every brand', sidsM3.includes(shiftA) && sidsM3.includes(shiftB), sidsM3);

    // ── 4) Pre-migration NULL branch_id shift stays visible ──
    console.log('▸ pre-migration NULL branch_id shift');
    const now = new Date();
    await db.query(
      "INSERT INTO shifts (id, username, start_time, status, branch_id) VALUES (?,?,?,?,NULL)",
      [NULL_BRANCH_SHIFT, U_CASH_B, now, 'OPEN']);
    r = await req('GET', '/api/shifts', mgrA);
    let sidsM4 = (r.body || []).map((s) => s.id);
    check('NULL branch_id shift visible to brand-scoped supervisor by default', sidsM4.includes(NULL_BRANCH_SHIFT), sidsM4);
  } finally {
    try { server.kill(); } catch (_) {}
    await revokeBypassCapability();
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  console.log(`\n${_f === 0 ? '✅' : '❌'} shiftsAuthzScope.api: ${_p} passed, ${_f} failed\n`);
  process.exit(_f === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
