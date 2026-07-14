'use strict';
/*
 * securityPolicies.api.test.js — Advanced security policies contract.
 *
 * Self-boots the real server against the .env DB (PORT 3271) and asserts:
 *   1. RBAC — a non-admin (cashier) GET and PUT are 403; admin passes.
 *   2. GET returns sensible defaults when unset.
 *   3. admin PUT → GET round-trips each block (password policy / session / IP allowlist).
 *   4. invalid payloads → 400 (bad minLength, enabled-but-empty allowlist, bad CIDR, bad session).
 *   5. ENFORCEMENT — after storing a stricter password policy, the change-password
 *      route rejects a password that was valid under the default policy (proves
 *      lib/passwordPolicy honors the stored policy with no edit to auth.js).
 *
 * Run: node tests/integration/securityPolicies.api.test.js   (MySQL on 127.0.0.1:3306)
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const ROOT = path.join(__dirname, '..', '..');
const db = require('../../db/connection');

const ENV = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (m) ENV[m[1]] = m[2];
}
const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
const PORT = 3271;
const BASE = `http://127.0.0.1:${PORT}`;
const T = {
  admin:   jwt.sign({ id: 1, username: 'admin', role: 'admin', tokenVersion: 1 }, ENV.JWT_SECRET, { expiresIn: '1h' }),
  cashier: jwt.sign({ id: 900711, username: 'secpol_cash', role: 'cashier', tokenVersion: 1 }, ENV.JWT_SECRET, { expiresIn: '1h' }),
};

const U = 'secpol_test_user';
const PW0 = 'OldPass#2024xy'; // strong current password (valid under defaults)

let _p = 0, _f = 0;
function check(name, cond, extra) {
  if (cond) { _p++; console.log('  ✅', name); }
  else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 200) : ''); }
}
async function waitUp(secs) {
  for (let i = 0; i < secs; i++) {
    try { const r = await fetch(BASE + '/api/version'); if (r.ok) return true; } catch (_) {}
    await new Promise((z) => setTimeout(z, 1000));
  }
  return false;
}
async function j(method, pathname, tok, body) {
  const r = await fetch(BASE + '/api' + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}
async function cleanup() {
  try { await db.query('DELETE FROM users WHERE username=?', [U]); } catch (_) {}
  try { await db.query("DELETE FROM audit_log WHERE username=?", [U]); } catch (_) {}
  try { await db.query("DELETE FROM settings WHERE setting_key IN ('SecurityPasswordPolicy','SecuritySession','SecurityIpAllowlist')"); } catch (_) {}
}

async function main() {
  console.log('\n═══ Advanced security policies (RBAC · round-trip · enforcement) ═══\n');
  await cleanup();
  // enforcement fixture: a cashier with a known strong password
  const hash = await bcrypt.hash(PW0, 12);
  await db.query('INSERT INTO users (username, password, role, active) VALUES (?,?,?,1)', [U, hash, 'cashier']);

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childLog = ''; child.stdout.on('data', d => childLog += d); child.stderr.on('data', d => childLog += d);

  try {
    check('server up', await waitUp(240));

    // 1. RBAC — cashier is refused on both read and write
    const cashGet = await j('GET', '/security-policies', T.cashier);
    check('cashier GET → 403', cashGet.status === 403, { status: cashGet.status });
    const cashPut = await j('PUT', '/security-policies', T.cashier, { session: { idleTimeoutMinutes: 10, absoluteTimeoutHours: 8 } });
    check('cashier PUT → 403', cashPut.status === 403, { status: cashPut.status });

    // 2. admin GET → sensible defaults when unset
    const g0 = await j('GET', '/security-policies', T.admin);
    check('admin GET → 200', g0.status === 200, { status: g0.status, data: g0.data });
    const d0 = g0.data || {};
    check('defaults: passwordPolicy.minLength = 12', d0.passwordPolicy && d0.passwordPolicy.minLength === 12, d0.passwordPolicy);
    check('defaults: session present', !!d0.session && typeof d0.session.idleTimeoutMinutes === 'number', d0.session);
    check('defaults: ipAllowlist disabled + empty', d0.ipAllowlist && d0.ipAllowlist.enabled === false && Array.isArray(d0.ipAllowlist.cidrs) && d0.ipAllowlist.cidrs.length === 0, d0.ipAllowlist);

    // 3. admin PUT valid → GET round-trip
    const payload = {
      passwordPolicy: { minLength: 14, requireUpper: true, requireNumber: true, requireSymbol: true, expiryDays: 90 },
      session: { idleTimeoutMinutes: 20, absoluteTimeoutHours: 10 },
      ipAllowlist: { enabled: false, cidrs: ['10.0.0.0/24', '192.168.1.50'] },
    };
    const put1 = await j('PUT', '/security-policies', T.admin, payload);
    check('admin PUT valid → 200 success', put1.status === 200 && put1.data && put1.data.success === true, put1.data);
    const g1 = await j('GET', '/security-policies', T.admin);
    const d1 = g1.data || {};
    check('round-trip: passwordPolicy persisted', d1.passwordPolicy && d1.passwordPolicy.minLength === 14 && d1.passwordPolicy.requireUpper === true && d1.passwordPolicy.expiryDays === 90, d1.passwordPolicy);
    check('round-trip: session persisted', d1.session && d1.session.idleTimeoutMinutes === 20 && d1.session.absoluteTimeoutHours === 10, d1.session);
    check('round-trip: ipAllowlist persisted', d1.ipAllowlist && d1.ipAllowlist.enabled === false && d1.ipAllowlist.cidrs.length === 2, d1.ipAllowlist);

    // partial PUT — only session; other blocks untouched
    const put2 = await j('PUT', '/security-policies', T.admin, { session: { idleTimeoutMinutes: 45, absoluteTimeoutHours: 12 } });
    check('partial PUT (session only) → 200', put2.status === 200 && put2.data.success === true, put2.data);
    const g2 = await j('GET', '/security-policies', T.admin);
    check('partial PUT kept password policy intact', g2.data.passwordPolicy.minLength === 14 && g2.data.session.idleTimeoutMinutes === 45, g2.data);

    // 4. invalid payloads → 400
    const badLen = await j('PUT', '/security-policies', T.admin, { passwordPolicy: { minLength: 2, expiryDays: 0 } });
    check('minLength too small → 400', badLen.status === 400, badLen.data);
    const badEmpty = await j('PUT', '/security-policies', T.admin, { ipAllowlist: { enabled: true, cidrs: [] } });
    check('enabled allowlist with no CIDRs → 400', badEmpty.status === 400, badEmpty.data);
    const badCidr = await j('PUT', '/security-policies', T.admin, { ipAllowlist: { enabled: false, cidrs: ['999.1.1.1'] } });
    check('malformed CIDR → 400', badCidr.status === 400, badCidr.data);
    const badSession = await j('PUT', '/security-policies', T.admin, { session: { idleTimeoutMinutes: 99999, absoluteTimeoutHours: 1 } });
    check('out-of-range idle timeout → 400', badSession.status === 400, badSession.data);
    const empty = await j('PUT', '/security-policies', T.admin, {});
    check('empty body → 400', empty.status === 400, empty.data);

    // 5. ENFORCEMENT — stored password policy is honored by change-password
    // Store a strict policy (minLength 24) then try a 12-char (valid-under-default) new password.
    const putStrict = await j('PUT', '/security-policies', T.admin, {
      passwordPolicy: { minLength: 24, requireUpper: true, requireNumber: true, requireSymbol: true, expiryDays: 0 },
    });
    check('store strict policy (minLength 24) → 200', putStrict.status === 200, putStrict.data);
    const login = await j('POST', '/auth/login', null, { username: U, password: PW0 });
    check('fixture user login → token', login.status === 200 && login.data && login.data.token, login.data && login.data.error);
    const userTok = login.data && login.data.token;
    const change = await j('POST', '/auth/change-password', userTok, { currentPassword: PW0, newPassword: 'Short#Pass12' /* 12 chars, upper+num+sym */ });
    check('12-char new password rejected under minLength-24 policy → 422 WEAK_PASSWORD', change.status === 422 && change.data && change.data.code === 'WEAK_PASSWORD', { status: change.status, code: change.data && change.data.code });

  } catch (e) {
    check('no exception', false, e && e.message);
    console.log(childLog.slice(-2000));
  } finally {
    child.kill('SIGKILL');
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  console.log(`\n─── ${_p} passed, ${_f} failed ───\n`);
  process.exit(_f ? 1 : 0);
}
main();
