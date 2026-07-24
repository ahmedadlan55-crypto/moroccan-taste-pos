'use strict';
/* Integration — /api/analytics/budgets + BudgetService.dailySeries/expandMonth
 * (real server + DB, direct-SQL fixtures from tests/fixtures/salesHubSeed).
 *
 * Covers:
 *   · accountant (analytics.budget.manage via role, W1+W2 grants) bulk-upserts
 *     lines → version 1; re-upsert of the same (branch, month, metric) key
 *     updates amount/distribution and bumps version to 2;
 *   · manager (analytics.view but NOT budget.manage) PUT → 403;
 *   · scoped accountant (W1 only) writing a B2 line → 403 (branch outside
 *     scope), and NOTHING from that batch persists;
 *   · list is branch-scope-clamped (manager sees only B1 rows; zero-grant
 *     user gets an EMPTY list — fail-closed, never an error);
 *   · validation: bad month / bad metric / bad distribution → 422;
 *   · dailySeries: 'even' month expands to amount/daysInMonth and sums back
 *     to the month amount (±0.01); 'weekday_weighted' sums back too AND
 *     Fri/Sat days carry exactly 1.5× a Sun–Thu day (Saudi weekend);
 *     range clipping keeps only in-window days;
 *   · expandMonth unit-asserts (pure): leap February, normalization, 422s.
 *
 * Fixtures: ITEST-SHB-* (salesHubSeed, 2032-03). PORT 3988.
 * Run: node tests/integration/analyticsBudget.api.test.js
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');
const seedMod = require('../fixtures/salesHubSeed');
const BudgetService = require('../../services/analytics/BudgetService');

const PORT = 3988;
const PREFIX = 'ITEST-SHB';
const ADMIN = 'itest_shb_admin';
const ACCT = 'itest_shb_acct';    // accountant, W1+W2 → B1+B2
const ACCT1 = 'itest_shb_acct1';  // accountant, W1 only → B1
const MGR = 'itest_shb_mgr';      // manager (no budget.manage), W1 → B1
const ZERO = 'itest_shb_zero';    // manager, zero grants
const PW = 'Shb#Test!2032';
let I = null;

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) {
  if (c) { pass++; console.log('  ✅', n); }
  else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 300) : ''); }
}
const near = (a, b, eps = 0.01) => Math.abs(Number(a) - Number(b)) <= eps;

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
const login = async (u) => (await call('POST', '/api/auth/login', null, { username: u, password: PW })).body?.token || '';
async function waitUp() {
  for (let i = 0; i < 180; i++) {
    const ok = await new Promise((z) => http.get('http://127.0.0.1:' + PORT + '/api/version', (s) => z(s.statusCode === 200)).on('error', () => z(false)));
    if (ok) return true;
    await new Promise((z) => setTimeout(z, 1000));
  }
  return false;
}

async function cleanupAll() {
  for (const u of [ADMIN, ACCT, ACCT1, MGR, ZERO]) {
    try {
      const [r] = await db.query('SELECT id FROM users WHERE username = ?', [u]);
      if (r.length) await db.query('DELETE FROM user_warehouse_access WHERE user_id = ?', [r[0].id]);
      await db.query('DELETE FROM users WHERE username = ?', [u]);
    } catch (_) {}
  }
  try { await db.query("DELETE FROM analytics_sales_budget WHERE branch_id LIKE 'ITEST-SHB-%'"); } catch (_) {}
}

(async () => {
  await seedMod.cleanup(db, PREFIX);
  await cleanupAll();
  I = await seedMod.seed(db, PREFIX);

  const hash = await bcrypt.hash(PW, 12);
  const mkUser = async (u, role) => {
    const [r] = await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [u, hash, role]);
    return r.insertId;
  };
  await mkUser(ADMIN, 'admin');
  const acctId = await mkUser(ACCT, 'accountant');
  const acct1Id = await mkUser(ACCT1, 'accountant');
  const mgrId = await mkUser(MGR, 'manager');
  await mkUser(ZERO, 'manager');
  await db.query(
    'INSERT INTO user_warehouse_access (user_id, warehouse_id, created_by) VALUES (?,?,?),(?,?,?),(?,?,?),(?,?,?)',
    [acctId, I.W1, 'itest', acctId, I.W2, 'itest', acct1Id, I.W1, 'itest', mgrId, I.W1, 'itest']);

  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..', '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    const admin = await login(ADMIN);
    const acct = await login(ACCT);
    const acct1 = await login(ACCT1);
    const mgr = await login(MGR);
    const zero = await login(ZERO);
    check('all five users got JWTs', !!admin && !!acct && !!acct1 && !!mgr && !!zero);

    // ── upsert + list ─────────────────────────────────────────────────────
    console.log('\n▶ bulk upsert (accountant, both branches in scope)');
    const put1 = await call('PUT', '/api/analytics/budgets', acct, {
      lines: [
        { branch_id: I.B1, period_month: '2032-03', metric: 'net_sales_ex_vat', amount: 31000, distribution: 'even' },
        { branch_id: I.B2, period_month: '2032-03', metric: 'net_sales_ex_vat', amount: 29000, distribution: 'weekday_weighted' },
        { branch_id: I.B1, period_month: '2032-03', metric: 'orders', amount: 900, distribution: 'even' },
      ],
    });
    check('upsert answers 200 {upserted:3}', put1.status === 200 && put1.body?.data?.upserted === 3, put1.body);

    const l1 = await call('GET', `/api/analytics/budgets?from=2032-03&to=2032-03`, acct);
    const rows1 = l1.body?.data || [];
    check('list returns the 3 rows, version 1, normalized period_month', l1.status === 200 &&
      rows1.length === 3 && rows1.every((r) => r.version === 1 && r.period_month === '2032-03-01'), rows1);
    const b1net = rows1.find((r) => r.branch_id === I.B1 && r.metric === 'net_sales_ex_vat');
    check('B1 net line exact (31000, even)', !!b1net && b1net.amount === 31000 && b1net.distribution === 'even', b1net);

    console.log('\n▶ re-upsert bumps version');
    const put2 = await call('PUT', '/api/analytics/budgets', acct, {
      lines: [{ branch_id: I.B1, period_month: '2032-03', metric: 'net_sales_ex_vat', amount: 32000, distribution: 'even' }],
    });
    check('re-upsert answers 200', put2.status === 200 && put2.body?.data?.upserted === 1, put2.body);
    const l2 = await call('GET', `/api/analytics/budgets?from=2032-03&to=2032-03&metric=net_sales_ex_vat`, acct);
    const b1net2 = (l2.body?.data || []).find((r) => r.branch_id === I.B1);
    check('same key updated in place: amount 32000, version 2 (still one row)',
      !!b1net2 && b1net2.amount === 32000 && b1net2.version === 2 &&
      (l2.body?.data || []).filter((r) => r.branch_id === I.B1).length === 1, b1net2);

    // ── authz ─────────────────────────────────────────────────────────────
    console.log('\n▶ capability + scope gates');
    const putMgr = await call('PUT', '/api/analytics/budgets', mgr, {
      lines: [{ branch_id: I.B1, period_month: '2032-03', metric: 'orders', amount: 1, distribution: 'even' }],
    });
    check('manager (no budget.manage) PUT → 403 PERMISSION_DENIED',
      putMgr.status === 403 && putMgr.body?.code === 'PERMISSION_DENIED', putMgr);

    const putOut = await call('PUT', '/api/analytics/budgets', acct1, {
      lines: [
        { branch_id: I.B1, period_month: '2032-04', metric: 'guests', amount: 100, distribution: 'even' },
        { branch_id: I.B2, period_month: '2032-04', metric: 'guests', amount: 100, distribution: 'even' },
      ],
    });
    check('scoped accountant writing an out-of-scope branch → 403', putOut.status === 403 &&
      putOut.body?.code === 'PERMISSION_DENIED', putOut);
    const [resid] = await db.query(
      "SELECT COUNT(*) AS n FROM analytics_sales_budget WHERE branch_id LIKE 'ITEST-SHB-%' AND metric = 'guests'");
    check('the denied batch persisted NOTHING (validate-all-then-write)', Number(resid[0].n) === 0, resid[0]);

    const lMgr = await call('GET', `/api/analytics/budgets?from=2032-03&to=2032-03`, mgr);
    const mgrRows = lMgr.body?.data || [];
    check('manager list is scope-clamped to B1 rows only', lMgr.status === 200 &&
      mgrRows.length === 2 && mgrRows.every((r) => r.branch_id === I.B1), mgrRows.map((r) => r.branch_id));
    const lZero = await call('GET', '/api/analytics/budgets', zero);
    check('zero-grant list → EMPTY (fail-closed, success:true)', lZero.status === 200 &&
      lZero.body?.success === true && (lZero.body?.data || []).length === 0, lZero.body);

    // ── validation ────────────────────────────────────────────────────────
    console.log('\n▶ validation');
    const v1 = await call('PUT', '/api/analytics/budgets', acct,
      { lines: [{ branch_id: I.B1, period_month: '2032-13', metric: 'orders', amount: 1 }] });
    check('bad month → 422', v1.status === 422 && v1.body?.code === 'VALIDATION_ERROR', v1);
    const v2 = await call('PUT', '/api/analytics/budgets', acct,
      { lines: [{ branch_id: I.B1, period_month: '2032-03', metric: 'profit', amount: 1 }] });
    check('unknown metric → 422', v2.status === 422 && v2.body?.code === 'VALIDATION_ERROR', v2);
    const v3 = await call('PUT', '/api/analytics/budgets', acct,
      { lines: [{ branch_id: I.B1, period_month: '2032-03', metric: 'orders', amount: 1, distribution: 'random' }] });
    check('unknown distribution → 422', v3.status === 422 && v3.body?.code === 'VALIDATION_ERROR', v3);

    // ── dailySeries (DB-backed) ───────────────────────────────────────────
    console.log('\n▶ dailySeries (even)');
    const even = await BudgetService.dailySeries(db, {
      branchIds: [I.B1], from: '2032-03-01', to: '2032-03-31', metric: 'net_sales_ex_vat',
    });
    check('even: 31 days, each = 32000/31', even.length === 31 &&
      even.every((d) => near(d.amount, 32000 / 31, 1e-9)), even.slice(0, 2));
    check('even: sums back to the month amount (±0.01)',
      near(even.reduce((s, d) => s + d.amount, 0), 32000), even.reduce((s, d) => s + d.amount, 0));

    console.log('\n▶ dailySeries (weekday_weighted, Saudi weekend)');
    const ww = await BudgetService.dailySeries(db, {
      branchIds: [I.B2], from: '2032-03-01', to: '2032-03-31', metric: 'net_sales_ex_vat',
    });
    check('weighted: 31 days, sums back to 29000 (±0.01)', ww.length === 31 &&
      near(ww.reduce((s, d) => s + d.amount, 0), 29000), ww.reduce((s, d) => s + d.amount, 0));
    const dow = (iso) => new Date(iso + 'T00:00:00Z').getUTCDay();
    const friday = ww.find((d) => dow(d.date) === 5);
    const sunday = ww.find((d) => dow(d.date) === 0);
    check('weighted: a Friday carries exactly 1.5× a Sunday', !!friday && !!sunday &&
      near(friday.amount / sunday.amount, 1.5, 1e-9), { friday, sunday });

    const clipped = await BudgetService.dailySeries(db, {
      branchIds: [I.B1], from: '2032-03-10', to: '2032-03-20', metric: 'net_sales_ex_vat',
    });
    check('range clipping keeps only in-window days (11 days)', clipped.length === 11 &&
      near(clipped.reduce((s, d) => s + d.amount, 0), (32000 / 31) * 11), clipped.length);

    // ── expandMonth unit-asserts (pure helper) ────────────────────────────
    console.log('\n▶ expandMonth (pure)');
    const feb = BudgetService.expandMonth({ periodMonth: '2032-02', amount: 2900, distribution: 'even' });
    check('leap February: 29 days, each 2900/29', feb.length === 29 &&
      feb.every((d) => near(d.amount, 2900 / 29, 1e-9)), feb.length);
    const wfeb = BudgetService.expandMonth({ periodMonth: '2032-02', amount: 2900, distribution: 'weekday_weighted' });
    check('weighted February normalizes: Σ days === amount (1e-6)',
      near(wfeb.reduce((s, d) => s + d.amount, 0), 2900, 1e-6), wfeb.reduce((s, d) => s + d.amount, 0));
    const wFri = wfeb.find((d) => dow(d.date) === 5);
    const wMon = wfeb.find((d) => dow(d.date) === 1);
    check('weighted February: Fri = 1.5 × Mon', !!wFri && !!wMon && near(wFri.amount / wMon.amount, 1.5, 1e-9),
      { wFri, wMon });
    let threw = null;
    try { BudgetService.expandMonth({ periodMonth: 'not-a-month', amount: 1, distribution: 'even' }); }
    catch (e) { threw = e; }
    check('expandMonth rejects a bad month with a coded 422', !!threw && threw.code === 'VALIDATION_ERROR' && threw.http === 422, threw && threw.code);

    console.log(`\n${fail === 0 ? '✅' : '❌'} analyticsBudget: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await seedMod.cleanup(db, PREFIX);
    await cleanupAll();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
