'use strict';
/* Integration — user-management audit trail (real server + DB).
 *
 * Regression guard for a real defect found this session: _auditUserOp (the
 * write side backing the Users.tsx "audit trail" tab) inserted into audit_log
 * using column names that table has never had (entity_type/entity_id/
 * username-vs-user_username/details/ip) — every write silently failed via its
 * own catch. GET /users/:username/audit (the read side) had the matching bug
 * (filtered on entity_type/entity_id, columns that don't exist), so it always
 * returned [] regardless of whether anything had been written. Both are now
 * fixed to use the real schema (table_name/record_id/old_value/new_value/
 * ip_address) via lib/auditLogger.js's appendAuditEntry(). This proves the
 * FULL round trip: create → update → toggle → reset-password all produce a
 * REAL row the admin screen can read back, not just that the endpoint 200s.
 *
 * Run: node tests/integration/userAuditTrail.api.test.js   (port 3993)
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const PORT = 3993;
const ADMIN = 'itest_uat_admin';
const TARGET = 'itest_uat_target';
const PW = 'UserAudit#Trail!2026';

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 220) : ''); } }

function call(method, p, token, body) {
  return new Promise((res) => {
    const d = body ? JSON.stringify(body) : null;
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (d) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(d); }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers }, (s) => {
      let b = ''; s.on('data', (c) => (b += c)); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, body: j }); });
    });
    r.on('error', () => res({ status: 0 })); if (d) r.write(d); r.end();
  });
}
const login = async (u) => (await call('POST', '/api/auth/login', null, { username: u, password: PW })).body?.token || '';
async function waitUp() { for (let i = 0; i < 120; i++) { const ok = await new Promise((z) => http.get('http://127.0.0.1:' + PORT + '/api/version', (s) => z(s.statusCode === 200)).on('error', () => z(false))); if (ok) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }

async function cleanup() {
  for (const u of [ADMIN, TARGET]) { try { await db.query('DELETE FROM users WHERE username=?', [u]); } catch (_) {} }
  try { await db.query("DELETE FROM audit_log WHERE table_name='users' AND record_id=?", [TARGET]); } catch (_) {}
  try { await db.query("DELETE FROM audit_logs WHERE user_username=?", [ADMIN]); } catch (_) {}
}

(async () => {
  await cleanup();
  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [ADMIN, hash, 'admin']);

  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    console.log('\n═══ user-management audit trail ═══');

    const admin = await login(ADMIN);
    check('admin authenticates', !!admin);

    const create = await call('POST', '/api/auth/users', admin, { username: TARGET, password: 'Targ3t#Pass!', role: 'cashier' });
    check('target user created', create.status === 200 && create.body && create.body.success !== false, create.body);

    // ── separate regression guard: auditMiddleware('auth') writes to the
    // OTHER audit table (audit_logs, plural — mounted on /api/sales,
    // /api/inventory, /api/purchases, /api/erp, /api/custody, /api/hr,
    // /api/workflow, /api/auth, /api/procurement, /api/order-to-cash in
    // server.js). It had TWO independent bugs: a wrong column name
    // (username vs. user_username) and generating a string id for a bigint
    // AUTO_INCREMENT column — either alone made every write across ALL of
    // those route groups fail silently. This proves the actual middleware
    // path a real request goes through, not just a direct function call. ──
    const [auditLogsRows] = await db.query(
      "SELECT * FROM audit_logs WHERE entity_type='auth' AND action='CREATE' AND user_username=? ORDER BY id DESC LIMIT 1",
      [ADMIN]
    );
    check('auditMiddleware(\'auth\') wrote a REAL row for this request (was silently failing app-wide)',
      auditLogsRows.length > 0, auditLogsRows);

    const update = await call('PUT', '/api/auth/users/' + TARGET, admin, { role: 'manager' });
    check('target user updated', update.body && update.body.success !== false, update.body);

    const toggle = await call('POST', '/api/auth/users/' + TARGET + '/toggle', admin, {});
    check('target user toggled', toggle.body && toggle.body.success !== false, toggle.body);

    const reset = await call('POST', '/api/auth/users/' + TARGET + '/reset-password', admin, { password: 'NewTarg3t#Pass!' });
    check('target user password reset', reset.body && reset.body.success === true, reset.body);

    // ── the actual regression guard: the audit tab must show REAL rows ──
    const audit = await call('GET', '/api/auth/users/' + TARGET + '/audit', admin);
    check('audit endpoint 200s', audit.status === 200, { status: audit.status });
    check('audit trail is a non-empty array (THE bug: this used to always be [])',
      Array.isArray(audit.body) && audit.body.length > 0, audit.body);

    const actions = (audit.body || []).map(r => r.action);
    check('create_user recorded', actions.includes('create_user'), actions);
    check('update_user recorded', actions.includes('update_user'), actions);
    check('toggle_user_active recorded', actions.includes('toggle_user_active'), actions);
    check('reset_password recorded', actions.includes('reset_password'), actions);

    const createRow = (audit.body || []).find(r => r.action === 'create_user');
    check('each row carries the acting admin username', createRow && createRow.username === ADMIN, createRow);
    check('each row targets the right entity', createRow && createRow.entityId === TARGET, createRow);

    // ── prove the row is real in the DB too, not just shaped right in the response ──
    const [dbRows] = await db.query("SELECT action, table_name, record_id, username FROM audit_log WHERE table_name='users' AND record_id=? ORDER BY created_at ASC", [TARGET]);
    check('DB itself has the rows (not a route-level fabrication)', dbRows.length >= 4, { count: dbRows.length });

    // ── an unrelated user's audit trail must not see this user's history ──
    const otherAudit = await call('GET', '/api/auth/users/' + ADMIN + '/audit', admin);
    const leaked = (otherAudit.body || []).some(r => r.entityId === TARGET);
    check('another user\'s audit trail does not leak this target\'s rows', !leaked);

    console.log(`\n${fail === 0 ? '✅' : '❌'} userAuditTrail: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
