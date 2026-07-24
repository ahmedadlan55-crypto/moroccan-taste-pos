'use strict';
/* Integration — payment-fact semantics (real server + DB).
 *
 *   · split tender legs SUM exactly to the sale's total_final (F1: cash 104 +
 *     card 100 = 204) — asserted against the DB row AND the seed constant;
 *   · refunds carry direction 'out' and never contaminate payments_in
 *     (F14 cash refund + the two ar_reduction refunds);
 *   · method_norm buckets: cash/card exact by branch and in total, plus the
 *     normalizeMethod fold itself (Arabic labels, mada→card, كيتا→kita);
 *   · the payment fact reconciles with the ORDER fact for the same filters:
 *     payments_in == invoice_total per branch and in total (every sale in the
 *     fixture is fully tendered at sale time);
 *   · net_collections (derived) = payments_in − refunds_out.
 *
 * Fixtures: ITEST-SHP-* (salesHubSeed, 2032-03). PORT 3985.
 * Run: node tests/integration/analyticsPayments.api.test.js
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');
const seedMod = require('../fixtures/salesHubSeed');
const { normalizeMethod } = require('../../services/analytics/ProjectionService');

const PORT = 3985;
const PREFIX = 'ITEST-SHP';
const E = seedMod.EXPECTED;
const ADMIN = 'itest_shp_admin';
const PW = 'Shp#Test!2032';
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

    const bothBranches = { dimension: 'branch', op: 'in', values: [I.B1, I.B2] };

    // ── split legs == sales.total_final ───────────────────────────────────
    console.log('\n▶ split legs sum to the sale total');
    const [[saleRow]] = [await db.query('SELECT total_final FROM sales WHERE id = ? LIMIT 1', [I.S1])].map((p) => p);
    const [legRows] = await db.query(
      "SELECT method_norm, SUM(amount) amt, COUNT(*) legs FROM analytics_payment_facts WHERE source_id = ? AND direction='in' GROUP BY method_norm",
      [I.S1]);
    const legSum = r2(legRows.reduce((s, r) => s + Number(r.amt), 0));
    check('F1 split: Σ legs (104 cash + 100 card) == sales.total_final == 204',
      legSum === r2(saleRow[0].total_final) && legSum === E.F1.split_sum, { legSum, total: saleRow[0] });
    const byNorm = {};
    for (const r of legRows) byNorm[r.method_norm] = r2(r.amt);
    check('F1 legs normalized: cash 104 / card 100 (Mada folds into card)',
      byNorm.cash === E.F1.cash && byNorm.card === E.F1.card, byNorm);

    // ── normalizeMethod fold (the lib itself) ─────────────────────────────
    console.log('\n▶ method_norm buckets (normalizeMethod)');
    check('fold: Cash/نقدي/كاش → cash', normalizeMethod('Cash') === 'cash' &&
      normalizeMethod('نقدي') === 'cash' && normalizeMethod('كاش') === 'cash');
    check('fold: Mada/Visa/شبكة/بطاقة → card', normalizeMethod('Mada') === 'card' &&
      normalizeMethod('Visa') === 'card' && normalizeMethod('شبكة') === 'card' && normalizeMethod('بطاقة') === 'card');
    check('fold: كيتا/آجل/credit → kita', normalizeMethod('كيتا') === 'kita' &&
      normalizeMethod('آجل') === 'kita' && normalizeMethod('credit') === 'kita');
    check('fold: تحويل بنكي → transfer; junk → other', normalizeMethod('تحويل بنكي') === 'transfer' &&
      normalizeMethod('???') === 'other');

    // ── payments_in by method through the API ─────────────────────────────
    console.log('\n▶ payments_in by method');
    const qm = await Q(admin, {
      metrics: ['payments_in', 'refunds_out'], dimensions: ['payment_method'],
      range: E.RANGE, filters: [bothBranches], limit: 20,
    });
    check('answers 200', qm.status === 200 && qm.body?.success === true, qm.status);
    const cashRow = rowByKeys(qm, { payment_method: 'cash' });
    const cardRow = rowByKeys(qm, { payment_method: 'card' });
    const otherRow = rowByKeys(qm, { payment_method: 'other' });
    check('cash in 511.50 / card in 560', !!cashRow && cashRow.values.payments_in === E.PAY_IN.cash &&
      !!cardRow && cardRow.values.payments_in === E.PAY_IN.card, { cash: cashRow?.values, card: cardRow?.values });
    check('refunds by method: cash 57.50 (F14) / other 205 (2× ar_reduction)',
      !!cashRow && cashRow.values.refunds_out === E.PAY_OUT.cash &&
      !!otherRow && otherRow.values.refunds_out === E.PAY_OUT.other, { cash: cashRow?.values, other: otherRow?.values });
    check('totals: in 1071.50 / out 262.50', qm.body.data.totals.values.payments_in === E.TOTAL.payments_in &&
      qm.body.data.totals.values.refunds_out === E.TOTAL.refunds_out, qm.body.data.totals);

    // ── direction dimension ───────────────────────────────────────────────
    console.log('\n▶ direction dimension');
    const qd = await Q(admin, {
      metrics: ['payments_in', 'refunds_out'], dimensions: ['direction'],
      range: E.RANGE, filters: [bothBranches],
    });
    const inRow = rowByKeys(qd, { direction: 'in' });
    const outRow = rowByKeys(qd, { direction: 'out' });
    check('direction=in row: payments_in 1071.5, refunds_out 0', !!inRow &&
      inRow.values.payments_in === E.TOTAL.payments_in && inRow.values.refunds_out === 0, inRow?.values);
    check('direction=out row: refunds_out 262.5, payments_in 0 (refunds NEVER leak into in)',
      !!outRow && outRow.values.refunds_out === E.TOTAL.refunds_out && outRow.values.payments_in === 0, outRow?.values);

    // ── reconciliation with the order fact ────────────────────────────────
    console.log('\n▶ payment fact ⇄ order fact reconciliation');
    const qr = await Q(admin, {
      metrics: ['payments_in', 'invoice_total', 'refunds_out', 'net_collections'],
      dimensions: ['branch'], range: E.RANGE, filters: [bothBranches],
    });
    const b1 = rowByKeys(qr, { branch: I.B1 });
    const b2 = rowByKeys(qr, { branch: I.B2 });
    check('B1: payments_in == invoice_total == 951.50 (fully-tendered sales)',
      !!b1 && b1.values.payments_in === E.B1.payments_in && b1.values.invoice_total === E.B1.invoice_total &&
      b1.values.payments_in === b1.values.invoice_total, b1?.values);
    check('B2: payments_in == invoice_total == 120', !!b2 &&
      b2.values.payments_in === E.B2.payments_in && b2.values.invoice_total === E.B2.invoice_total, b2?.values);
    check('B1 refunds_out 172.50 / B2 refunds_out 90', !!b1 && b1.values.refunds_out === E.B1.refunds_out &&
      !!b2 && b2.values.refunds_out === E.B2.refunds_out, { b1: b1?.values, b2: b2?.values });
    const t = qr.body.data.totals.values;
    check('net_collections = 1071.50 − 262.50 = 809 (derived, integer-halala arithmetic)',
      t.net_collections === r2(E.TOTAL.payments_in - E.TOTAL.refunds_out), t);

    // ── F14 refund attribution ────────────────────────────────────────────
    console.log('\n▶ F14 cash refund lands on the RETURN day, not the sale day');
    const qf = await Q(admin, {
      metrics: ['refunds_out'], dimensions: ['business_day'],
      range: E.RANGE, filters: [{ dimension: 'branch', op: 'eq', value: I.B1 }],
    });
    const d14 = rowByKeys(qf, { business_day: E.F14.day });
    const d13 = rowByKeys(qf, { business_day: '2032-03-13' });
    check('refund 57.50 attributed to 03-14 (the credit-note day)', !!d14 && d14.values.refunds_out === E.F14.refund, qf.body?.data?.rows);
    check('the SALE day (03-13) carries no refund', !d13 || d13.values.refunds_out === 0, d13?.values);

    console.log(`\n${fail === 0 ? '✅' : '❌'} analyticsPayments: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await seedMod.cleanup(db, PREFIX);
    try { await db.query('DELETE FROM users WHERE username = ?', [ADMIN]); } catch (_) {}
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
