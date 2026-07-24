'use strict';
/* Integration — POST /api/analytics/query + GET /api/analytics/metadata
 * (real server + DB, direct-SQL fixtures from tests/fixtures/salesHubSeed).
 *
 * Asserts EXACT hand-computed values (salesHubSeed.EXPECTED) for:
 *   single-dim / two-dim / three-dim groupings, multiple metrics per fact
 *   merged on the composite key; totals === Σ rows; ROLLUP subtotal rows;
 *   sort + top-N (totals unaffected by LIMIT); compare prevPeriod against a
 *   seeded prior window; derived metrics (avg_ticket / net_incl_vat /
 *   qty_net); meal-period grouping; voids visible only via voids_* metrics;
 *   labels attached from ONE batched lookup; metadata shape; 422 unknown
 *   metric; 422 too-wide range.
 *
 * Fixtures: ITEST-SHQ-* in 2032-03 (+2032-02 prior window) — disjoint from
 * every other suite. Cleanup before AND in finally. PORT 3981.
 * Run: node tests/integration/analyticsQuery.api.test.js
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');
const seedMod = require('../fixtures/salesHubSeed');

const PORT = 3981;
const PREFIX = 'ITEST-SHQ';
const ADMIN = 'itest_shq_admin';
const PW = 'Shq#Test!2032';
const E = seedMod.EXPECTED;
let I = null;

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) {
  if (c) { pass++; console.log('  ✅', n); }
  else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 300) : ''); }
}
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

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

// every query carries noCache — suites must never read a stale cache entry
const Q = (token, body) => call('POST', '/api/analytics/query', token, Object.assign({ noCache: true }, body));
const rowByKeys = (resp, match) => (resp.body?.data?.rows || []).find((r) =>
  Object.entries(match).every(([k, v]) => String(r.keys[k]) === String(v)));

async function cleanupUsers() {
  try { await db.query('DELETE FROM users WHERE username = ?', [ADMIN]); } catch (_) {}
}

(async () => {
  await seedMod.cleanup(db, PREFIX);
  await cleanupUsers();
  I = await seedMod.seed(db, PREFIX);
  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [ADMIN, hash, 'admin']);

  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..', '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    const admin = await login(ADMIN);
    check('admin got a JWT', !!admin);

    // ── metadata ──────────────────────────────────────────────────────────
    console.log('\n▶ metadata');
    const md = await call('GET', '/api/analytics/metadata', admin);
    check('metadata answers 200 success', md.status === 200 && md.body?.success === true, md.status);
    const mdd = md.body?.data || {};
    check('metadata: metrics + dimensions + dateBases + mealPeriods + freshness present',
      Array.isArray(mdd.metrics) && Array.isArray(mdd.dimensions) &&
      Array.isArray(mdd.dateBases) && Array.isArray(mdd.mealPeriods) &&
      mdd.freshness && mdd.freshness.source === 'live', Object.keys(mdd));
    check('metadata: admin sees the cost-gated metric (cogs)', (mdd.metrics || []).some((m) => m.id === 'cogs'));
    check('metadata: metric shape carries fact/format/equationKey/version', (() => {
      const m = (mdd.metrics || []).find((x) => x.id === 'net_ex_vat');
      return m && m.fact === 'line' && m.format === 'money' && m.equationKey === 'sum' && m.version === 1;
    })(), (mdd.metrics || []).find((x) => x.id === 'net_ex_vat'));
    check('metadata: modifier metrics carry availableFrom (live-only honesty)', (() => {
      const m = (mdd.metrics || []).find((x) => x.id === 'modifier_qty');
      return m && ('availableFrom' in m);
    })());
    const anonMd = await call('GET', '/api/analytics/metadata', null);
    check('anonymous is 401', anonMd.status === 401, anonMd.status);

    // ── single dimension ──────────────────────────────────────────────────
    console.log('\n▶ single-dim [branch]');
    const q1 = await Q(admin, {
      metrics: ['net_ex_vat', 'orders', 'invoice_total', 'qty_sold'],
      dimensions: ['branch'], range: E.RANGE,
      filters: [{ dimension: 'branch', op: 'in', values: [I.B1, I.B2] }],
    });
    check('answers 200 success', q1.status === 200 && q1.body?.success === true, q1.body);
    const b1 = rowByKeys(q1, { branch: I.B1 }), b2 = rowByKeys(q1, { branch: I.B2 });
    check('B1 row exact (net/orders/invoice/qty)', !!b1 &&
      b1.values.net_ex_vat === E.B1.net_ex_vat && b1.values.orders === E.B1.orders &&
      b1.values.invoice_total === E.B1.invoice_total && b1.values.qty_sold === E.B1.qty_sold, b1);
    check('B2 row exact', !!b2 &&
      b2.values.net_ex_vat === E.B2.net_ex_vat && b2.values.orders === E.B2.orders &&
      b2.values.invoice_total === E.B2.invoice_total && b2.values.qty_sold === E.B2.qty_sold, b2);
    const t1 = q1.body.data.totals.values;
    check('totals exact + == Σ rows', t1.net_ex_vat === E.TOTAL.net_ex_vat &&
      t1.orders === E.TOTAL.orders && t1.invoice_total === E.TOTAL.invoice_total &&
      r2(b1.values.net_ex_vat + b2.values.net_ex_vat) === t1.net_ex_vat, t1);
    check('labels attached (branch name from ONE batched lookup)',
      b1.labels && b1.labels.branch === 'ITEST SH Riyadh', b1.labels);
    check('defaultsApplied reports excluded_voided + excluded_credit_note_docs',
      (q1.body.meta?.defaultsApplied || []).includes('excluded_voided') &&
      (q1.body.meta?.defaultsApplied || []).includes('excluded_credit_note_docs'), q1.body.meta);
    check('freshness meta is live', q1.body.meta?.freshness?.source === 'live', q1.body.meta);

    // ── two dimensions + subtotals ────────────────────────────────────────
    console.log('\n▶ two-dim [branch, business_day] + ROLLUP subtotals');
    const q2 = await Q(admin, {
      metrics: ['net_ex_vat'], dimensions: ['branch', 'business_day'], range: E.RANGE,
      filters: [{ dimension: 'branch', op: 'in', values: [I.B1, I.B2] }],
      limit: 100,
    });
    check('answers 200', q2.status === 200 && q2.body?.success === true, q2.status);
    const midnight = rowByKeys(q2, { branch: I.B1, business_day: '2032-03-15' });
    check('B1/03-15 groups BOTH midnight-straddling sales (300)', !!midnight && midnight.values.net_ex_vat === 300, midnight);
    for (const [day, net] of Object.entries(E.BD_B1)) {
      const row = rowByKeys(q2, { branch: I.B1, business_day: day });
      check(`B1 ${day} net=${net}`, !!row && row.values.net_ex_vat === net, row && row.values);
    }
    const subs = q2.body.data.subtotals || [];
    const subB1 = subs.find((s) => s.level === 1 && String(s.keys.branch) === I.B1);
    const subB2 = subs.find((s) => s.level === 1 && String(s.keys.branch) === I.B2);
    check('subtotal level-1 B1 = 830 (ROLLUP)', !!subB1 && subB1.values.net_ex_vat === E.B1.net_ex_vat, subB1);
    check('subtotal level-1 B2 = 120', !!subB2 && subB2.values.net_ex_vat === E.B2.net_ex_vat, subB2);
    check('grand total 950', q2.body.data.totals.values.net_ex_vat === E.TOTAL.net_ex_vat, q2.body.data.totals);

    // ── three dimensions ──────────────────────────────────────────────────
    console.log('\n▶ three-dim [branch, business_day, hour]');
    const q3 = await Q(admin, {
      metrics: ['net_ex_vat', 'orders'], dimensions: ['branch', 'business_day', 'hour'],
      range: E.RANGE, filters: [{ dimension: 'branch', op: 'in', values: [I.B1, I.B2] }],
      limit: 100,
    });
    check('answers 200', q3.status === 200 && q3.body?.success === true, q3.status);
    const h21 = rowByKeys(q3, { branch: I.B1, business_day: '2032-03-15', hour: 21 });
    const h1 = rowByKeys(q3, { branch: I.B1, business_day: '2032-03-15', hour: 1 });
    check('B1/03-15/21:00 → net 100 (pre-midnight sale)', !!h21 && h21.values.net_ex_vat === 100, h21);
    check('B1/03-15/01:00 → net 200 (post-midnight sale, same business day)', !!h1 && h1.values.net_ex_vat === 200, h1);
    check('three-dim totals still 950 / 8 orders', q3.body.data.totals.values.net_ex_vat === 950 &&
      q3.body.data.totals.values.orders === 8, q3.body.data.totals);

    // ── sort + top-N ──────────────────────────────────────────────────────
    console.log('\n▶ sort + top-N');
    const q4 = await Q(admin, {
      metrics: ['net_ex_vat', 'orders'], dimensions: ['business_day'], range: E.RANGE,
      filters: [{ dimension: 'branch', op: 'in', values: [I.B1, I.B2] }],
      sort: [{ by: 'net_ex_vat', dir: 'desc' }], limit: 2,
    });
    const rows4 = q4.body?.data?.rows || [];
    check('top-2 by net: 03-15 (300) then 03-11 (290)', rows4.length === 2 &&
      rows4[0].keys.business_day === '2032-03-15' && rows4[0].values.net_ex_vat === 300 &&
      rows4[1].keys.business_day === '2032-03-11' && rows4[1].values.net_ex_vat === 290, rows4);
    check('top-N page rows carry the SECONDARY fact\'s metric too (orders 2/2, never merge-hole zeros)',
      rows4.length === 2 && rows4[0].values.orders === 2 && rows4[1].values.orders === 2, rows4);
    check('totals unaffected by LIMIT (950)', q4.body.data.totals.values.net_ex_vat === 950, q4.body.data.totals);
    check('page envelope carries limit/offset', q4.body.data.page.limit === 2 && q4.body.data.page.offset === 0, q4.body.data.page);

    // ── derived metrics ───────────────────────────────────────────────────
    console.log('\n▶ derived metrics');
    const q5 = await Q(admin, {
      metrics: ['net_ex_vat', 'vat_amount', 'orders', 'avg_ticket', 'net_incl_vat', 'qty_sold', 'qty_returned', 'qty_net'],
      dimensions: [], range: E.RANGE,
      filters: [{ dimension: 'branch', op: 'in', values: [I.B1, I.B2] }],
    });
    const t5 = q5.body?.data?.totals?.values || {};
    check('vat_amount 121.50 (stored column, never derived)', t5.vat_amount === E.TOTAL.vat_amount, t5);
    check('avg_ticket = round2(950/8) = 118.75', t5.avg_ticket === E.TOTAL.avg_ticket, t5.avg_ticket);
    check('net_incl_vat = 950 + 121.5 = 1071.5', t5.net_incl_vat === E.TOTAL.net_incl_vat, t5.net_incl_vat);
    check('qty_net = 15 sold − 5 returned = 10 (cross-fact merge)', t5.qty_sold === 15 && t5.qty_returned === 5 && t5.qty_net === 10, t5);

    // ── meal periods ──────────────────────────────────────────────────────
    console.log('\n▶ meal_period grouping (derived-js → SQL CASE)');
    const q6 = await Q(admin, {
      metrics: ['net_ex_vat'], dimensions: ['meal_period'], range: E.RANGE,
      filters: [{ dimension: 'branch', op: 'in', values: [I.B1, I.B2] }],
    });
    const lunch = rowByKeys(q6, { meal_period: 'lunch' });
    const dinner = rowByKeys(q6, { meal_period: 'dinner' });
    check('lunch 520 (12:00–16:59 sales)', !!lunch && lunch.values.net_ex_vat === E.MEAL.lunch, lunch);
    check('dinner 430 (incl. 01:30 + 03:30 + 04:30 overnight bucket)', !!dinner && dinner.values.net_ex_vat === E.MEAL.dinner, dinner);

    // ── voids ─────────────────────────────────────────────────────────────
    console.log('\n▶ voids');
    const q7 = await Q(admin, {
      metrics: ['voids_count', 'voids_value'], dimensions: [], range: E.RANGE,
      filters: [{ dimension: 'branch', op: 'in', values: [I.B1, I.B2] }],
    });
    const t7 = q7.body?.data?.totals?.values || {};
    check('voids_count 1 / voids_value 57.50 (the F5 order, visible ONLY here)',
      t7.voids_count === E.VOIDS.count && t7.voids_value === E.VOIDS.value, t7);

    // ── compare prevPeriod ────────────────────────────────────────────────
    console.log('\n▶ compare prevPeriod');
    const q8 = await Q(admin, {
      metrics: ['net_ex_vat', 'orders'], dimensions: [], range: E.RANGE,
      filters: [{ dimension: 'branch', op: 'in', values: [I.B1, I.B2] }],
      compare: 'prevPeriod',
    });
    const tot8 = q8.body?.data?.totals || {};
    check('compare totals = the prior-window doc (net 90, orders 1)',
      tot8.compare && tot8.compare.net_ex_vat === E.PREV.net_ex_vat && tot8.compare.orders === E.PREV.orders, tot8.compare);
    check('delta.pct = growth(950, 90) = 955.56', tot8.delta &&
      tot8.delta.net_ex_vat && tot8.delta.net_ex_vat.pct === E.PREV.growthNetPct, tot8.delta);
    check('delta.abs = 860', tot8.delta && tot8.delta.net_ex_vat.abs === r2(950 - 90), tot8.delta);

    // ── error contract ────────────────────────────────────────────────────
    console.log('\n▶ error contract');
    const e1 = await Q(admin, { metrics: ['no_such_metric'], range: E.RANGE });
    check('unknown metric → 422 ANALYTICS_UNKNOWN_METRIC', e1.status === 422 && e1.body?.code === 'ANALYTICS_UNKNOWN_METRIC', e1);
    const e2 = await Q(admin, { metrics: ['net_ex_vat'], range: { from: '2031-01-01', to: '2032-12-31' } });
    check('too-wide range → 422 ANALYTICS_RANGE_TOO_WIDE', e2.status === 422 && e2.body?.code === 'ANALYTICS_RANGE_TOO_WIDE', e2);
    const e3 = await Q(admin, { metrics: ['net_ex_vat'] });
    check('missing range → 422 VALIDATION_ERROR', e3.status === 422 && e3.body?.code === 'VALIDATION_ERROR', e3);
    const e4 = await call('POST', '/api/analytics/query', null, { metrics: ['net_ex_vat'], range: E.RANGE });
    check('anonymous → 401', e4.status === 401, e4.status);

    console.log(`\n${fail === 0 ? '✅' : '❌'} analyticsQuery: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await seedMod.cleanup(db, PREFIX);
    await cleanupUsers();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
