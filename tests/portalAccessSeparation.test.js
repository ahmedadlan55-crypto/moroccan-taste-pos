#!/usr/bin/env node
'use strict';
/**
 * tests/portalAccessSeparation.test.js — a custody officer is a portal user in
 * their own right, and never an attendance employee by accident.
 *
 * WHAT WAS BROKEN
 *   The one installable app sends portal:"employee", and login refused any
 *   account without employee_portal=1. So the only way a custody officer could
 *   sign in was to be made an attendance employee too — five attendance tabs,
 *   and a home screen that opens on the clock. And /api/custody was gated on
 *   ROLE only: an `employee` with custody_portal=1 was told at login it had
 *   custody, shown the tab, and 403'd on first touch.
 *
 * WHAT THIS FILE PINS (real routes/auth + real middleware, live DB)
 *   1. Login with portal:"employee" admits custody_portal=1 alone, and echoes
 *      employeePortal:false / custodyPortal:true so the app can build the bar.
 *   2. An account with NEITHER flag is still refused.
 *   3. The JWT carries both flags, and requireRoleOrFlag opens /api/custody on
 *      the flag for a non-custody role — and still refuses an account with
 *      neither the role nor the flag.
 *   4. /hr/my-clock refuses an account whose employee_portal is 0, with a code
 *      the client can name. A custody officer cannot punch a clock.
 *   5. Flipping either portal flag bumps token_version, the way a role change
 *      does — a revoked custody flag must not keep opening the door for 24h.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db/connection');
const { requireRoleOrFlag } = require('../middleware/auth');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-portal-separation';

let _passed = 0, _failed = 0, _total = 0;
function test(name, fn) {
  _total++;
  return Promise.resolve().then(fn)
    .then(() => { _passed++; console.log('  ✅', name); })
    .catch((e) => { _failed++; console.log('  ❌', name); console.log('     ', e.message); });
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || ''} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const PW = 'Portal#Sep-2026!';
const U_CUSTODY = { id: 990401, username: 'psep_custody', role: 'employee', employee_portal: 0, custody_portal: 1 };
const U_EMP = { id: 990402, username: 'psep_emp', role: 'employee', employee_portal: 1, custody_portal: 0 };
const U_NONE = { id: 990403, username: 'psep_none', role: 'employee', employee_portal: 0, custody_portal: 0 };
const U_BOTH = { id: 990404, username: 'psep_both', role: 'employee', employee_portal: 1, custody_portal: 1 };
const ADMIN = { id: 990405, username: 'psep_admin', role: 'admin', employee_portal: 0, custody_portal: 0 };
const ALL = [U_CUSTODY, U_EMP, U_NONE, U_BOTH, ADMIN];

async function seed() {
  const hash = await bcrypt.hash(PW, 8);
  for (const u of ALL) {
    await db.query('DELETE FROM users WHERE id=? OR username=?', [u.id, u.username]);
    await db.query(
      'INSERT INTO users (id, username, password, role, active, employee_portal, custody_portal, token_version) VALUES (?,?,?,?,1,?,?,1)',
      [u.id, u.username, hash, u.role, u.employee_portal, u.custody_portal]);
  }
}
async function cleanup() {
  for (const u of ALL) {
    await db.query('DELETE FROM custody_users WHERE linked_username=?', [u.username]).catch(() => {});
    await db.query('DELETE FROM hr_employees WHERE linked_username=?', [u.username]).catch(() => {});
    await db.query('DELETE FROM users WHERE id=? OR username=?', [u.id, u.username]).catch(() => {});
  }
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  // A stand-in for the real /api/custody mount: the SAME guard, a stub route.
  app.use('/api/custody-gate', (req, _res, next) => {
    // verifyToken stand-in: decode the JWT the login handed out.
    try { req.user = jwt.verify(String(req.headers.authorization || '').replace(/^Bearer /, ''), process.env.JWT_SECRET); } catch (_) { req.user = null; }
    next();
  }, requireRoleOrFlag(['admin', 'manager', 'custody'], 'custodyPortal'), (_req, res) => res.json({ opened: true }));
  // The real HR router behind the same token stand-in.
  app.use('/api/hr', (req, _res, next) => {
    try { req.user = jwt.verify(String(req.headers.authorization || '').replace(/^Bearer /, ''), process.env.JWT_SECRET); } catch (_) { req.user = null; }
    next();
  }, require('../routes/hr'));
  return app;
}

async function main() {
  await cleanup();
  await seed();
  const app = buildApp();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, body, token) => {
    const res = await fetch(base + p, {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
      body: JSON.stringify(body || {}),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const get = async (p, token) => {
    const res = await fetch(base + p, { headers: token ? { authorization: 'Bearer ' + token } : {} });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const loginAs = (u, portal) => post('/api/auth/login', { username: u.username, password: PW, portal });

  try {
    console.log('\n1. the door: portal:"employee" admits a custody-only account');
    let custodyToken = '';
    await test('custody_portal alone signs in, and says what it is', async () => {
      const r = await loginAs(U_CUSTODY, 'employee');
      eq(r.json.success, true, 'signed in: ' + JSON.stringify(r.json).slice(0, 160));
      eq(r.json.custodyPortal, true, 'custodyPortal');
      eq(r.json.employeePortal, false, 'employeePortal — this is what removes the attendance tabs');
      custodyToken = r.json.token;
    });
    await test('an ordinary employee still signs in as an employee', async () => {
      const r = await loginAs(U_EMP, 'employee');
      eq(r.json.success, true);
      eq(r.json.employeePortal, true);
      eq(r.json.custodyPortal, false);
    });
    await test('an account with NEITHER flag is still refused', async () => {
      const r = await loginAs(U_NONE, 'employee');
      eq(r.json.success, false, 'refused');
      ok(/بوابة الموظف/.test(String(r.json.error)), 'names the portal');
    });

    console.log('\n2. the custody door opens on the FLAG, not only the role');
    await test('the JWT carries both flags', () => {
      const claims = jwt.verify(custodyToken, process.env.JWT_SECRET);
      eq(claims.custodyPortal, true);
      eq(claims.employeePortal, false);
    });
    await test('role=employee + custody flag opens /api/custody', async () => {
      const r = await get('/api/custody-gate', custodyToken);
      eq(r.status, 200, JSON.stringify(r.json));
      eq(r.json.opened, true);
    });
    await test('role=employee with NO custody flag is refused', async () => {
      const emp = await loginAs(U_EMP, 'employee');
      const r = await get('/api/custody-gate', emp.json.token);
      eq(r.status, 403, 'refused');
    });
    await test('the custody ROLE still opens it without the flag (admin here)', async () => {
      const a = await loginAs(ADMIN, '');
      const r = await get('/api/custody-gate', a.json.token);
      eq(r.status, 200);
    });

    console.log('\n3. a custody officer cannot punch a clock');
    await test('/hr/my-clock refuses employee_portal=0 with a named code', async () => {
      const r = await post('/api/hr/my-clock', { geoLat: 0, geoLng: 0 }, custodyToken);
      eq(r.status, 403, JSON.stringify(r.json).slice(0, 160));
      eq(r.json.code, 'attendance_not_enabled');
    });
    await test('an attendance employee is NOT refused by that gate', async () => {
      // No hr_employees row was seeded, so the handler's own next check fires —
      // proof the new gate let the request THROUGH to it.
      const emp = await loginAs(U_EMP, 'employee');
      const r = await post('/api/hr/my-clock', { geoLat: 0, geoLng: 0 }, emp.json.token);
      ok(r.json.code !== 'attendance_not_enabled', 'not the attendance gate: ' + JSON.stringify(r.json).slice(0, 120));
    });

    console.log('\n4. flipping a portal flag ends outstanding sessions');
    await test('revoking custody_portal bumps token_version', async () => {
      const a = await loginAs(ADMIN, '');
      const [[before]] = await db.query('SELECT token_version FROM users WHERE username=?', [U_BOTH.username]);
      const r = await fetch(base + '/api/auth/users/' + U_BOTH.username, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + a.json.token },
        body: JSON.stringify({ custodyPortal: false }),
      });
      ok(r.status < 500, 'update answered ' + r.status);
      const [[after]] = await db.query('SELECT token_version, custody_portal FROM users WHERE username=?', [U_BOTH.username]);
      eq(Number(after.custody_portal), 0, 'flag written');
      eq(Number(after.token_version), Number(before.token_version) + 1, 'session version bumped');
    });
    await test('saving the SAME flags does not log the user out', async () => {
      const a = await loginAs(ADMIN, '');
      const [[before]] = await db.query('SELECT token_version FROM users WHERE username=?', [U_EMP.username]);
      await fetch(base + '/api/auth/users/' + U_EMP.username, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + a.json.token },
        body: JSON.stringify({ employeePortal: true, custodyPortal: false }),
      });
      const [[after]] = await db.query('SELECT token_version FROM users WHERE username=?', [U_EMP.username]);
      eq(Number(after.token_version), Number(before.token_version), 'unchanged');
    });
  } finally {
    server.close();
    await cleanup();
    await db.end?.().catch?.(() => {});
  }

  console.log(`\n${_passed}/${_total} passed${_failed ? `, ${_failed} failed` : ''}`);
  if (_failed) process.exit(1);
  console.log('  ✅ custody officer: signs in alone, custody door opens on the flag, no clock, revocation ends sessions');
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
