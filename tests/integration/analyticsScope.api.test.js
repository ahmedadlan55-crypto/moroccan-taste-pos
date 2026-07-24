'use strict';
/* Integration — analytics scope + capability enforcement (real server + DB).
 *
 *   · admin sees BOTH branches (global scope, no scope clause);
 *   · a branch-scoped manager (user_warehouse_access → W1 → branch B1) sees
 *     ONLY B1 — totals shrink accordingly, and the other branch's row never
 *     appears;
 *   · a zero-grant manager gets EMPTY rows + zero totals — success:true,
 *     never an error, never someone else's data (fail-closed);
 *   · a manager (no analytics.cost.view) requesting cost metrics gets them
 *     STRIPPED into meta.maskedMetrics, absent from every values payload;
 *   · a request of ONLY masked metrics → 403 ANALYTICS_ALL_MASKED;
 *   · a cashier (role without analytics.view) → 403 PERMISSION_DENIED from
 *     the scope middleware, on query AND metadata;
 *   · a capability-gated dimension (cashier) without analytics.employees.view
 *     → 403 PERMISSION_DENIED;
 *   · metadata is capability-filtered (no cogs for the manager).
 *
 * Fixtures: ITEST-SHS-* (salesHubSeed, 2032-03). PORT 3983.
 * Run: node tests/integration/analyticsScope.api.test.js
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');
const seedMod = require('../fixtures/salesHubSeed');

const PORT = 3983;
const PREFIX = 'ITEST-SHS';
const E = seedMod.EXPECTED;
const ADMIN = 'itest_shs_admin';
const MGR_B1 = 'itest_shs_mgr_b1';
const MGR_ZERO = 'itest_shs_mgr_zero';
const CASHIER = 'itest_shs_cashier';
const PW = 'Shs#Test!2032';
let I = null;

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) {
  if (c) { pass++; console.log('  ✅', n); }
  else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 300) : ''); }
}

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
const Q = (token, body) => call('POST', '/api/analytics/query', token, Object.assign({ noCache: true }, body));
const BASE = () => ({
  metrics: ['net_ex_vat', 'orders'], dimensions: ['branch'], range: E.RANGE,
  filters: [{ dimension: 'branch', op: 'in', values: [I.B1, I.B2] }],
});

async function cleanupUsers() {
  for (const u of [ADMIN, MGR_B1, MGR_ZERO, CASHIER]) {
    try {
      const [r] = await db.query('SELECT id FROM users WHERE username = ?', [u]);
      if (r.length) await db.query('DELETE FROM user_warehouse_access WHERE user_id = ?', [r[0].id]);
      await db.query('DELETE FROM users WHERE username = ?', [u]);
    } catch (_) {}
  }
}

(async () => {
  await seedMod.cleanup(db, PREFIX);
  await cleanupUsers();
  I = await seedMod.seed(db, PREFIX);

  const hash = await bcrypt.hash(PW, 12);
  const mkUser = async (u, role) => {
    const [r] = await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [u, hash, role]);
    return r.insertId;
  };
  await mkUser(ADMIN, 'admin');
  const mgrId = await mkUser(MGR_B1, 'manager');
  await mkUser(MGR_ZERO, 'manager');
  await mkUser(CASHIER, 'cashier');
  // branch grant: manager → W1 (branch B1) via the SAME table warehouseScope uses
  await db.query('INSERT INTO user_warehouse_access (user_id, warehouse_id, created_by) VALUES (?,?,?)',
    [mgrId, I.W1, 'itest']);

  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..', '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    const admin = await login(ADMIN);
    const mgr = await login(MGR_B1);
    const zero = await login(MGR_ZERO);
    const cashier = await login(CASHIER);
    check('all four users got JWTs', !!admin && !!mgr && !!zero && !!cashier);

    // ── admin: global scope ───────────────────────────────────────────────
    console.log('\n▶ admin (global)');
    const qa = await Q(admin, BASE());
    check('admin answers 200', qa.status === 200 && qa.body?.success === true, qa.status);
    const aRows = qa.body?.data?.rows || [];
    check('admin sees BOTH branches', aRows.length === 2, aRows.map((r) => r.keys));
    check('admin totals = both branches (net 950)', qa.body.data.totals.values.net_ex_vat === E.TOTAL.net_ex_vat, qa.body.data.totals);

    // ── branch-scoped manager ─────────────────────────────────────────────
    console.log('\n▶ branch-scoped manager (W1 → B1 only)');
    const qm = await Q(mgr, BASE());
    check('manager answers 200', qm.status === 200 && qm.body?.success === true, qm.status);
    const mRows = qm.body?.data?.rows || [];
    check('manager sees ONLY B1', mRows.length === 1 && String(mRows[0].keys.branch) === I.B1, mRows.map((r) => r.keys));
    check('manager totals = B1 only (net 830, orders 6 — NOT 950/8)',
      qm.body.data.totals.values.net_ex_vat === E.B1.net_ex_vat &&
      qm.body.data.totals.values.orders === E.B1.orders, qm.body.data.totals);
    // even asking for B2 explicitly must not leak it
    const qm2 = await Q(mgr, Object.assign(BASE(), { filters: [{ dimension: 'branch', op: 'eq', value: I.B2 }] }));
    check('manager filtering to the OTHER branch gets empty rows, zero totals',
      qm2.status === 200 && (qm2.body?.data?.rows || []).length === 0 &&
      qm2.body?.data?.totals?.values?.net_ex_vat === 0, qm2.body?.data?.totals);

    // ── zero-grant manager ────────────────────────────────────────────────
    console.log('\n▶ zero-grant manager');
    const qz = await Q(zero, BASE());
    check('zero-grant answers 200 success (never an error)', qz.status === 200 && qz.body?.success === true, qz.status);
    check('zero-grant rows are EMPTY, totals zero (fail-closed)',
      (qz.body?.data?.rows || []).length === 0 && qz.body?.data?.totals?.values?.net_ex_vat === 0 &&
      qz.body?.data?.totals?.values?.orders === 0, qz.body?.data);

    // ── cost masking ──────────────────────────────────────────────────────
    console.log('\n▶ cost-capability masking (manager lacks analytics.cost.view)');
    const qc = await Q(mgr, {
      metrics: ['net_ex_vat', 'cogs', 'gross_profit', 'margin_pct'],
      dimensions: ['branch'], range: E.RANGE,
      filters: [{ dimension: 'branch', op: 'eq', value: I.B1 }],
    });
    check('masked query answers 200', qc.status === 200 && qc.body?.success === true, qc.status);
    check('maskedMetrics lists cogs + gross_profit + margin_pct',
      (qc.body?.meta?.maskedMetrics || []).join(',') === 'cogs,gross_profit,margin_pct', qc.body?.meta);
    const cRow = (qc.body?.data?.rows || [])[0];
    check('cost metrics ABSENT from row values + totals + columns', !!cRow &&
      !('cogs' in cRow.values) && !('gross_profit' in cRow.values) &&
      !('cogs' in (qc.body.data.totals.values || {})) &&
      !(qc.body.data.columns || []).some((c) => c.key === 'cogs'), cRow);
    check('the visible metric still answers exactly (net 830)', !!cRow && cRow.values.net_ex_vat === E.B1.net_ex_vat, cRow);
    // admin DOES see cost on the same request
    const qadm = await Q(admin, {
      metrics: ['cogs'], dimensions: [], range: E.RANGE,
      filters: [{ dimension: 'branch', op: 'eq', value: I.B1 }],
    });
    check('admin cogs B1 = 340 (cap held → value served)', qadm.status === 200 &&
      qadm.body?.data?.totals?.values?.cogs === E.B1.cogs, qadm.body?.data?.totals);

    // ── only-masked → 403 ─────────────────────────────────────────────────
    const qOnly = await Q(mgr, { metrics: ['cogs', 'gross_profit'], range: E.RANGE });
    check('request of ONLY masked metrics → 403 ANALYTICS_ALL_MASKED',
      qOnly.status === 403 && qOnly.body?.code === 'ANALYTICS_ALL_MASKED', qOnly);

    // ── gated dimension ───────────────────────────────────────────────────
    console.log('\n▶ capability-gated dimension');
    // strip the manager's employees capability via a user override (revoke)
    await db.query(
      "INSERT INTO user_permission_overrides (username, permission_id, grant_type) VALUES (?, 'analytics.employees.view', 'revoke') ON DUPLICATE KEY UPDATE grant_type='revoke'",
      [MGR_B1]);
    const qDim = await Q(mgr, {
      metrics: ['orders'], dimensions: ['cashier'], range: E.RANGE,
    });
    check('cashier dimension without employees cap → 403 PERMISSION_DENIED',
      qDim.status === 403 && qDim.body?.code === 'PERMISSION_DENIED', qDim);
    try { await db.query("DELETE FROM user_permission_overrides WHERE username = ? AND permission_id = 'analytics.employees.view'", [MGR_B1]); } catch (_) {}

    // ── no analytics.view at all ──────────────────────────────────────────
    console.log('\n▶ cashier (no analytics.view)');
    const qCash = await Q(cashier, BASE());
    check('cashier query → 403 PERMISSION_DENIED (middleware gate)',
      qCash.status === 403 && qCash.body?.code === 'PERMISSION_DENIED', qCash);
    const mdCash = await call('GET', '/api/analytics/metadata', cashier);
    check('cashier metadata → 403 too (gate covers the whole router)', mdCash.status === 403, mdCash.status);

    // ── metadata is capability-filtered ───────────────────────────────────
    console.log('\n▶ metadata filtering');
    const mdMgr = await call('GET', '/api/analytics/metadata', mgr);
    check('manager metadata omits cost-gated metrics entirely', mdMgr.status === 200 &&
      !(mdMgr.body?.data?.metrics || []).some((m) => m.id === 'cogs' || m.id === 'gross_profit'),
      (mdMgr.body?.data?.metrics || []).filter((m) => m.requiresCap).map((m) => m.id));

    console.log(`\n${fail === 0 ? '✅' : '❌'} analyticsScope: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await seedMod.cleanup(db, PREFIX);
    await cleanupUsers();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
