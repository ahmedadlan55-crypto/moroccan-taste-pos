'use strict';
/* Integration — global /api auth-gate narrowing + hr_departments round-trip
 * (real server + DB, synthesized fixtures).
 *
 * What this locks in (close/g3-core):
 *   · /settings is public for GET ONLY — the login pages read branding before
 *     auth, but an anonymous WRITE must hit the JWT gate (401), even though
 *     routes/settings.js re-verifies inline (defense-in-depth).
 *   · /hr/departments and /hr/leave-types are NO LONGER public — they exposed
 *     the org directory to anonymous callers.
 *   · /shifts/:id/full-report-print is NO LONGER public — it served the full
 *     financial shift report to anyone with the URL. (A parallel change makes
 *     the route itself token-aware for the print-tab flow.)
 *   · hr_departments manager_id / parent_id / description exist (boot
 *     migration) and POST /hr/departments actually persists them — it used to
 *     parse then silently DROP all three while returning success:true.
 *
 * Run: node tests/integration/authGate.api.test.js
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const PORT = 3995;
const ADMIN = 'itest_authgate_admin';
const PW = 'AuthGate#Test!2026';
const DEPT_NAME = 'ITEST-AUTHGATE-DEPT';
const DEPT_CODE = 'ITEST-AG-1';
const MGR_ID = 'EMP-ITEST-AG-MGR';
const PARENT_ID = 'DEP-ITEST-AG-PARENT';
const DESC = 'قسم اختبار تكاملي — يُحذف تلقائيًا';
let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 220) : ''); } }

function call(method, p, token, body, headers = {}) {
  return new Promise((res) => {
    const d = body ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json', ...headers };
    if (token) h.Authorization = 'Bearer ' + token;
    if (d) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(d); }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h }, (s) => {
      let b = ''; s.on('data', (c) => (b += c)); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, body: j }); });
    });
    r.on('error', () => res({ status: 0 })); if (d) r.write(d); r.end();
  });
}
const login = async (u) => (await call('POST', '/api/auth/login', null, { username: u, password: PW })).body?.token || '';
async function waitUp() { for (let i = 0; i < 120; i++) { const ok = await new Promise((z) => http.get('http://127.0.0.1:' + PORT + '/api/version', (s) => z(s.statusCode === 200)).on('error', () => z(false))); if (ok) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }

async function cleanup() {
  try { await db.query('DELETE FROM users WHERE username=?', [ADMIN]); } catch (_) {}
  try { await db.query('DELETE FROM hr_departments WHERE name=? OR code=?', [DEPT_NAME, DEPT_CODE]); } catch (_) {}
}

(async () => {
  await cleanup();
  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [ADMIN, hash, 'admin']);

  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    console.log('\n═══ auth gate narrowing ═══');

    // ── migration: the three columns hr.js selects/writes actually exist ──
    const [cols] = await db.query(
      "SELECT COLUMN_NAME, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='hr_departments' AND COLUMN_NAME IN ('manager_id','parent_id','description')");
    check('migration added hr_departments manager_id/parent_id/description (additive, nullable)',
      cols.length === 3 && cols.every((c) => c.IS_NULLABLE === 'YES'), cols);

    // ── (a) /settings: GET stays public (login branding), writes do not ──
    const anonGet = await call('GET', '/api/settings', null);
    check('anonymous GET /api/settings still 200 (login pages read branding)',
      anonGet.status === 200 && anonGet.body && typeof anonGet.body === 'object', { status: anonGet.status });
    const anonPut = await call('PUT', '/api/settings', null, { CompanyName: 'HACKED' });
    check('anonymous PUT /api/settings → 401 (write no longer rides the GET exemption)',
      anonPut.status === 401, { status: anonPut.status, body: anonPut.body });

    // ── (b) org directory is no longer anonymous ──
    const anonDepts = await call('GET', '/api/hr/departments', null);
    check('anonymous GET /api/hr/departments → 401', anonDepts.status === 401, { status: anonDepts.status, body: anonDepts.body });
    const anonLeave = await call('GET', '/api/hr/leave-types', null);
    check('anonymous GET /api/hr/leave-types → 401', anonLeave.status === 401, { status: anonLeave.status, body: anonLeave.body });

    // ── (d) printable shift report is no longer anonymous ──
    const anonPrint = await call('GET', '/api/shifts/x/full-report-print', null);
    check('anonymous GET /api/shifts/x/full-report-print → 401', anonPrint.status === 401, { status: anonPrint.status, body: anonPrint.body });

    // ── (c) authenticated flow still works AND the write round-trips ──
    const admin = await login(ADMIN);
    check('admin authenticates', !!admin);

    const created = await call('POST', '/api/hr/departments', admin, {
      name: DEPT_NAME, code: DEPT_CODE, managerId: MGR_ID, parentId: PARENT_ID, description: DESC,
    });
    check('admin can create a department', created.body && created.body.success === true, created.body);

    const list = await call('GET', '/api/hr/departments', admin);
    check('admin GET /api/hr/departments → 200 (narrowing did not break the authed path)',
      list.status === 200 && Array.isArray(list.body), { status: list.status });
    const mine = Array.isArray(list.body) ? list.body.find((d) => d.id === (created.body && created.body.id)) : null;
    check('the created department is listed', !!mine, created.body);
    check('manager_id ROUND-TRIPS (was parsed then silently dropped)', !!mine && mine.managerId === MGR_ID, mine && mine.managerId);
    check('parent_id ROUND-TRIPS', !!mine && mine.parentId === PARENT_ID, mine && mine.parentId);
    check('description ROUND-TRIPS', !!mine && mine.description === DESC, mine && mine.description);

    // the UPDATE path persists them too (same silent-drop bug, second branch)
    const updated = await call('POST', '/api/hr/departments', admin, {
      id: created.body.id, name: DEPT_NAME, code: DEPT_CODE,
      managerId: MGR_ID + '-2', parentId: PARENT_ID, description: DESC + ' (2)',
    });
    check('update succeeds', updated.body && updated.body.success === true, updated.body);
    const list2 = await call('GET', '/api/hr/departments', admin);
    const mine2 = Array.isArray(list2.body) ? list2.body.find((d) => d.id === created.body.id) : null;
    check('the UPDATE branch persists manager_id/description too',
      !!mine2 && mine2.managerId === MGR_ID + '-2' && mine2.description === DESC + ' (2)',
      mine2 && { managerId: mine2.managerId, description: mine2.description });

    console.log(`\n${fail === 0 ? '✅' : '❌'} authGate: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
