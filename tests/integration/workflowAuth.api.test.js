'use strict';
/* Integration — /api/workflow authentication + authorization (real server + DB).
 *
 * THREE defects, all proven live before the fix:
 *
 * 1. server.js exempted /workflow/* from the global JWT gate with the comment
 *    "auth checked inside". routes/workflow.js contained ZERO guards, so
 *    `GET /api/workflow/org-tree` answered 200 with the entire staff directory
 *    (full names, usernames, job titles, manager chain, branches) to a caller
 *    with NO Authorization header. `PUT /org-tree/:id` was equally open — anyone
 *    could rewrite the manager chain and grant themselves can_approve_txn.
 *
 * 2. Because the exemption meant req.user was never set, guardAdmin/guardDeveloper
 *    "compensated" by falling back to `req.query.username`, next to a
 *    `username === 'admin'` fast-path. So `?username=admin` authenticated as
 *    admin/developer with NO TOKEN — on routes including
 *    DELETE /transactions/__wipe-all. Proven: a tokenless
 *    `DELETE /transactions/NO-SUCH-ID?username=admin` reached the handler and
 *    answered 404 "المعاملة غير موجودة" instead of 401.
 *
 * 3. PUT /org-tree validated nothing: an employee could be made their own manager
 *    (A→A) or a cycle closed (A→B→A), which the org chart's nesting would hit.
 *
 * Run: node tests/integration/workflowAuth.api.test.js
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const PORT = 3989;
const CASHIER = 'itest_wf_cashier';
const MANAGER = 'itest_wf_manager';
const PW = 'Workflow#Test!2026';
const EMP_A = 'ITEST-WF-EMP-A';
const EMP_B = 'ITEST-WF-EMP-B';
const POS_FREE = 'ITEST-WF-POS-FREE';
const POS_USED = 'ITEST-WF-POS-USED';
let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 200) : ''); } }

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
  for (const u of [CASHIER, MANAGER]) { try { await db.query('DELETE FROM users WHERE username=?', [u]); } catch (_) {} }
  for (const e of [EMP_A, EMP_B]) { try { await db.query('DELETE FROM hr_employees WHERE id=?', [e]); } catch (_) {} }
  for (const p of [POS_FREE, POS_USED]) { try { await db.query('DELETE FROM positions WHERE id=?', [p]); } catch (_) {} }
}

(async () => {
  await cleanup();
  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [CASHIER, hash, 'cashier']);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [MANAGER, hash, 'manager']);
  await db.query("INSERT INTO hr_employees (id, employee_number, first_name, status) VALUES (?,?,?,'active')", [EMP_A, 'ITESTA', 'AlphaTest']);
  await db.query("INSERT INTO hr_employees (id, employee_number, first_name, status) VALUES (?,?,?,'active')", [EMP_B, 'ITESTB', 'BetaTest']);
  await db.query("INSERT INTO positions (id, name, level) VALUES (?,?,?)", [POS_FREE, 'ITEST Free Position', 1]);
  await db.query("INSERT INTO positions (id, name, level) VALUES (?,?,?)", [POS_USED, 'ITEST Used Position', 1]);
  await db.query('UPDATE hr_employees SET position_id=? WHERE id=?', [POS_USED, EMP_B]);

  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    console.log('\n═══ /api/workflow — auth + authz ═══');

    const [perms] = await db.query("SELECT id FROM permissions_v3 WHERE id IN ('workflow.view','workflow.manage') ORDER BY id");
    check('late-seed added workflow.view + workflow.manage', perms.length === 2, perms.map((p) => p.id));

    // ── 1. the staff-directory leak ──
    const anon = await call('GET', '/api/workflow/org-tree', null);
    check('org-tree with NO token is now 401 (was 200 + 27 employees)', anon.status === 401, { status: anon.status, got: Array.isArray(anon.body) ? anon.body.length + ' employees' : anon.body });

    const anonPut = await call('PUT', `/api/workflow/org-tree/${EMP_A}`, null, { permissions: { approve: true } });
    check('org-tree WRITE with no token is 401', anonPut.status === 401, { status: anonPut.status });

    // ── 2. THE BYPASS: ?username=admin with no token ──
    const bypass = await call('DELETE', '/api/workflow/transactions/NO-SUCH-ID-XYZ?username=admin', null);
    check('?username=admin with NO token no longer authenticates (was 404 = handler reached)',
      bypass.status === 401, { status: bypass.status, body: bypass.body });

    const bypassOrg = await call('GET', '/api/workflow/org-tree?username=admin', null);
    check('?username=admin cannot read the org chart either', bypassOrg.status === 401, { status: bypassOrg.status });

    const bypassBody = await call('POST', '/api/workflow/positions', null, { name: 'pwned', level: 9, username: 'admin' });
    check('username in the BODY cannot authenticate either', bypassBody.status === 401, { status: bypassBody.status });

    // ── 3. capability separation ──
    const cashier = await login(CASHIER);
    const manager = await login(MANAGER);
    check('both users authenticate', !!cashier && !!manager);

    const cashierRead = await call('GET', '/api/workflow/org-tree', cashier);
    check('cashier is DENIED reading the org chart', cashierRead.status === 403, { status: cashierRead.status });

    const cashierWrite = await call('PUT', `/api/workflow/org-tree/${EMP_A}`, cashier, { permissions: { approve: true } });
    check('cashier is DENIED granting themselves approval rights', cashierWrite.status === 403, { status: cashierWrite.status });

    const [afterCashier] = await db.query('SELECT can_approve_txn FROM hr_employees WHERE id=?', [EMP_A]);
    check('the permission really did not change after the denied write', !afterCashier[0].can_approve_txn, afterCashier[0]);

    const mgrRead = await call('GET', '/api/workflow/org-tree', manager);
    check('manager CAN read the org chart', mgrRead.status === 200 && Array.isArray(mgrRead.body), { status: mgrRead.status });
    check('the org chart still returns real rows', Array.isArray(mgrRead.body) && mgrRead.body.length > 0, Array.isArray(mgrRead.body) ? mgrRead.body.length : null);

    const mgrWrite = await call('PUT', `/api/workflow/org-tree/${EMP_A}`, manager, { workflowLevel: 3, permissions: { approve: true } });
    check('manager CAN edit (the guard hardens without removing the function)', mgrWrite.body && mgrWrite.body.success === true, mgrWrite.body);
    const [afterMgr] = await db.query('SELECT can_approve_txn, workflow_level FROM hr_employees WHERE id=?', [EMP_A]);
    check('the edit persisted', !!afterMgr[0].can_approve_txn && afterMgr[0].workflow_level === 3, afterMgr[0]);

    // ── 4. cycle prevention ──
    const self = await call('PUT', `/api/workflow/org-tree/${EMP_A}`, manager, { managerId: EMP_A });
    check('an employee cannot be their own manager', self.status === 400 && self.body && self.body.success === false, self.body);

    const ghost = await call('PUT', `/api/workflow/org-tree/${EMP_A}`, manager, { managerId: 'NO-SUCH-EMPLOYEE' });
    check('a nonexistent manager is refused', ghost.status === 400, { status: ghost.status });

    const missing = await call('PUT', '/api/workflow/org-tree/NO-SUCH-EMP', manager, { workflowLevel: 2 });
    check('editing a nonexistent employee is 404, not a silent no-op', missing.status === 404, { status: missing.status });

    // A → B, then B → A must be refused (closes a loop)
    const ab = await call('PUT', `/api/workflow/org-tree/${EMP_A}`, manager, { managerId: EMP_B });
    check('A can report to B', ab.body && ab.body.success === true, ab.body);
    const ba = await call('PUT', `/api/workflow/org-tree/${EMP_B}`, manager, { managerId: EMP_A });
    check('B cannot then report to A (A→B→A cycle refused)', ba.status === 400 && ba.body && /حلقة/.test(ba.body.error || ''), ba.body);
    const [noCycle] = await db.query('SELECT manager_id FROM hr_employees WHERE id=?', [EMP_B]);
    check('the cycle was really not stored', !noCycle[0].manager_id, noCycle[0]);

    const badLevel = await call('PUT', `/api/workflow/org-tree/${EMP_A}`, manager, { workflowLevel: 99 });
    check('an out-of-range level is refused', badLevel.status === 400, { status: badLevel.status });

    // ── 5. position delete reference check ──
    const delUsed = await call('DELETE', `/api/workflow/positions/${POS_USED}`, manager);
    check('deleting a position still linked to an employee is BLOCKED', delUsed.status === 409 && delUsed.body && delUsed.body.blocked === true, delUsed.body);
    check('the block names what references it', delUsed.body && Array.isArray(delUsed.body.references) && delUsed.body.references.length > 0, delUsed.body && delUsed.body.references);
    const [stillThere] = await db.query('SELECT id FROM positions WHERE id=?', [POS_USED]);
    check('the referenced position really still exists', stillThere.length === 1);

    const delFree = await call('DELETE', `/api/workflow/positions/${POS_FREE}`, manager);
    check('an unreferenced position CAN be deleted', delFree.body && delFree.body.success === true, delFree.body);
    const delGhost = await call('DELETE', '/api/workflow/positions/NO-SUCH-POS', manager);
    check('deleting a nonexistent position is 404, not a false success', delGhost.status === 404, { status: delGhost.status });

    console.log(`\n${fail === 0 ? '✅' : '❌'} workflowAuth: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
