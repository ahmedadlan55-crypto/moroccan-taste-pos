'use strict';
/* Integration — GET /api/analytics/forecast (real server + DB, own fixture).
 *
 *   · rich branch (8 trailing same-weekday days seeded straight into
 *     analytics_hourly_branch): the checked slot answers with the expected
 *     MEDIAN (7×100 + one 120 outlier → point 100, MAD 0 → band 100..100,
 *     samples 8) — the outlier proves median-not-mean;
 *   · a volatile slot (10/200 alternating → MAD/median ≈ 0.9 > 0.6) is
 *     SUPPRESSED as insufficient_history even with 8 samples;
 *   · metric=orders forecasts the orders column (point 4);
 *   · sparse branch (2 weeks) → every slot insufficient_history (never a
 *     fabricated point), weeksUsed honest;
 *   · empty branch → the GLOBAL insufficient_history response;
 *   · scope: manager (W→BF1) reads BF1 fine, BF2 → 403;
 *   · validation: missing branchId / weekday=9 / bogus metric → 422.
 *
 * Fixtures: ITEST-SHF-* seeded RELATIVE TO TODAY (the service's window is the
 * 56 days ending yesterday — absolute far-future dates would fall outside).
 * PORT 3993.
 * Run: node tests/integration/analyticsForecastApi.api.test.js
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');
const analyticsSchema = require('../../db/migrations/analytics/schema');

const PORT = 3993;
const PREFIX = 'ITEST-SHF';
const ADMIN = 'itest_shf_admin';
const MGR = 'itest_shf_mgr';
const PW = 'Shf#Test!2032';
const BR = `${PREFIX}-BR`;
const BF1 = `${PREFIX}-BF1`;   // rich: 8 weeks
const BF2 = `${PREFIX}-BF2`;   // sparse: 2 weeks
const BF3 = `${PREFIX}-BF3`;   // empty: no rollups at all
const WF1 = `${PREFIX}-WF1`;

const SLOT_GOOD = 26;  // 13:00 — steady history
const SLOT_NOISY = 30; // 15:00 — volatile history (suppression proof)

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) {
  if (c) { pass++; console.log('  ✅', n); }
  else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 400) : ''); }
}

// trailing same-weekday days, LOCAL calendar: yesterday − 7k
function dayAgo(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}
const DAYS = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => dayAgo(1 + 7 * k)); // 8 same-weekday days
const WD = new Date(DAYS[0] + 'T00:00:00Z').getUTCDay();             // their weekday (0=Sun)

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
const FC = (token, qs) => call('GET', '/api/analytics/forecast' + (qs ? '?' + qs : ''), token);
const slotOf = (resp, slot30) => (resp.body?.data?.slots || [])
  .find((s) => s.slot30 === slot30 && s.weekday === WD);

async function cleanupAll() {
  const like = `${PREFIX}-%`;
  const del = async (sql, p) => { try { await db.query(sql, p); } catch (_) {} };
  await del('DELETE FROM analytics_hourly_branch WHERE branch_id LIKE ?', [like]);
  for (const u of [ADMIN, MGR]) {
    try {
      const [r] = await db.query('SELECT id FROM users WHERE username = ?', [u]);
      if (r.length) await db.query('DELETE FROM user_warehouse_access WHERE user_id = ?', [r[0].id]);
    } catch (_) {}
    await del('DELETE FROM users WHERE username = ?', [u]);
  }
  await del('DELETE FROM warehouses WHERE id LIKE ?', [like]);
  await del('DELETE FROM branches WHERE id LIKE ?', [like]);
  await del('DELETE FROM brands WHERE id LIKE ?', [like]);
}

async function seed() {
  await analyticsSchema.apply(db); // rollup tables — idempotent

  await db.query('INSERT INTO brands (id, name) VALUES (?,?)', [BR, 'ITEST SHF Brand']);
  for (const [b, n] of [[BF1, 'Rich'], [BF2, 'Sparse'], [BF3, 'Empty']]) {
    await db.query('INSERT INTO branches (id, name, brand_id) VALUES (?,?,?)',
      [b, 'ITEST SHF ' + n, BR]);
  }
  await db.query(
    "INSERT INTO warehouses (id, code, name, type, branch_id) VALUES (?,?,?,'branch',?)",
    [WF1, 'SHFW1', 'ITEST SHF WH1', BF1]);

  const row = (branch, day, slot, orders, net, guests) => db.query(
    `INSERT INTO analytics_hourly_branch (business_day, branch_id, slot30, orders, net_ex_vat, guests)
     VALUES (?,?,?,?,?,?)`,
    [day, branch, slot, orders, net, guests]);

  // BF1 — 8 same-weekday days: steady slot (one 120 outlier proves median),
  // and a volatile slot alternating 10/200 (dispersion suppression).
  for (let k = 0; k < 8; k++) {
    await row(BF1, DAYS[k], SLOT_GOOD, 4, k === 3 ? 120 : 100, 2);
    await row(BF1, DAYS[k], SLOT_NOISY, 1, k % 2 === 0 ? 10 : 200, 1);
  }
  // BF2 — 2 weeks only
  for (let k = 0; k < 2; k++) {
    await row(BF2, DAYS[k], SLOT_GOOD, 3, 100, 1);
  }
  // BF3 — deliberately nothing
}

(async () => {
  await cleanupAll();
  await seed();

  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [ADMIN, hash, 'admin']);
  const [mr] = await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [MGR, hash, 'manager']);
  await db.query('INSERT INTO user_warehouse_access (user_id, warehouse_id, created_by) VALUES (?,?,?)',
    [mr.insertId, WF1, 'itest']);

  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..', '..'),
    env: { ...process.env, PORT: String(PORT), ANALYTICS_DISABLE_WORKER: '1' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    const admin = await login(ADMIN);
    const mgr = await login(MGR);
    check('both users got JWTs', !!admin && !!mgr);

    // ── rich branch ────────────────────────────────────────────────────────
    console.log('\n▶ rich branch (8 weeks)');
    const f1 = await FC(admin, `branchId=${BF1}&weekday=${WD}`);
    check('answers 200 success, basis rollup', f1.status === 200 &&
      f1.body?.success === true && f1.body?.data?.meta?.basis === 'rollup', f1.status);
    check('meta.weeksUsed = 8 (full history)', f1.body?.data?.meta?.weeksUsed === 8, f1.body?.data?.meta);
    const good = slotOf(f1, SLOT_GOOD);
    check(`steady slot ${SLOT_GOOD}: point = MEDIAN 100 (outlier 120 shrugged off), samples 8`,
      !!good && good.point === 100 && good.samples === 8, good);
    check('steady slot band is exact (MAD 0 → low 100, high 100)',
      !!good && good.low === 100 && good.high === 100, good);
    const noisy = slotOf(f1, SLOT_NOISY);
    check(`volatile slot ${SLOT_NOISY}: SUPPRESSED as insufficient_history despite 8 samples`,
      !!noisy && noisy.availability === 'insufficient_history' &&
      noisy.samples === 8 && noisy.point == null, noisy);
    check('weekday filter respected (every slot is the requested weekday)',
      (f1.body?.data?.slots || []).length > 0 &&
      (f1.body?.data?.slots || []).every((s) => s.weekday === WD),
      (f1.body?.data?.slots || []).map((s) => s.weekday));

    const fo = await FC(admin, `branchId=${BF1}&weekday=${WD}&metric=orders`);
    const goodOrders = slotOf(fo, SLOT_GOOD);
    check('metric=orders: steady slot point = 4', !!goodOrders && goodOrders.point === 4, goodOrders);

    // ── sparse + empty branches ────────────────────────────────────────────
    console.log('\n▶ sparse + empty branches');
    const f2 = await FC(admin, `branchId=${BF2}`);
    const s2 = f2.body?.data?.slots || [];
    check('sparse branch: slots exist but ALL insufficient_history (samples 2 < 6)',
      f2.status === 200 && s2.length > 0 &&
      s2.every((s) => s.availability === 'insufficient_history' && s.point == null), s2);
    check('sparse meta.weeksUsed = 2 (honest)', f2.body?.data?.meta?.weeksUsed === 2, f2.body?.data?.meta);
    const f3 = await FC(admin, `branchId=${BF3}`);
    check('empty branch → GLOBAL insufficient_history, zero slots, weeksUsed 0',
      f3.status === 200 && f3.body?.data?.availability === 'insufficient_history' &&
      (f3.body?.data?.slots || []).length === 0 && f3.body?.data?.meta?.weeksUsed === 0,
      f3.body?.data);

    // ── scope ──────────────────────────────────────────────────────────────
    console.log('\n▶ scope');
    const fm1 = await FC(mgr, `branchId=${BF1}&weekday=${WD}`);
    check('manager reads the IN-scope branch fine', fm1.status === 200 &&
      !!slotOf(fm1, SLOT_GOOD), fm1.status);
    const fm2 = await FC(mgr, `branchId=${BF2}`);
    check('manager asking the OUT-of-scope branch → 403 PERMISSION_DENIED',
      fm2.status === 403 && fm2.body?.code === 'PERMISSION_DENIED', fm2);

    // ── validation ─────────────────────────────────────────────────────────
    console.log('\n▶ validation');
    const v1 = await FC(admin, '');
    check('missing branchId → 422', v1.status === 422 && v1.body?.code === 'VALIDATION_ERROR', v1);
    const v2 = await FC(admin, `branchId=${BF1}&weekday=9`);
    check('weekday=9 → 422', v2.status === 422 && v2.body?.code === 'VALIDATION_ERROR', v2);
    const v3 = await FC(admin, `branchId=${BF1}&metric=bogus`);
    check('bogus metric → 422', v3.status === 422 && v3.body?.code === 'VALIDATION_ERROR', v3);

    console.log(`\n${fail === 0 ? '✅' : '❌'} analyticsForecastApi: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await cleanupAll();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
