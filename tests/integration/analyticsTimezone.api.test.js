'use strict';
/* Integration — business-day vs calendar-day timezone semantics.
 *
 *   F7 midnight-crossing shift (B1, Riyadh, day_close 04:00):
 *     21:00 sale + 01:30-next-morning sale → SAME business_day 2032-03-15,
 *     DIFFERENT calendar days (03-15 vs 03-16).
 *   F8 same-UTC-instant sales (2032-03-20T01:30:00Z):
 *     Riyadh (+03) local 04:30 ≥ close → business_day 03-20;
 *     Cairo  (+02) local 03:30 < close → business_day 03-19 —
 *     one instant, two business days, decided per-branch.
 *   Day-close boundary is EXACT: strictly-before shifts back, at/after does
 *     not (04:30 stays, 01:30 shifts) — asserted through the API and through
 *     the pure lib (businessDay.computeLocal) against the SAME constants, so
 *     the seed can never drift from the engine.
 *
 * Fixtures: ITEST-SHT-* (salesHubSeed, 2032-03). PORT 3984.
 * Run: node tests/integration/analyticsTimezone.api.test.js
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');
const seedMod = require('../fixtures/salesHubSeed');
const businessDay = require('../../lib/analytics/businessDay');

const PORT = 3984;
const PREFIX = 'ITEST-SHT';
const E = seedMod.EXPECTED;
const ADMIN = 'itest_sht_admin';
const PW = 'Sht#Test!2032';
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
const rowByKeys = (resp, match) => (resp.body?.data?.rows || []).find((r) =>
  Object.entries(match).every(([k, v]) => String(r.keys[k]) === String(v)));

(async () => {
  await seedMod.cleanup(db, PREFIX);
  try { await db.query('DELETE FROM users WHERE username = ?', [ADMIN]); } catch (_) {}
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

    // ── pure-lib agreement: the SAME constants the seed hardcodes ─────────
    console.log('\n▶ pure lib agrees with the seeded constants');
    const instant = new Date(E.F8.utcInstant);
    const riyadh = businessDay.computeLocal(instant, 'Asia/Riyadh', '04:00:00');
    check(`computeLocal(UTC 01:30, Riyadh) → local ${E.F8.b1Local}, day ${E.F8.b1Day}`,
      riyadh.occurredAtLocal === E.F8.b1Local && riyadh.businessDay === E.F8.b1Day, riyadh);
    const cairo = businessDay.computeLocal(instant, 'Africa/Cairo', '04:00:00');
    check(`computeLocal(UTC 01:30, Cairo) → local ${E.F8.b2Local}, day ${E.F8.b2Day} (previous!)`,
      cairo.occurredAtLocal === E.F8.b2Local && cairo.businessDay === E.F8.b2Day, cairo);
    const atClose = businessDay.computeLocal('2032-03-16 04:00:00', 'Asia/Riyadh', '04:00:00');
    const beforeClose = businessDay.computeLocal('2032-03-16 03:59:59', 'Asia/Riyadh', '04:00:00');
    check('exact boundary: 04:00:00 belongs to TODAY, 03:59:59 to yesterday',
      atClose.businessDay === '2032-03-16' && beforeClose.businessDay === '2032-03-15',
      { atClose: atClose.businessDay, beforeClose: beforeClose.businessDay });

    // ── F7 through the API ────────────────────────────────────────────────
    console.log('\n▶ F7 — midnight-crossing shift (business vs calendar day)');
    const bd = await Q(admin, {
      metrics: ['net_ex_vat', 'orders'], dimensions: ['business_day'],
      range: { from: '2032-03-15', to: '2032-03-16' },
      filters: [{ dimension: 'branch', op: 'eq', value: I.B1 }],
    });
    check('business_day basis: ONE group 2032-03-15 with BOTH sales (net 300, orders 2)', (() => {
      const rows = bd.body?.data?.rows || [];
      const d15 = rowByKeys(bd, { business_day: E.F7.businessDay });
      return rows.length === 1 && d15 && d15.values.net_ex_vat === 300 && d15.values.orders === 2;
    })(), bd.body?.data?.rows);
    const cal = await Q(admin, {
      metrics: ['net_ex_vat'], dimensions: ['calendar_day'], dateBasis: 'calendar_day',
      range: { from: '2032-03-15', to: '2032-03-16' },
      filters: [{ dimension: 'branch', op: 'eq', value: I.B1 }],
    });
    const c15 = rowByKeys(cal, { calendar_day: E.F7.calA });
    const c16 = rowByKeys(cal, { calendar_day: E.F7.calB });
    check('calendar_day basis: 03-15 → 100 and 03-16 → 200 (the 01:30 sale moves)',
      !!c15 && c15.values.net_ex_vat === E.F7.netA && !!c16 && c16.values.net_ex_vat === E.F7.netB,
      cal.body?.data?.rows);
    // mixed basis: business_day RANGE with calendar_day grouping intentionally
    // not asserted — each basis is queried on its own column end-to-end above.
    const hour = await Q(admin, {
      metrics: ['net_ex_vat'], dimensions: ['hour'], dateBasis: 'calendar_day',
      range: { from: '2032-03-16', to: '2032-03-16' },
      filters: [{ dimension: 'branch', op: 'eq', value: I.B1 }],
    });
    const h1 = rowByKeys(hour, { hour: 1 });
    check('the 01:30 sale lands in hour 1 of calendar 03-16', !!h1 && h1.values.net_ex_vat === 200, hour.body?.data?.rows);

    // ── F8 through the API ────────────────────────────────────────────────
    console.log('\n▶ F8 — same UTC instant, two branches, two business days');
    const f8 = await Q(admin, {
      metrics: ['net_ex_vat'], dimensions: ['branch', 'business_day'],
      range: { from: '2032-03-19', to: '2032-03-20' },
      filters: [{ dimension: 'branch', op: 'in', values: [I.B1, I.B2] }],
    });
    const rB1 = rowByKeys(f8, { branch: I.B1, business_day: E.F8.b1Day });
    const rB2 = rowByKeys(f8, { branch: I.B2, business_day: E.F8.b2Day });
    check(`Riyadh branch: business_day ${E.F8.b1Day} (local 04:30 ≥ close)`, !!rB1 && rB1.values.net_ex_vat === E.F8.b1Net, f8.body?.data?.rows);
    check(`Cairo branch: business_day ${E.F8.b2Day} (local 03:30 < close — PREVIOUS day)`, !!rB2 && rB2.values.net_ex_vat === E.F8.b2Net, f8.body?.data?.rows);
    check('neither branch has a row on the OTHER branch\'s day', !rowByKeys(f8, { branch: I.B1, business_day: E.F8.b2Day }) &&
      !rowByKeys(f8, { branch: I.B2, business_day: E.F8.b1Day }), f8.body?.data?.rows);

    // ── full-window day map (both bases, both branches) ───────────────────
    console.log('\n▶ full-window day maps');
    const all = await Q(admin, {
      metrics: ['net_ex_vat'], dimensions: ['branch', 'business_day'], range: E.RANGE,
      filters: [{ dimension: 'branch', op: 'in', values: [I.B1, I.B2] }], limit: 100,
    });
    let mapOk = true;
    for (const [day, net] of Object.entries(E.BD_B1)) {
      const r = rowByKeys(all, { branch: I.B1, business_day: day });
      if (!r || r.values.net_ex_vat !== net) { mapOk = false; break; }
    }
    for (const [day, net] of Object.entries(E.BD_B2)) {
      const r = rowByKeys(all, { branch: I.B2, business_day: day });
      if (!r || r.values.net_ex_vat !== net) { mapOk = false; break; }
    }
    check('every business_day bucket matches the hand-computed map (B1 + B2)', mapOk, all.body?.data?.rows);
    const allCal = await Q(admin, {
      metrics: ['net_ex_vat'], dimensions: ['branch', 'calendar_day'], dateBasis: 'calendar_day',
      range: E.RANGE,
      filters: [{ dimension: 'branch', op: 'in', values: [I.B1, I.B2] }], limit: 100,
    });
    let calOk = true;
    for (const [day, net] of Object.entries(E.CAL_B1)) {
      const r = rowByKeys(allCal, { branch: I.B1, calendar_day: day });
      if (!r || r.values.net_ex_vat !== net) { calOk = false; break; }
    }
    for (const [day, net] of Object.entries(E.CAL_B2)) {
      const r = rowByKeys(allCal, { branch: I.B2, calendar_day: day });
      if (!r || r.values.net_ex_vat !== net) { calOk = false; break; }
    }
    check('every calendar_day bucket matches the hand-computed map (B1 + B2)', calOk, allCal.body?.data?.rows);
    check('both bases agree on the grand total (950)',
      all.body?.data?.totals?.values?.net_ex_vat === 950 &&
      allCal.body?.data?.totals?.values?.net_ex_vat === 950,
      { bd: all.body?.data?.totals, cal: allCal.body?.data?.totals });

    console.log(`\n${fail === 0 ? '✅' : '❌'} analyticsTimezone: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await seedMod.cleanup(db, PREFIX);
    try { await db.query('DELETE FROM users WHERE username = ?', [ADMIN]); } catch (_) {}
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
