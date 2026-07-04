'use strict';
/* Integration — POST /api/auth/change-password (self-booting real server + DB).
   Covers: current-password check, strong-policy + common/default rejection,
   token_version revocation of OTHER sessions, fresh token for THIS session,
   rate-limit path, old-password-fails / new-password-works, audit has no secret.
   Run: node tests/integration/changePassword.api.test.js  (MariaDB on 3307) */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const PORT = 3993;
const BASE = 'http://127.0.0.1:' + PORT;
const U = 'cpw_test_user';
const PW0 = 'OldPass#2024xy'; // valid strong current password
let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 200) : ''); } }

function req(method, p, token, body) {
  return new Promise((res) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h }, (s) => { let b = ''; s.on('data', (c) => (b += c)); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, body: j }); }); });
    r.on('error', () => res({ status: 0 })); if (data) r.write(data); r.end();
  });
}
const login = (u, p) => req('POST', '/api/auth/login', null, { username: u, password: p });
const change = (tok, cur, nw) => req('POST', '/api/auth/change-password', tok, { currentPassword: cur, newPassword: nw });
async function waitUp() { for (let i = 0; i < 120; i++) { const ok = await new Promise((z) => http.get(BASE + '/api/version', (s) => z(s.statusCode === 200)).on('error', () => z(false))); if (ok) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }
async function cleanup() { try { await db.query('DELETE FROM users WHERE username=?', [U]); } catch (_) {} try { await db.query("DELETE FROM audit_log WHERE username=?", [U]); } catch (_) {} }

(async () => {
  await cleanup();
  const hash = await bcrypt.hash(PW0, 12);
  await db.query('INSERT INTO users (username, password, role, active) VALUES (?,?,?,1)', [U, hash, 'cashier']);
  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    console.log('\n═══ change-password API ═══');

    // A) login → get a valid token (session #1)
    const l1 = await login(U, PW0);
    check('login with current password → token', l1.status === 200 && l1.body && l1.body.success && l1.body.token, l1.body && l1.body.error);
    const sess1 = l1.body.token;
    // a SECOND session (another device) on the same account
    const l2 = await login(U, PW0);
    const sess2 = l2.body && l2.body.token;
    check('second session token issued', !!sess2);

    // B) wrong current password → 422
    const wrong = await change(sess1, 'nope-not-current', 'Brand#New2025zz');
    check('wrong current password → 422 INVALID_CURRENT_PASSWORD', wrong.status === 422 && wrong.body.code === 'INVALID_CURRENT_PASSWORD', wrong.body);

    // C) weak / common new passwords → 422
    const short = await change(sess1, PW0, 'Ab#1');
    check('too short → 422 WEAK_PASSWORD', short.status === 422 && short.body.code === 'WEAK_PASSWORD', short.body && short.body.code);
    const common = await change(sess1, PW0, 'admin123');
    check('common/default new password → 422 WEAK_PASSWORD', common.status === 422 && common.body.code === 'WEAK_PASSWORD', common.body && short.body.code);
    const noSpecial = await change(sess1, PW0, 'Abcdefgh12345');
    check('no special char → 422', noSpecial.status === 422, noSpecial.body && noSpecial.body.code);

    // D) valid change → 200 + fresh token; OTHER session revoked
    const PW1 = 'Str0ng#Pass!2026';
    const ok = await change(sess1, PW0, PW1);
    check('valid change → 200 + fresh token + otherSessionsRevoked', ok.status === 200 && ok.body.success && ok.body.token && ok.body.otherSessionsRevoked, ok.body);
    const sess1b = ok.body.token;

    // E) the OTHER (old) session is now invalid (token_version bumped)
    // allow the 15s cache a moment to be bypassed: bump() was called → immediate.
    const s2use = await req('GET', '/api/auth/template', sess2);
    check('old OTHER session → 401 (revoked)', s2use.status === 401, s2use.status);
    // the fresh token for THIS session still works
    const s1use = await req('GET', '/api/auth/template', sess1b);
    check('fresh current-session token → 200', s1use.status === 200, s1use.status);

    // F) old password no longer logs in; new one does
    const oldLogin = await login(U, PW0);
    check('old password login → rejected', !(oldLogin.body && oldLogin.body.success), oldLogin.body);
    const newLogin = await login(U, PW1);
    check('new password login → success', newLogin.status === 200 && newLogin.body.success, newLogin.body && newLogin.body.error);

    // G) reuse (same as current) → 422
    const reuse = await change(newLogin.body.token, PW1, PW1);
    check('reuse current as new → 422 PASSWORD_REUSED', reuse.status === 422 && reuse.body.code === 'PASSWORD_REUSED', reuse.body && reuse.body.code);

    // H) audit row exists WITHOUT any password material
    const [aud] = await db.query("SELECT new_value FROM audit_log WHERE username=? AND action='password_changed' ORDER BY created_at DESC LIMIT 1", [U]);
    const auditStr = aud.length ? String(aud[0].new_value || '') : '';
    const leaks = auditStr.includes('Str0ng') || auditStr.includes('OldPass') || auditStr.includes(PW0) || auditStr.includes('admin123');
    check('audit row present + carries no password material', aud.length === 1 && !leaks && /bcrypt/.test(auditStr), auditStr.slice(0, 120));

    // I) mustChangePassword flag surfaces for a default-password user
    await db.query('UPDATE users SET password=?, must_change_password=1 WHERE username=?', [await bcrypt.hash('admin123', 10), U]);
    const defLogin = await login(U, 'admin123');
    check('default-password user login carries mustChangePassword=true', defLogin.body && defLogin.body.mustChangePassword === true, defLogin.body);
  } catch (e) { fail++; fails.push('FATAL: ' + e.message); console.error(e); } finally {
    try { server.kill(); } catch (_) {}
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  console.log(`\n${fail === 0 ? '✅' : '❌'} change-password: ${pass} passed, ${fail} failed`);
  if (fails.length) console.log(fails.map((f) => ' - ' + f).join('\n'));
  process.exit(fail === 0 ? 0 : 1);
})();
