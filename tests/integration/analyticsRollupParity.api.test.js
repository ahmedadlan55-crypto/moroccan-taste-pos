'use strict';
/* Integration — RollupService parity vs the LIVE /api/analytics/query path.
 *
 * Seeds the shared salesHubSeed fixtures (ITEST-SHR-*, window 2032-03 +
 * 2032-02 prior doc), enqueues every (branch, day) pair via
 * RollupService.rebuildRange, drains the dirty queue IN-PROCESS (never the
 * worker timer), then asserts:
 *   (a) every seeded day's analytics_daily_branch row equals the live query
 *       result for the same day/branch across net_ex_vat / orders / vat /
 *       invoice_total / discounts / refunds (+ returns_net), noCache;
 *   (b) analytics_hourly_branch slot30 rows equal live half_hour grouping;
 *   (c) analytics_daily_payment equals live payment_method×direction grouping
 *       (amounts) and the fact table itself (tx_count);
 *   (d) drainDirty is idempotent — re-enqueue + re-drain → byte-identical
 *       rollup rows across all 4 tables;
 *   (e) drainRepair heals a queued repair row (replay through
 *       ProjectionService), bumps unknown types, skips attempts>=10 rows;
 *   (f) analytics_rollup_state.rollup_watermark advanced.
 *
 * The spawned server runs with ANALYTICS_DISABLE_WORKER=1 so only THIS
 * process drives the rollups. Cleanup before AND in finally. PORT 3986.
 * Run: node tests/integration/analyticsRollupParity.api.test.js
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');
const seedMod = require('../fixtures/salesHubSeed');
const RollupService = require('../../services/analytics/RollupService');

const PORT = 3986;
const PREFIX = 'ITEST-SHR';
const ADMIN = 'itest_shr_admin';
const PW = 'Shr#Test!2032';
const E = seedMod.EXPECTED;
let I = null;

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) {
  if (c) { pass++; console.log('  ✅', n); }
  else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 400) : ''); }
}
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// DB tz offset → recover wall-clock 'YYYY-MM-DD' from mysql2 DATE Dates.
const OFF_MIN = (() => {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(String(db.DB_TIME_ZONE || '+03:00'));
  if (!m) return 180;
  const min = (+m[2]) * 60 + (+m[3]);
  return m[1] === '-' ? -min : min;
})();
const dayOf = (v) => RollupService._dayStr(v, OFF_MIN);

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
// every live query carries noCache — parity must never read a stale cache
const Q = (token, body) => call('POST', '/api/analytics/query', token, Object.assign({ noCache: true }, body));
const rowByKeys = (resp, match) => (resp.body?.data?.rows || []).find((r) =>
  Object.entries(match).every(([k, v]) => String(r.keys[k]) === String(v)));

async function cleanupUsers() {
  try { await db.query('DELETE FROM users WHERE username = ?', [ADMIN]); } catch (_) {}
}
async function cleanupRollups() {
  const like = `${PREFIX}-%`;
  const del = async (sql) => { try { await db.query(sql, [like]); } catch (_) {} };
  await del('DELETE FROM analytics_daily_branch WHERE branch_id LIKE ?');
  await del('DELETE FROM analytics_daily_item WHERE branch_id LIKE ?');
  await del('DELETE FROM analytics_daily_payment WHERE branch_id LIKE ?');
  await del('DELETE FROM analytics_hourly_branch WHERE branch_id LIKE ?');
  await del('DELETE FROM analytics_projection_repair WHERE source_id LIKE ?');
}

/** Deterministic, DB-representation-stable snapshot of all 4 rollup tables
 *  restricted to the test branches (idempotency proof). */
async function snapshotRollups() {
  const norm = (rows, dateCols) => JSON.stringify(rows.map((r) => {
    const o = {};
    for (const k of Object.keys(r).sort()) {
      o[k] = dateCols.includes(k) ? dayOf(r[k]) : (r[k] == null ? null : String(r[k]));
    }
    return o;
  }));
  const B = [I.B1, I.B2];
  const [b] = await db.query(
    'SELECT * FROM analytics_daily_branch WHERE branch_id IN (?,?) ORDER BY business_day, branch_id', B);
  const [it] = await db.query(
    'SELECT * FROM analytics_daily_item WHERE branch_id IN (?,?) ORDER BY business_day, branch_id, menu_id', B);
  const [p] = await db.query(
    'SELECT * FROM analytics_daily_payment WHERE branch_id IN (?,?) ORDER BY business_day, branch_id, method_norm, direction', B);
  const [h] = await db.query(
    'SELECT * FROM analytics_hourly_branch WHERE branch_id IN (?,?) ORDER BY business_day, branch_id, slot30', B);
  return {
    daily_branch: norm(b, ['business_day']),
    daily_item: norm(it, ['business_day']),
    daily_payment: norm(p, ['business_day']),
    hourly_branch: norm(h, ['business_day']),
  };
}

async function drainAll(limit) {
  const acc = { claimed: 0, rebuilt: 0, failed: 0, mode: null, iterations: 0 };
  for (let i = 0; i < 30; i++) {
    const r = await RollupService.drainDirty(db, { limit });
    acc.iterations++; acc.mode = r.mode;
    acc.claimed += r.claimed; acc.rebuilt += r.rebuilt; acc.failed += r.failed;
    if (r.claimed === 0) break;
  }
  return acc;
}

(async () => {
  const testStartMs = Date.now();
  await seedMod.cleanup(db, PREFIX);
  await cleanupRollups();
  await cleanupUsers();
  I = await seedMod.seed(db, PREFIX);
  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [ADMIN, hash, 'admin']);

  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..', '..'),
    env: { ...process.env, PORT: String(PORT), ANALYTICS_DISABLE_WORKER: '1' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    const admin = await login(ADMIN);
    check('admin got a JWT', !!admin);

    // ── rebuildRange enqueues every (branch, day) pair ─────────────────────
    console.log('\n▶ rebuildRange');
    const rr1 = await RollupService.rebuildRange(db, {
      from: '2032-02-01', to: '2032-03-31', branchIds: [I.B1, I.B2],
    });
    const [dc] = await db.query(
      'SELECT COUNT(*) c FROM analytics_rollup_dirty WHERE branch_id IN (?,?)', [I.B1, I.B2]);
    check('enqueued 120 pairs (2 branches × 60 days, INSERT IGNORE)',
      rr1.pairs === 120 && rr1.days === 60 && Number(dc[0].c) === 120, { rr1, dirty: dc[0].c });

    // ── drainDirty ─────────────────────────────────────────────────────────
    console.log('\n▶ drainDirty');
    const d1 = await drainAll(200);
    check('drained ≥ 120 pairs (ours + any pre-existing backlog)', d1.claimed >= 120, d1);
    check('claim mode is skip_locked on this MySQL', d1.mode === 'skip_locked', d1.mode);
    const [dl] = await db.query(
      'SELECT COUNT(*) c FROM analytics_rollup_dirty WHERE branch_id IN (?,?)', [I.B1, I.B2]);
    check('dirty queue empty for the test branches (all pairs rebuilt + deleted)',
      Number(dl[0].c) === 0, dl[0]);

    // ── (a) daily_branch parity vs live query ──────────────────────────────
    console.log('\n▶ (a) daily_branch ≡ live query, per (branch, day)');
    const PAIRS = [
      [I.B1, '2032-03-10'], [I.B1, '2032-03-11'], [I.B1, '2032-03-12'],
      [I.B1, '2032-03-13'], [I.B1, '2032-03-14'], [I.B1, '2032-03-15'],
      [I.B1, '2032-03-20'],
      [I.B2, '2032-03-11'], [I.B2, '2032-03-13'], [I.B2, '2032-03-19'],
      [I.B1, '2032-02-10'], // prior-window doc — rebuildRange covered Feb too
    ];
    for (const [branch, day] of PAIRS) {
      const range = day.slice(0, 7) === '2032-02' ? { from: '2032-02-01', to: '2032-02-29' } : E.RANGE;
      const live = await Q(admin, {
        metrics: ['orders', 'net_ex_vat', 'vat_amount', 'invoice_total',
          'discounts_total', 'refunds_out', 'returns_net'],
        dimensions: [], range,
        filters: [
          { dimension: 'branch', op: 'eq', value: branch },
          { dimension: 'business_day', op: 'eq', value: day },
        ],
      });
      const lv = live.body?.data?.totals?.values || {};
      const [rrow] = await db.query(
        'SELECT * FROM analytics_daily_branch WHERE branch_id = ? AND business_day = ?', [branch, day]);
      const row = rrow[0] || {};
      check(`parity ${branch.slice(-2)} ${day} (orders/net/vat/invoice/discounts/refunds/returns)`,
        live.status === 200 &&
        r2(row.orders) === r2(lv.orders) &&
        r2(row.net_ex_vat) === r2(lv.net_ex_vat) &&
        r2(row.vat) === r2(lv.vat_amount) &&
        r2(row.invoice_total) === r2(lv.invoice_total) &&
        r2(row.discounts) === r2(lv.discounts_total) &&
        r2(row.refunds_amount) === r2(lv.refunds_out) &&
        r2(row.returns_net) === r2(lv.returns_net),
        { rollup: row, live: lv });
    }

    // anchor the parity to the hand-computed constants (not just live↔rollup)
    const [[a10]] = await db.query(
      'SELECT * FROM analytics_daily_branch WHERE branch_id = ? AND business_day = ?', [I.B1, '2032-03-10']);
    check('B1 03-10 anchors: net 180 / vat 24 / invoice 204 / voids 1 / guests 3 / gross_product 204 / cogs 70 / gross_profit 110',
      !!a10 && r2(a10.net_ex_vat) === 180 && r2(a10.vat) === 24 && r2(a10.invoice_total) === 204 &&
      Number(a10.voids_count) === 1 && Number(a10.guests) === 3 &&
      r2(a10.gross_product) === 204 && r2(a10.cogs) === 70 && r2(a10.gross_profit) === 110, a10);
    const [[a12]] = await db.query(
      'SELECT * FROM analytics_daily_branch WHERE branch_id = ? AND business_day = ?', [I.B1, '2032-03-12']);
    check('B1 03-12 (CN day): sales columns 0, returns_net 100, refunds 115 (no double count in the rollup)',
      !!a12 && Number(a12.orders) === 0 && r2(a12.net_ex_vat) === 0 && r2(a12.invoice_total) === 0 &&
      r2(a12.returns_net) === 100 && r2(a12.refunds_amount) === 115, a12);
    const [[gt]] = await db.query(
      `SELECT SUM(orders) o, SUM(guests) g, SUM(net_ex_vat) n, SUM(vat) v, SUM(invoice_total) it,
              SUM(discounts) dis, SUM(refunds_amount) rf, SUM(returns_net) rn,
              SUM(voids_count) vc, SUM(gross_product) gp, SUM(cogs) c
         FROM analytics_daily_branch
        WHERE branch_id IN (?,?) AND business_day BETWEEN ? AND ?`,
      [I.B1, I.B2, E.RANGE.from, E.RANGE.to]);
    check('rollup grand totals = EXPECTED.TOTAL (orders 8 / net 950 / vat 121.5 / invoice 1071.5 / refunds 262.5 / returns 240 / voids 1 / cogs 365)',
      Number(gt.o) === E.TOTAL.orders && Number(gt.g) === E.TOTAL.guests &&
      r2(gt.n) === E.TOTAL.net_ex_vat && r2(gt.v) === E.TOTAL.vat_amount &&
      r2(gt.it) === E.TOTAL.invoice_total && r2(gt.dis) === E.TOTAL.discounts_total &&
      r2(gt.rf) === E.TOTAL.refunds_out && r2(gt.rn) === E.TOTAL.returns_net &&
      Number(gt.vc) === E.VOIDS.count && r2(gt.gp) === 1071.5 && r2(gt.c) === E.TOTAL.cogs, gt);

    // ── (b) hourly_branch parity vs live half_hour grouping ────────────────
    console.log('\n▶ (b) hourly_branch slot30 ≡ live half_hour');
    const liveH = await Q(admin, {
      metrics: ['orders', 'net_ex_vat', 'guests'], dimensions: ['half_hour'], range: E.RANGE,
      filters: [
        { dimension: 'branch', op: 'eq', value: I.B1 },
        { dimension: 'business_day', op: 'eq', value: '2032-03-15' },
      ], limit: 100,
    });
    const [h15] = await db.query(
      'SELECT slot30, orders, net_ex_vat, guests FROM analytics_hourly_branch WHERE branch_id = ? AND business_day = ? ORDER BY slot30',
      [I.B1, '2032-03-15']);
    check('B1 03-15 has exactly slots 3 (01:30) and 42 (21:00)',
      h15.length === 2 && Number(h15[0].slot30) === 3 && Number(h15[1].slot30) === 42, h15);
    for (const hr of h15) {
      const lrow = rowByKeys(liveH, { half_hour: Number(hr.slot30) });
      check(`slot ${hr.slot30}: rollup == live (orders/net/guests)`,
        !!lrow && Number(hr.orders) === lrow.values.orders &&
        r2(hr.net_ex_vat) === lrow.values.net_ex_vat &&
        Number(hr.guests) === lrow.values.guests,
        { rollup: hr, live: lrow && lrow.values });
    }
    const [[hsum]] = await db.query(
      `SELECT SUM(net_ex_vat) n, SUM(orders) o FROM analytics_hourly_branch
        WHERE branch_id IN (?,?) AND business_day BETWEEN ? AND ?`,
      [I.B1, I.B2, E.RANGE.from, E.RANGE.to]);
    check('hourly range sums = daily grand (net 950 / orders 8) — no slot lost or duplicated',
      r2(hsum.n) === E.TOTAL.net_ex_vat && Number(hsum.o) === E.TOTAL.orders, hsum);
    const [hVoid] = await db.query(
      'SELECT slot30 FROM analytics_hourly_branch WHERE branch_id = ? AND business_day = ? AND slot30 = 21',
      [I.B1, '2032-03-10']);
    check('voided F5 (10:30 → slot 21) contributes NO hourly row', hVoid.length === 0, hVoid);

    // ── (c) daily_payment parity ───────────────────────────────────────────
    console.log('\n▶ (c) daily_payment ≡ live payment_method × direction');
    const liveP = await Q(admin, {
      metrics: ['payments_in', 'refunds_out'], dimensions: ['payment_method', 'direction'],
      range: E.RANGE, filters: [{ dimension: 'branch', op: 'in', values: [I.B1, I.B2] }],
      limit: 100,
    });
    const [pRoll] = await db.query(
      `SELECT method_norm, direction, SUM(amount) amt, SUM(tx_count) cnt
         FROM analytics_daily_payment
        WHERE branch_id IN (?,?) AND business_day BETWEEN ? AND ?
        GROUP BY method_norm, direction ORDER BY method_norm, direction`,
      [I.B1, I.B2, E.RANGE.from, E.RANGE.to]);
    const [pFact] = await db.query(
      `SELECT COALESCE(p.method_norm, 'other') mn, p.direction, COUNT(*) c, SUM(p.amount) a
         FROM analytics_payment_facts p
        WHERE p.branch_id IN (?,?) AND p.business_day BETWEEN ? AND ?
        GROUP BY COALESCE(p.method_norm, 'other'), p.direction`,
      [I.B1, I.B2, E.RANGE.from, E.RANGE.to]);
    check('4 payment groups (cash-in, card-in, cash-out, other-out)', pRoll.length === 4, pRoll);
    for (const g of pRoll) {
      const lrow = rowByKeys(liveP, { payment_method: g.method_norm, direction: g.direction });
      const liveAmt = lrow ? (g.direction === 'in' ? lrow.values.payments_in : lrow.values.refunds_out) : null;
      const fRow = pFact.find((f) => f.mn === g.method_norm && f.direction === g.direction);
      check(`payment ${g.method_norm}/${g.direction}: rollup amount == live && tx_count == fact count`,
        !!lrow && r2(g.amt) === r2(liveAmt) && !!fRow &&
        Number(g.cnt) === Number(fRow.c) && r2(g.amt) === r2(fRow.a),
        { rollup: g, live: liveAmt, fact: fRow });
    }
    const cashIn = pRoll.find((g) => g.method_norm === 'cash' && g.direction === 'in');
    const cardIn = pRoll.find((g) => g.method_norm === 'card' && g.direction === 'in');
    const cashOut = pRoll.find((g) => g.method_norm === 'cash' && g.direction === 'out');
    const otherOut = pRoll.find((g) => g.method_norm === 'other' && g.direction === 'out');
    check('payment anchors: cash-in 511.5 / card-in 560 / cash-out 57.5 / other-out 205',
      cashIn && r2(cashIn.amt) === E.PAY_IN.cash && cardIn && r2(cardIn.amt) === E.PAY_IN.card &&
      cashOut && r2(cashOut.amt) === E.PAY_OUT.cash && otherOut && r2(otherOut.amt) === E.PAY_OUT.other,
      pRoll);

    // ── daily_item spot parity (covered structurally by (d) snapshots) ─────
    console.log('\n▶ daily_item ≡ live menu_item grouping');
    const liveI = await Q(admin, {
      metrics: ['qty_sold', 'net_ex_vat'], dimensions: ['menu_item'], range: E.RANGE,
      filters: [
        { dimension: 'branch', op: 'eq', value: I.B1 },
        { dimension: 'business_day', op: 'eq', value: '2032-03-10' },
      ], limit: 100,
    });
    const [i10] = await db.query(
      'SELECT menu_id, qty_sold, gross, discount_alloc, net_ex_vat, vat, cogs FROM analytics_daily_item WHERE branch_id = ? AND business_day = ? ORDER BY menu_id',
      [I.B1, '2032-03-10']);
    check('B1 03-10 has 3 item rows (voided D5 line excluded)', i10.length === 3, i10);
    for (const ir of i10) {
      const lrow = rowByKeys(liveI, { menu_item: ir.menu_id });
      check(`item ${String(ir.menu_id).slice(-2)}: rollup qty/net == live`,
        !!lrow && r2(ir.qty_sold) === lrow.values.qty_sold && r2(ir.net_ex_vat) === lrow.values.net_ex_vat,
        { rollup: ir, live: lrow && lrow.values });
    }
    const [[itRet]] = await db.query(
      'SELECT qty_sold, qty_returned FROM analytics_daily_item WHERE branch_id = ? AND business_day = ? AND menu_id = ?',
      [I.B1, '2032-03-12', I.M1]);
    check('return-only day row (B1 03-12 M1): qty_sold 0, qty_returned 1 (return attributes to the RETURN day)',
      !!itRet && r2(itRet.qty_sold) === 0 && r2(itRet.qty_returned) === 1, itRet);

    // ── (d) idempotency ────────────────────────────────────────────────────
    console.log('\n▶ (d) drain idempotency (re-enqueue + re-drain → identical rows)');
    const snap1 = await snapshotRollups();
    await RollupService.rebuildRange(db, { from: '2032-02-01', to: '2032-03-31', branchIds: [I.B1, I.B2] });
    const d2 = await drainAll(200);
    check('second drain claimed the 120 re-enqueued pairs', d2.claimed >= 120 && d2.failed === 0, d2);
    const snap2 = await snapshotRollups();
    for (const t of ['daily_branch', 'daily_item', 'daily_payment', 'hourly_branch']) {
      check(`idempotent: ${t} byte-identical after re-drain`, snap1[t] === snap2[t],
        snap1[t] === snap2[t] ? undefined : { before: snap1[t].slice(0, 200), after: snap2[t].slice(0, 200) });
    }

    // ── (e) drainRepair ────────────────────────────────────────────────────
    console.log('\n▶ (e) drainRepair');
    await db.query(
      'INSERT INTO analytics_projection_repair (source_type, source_id, attempts, last_error) VALUES (?,?,0,?)',
      ['sale', I.S1, 'ITEST artificial failure']);
    await db.query(
      'INSERT INTO analytics_projection_repair (source_type, source_id, attempts) VALUES (?,?,0)',
      ['bogus_type', PREFIX + '-BOGUS']);
    await db.query(
      'INSERT INTO analytics_projection_repair (source_type, source_id, attempts, last_error) VALUES (?,?,10,?)',
      ['sale', PREFIX + '-FLAGGED', 'gave up earlier']);
    const rep = await RollupService.drainRepair(db, { limit: 50 });
    check('drainRepair scanned + healed ≥ 1', rep.scanned >= 2 && rep.healed >= 1, rep);
    const [healed] = await db.query(
      'SELECT 1 FROM analytics_projection_repair WHERE source_type = ? AND source_id = ?', ['sale', I.S1]);
    check('healed row deleted (sale replayed through ProjectionService)', healed.length === 0, healed);
    const [[bogus]] = await db.query(
      'SELECT attempts, last_error FROM analytics_projection_repair WHERE source_type = ? AND source_id = ?',
      ['bogus_type', PREFIX + '-BOGUS']);
    check('unknown source_type: kept, attempts bumped to 1, reason recorded',
      !!bogus && Number(bogus.attempts) === 1 && /no replay mapping/.test(String(bogus.last_error)), bogus);
    const [[flagged]] = await db.query(
      'SELECT attempts FROM analytics_projection_repair WHERE source_type = ? AND source_id = ?',
      ['sale', PREFIX + '-FLAGGED']);
    check('attempts>=10 row permanently flagged: untouched (not replayed, not deleted)',
      !!flagged && Number(flagged.attempts) === 10, flagged);
    const [redirty] = await db.query(
      'SELECT 1 FROM analytics_rollup_dirty WHERE branch_id = ? AND business_day = ?', [I.B1, '2032-03-10']);
    check('successful replay re-enqueued its (branch, day) into the dirty queue', redirty.length === 1, redirty);
    // drain the re-enqueued pair and prove the healed projection kept parity
    await drainAll(200);
    const snap3 = await snapshotRollups();
    check('rollups unchanged after replay + re-drain (repair is value-neutral on healthy data)',
      snap3.daily_branch === snap2.daily_branch && snap3.daily_payment === snap2.daily_payment,
      undefined);

    // ── (f) watermark ──────────────────────────────────────────────────────
    console.log('\n▶ (f) rollup_watermark');
    const [wm] = await db.query("SELECT v FROM analytics_rollup_state WHERE k = 'rollup_watermark' LIMIT 1");
    const wmMs = wm.length ? Date.parse(String(wm[0].v)) : NaN;
    check('rollup_watermark present, ISO, advanced past test start',
      wm.length === 1 && Number.isFinite(wmMs) && wmMs >= testStartMs - 60000, wm[0]);

    console.log(`\n${fail === 0 ? '✅' : '❌'} analyticsRollupParity: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await seedMod.cleanup(db, PREFIX);
    await cleanupRollups();
    await cleanupUsers();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
