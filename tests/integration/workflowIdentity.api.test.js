'use strict';
/* Integration — workflow/counters/sla/notifications identity + capability guards
 * (real server + real DB). Companion to workflowAuth.api.test.js; proves the
 * g-wf hardening:
 *
 *   (a) a spoofed ?username= / body.username is IGNORED — the RECORDED actor is
 *       the token's user, never the request-supplied value;
 *   (b) previously-fallback routes now 401 with no token (incl. the classic
 *       ?username=admin tokenless bypass);
 *   (c) a write without the required capability is 403 AND the state is unchanged;
 *   (d) the authorized role still succeeds (the guard hardens without removing
 *       the function), and operational roles keep their daily flow.
 *
 * Run: node tests/integration/workflowIdentity.api.test.js
 * NOTE: shared MySQL — the coordinator runs this. Do not run ad-hoc.
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const PORT = 3991;
const CASHIER = 'itest_wfid_cashier';   // role cashier → txn.view + txn.create, NO workflow.manage
const MANAGER = 'itest_wfid_manager';   // role manager → workflow.manage + txn.*
const PW = 'WfIdentity#Test!2026';
const EMP_A = 'ITEST-WFID-EMP-A';
const POS_PWNED = 'ITEST WFID pwned position';   // cashier write (denied) must NOT create this
const POS_MGR   = 'ITEST WFID manager position'; // manager write (allowed) MUST create this
const TT_ID = 'ITEST-WFID-TT';
const NOTIF_MGR = 'ITEST-WFID-NOTIF-MGR';

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) {
  if (c) { pass++; console.log('  OK ', n); }
  else { fail++; fails.push(n); console.log('  XX ', n, extra != null ? '-> ' + JSON.stringify(extra).slice(0, 200) : ''); }
}

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
  try { await db.query('DELETE FROM transactions WHERE created_by IN (?,?) OR transaction_type_id = ?', [CASHIER, MANAGER, TT_ID]); } catch (_) {}
  try { await db.query('DELETE FROM notifications WHERE username IN (?,?) OR id = ?', [CASHIER, MANAGER, NOTIF_MGR]); } catch (_) {}
  for (const u of [CASHIER, MANAGER]) { try { await db.query('DELETE FROM users WHERE username=?', [u]); } catch (_) {} }
  try { await db.query('DELETE FROM hr_employees WHERE id=?', [EMP_A]); } catch (_) {}
  try { await db.query('DELETE FROM positions WHERE name IN (?,?)', [POS_PWNED, POS_MGR]); } catch (_) {}
  try { await db.query('DELETE FROM transaction_types WHERE id=?', [TT_ID]); } catch (_) {}
}

(async () => {
  await cleanup();
  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [CASHIER, hash, 'cashier']);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [MANAGER, hash, 'manager']);
  await db.query("INSERT INTO hr_employees (id, employee_number, first_name, status) VALUES (?,?,?,'active')", [EMP_A, 'ITWFID', 'AlphaId']);
  await db.query('INSERT INTO transaction_types (id, name, code) VALUES (?,?,?)', [TT_ID, 'ITEST WFID Type', 'ITWFID']);
  // A notification that belongs to MANAGER — used to prove feed isolation.
  await db.query("INSERT INTO notifications (id, username, type, title, body) VALUES (?,?,?,?,?)",
    [NOTIF_MGR, MANAGER, 'info', 'ITEST-secret-to-manager', 'only manager should see this']);

  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    console.log('\n=== workflow/counters/sla/notifications — identity + capability ===');

    const cashier = await login(CASHIER);
    const manager = await login(MANAGER);
    check('both users authenticate', !!cashier && !!manager);

    // ── (b) 401 with NO token on previously-fallback routes ──
    const noTokMyProfile = await call('GET', '/api/workflow/my-profile?username=admin', null);
    check('workflow/my-profile?username=admin with NO token is 401 (was: returned admin profile)', noTokMyProfile.status === 401, noTokMyProfile);

    const noTokCounters = await call('GET', '/api/counters/me?username=admin', null);
    check('counters/me?username=admin with NO token is 401', noTokCounters.status === 401, noTokCounters);

    const noTokSla = await call('GET', '/api/sla/overdue?username=admin', null);
    check('sla/overdue?username=admin with NO token is 401 (was: dumped any inbox)', noTokSla.status === 401, noTokSla);

    const noTokNotif = await call('GET', '/api/erp/notifications?username=admin', null);
    check('erp/notifications?username=admin with NO token is 401', noTokNotif.status === 401, noTokNotif);

    const noTokAction = await call('POST', '/api/workflow/transactions/NO-SUCH/action', null, { action: 'approve', username: 'admin' });
    check('workflow action with NO token is 401 (body.username=admin ignored)', noTokAction.status === 401, noTokAction);

    const bypass = await call('DELETE', '/api/workflow/transactions/NO-SUCH-ID-XYZ?username=admin', null);
    check('the classic ?username=admin tokenless DELETE bypass is 401 (was 404 = handler reached)', bypass.status === 401, bypass);

    // ── (a) spoofed identity is IGNORED — recorded actor = token user ──
    const spoofCreate = await call('POST', '/api/workflow/transactions', cashier, {
      transactionTypeId: TT_ID, subject: 'ITEST identity draft', title: 'ITEST identity draft',
      username: 'admin', saveAsDraft: true
    });
    check('cashier CAN create a transaction (txn.create — daily flow intact)', spoofCreate.body && spoofCreate.body.success === true, spoofCreate.body);
    const newTxnId = spoofCreate.body && spoofCreate.body.id;
    let recordedCreator = null;
    if (newTxnId) {
      const [r] = await db.query('SELECT created_by FROM transactions WHERE id = ?', [newTxnId]);
      recordedCreator = r.length ? r[0].created_by : null;
    }
    check('the RECORDED creator is the token user (cashier), NOT the spoofed body.username=admin', recordedCreator === CASHIER, { recordedCreator });

    // ── (a) spoofed identity is IGNORED on a READ (feed isolation) ──
    const cashierFeed = await call('GET', '/api/counters/notifications?username=' + encodeURIComponent(MANAGER), cashier);
    const leaked = Array.isArray(cashierFeed.body) && cashierFeed.body.some(n => n.title === 'ITEST-secret-to-manager');
    check('counters/notifications?username=<manager> returns the CASHIER feed, not the manager feed', cashierFeed.status === 200 && !leaked, { status: cashierFeed.status, leaked });

    const mgrFeed = await call('GET', '/api/counters/notifications', manager);
    const mgrSeesOwn = Array.isArray(mgrFeed.body) && mgrFeed.body.some(n => n.title === 'ITEST-secret-to-manager');
    check('the manager DOES see their own notification (proves the seed + read path work)', mgrSeesOwn, { status: mgrFeed.status });

    // ── (c) write without capability → 403 AND state unchanged ──
    // No `id` in the body → the handler takes its INSERT path (with an id the
    // handler UPDATEs instead, which would be a no-op and prove nothing).
    const cashierPos = await call('POST', '/api/workflow/positions', cashier, { name: POS_PWNED, level: 9 });
    check('cashier is DENIED creating a position (needs workflow.manage)', cashierPos.status === 403, cashierPos);
    const [posAfter] = await db.query('SELECT id FROM positions WHERE name = ?', [POS_PWNED]);
    check('the position was really NOT created after the denied write', posAfter.length === 0);

    const cashierOrg = await call('PUT', `/api/workflow/org-tree/${EMP_A}`, cashier, { permissions: { approve: true } });
    check('cashier is DENIED granting themselves approval rights via org-tree', cashierOrg.status === 403, cashierOrg);
    const [orgAfter] = await db.query('SELECT can_approve_txn FROM hr_employees WHERE id = ?', [EMP_A]);
    check('the approval flag really did not change after the denied write', !orgAfter[0].can_approve_txn, orgAfter[0]);

    // ── (d) the authorized role still succeeds ──
    const mgrPos = await call('POST', '/api/workflow/positions', manager, { name: POS_MGR, level: 2 });
    check('manager CAN create a position (workflow.manage — guard hardens without removing the function)', mgrPos.body && mgrPos.body.success === true, mgrPos.body);
    const [posMade] = await db.query('SELECT id FROM positions WHERE name = ?', [POS_MGR]);
    check('the manager write really persisted', posMade.length === 1);

    const mgrOrg = await call('PUT', `/api/workflow/org-tree/${EMP_A}`, manager, { permissions: { approve: true } });
    check('manager CAN edit org-tree', mgrOrg.body && mgrOrg.body.success === true, mgrOrg.body);
    const [orgMade] = await db.query('SELECT can_approve_txn FROM hr_employees WHERE id = ?', [EMP_A]);
    check('the manager org-tree edit persisted', !!orgMade[0].can_approve_txn, orgMade[0]);

    // ── operational-role daily flow stays open ──
    const cashierCounters = await call('GET', '/api/counters/me', cashier);
    check('cashier CAN read their own counters (inbox badge — daily flow intact)', cashierCounters.status === 200, { status: cashierCounters.status });

    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} workflowIdentity: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
