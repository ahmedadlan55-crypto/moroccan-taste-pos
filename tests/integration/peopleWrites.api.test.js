'use strict';
/* Integration — People module writes (real server + DB, synthesized fixtures).
 *
 * Covers the write contracts the React People module now fronts (the same
 * endpoints the legacy /employee and /custody PWAs used):
 *   (a) POST /api/hr/my-clock       — attendance actor comes from the TOKEN;
 *                                     a spoofed body username/created_by is ignored.
 *   (b) POST /api/hr/my-leave-request — submits and appears in my-requests.
 *   (c) custody create → topup → expense → approve — full cycle with amounts
 *                                     asserted against the DB after every step.
 *   (d) expense approve by a non-privileged role (the custody holder) → 403
 *                                     and the expense/balance state unchanged.
 *
 * KNOWN REGRESSION (documented, backend-owned): since 4fcb961 the /api/hr mount
 * carries requireRole('admin','manager'), which 403s role=employee on every
 * /hr/my-* self-service endpoint (the legacy employee PWA included). Tests (a)
 * and (b) assert the self-service CONTRACT and will FAIL with 403 until the
 * security stream exempts /hr/my-* at the mount. They are the regression alarm.
 *
 * Run: node tests/integration/peopleWrites.api.test.js   (port 3999)
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const PORT = 3999;
const EMP = 'itest_pw_emp';        // role employee — self-service actor
const MGR = 'itest_pw_mgr';        // role manager — custody admin decisions
const CUST = 'itest_pw_custody';   // role custody — holder submitting expenses
const PW = 'People#Writes!2026';
const EMP_ID = 'ITEST-PW-EMP';
const EMP_NO = 'ITEST-PW-001';
const LT_ID = 'ITEST-PW-LT';
const CUST_NAME = 'ITEST-PW-CUST'; // custody_users.name → GL account 'عهدة ITEST-PW-CUST'
const SRC_GL = 'GL-ITEST-PW-SRC';  // ITEST cash source so no REAL account balance moves

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

const custodyRow = async (id) => {
  const [r] = await db.query('SELECT balance, total_topups, total_expenses, status FROM custodies WHERE id=?', [id]);
  return r.length ? { balance: Number(r[0].balance), topups: Number(r[0].total_topups), expenses: Number(r[0].total_expenses), status: r[0].status } : null;
};
const expenseRow = async (id) => {
  const [r] = await db.query('SELECT status, created_by, approved_by, amount FROM custody_expenses WHERE id=?', [id]);
  return r.length ? { status: r[0].status, createdBy: r[0].created_by, approvedBy: r[0].approved_by, amount: Number(r[0].amount) } : null;
};

async function cleanup() {
  for (const u of [EMP, MGR, CUST]) { try { await db.query('DELETE FROM users WHERE username=?', [u]); } catch (_) {} }
  try {
    // Custody chain (children → parents). Locate ITEST custodies via the ITEST custodian.
    const [cus] = await db.query(
      'SELECT c.id FROM custodies c JOIN custody_users cu ON cu.id=c.user_id WHERE cu.name=?', [CUST_NAME]);
    for (const c of cus) {
      const [tops] = await db.query('SELECT id FROM custody_topups WHERE custody_id=?', [c.id]);
      for (const t of tops) {
        const [js] = await db.query("SELECT id FROM gl_journals WHERE reference_type='custody_topup' AND reference_id=?", [t.id]);
        for (const j of js) {
          await db.query('DELETE FROM gl_entries WHERE journal_id=?', [j.id]).catch(() => {});
          await db.query('DELETE FROM gl_journals WHERE id=?', [j.id]).catch(() => {});
        }
      }
      await db.query('DELETE FROM custody_expenses WHERE custody_id=?', [c.id]).catch(() => {});
      await db.query('DELETE FROM custody_topups WHERE custody_id=?', [c.id]).catch(() => {});
      await db.query('DELETE FROM custodies WHERE id=?', [c.id]).catch(() => {});
    }
    await db.query('DELETE FROM custody_users WHERE name=?', [CUST_NAME]);
  } catch (_) {}
  // ITEST GL accounts — the auto-created custodian account + our cash source.
  try { await db.query('DELETE FROM gl_accounts WHERE name_ar=?', ['عهدة ' + CUST_NAME]); } catch (_) {}
  try { await db.query('DELETE FROM gl_accounts WHERE id=?', [SRC_GL]); } catch (_) {}
  // HR self-service fixtures.
  try { await db.query('DELETE FROM hr_attendance WHERE employee_id=?', [EMP_ID]); } catch (_) {}
  try { await db.query('DELETE FROM hr_leave_requests WHERE employee_id=?', [EMP_ID]); } catch (_) {}
  try { await db.query('DELETE FROM hr_leave_balances WHERE employee_id=?', [EMP_ID]); } catch (_) {}
  try { await db.query('DELETE FROM hr_leave_types WHERE id=?', [LT_ID]); } catch (_) {}
  try { await db.query('DELETE FROM hr_employees WHERE id=?', [EMP_ID]); } catch (_) {}
}

(async () => {
  await cleanup();
  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [EMP, hash, 'employee']);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [MGR, hash, 'manager']);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [CUST, hash, 'custody']);
  // Employee profile linked to the employee login. branch_id NULL → no geofence,
  // so the clock records without coordinates (the geofence path needs a branch
  // with geo_lat/geo_lng and is exercised in production, not synthesized here).
  await db.query(
    'INSERT INTO hr_employees (id, employee_number, first_name, linked_username, status) VALUES (?,?,?,?,\'active\')',
    [EMP_ID, EMP_NO, 'ITEST PW Employee', EMP]);
  await db.query(
    "INSERT INTO hr_leave_types (id, name, code, default_days, is_paid, is_active) VALUES (?,?,?,?,1,1)",
    [LT_ID, 'ITEST PW سنوية', 'ITESTPW', 30]);
  const year = new Date().getFullYear();
  await db.query(
    'INSERT INTO hr_leave_balances (id, employee_id, leave_type_id, year, total_days, used_days, remaining_days) VALUES (?,?,?,?,30,0,30)',
    ['ITEST-PW-BAL', EMP_ID, LT_ID, year]);
  // ITEST cash source account so the topup's GL credit hits a synthetic account,
  // never a real صندوق (the route mutates gl_accounts.balance on both legs).
  await db.query(
    "INSERT INTO gl_accounts (id, code, name_ar, type, level) VALUES (?,?,?,?,4)",
    [SRC_GL, 'ITESTPW9', 'ITEST PW صندوق مصدر', 'asset']);

  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    console.log('\n═══ people writes (self-service + custody) ═══');

    const emp = await login(EMP);
    const mgr = await login(MGR);
    const cust = await login(CUST);
    check('users authenticate (employee/manager/custody)', !!emp && !!mgr && !!cust);

    // ── (a) clock-in — actor from TOKEN, spoofed body actor ignored ──
    // NOTE: currently 403s (requireRole('admin','manager') on the /api/hr
    // mount — see file header). The assertions state the CONTRACT.
    const clock = await call('POST', '/api/hr/my-clock', emp, {
      username: 'admin',            // spoof attempt — server must use the JWT
      created_by: 'admin',
      deviceName: 'ITEST-PW device',
      device: { brand: 'ITEST', model: 'PW', os: 'TestOS', ua: 'itest' },
    });
    check('(a) employee can clock in via /hr/my-clock (403 here = the known /api/hr mount regression)',
      clock.status === 200 && clock.body && clock.body.success === true, { status: clock.status, body: clock.body });
    const [att] = await db.query('SELECT id, clock_in, device_name FROM hr_attendance WHERE employee_id=? AND attendance_date=CURDATE()', [EMP_ID]);
    check('(a) attendance row recorded for the TOKEN user\'s employee profile', att.length === 1 && !!att[0].clock_in, att);
    const [attAdmin] = await db.query(
      "SELECT a.id FROM hr_attendance a JOIN hr_employees e ON e.id=a.employee_id WHERE e.linked_username='admin' AND a.attendance_date=CURDATE() AND a.device_name LIKE 'ITEST%'");
    check('(a) the spoofed body actor produced NOTHING for admin', attAdmin.length === 0, attAdmin);

    // ── (b) leave request — submits and appears in my-requests ──
    const leave = await call('POST', '/api/hr/my-leave-request', emp, {
      username: 'admin',            // spoof — employee must resolve from JWT
      leaveTypeId: LT_ID, startDate: year + 1 + '-03-01', endDate: (year + 1) + '-03-02', reason: 'ITEST-PW leave',
    });
    check('(b) leave request submits (403 here = the same /api/hr mount regression)',
      leave.status === 200 && leave.body && leave.body.success === true, { status: leave.status, body: leave.body });
    const mine = await call('GET', '/api/hr/my-leave-requests', emp);
    const mineRows = Array.isArray(mine.body) ? mine.body : [];
    check('(b) …and appears in the employee\'s my-requests', mineRows.some((r) => r.reason === 'ITEST-PW leave'), { count: mineRows.length });
    const [lr] = await db.query('SELECT employee_id, status FROM hr_leave_requests WHERE employee_id=? AND reason=?', [EMP_ID, 'ITEST-PW leave']);
    check('(b) the request row belongs to the TOKEN employee, pending', lr.length === 1 && lr[0].status === 'pending', lr);

    // ── (c) custody full cycle: create → topup → expense → approve ──
    // Custodian record (linked to the custody login) — created by the manager.
    const cu = await call('POST', '/api/custody/users', mgr, { name: CUST_NAME, jobTitle: 'ITEST', linkedUsername: CUST });
    check('(c) manager creates the custodian record', cu.body && cu.body.success === true, cu.body);

    const created = await call('POST', '/api/custody/create', mgr, { userId: cu.body.id, userName: CUST_NAME });
    check('(c) manager creates the custody (auto number)', created.body && created.body.success === true && !!created.body.custodyNumber, created.body);
    const cusId = created.body.id;

    // Employee role is blocked at the /api/custody mount (admin/manager/custody only).
    const empBlocked = await call('GET', '/api/custody/list', emp);
    check('(c) role=employee is 403 at the /api/custody mount', empBlocked.status === 403, { status: empBlocked.status });

    // The custody holder cannot create custodies (admin decision endpoint).
    const custCreate = await call('POST', '/api/custody/create', cust, { userId: cu.body.id, userName: CUST_NAME });
    check('(c) the custody ROLE cannot create custodies (admin-only inside the mount)', custCreate.status === 403, { status: custCreate.status, body: custCreate.body });

    // Topup 1000 against the ITEST source account.
    const topup = await call('POST', '/api/custody/' + cusId + '/topup', mgr, {
      amount: 1000, paymentMethod: 'cash', glAccountId: SRC_GL, notes: 'ITEST-PW topup',
    });
    check('(c) topup succeeds', topup.body && topup.body.success === true, topup.body);
    let row = await custodyRow(cusId);
    check('(c) balance = 1000 and total_topups = 1000 after the topup', !!row && row.balance === 1000 && row.topups === 1000, row);
    const [jrn] = await db.query("SELECT id, total_debit FROM gl_journals WHERE reference_type='custody_topup' AND reference_id=?", [topup.body.id]);
    check('(c) the topup posted a GL journal (Dr عهدة / Cr مصدر) for 1000', jrn.length === 1 && Number(jrn[0].total_debit) === 1000, jrn);

    // Holder submits an expense against OWN custody; actor from the JWT.
    const exp = await call('POST', '/api/custody/' + cusId + '/expenses', cust, {
      expenseDate: new Date().toISOString().slice(0, 10),
      description: 'ITEST-PW expense', amount: 200, hasVat: false, vatRate: 0,
      notes: 'itest', username: 'admin', createdBy: 'admin', // spoof — must be ignored
    });
    check('(c) the holder submits an expense on their own custody', exp.body && exp.body.success === true && exp.body.status === 'pending', exp.body);
    let expDb = await expenseRow(exp.body.id);
    check('(c) created_by is the TOKEN user (spoof ignored)', !!expDb && expDb.createdBy === CUST, expDb);
    row = await custodyRow(cusId);
    check('(c) balance untouched while the expense is pending', !!row && row.balance === 1000 && row.expenses === 0, row);

    // An employee-role token never reaches the expense endpoint (mount 403).
    const notOwner = await call('POST', '/api/custody/' + cusId + '/expenses', emp, { description: 'x', amount: 5 });
    check('(c) role=employee cannot reach the expense endpoint (mount 403)', notOwner.status === 403, { status: notOwner.status });

    // ── (d) approval by a NON-privileged role → 403 + state unchanged ──
    const custApprove = await call('POST', '/api/custody/expenses/' + exp.body.id + '/approve', cust, {});
    check('(d) the custody ROLE cannot approve an expense → 403', custApprove.status === 403, { status: custApprove.status, body: custApprove.body });
    expDb = await expenseRow(exp.body.id);
    row = await custodyRow(cusId);
    check('(d) …expense still pending, nothing recorded as approver', !!expDb && expDb.status === 'pending' && !expDb.approvedBy, expDb);
    check('(d) …balance/total_expenses unchanged', !!row && row.balance === 1000 && row.expenses === 0, row);

    // Manager approves — the money moves EXACTLY once.
    const approve = await call('POST', '/api/custody/expenses/' + exp.body.id + '/approve', mgr, {});
    check('(c) manager approves the expense', approve.body && approve.body.success === true, approve.body);
    expDb = await expenseRow(exp.body.id);
    check('(c) expense is approved with the manager as approver', !!expDb && expDb.status === 'approved' && expDb.approvedBy === MGR, expDb);
    row = await custodyRow(cusId);
    check('(c) balance 1000 − 200 = 800 and total_expenses = 200', !!row && row.balance === 800 && row.expenses === 200, row);

    // A second approval of the same expense must be refused (only pending can).
    const again = await call('POST', '/api/custody/expenses/' + exp.body.id + '/approve', mgr, {});
    check('(c) a double-approve is refused', again.body && again.body.success === false, again.body);
    row = await custodyRow(cusId);
    check('(c) …and did not deduct twice', !!row && row.balance === 800 && row.expenses === 200, row);

    console.log(`\n${fail === 0 ? '✅' : '❌'} peopleWrites: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
