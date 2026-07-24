'use strict';
/* Integration — RETIRED sales-report surfaces stay dead, and the surfaces the
 * retirement UNSHADOWED answer with the right contract (real server + DB).
 *
 * The Unified Sales Analytics Hub retirement commit deleted (per
 * docs/status/SALES_REPORTS_RATIONALIZATION_AR.md):
 *   · GET /api/sales/report/advanced                       (routes/sales.js)
 *   · GET /api/erp/reports/sales-by-channel                (routes/erp-core.js)
 *   · GET /api/erp/reports/channel-settlements             (routes/erp-core.js)
 *   · GET /api/erp/reports/discounts-given                 (routes/erp-core.js)
 *   · GET /api/erp/reports/waste-analytics                 (routes/erp-core.js)
 *   · GET /api/erp/reports/royalty-reconciliation          (routes/erp-core.js)
 *   · GET /api/erp/reports/sales-analytics                 (routes/erp-core.js)
 * Every one must now answer 404 for an AUTHENTICATED caller (anonymous still
 * gets 401 from the global /api JWT gate — asserted too, so nobody mistakes
 * the 404s for an auth artifact).
 *
 * THE INVERTED AGING DECISION (doc §2.2, executed): erp-core's legacy
 * /reports/{ar,ap}-aging handlers (asOf param, {asOf,totals:{current,1_30,…},
 * items} shape) were deleted, so the modular routes/erp/reports/{ar,ap}-aging.js
 * — mounted AFTER erp-core in server.js and previously unreachable — now
 * answer. Their shape is exactly what the live /accounting/{ar,ap}-aging pages
 * expect (frontend AgingResponse: asOfDate echo + customers/suppliers array +
 * grandBuckets keyed '0-30'…'120+'). This suite proves the live-broken-page
 * fix: the reachable handler now matches the page contract.
 *
 * KEEP decisions proven live (doc §2.1): GET /api/erp/reports/balance-sheet
 * (consumed by FinancialRatios.tsx) and GET /api/erp/reports/pnl (the ratios
 * page's second call) both still answer 200.
 *
 * Run: node tests/integration/retiredSurfaces.api.test.js   (PORT 3994)
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const PORT = 3994;
const ADMIN = 'itest_retired_admin';
const PW = 'Rt#Test!2026';

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

async function cleanup() {
  try { await db.query('DELETE FROM users WHERE username = ?', [ADMIN]); } catch (_) {}
}

/** Every retired endpoint, exactly as the doc lists them. */
const RETIRED = [
  '/api/sales/report/advanced?startDate=2026-01-01&endDate=2026-01-31',
  '/api/erp/reports/sales-by-channel?from=2026-01-01&to=2026-01-31',
  '/api/erp/reports/channel-settlements?from=2026-01-01&to=2026-01-31',
  '/api/erp/reports/discounts-given?from=2026-01-01&to=2026-01-31',
  '/api/erp/reports/waste-analytics?from=2026-01-01&to=2026-01-31',
  '/api/erp/reports/royalty-reconciliation?year=2026',
  '/api/erp/reports/sales-analytics?from=2026-01-01&to=2026-01-31&groupBy=all',
];

const AGING_BUCKETS = ['0-30', '31-60', '61-90', '91-120', '120+'];

(async () => {
  await cleanup();
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

    // ── retired endpoints are DEAD (404 authenticated, 401 anonymous) ──────
    console.log('\n▶ retired endpoints → 404');
    for (const p of RETIRED) {
      const r = await call('GET', p, admin);
      check(`404 ${p.split('?')[0]}`, r.status === 404, { status: r.status, body: r.body });
    }
    const anon = await call('GET', RETIRED[0], null);
    check('anonymous on a retired path is 401 (global JWT gate first — 404s above are real routing 404s)',
      anon.status === 401, anon.status);

    // ── the aging inversion: the modular contract is now the reachable one ─
    console.log('\n▶ ar-aging answers the MODULAR contract (the live-page fix)');
    const ar = await call('GET', '/api/erp/reports/ar-aging?asOfDate=2026-01-31', admin);
    check('ar-aging answers 200 success', ar.status === 200 && ar.body?.success === true, ar);
    check('asOfDate ECHOED (the legacy handler read `asOf` and ignored what the page sends)',
      ar.body?.asOfDate === '2026-01-31', ar.body?.asOfDate);
    check('customers is an ARRAY (AgingResponse.customers — legacy shape had `items`)',
      Array.isArray(ar.body?.customers), ar.body && Object.keys(ar.body));
    check("grandBuckets carries the page's keys '0-30'…'120+'",
      !!ar.body?.grandBuckets && AGING_BUCKETS.every((k) => k in ar.body.grandBuckets),
      ar.body?.grandBuckets && Object.keys(ar.body.grandBuckets));
    check('grandTotal + overdue90PlusRatio present (page KPIs)',
      typeof ar.body?.grandTotal === 'number' && typeof ar.body?.overdue90PlusRatio === 'number', ar.body);
    check('the LEGACY shape is GONE (no totals.current / totals.1_30 keys)',
      !(ar.body?.totals && ('current' in ar.body.totals || '1_30' in ar.body.totals)), ar.body?.totals);

    console.log('\n▶ ap-aging answers the MODULAR contract');
    const ap = await call('GET', '/api/erp/reports/ap-aging?asOfDate=2026-01-31', admin);
    check('ap-aging answers 200 success', ap.status === 200 && ap.body?.success === true, ap);
    check('suppliers is an ARRAY with grandBuckets 0-30…120+',
      Array.isArray(ap.body?.suppliers) &&
      !!ap.body?.grandBuckets && AGING_BUCKETS.every((k) => k in ap.body.grandBuckets),
      ap.body && Object.keys(ap.body));
    check('asOfDate echoed', ap.body?.asOfDate === '2026-01-31', ap.body?.asOfDate);

    // ── KEEP decisions stay live (doc §2.1 — FinancialRatios consumers) ────
    console.log('\n▶ kept endpoints still answer 200');
    const bs = await call('GET', '/api/erp/reports/balance-sheet?asOf=2026-01-31', admin);
    check('balance-sheet (FinancialRatios.tsx:28 consumer) answers 200 success with totals',
      bs.status === 200 && bs.body?.success === true && !!bs.body?.totals, { status: bs.status });
    const pnl = await call('GET', '/api/erp/reports/pnl?from=2026-01-01&to=2026-01-31', admin);
    check('pnl (the ratios page\'s second call) answers 200 success',
      pnl.status === 200 && pnl.body?.success === true, { status: pnl.status, body: pnl.body });

    console.log(`\n${fail === 0 ? '✅' : '❌'} retiredSurfaces: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
