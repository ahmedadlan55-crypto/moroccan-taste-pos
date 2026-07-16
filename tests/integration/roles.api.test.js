/* Integration — assignable roles (real server + DB).
 *
 * What was broken:
 *   • users.role was enum(admin,cashier,manager,custody,employee) while
 *     role_permissions had carried accountant/finance/sales grants since the
 *     O2C capability seed — every one of those grants was unreachable.
 *   • PUT /auth/users/:username silently IGNORED an unknown role (the form
 *     reported success while the write was skipped); POST rejected it.
 *   • A role change did not bump token_version, so an already-issued 24h JWT
 *     kept its old role's powers — including on /api/auth/* user management,
 *     which is exempt from the global session gate and whose requireAdmin
 *     did no version check at all.
 *   • routes/hr.js could create a user with ANY role string, unvalidated,
 *     from a manager session.
 *
 * Run: node tests/integration/roles.api.test.js   (MySQL must be up)
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const PORT = 3989;
const PW = 'Itest@12345';
const ADMIN = 'itest_roles_admin';
const ADMIN2 = 'itest_roles_admin2';     // gets demoted — proves requireAdmin invalidation
const MANAGER = 'itest_roles_manager';
const CASHIER = 'itest_roles_cashier';
const ACCT = 'itest_roles_accountant';
const FIN = 'itest_roles_finance';
const SALES = 'itest_roles_sales';
const VICTIM = 'itest_roles_victim';     // gets a role change — proves gate invalidation
const HR_EMP_PREFIX = 'itestroles';

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 240) : ''); } }

function call(method, p, token, body) {
  return new Promise((res) => {
    const d = body ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    if (d) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(d); }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h }, (s) => {
      let b = ''; s.on('data', (c) => (b += c)); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, body: j }); });
    });
    r.on('error', () => res({ status: 0 })); if (d) r.write(d); r.end();
  });
}
const login = async (u, pw) => (await call('POST', '/api/auth/login', null, { username: u, password: pw || PW })).body?.token || '';
async function waitUp() { for (let i = 0; i < 120; i++) { const ok = await new Promise((z) => http.get('http://127.0.0.1:' + PORT + '/api/version', (s) => z(s.statusCode === 200)).on('error', () => z(false))); if (ok) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }

async function cleanup() {
  for (const u of [ADMIN, ADMIN2, MANAGER, CASHIER, ACCT, FIN, SALES, VICTIM]) {
    await db.query('DELETE FROM users WHERE username = ?', [u]).catch(() => {});
  }
  await db.query("DELETE FROM users WHERE username LIKE ?", [HR_EMP_PREFIX + '%']).catch(() => {});
  await db.query("DELETE FROM hr_employees WHERE first_name LIKE ?", [HR_EMP_PREFIX + '%']).catch(() => {});
}

(async () => {
  // ── migration idempotence: apply() twice ⇒ identical, widened schema ───────
  console.log('▶ migration');
  const schema = require('../../db/migrations/order-to-cash/schema');
  await schema.apply(db);
  const colType = async () => (await db.query(
    "SELECT COLUMN_TYPE t FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='role'"))[0][0].t;
  const t1 = await colType();
  check('users.role now holds accountant/finance/sales', /accountant/.test(t1) && /finance/.test(t1) && /'sales'/.test(t1), t1);
  check('  …and kept every pre-existing role', /admin/.test(t1) && /cashier/.test(t1) && /manager/.test(t1) && /custody/.test(t1) && /employee/.test(t1), t1);
  const before = (await db.query('SELECT username, role FROM users ORDER BY username'))[0];
  await schema.apply(db); // re-run
  const t2 = await colType();
  check('apply() is re-runnable: second run leaves the column byte-identical', t1 === t2);
  const after = (await db.query('SELECT username, role FROM users ORDER BY username'))[0];
  check('  …and existing users kept their roles', JSON.stringify(before) === JSON.stringify(after));

  await cleanup();
  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [ADMIN, hash, 'admin']);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [ADMIN2, hash, 'admin']);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [MANAGER, hash, 'manager']);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [CASHIER, hash, 'cashier']);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [VICTIM, hash, 'cashier']);

  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT), ORDER_TO_CASH_ENABLE: '1' }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    const admin = await login(ADMIN);
    const manager = await login(MANAGER);
    const cashier = await login(CASHIER);
    check('admin + manager + cashier all got a JWT', !!admin && !!manager && !!cashier);

    // ── the three roles become real users, end to end ──────────────────────
    console.log('\n▶ accountant / finance / sales');
    for (const [uname, role] of [[ACCT, 'accountant'], [FIN, 'finance'], [SALES, 'sales']]) {
      const created = await call('POST', '/api/auth/users', admin, { username: uname, password: PW, role });
      check(`admin can CREATE a ${role} user`, created.status === 200 && created.body?.success !== false, created.body);
      const tok = await login(uname);
      check(`  …${role} can LOG IN`, !!tok);
      const decoded = tok ? jwt.verify(tok, process.env.JWT_SECRET) : {};
      check(`  …their JWT carries role='${role}'`, decoded.role === role, decoded.role);
    }
    const acct = await login(ACCT), fin = await login(FIN), sales = await login(SALES);

    // The grants that were dead now answer: each role hits an endpoint whose
    // capability role_permissions has held for it all along.
    const acctReturns = await call('GET', '/api/order-to-cash/returns', acct);
    check('accountant reaches O2C returns (returns.view grant, previously unreachable)', acctReturns.status === 200, acctReturns.status);
    const finInvoices = await call('GET', '/api/order-to-cash/invoices', fin);
    check('finance reaches O2C invoices (invoices.view grant)', finInvoices.status === 200, finInvoices.status);
    const salesInvoices = await call('GET', '/api/order-to-cash/invoices', sales);
    check('sales reaches O2C invoices (invoices.view grant)', salesInvoices.status === 200, salesInvoices.status);

    // Negative: the widen must not leak financial power to the cashier.
    const cashApprove = await call('POST', '/api/order-to-cash/returns/NOPE/approve', cashier, {});
    check('cashier still CANNOT approve returns (403 before any 404)', cashApprove.status === 403, cashApprove.status);
    const cashIssue = await call('POST', '/api/order-to-cash/invoices/NOPE/issue', cashier, {});
    check('cashier still CANNOT issue invoices', cashIssue.status === 403, cashIssue.status);

    // ── unknown roles are rejected LOUDLY on both writers ──────────────────
    console.log('\n▶ validation');
    const badCreate = await call('POST', '/api/auth/users', admin, { username: 'itestroles_bad', password: PW, role: 'superuser' });
    check('unknown role on CREATE ⇒ 400', badCreate.status === 400, badCreate);
    const badUpdate = await call('PUT', '/api/auth/users/' + VICTIM, admin, { role: 'superuser' });
    check('unknown role on UPDATE ⇒ 400 (was a silent no-op that reported success)', badUpdate.status === 400, badUpdate);
    const stillCashier = (await db.query('SELECT role FROM users WHERE username=?', [VICTIM]))[0][0].role;
    check('  …and the role write was genuinely refused', stillCashier === 'cashier', stillCashier);
    const nonAdmin = await call('PUT', '/api/auth/users/' + VICTIM, manager, { role: 'manager' });
    check('a NON-admin cannot change a role (requireAdmin 403)', nonAdmin.status === 403, nonAdmin.status);

    // ── role change kills outstanding sessions ─────────────────────────────
    console.log('\n▶ session invalidation');
    const victimTok = await login(VICTIM);
    const pre = await call('GET', '/api/order-to-cash/returns', victimTok);
    check('victim token works before the role change (cashier holds returns.view)', pre.status === 200, pre.status);
    const vBefore = (await db.query('SELECT token_version FROM users WHERE username=?', [VICTIM]))[0][0].token_version;
    const promote = await call('PUT', '/api/auth/users/' + VICTIM, admin, { role: 'accountant' });
    check('admin changes victim role to accountant', promote.status === 200 && promote.body?.success !== false, promote.body);
    const vAfter = (await db.query('SELECT token_version FROM users WHERE username=?', [VICTIM]))[0][0].token_version;
    check('token_version was bumped by the role change', Number(vAfter) === Number(vBefore) + 1, { vBefore, vAfter });
    const post = await call('GET', '/api/order-to-cash/returns', victimTok);
    check('the OLD token is now 401 on the gated API (انتهت الجلسة)', post.status === 401, post.status);
    const same = await call('PUT', '/api/auth/users/' + VICTIM, admin, { role: 'accountant' });
    const vSame = (await db.query('SELECT token_version FROM users WHERE username=?', [VICTIM]))[0][0].token_version;
    check('writing the SAME role does not bump (saving the form unchanged must not log the user out)',
      same.status === 200 && Number(vSame) === Number(vAfter), { vAfter, vSame });

    // requireAdmin itself honours the bump — /api/auth/* is exempt from the
    // global gate, so this was the hole where a demoted admin kept user-CRUD.
    const admin2Tok = await login(ADMIN2);
    const adminList = await call('GET', '/api/auth/users', admin2Tok);
    check('second admin can list users before demotion', adminList.status === 200, adminList.status);
    const demote = await call('PUT', '/api/auth/users/' + ADMIN2, admin, { role: 'cashier' });
    check('first admin demotes the second', demote.status === 200 && demote.body?.success !== false, demote.body);
    const adminListAfter = await call('GET', '/api/auth/users', admin2Tok);
    check('the demoted admin\'s OLD token is refused on requireAdmin routes (401, not a lingering 200)',
      adminListAfter.status === 401, adminListAfter.status);

    // ── the HR back door ────────────────────────────────────────────────────
    console.log('\n▶ HR path');
    const hrBad = await call('POST', '/api/hr/employees', manager,
      { firstName: HR_EMP_PREFIX + 'a', createUser: true, userRole: 'cashier', userPassword: PW });
    check('a MANAGER may not assign a role via HR employee-create (403)', hrBad.status === 403, hrBad.status);
    const hrBad2 = await call('POST', '/api/hr/employees', admin,
      { firstName: HR_EMP_PREFIX + 'b', createUser: true, userRole: 'superuser', userPassword: PW });
    check('an unknown role via HR is rejected (400) even for admin', hrBad2.status === 400, hrBad2.status);
    const hrOk = await call('POST', '/api/hr/employees', admin,
      { firstName: HR_EMP_PREFIX + 'c', createUser: true, userRole: 'accountant', userPassword: PW });
    check('admin CAN create an accountant via HR', hrOk.status === 200 && hrOk.body?.success !== false, hrOk.body);
    const hrRole = (await db.query('SELECT role FROM users WHERE username=?', [HR_EMP_PREFIX + 'c']))[0];
    check('  …and the stored role is accountant', hrRole.length === 1 && hrRole[0].role === 'accountant', hrRole);
    const hrEmp = await call('POST', '/api/hr/employees', manager,
      { firstName: HR_EMP_PREFIX + 'd', createUser: true, userRole: 'employee', userPassword: PW });
    check('a manager can still create a plain EMPLOYEE user via HR', hrEmp.status === 200 && hrEmp.body?.success !== false, hrEmp.body);
  } finally {
    server.kill();
    await cleanup();
    await db.end();
  }

  console.log(`\n${fail ? '❌' : '✅'} roles: ${pass} passed, ${fail} failed`);
  if (fail) { console.log(fails.map((f) => '  - ' + f).join('\n')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
