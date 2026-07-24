'use strict';
/* Integration — POST /api/analytics/anomaly-scan + anomaly_alerts dedupe
 * (real server + DB, own direct-SQL fixture).
 *
 *   · a cashier with 5 same-weekday baseline days (discount rate 5%) and one
 *     spike day (50%) → discount_rate_spike created with the cashier as
 *     subject (proven via the exact dedupe_key);
 *   · till variance day (expected 300 via open 100 + cash_sale 200, counted
 *     200 → variance −100 > max(20, 2%×300)) → till_variance created;
 *   · re-scan → the SAME rows are refreshed, created=0, still exactly ONE row
 *     per dedupe_key (dedupe proven);
 *   · alerts are listable through the EXISTING GET /api/anomalies route
 *     (routes/anomalies.js — the alert-listing UI contract);
 *   · manager (analytics.view but NOT anomaly.manage) → 403;
 *   · missing from/to → 422.
 *
 * Fixtures: ITEST-SHAN-* (own, window 2032-04/05 — disjoint from every other
 * suite). PORT 3992.
 * Run: node tests/integration/analyticsAnomalies.api.test.js
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');
const analyticsSchema = require('../../db/migrations/analytics/schema');

const PORT = 3992;
const PREFIX = 'ITEST-SHAN';
const ADMIN = 'itest_shan_admin';
const MGR = 'itest_shan_mgr';
const CSH = 'itest_shan_cash1';          // the spiking cashier (subject)
const PW = 'Shan#Test!2032';
const BR = `${PREFIX}-BR`;
const BA = `${PREFIX}-BA`;
const SPIKE_DAY = '2032-05-10';
// 5 same-weekday baseline days (SPIKE_DAY − 7k, k=1..5); the rule's
// trailing-28d window uses the first four.
const BASE_DAYS = [1, 2, 3, 4, 5].map((k) =>
  new Date(Date.parse(SPIKE_DAY + 'T00:00:00Z') - k * 7 * 86400000).toISOString().slice(0, 10));

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) {
  if (c) { pass++; console.log('  ✅', n); }
  else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 400) : ''); }
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
const SCAN = (token, body) => call('POST', '/api/analytics/anomaly-scan', token, body);

const KEY_DISCOUNT = `discount_rate_spike:${BA}:${SPIKE_DAY}:${CSH}`;
const KEY_TILL = `till_variance:${BA}:${SPIKE_DAY}:till`;

async function cleanupAll() {
  const like = `${PREFIX}-%`;
  const del = async (sql, p) => { try { await db.query(sql, p); } catch (_) {} };
  await del('DELETE FROM anomaly_alerts WHERE dedupe_key LIKE ?', [`%:${BA}:%`]);
  await del('DELETE FROM anomaly_alerts WHERE related_doc_id LIKE ?', [like]);
  await del('DELETE FROM analytics_order_facts WHERE document_id LIKE ?', [like]);
  await del('DELETE FROM analytics_till_facts WHERE source_id LIKE ?', [like]);
  await del('DELETE FROM ar_documents WHERE id LIKE ?', [like]);
  await del('DELETE FROM branches WHERE id LIKE ?', [like]);
  await del('DELETE FROM brands WHERE id LIKE ?', [like]);
  for (const u of [ADMIN, MGR]) {
    await del('DELETE FROM users WHERE username = ?', [u]);
  }
}

async function seed() {
  await analyticsSchema.apply(db); // fact tables + anomaly dedupe key — idempotent

  await db.query('INSERT INTO brands (id, name) VALUES (?,?)', [BR, 'ITEST SHAN Brand']);
  await db.query('INSERT INTO branches (id, name, brand_id) VALUES (?,?,?)', [BA, 'ITEST SHAN Branch', BR]);

  const doc = (id, day, total, discount) => db.query(
    `INSERT INTO ar_documents (id, document_number, document_type, source_type,
                               brand_id, branch_id, issue_date, subtotal, discount_amount,
                               vat_amount, total_amount, status, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, id, 'invoice', 'pos', BR, BA, day, total, discount, 0, total, 'paid', CSH]);
  const ofact = (docId, day, discount) => db.query(
    `INSERT INTO analytics_order_facts
       (document_id, branch_id, brand_id, order_type, source, status, created_by,
        occurred_at_local, business_day, tz_snapshot, discount_total, provenance)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [docId, BA, BR, 'dine_in', 'pos', 'completed', CSH,
     `${day} 12:00:00`, day, 'Asia/Riyadh', discount, 'live']);

  // baseline: 5 same-weekday days at a steady 5% discount rate
  for (let k = 0; k < BASE_DAYS.length; k++) {
    const id = `${PREFIX}-DB${k + 1}`;
    await doc(id, BASE_DAYS[k], 100, 5);
    await ofact(id, BASE_DAYS[k], 5);
  }
  // spike day: 50% discount rate
  await doc(`${PREFIX}-DSP`, SPIKE_DAY, 100, 50);
  await ofact(`${PREFIX}-DSP`, SPIKE_DAY, 50);

  // till variance on the spike day: expected 100+200 = 300, counted 200
  const till = (type, amount, srcId) => db.query(
    `INSERT INTO analytics_till_facts
       (branch_id, movement_type, amount, occurred_at, occurred_at_local, business_day,
        performed_by, source_type, source_id, provenance)
     VALUES (?,?,?,?,?,?,?,?,?,'live')`,
    [BA, type, amount, `${SPIKE_DAY} 09:00:00`, `${SPIKE_DAY} 09:00:00`, SPIKE_DAY,
     CSH, 'itest', srcId]);
  await till('open_float', 100, `${PREFIX}-T1`);
  await till('cash_sale', 200, `${PREFIX}-T2`);
  await till('close_count', 200, `${PREFIX}-T3`);
}

(async () => {
  await cleanupAll();
  await seed();

  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [ADMIN, hash, 'admin']);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [MGR, hash, 'manager']);

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

    // ── first scan: creates ────────────────────────────────────────────────
    console.log('\n▶ first scan (spike day)');
    const s1 = await SCAN(admin, { from: SPIKE_DAY, to: SPIKE_DAY, branchIds: [BA] });
    check('scan answers 200 success', s1.status === 200 && s1.body?.success === true, s1);
    const d1 = s1.body?.data || {};
    check('discount_rate_spike fired exactly once', d1.byRule?.discount_rate_spike === 1, d1.byRule);
    check('till_variance fired exactly once', d1.byRule?.till_variance === 1, d1.byRule);
    check('created=2, refreshed=0 on first scan', d1.created === 2 && d1.refreshed === 0, d1);
    check('quiet rules stayed quiet (void/return/offline/drift = 0)',
      d1.byRule?.void_spike === 0 && d1.byRule?.return_spike === 0 &&
      d1.byRule?.late_offline_sync === 0 && d1.byRule?.projection_drift === 0, d1.byRule);

    const [[disc]] = await db.query(
      'SELECT id, severity, category, status, related_doc_type, related_doc_id, description FROM anomaly_alerts WHERE dedupe_key = ?',
      [KEY_DISCOUNT]);
    check('discount alert row exists with the CASHIER as subject (exact dedupe_key)',
      !!disc, KEY_DISCOUNT);
    check('discount alert: behavioral / medium / open / branch-linked', !!disc &&
      disc.category === 'behavioral' && disc.severity === 'medium' &&
      disc.status === 'open' && disc.related_doc_id === BA, disc);
    check('discount alert description names the cashier', !!disc &&
      String(disc.description).includes(CSH), disc && disc.description);
    const [[till]] = await db.query(
      'SELECT severity, category, description FROM anomaly_alerts WHERE dedupe_key = ?', [KEY_TILL]);
    check('till_variance alert row exists (financial / high)', !!till &&
      till.category === 'financial' && till.severity === 'high', till);

    // ── re-scan: refreshes, never duplicates ───────────────────────────────
    console.log('\n▶ re-scan (dedupe)');
    const s2 = await SCAN(admin, { from: SPIKE_DAY, to: SPIKE_DAY, branchIds: [BA] });
    const d2 = s2.body?.data || {};
    check('re-scan: created=0, refreshed=2', s2.status === 200 &&
      d2.created === 0 && d2.refreshed === 2, d2);
    const [[cnt1]] = await db.query(
      'SELECT COUNT(*) c FROM anomaly_alerts WHERE dedupe_key = ?', [KEY_DISCOUNT]);
    const [[cnt2]] = await db.query(
      'SELECT COUNT(*) c FROM anomaly_alerts WHERE dedupe_key = ?', [KEY_TILL]);
    check('exactly ONE row per dedupe_key after re-scan', Number(cnt1.c) === 1 && Number(cnt2.c) === 1,
      { discount: cnt1.c, till: cnt2.c });

    // ── listable via the EXISTING /api/anomalies route ─────────────────────
    console.log('\n▶ existing listing route');
    const since = new Date(Date.now() - 10 * 60000).toISOString().slice(0, 19).replace('T', ' ');
    const list = await call('GET', '/api/anomalies?status=open&since=' + encodeURIComponent(since), admin);
    const items = Array.isArray(list.body) ? list.body : [];
    const foundDisc = items.find((a) => a.dedupe_key === KEY_DISCOUNT);
    const foundTill = items.find((a) => a.dedupe_key === KEY_TILL);
    check('GET /api/anomalies lists BOTH scan-written alerts', list.status === 200 &&
      !!foundDisc && !!foundTill, { status: list.status, n: items.length });
    check('listed alert carries the existing UI contract fields (title/severity/score)',
      !!foundDisc && !!foundDisc.title && !!foundDisc.severity && foundDisc.score != null, foundDisc);

    // ── authz + validation ─────────────────────────────────────────────────
    console.log('\n▶ authz + validation');
    const sm = await SCAN(mgr, { from: SPIKE_DAY, to: SPIKE_DAY, branchIds: [BA] });
    check('manager (no anomaly.manage) → 403 PERMISSION_DENIED',
      sm.status === 403 && sm.body?.code === 'PERMISSION_DENIED', sm);
    const sv = await SCAN(admin, { to: SPIKE_DAY });
    check('missing from → 422 VALIDATION_ERROR',
      sv.status === 422 && sv.body?.code === 'VALIDATION_ERROR', sv);

    console.log(`\n${fail === 0 ? '✅' : '❌'} analyticsAnomalies: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await cleanupAll();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
