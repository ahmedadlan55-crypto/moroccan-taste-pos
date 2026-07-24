'use strict';
/* Integration — dashboard payment mix + margin basis (real server + DB).
 *
 * THE DEFECT: /api/dashboard/overview computed its cash position from a
 * `sale_payments` table that has NEVER existed in this schema — the .catch
 * silently returned 0 forever, so the widget lied on every deploy. And the
 * "gross margin" KPI was a (sales − purchases) / sales proxy presented as if
 * it were a real margin.
 *
 * What this suite proves, live through GET /api/dashboard/overview:
 *   · the phantom table is GONE from the route source (literal grep = zero);
 *   · paymentMix reads analytics_payment_facts: split legs count separately,
 *     direction='out' refunds NEVER contaminate the mix, basis:'facts';
 *   · on an un-backfilled DB (facts absent) the mix is DERIVED from
 *     sales.payment_method / split_details_json with the same
 *     ProjectionService fold — same buckets, basis:'derived' says so;
 *   · kpi.grossMargin carries marginBasis 'cogs' (analytics_daily_branch
 *     rollups: (net_ex_vat − cogs) / net_ex_vat) when rollups exist, and
 *     falls back to the labeled 'proxy' when they don't — never silently;
 *   · the legacy response shape (kpi / ops / counts / charts / alerts) is
 *     intact for the existing frontend consumers.
 *
 * Fixtures: ITEST-DSH-* prefixed, isolated 2032-06 window (facts projected by
 * calling ProjectionService.projectPosSale directly on directly-seeded sales).
 * Cleanup before AND in finally — zero residue.
 * PORT 3990. Run: node tests/integration/dashboardPayments.api.test.js
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');
const projection = require('../../services/analytics/ProjectionService');

const PORT = 3990;
const ADMIN = 'itest_dsh_admin';
const PW = 'Dsh#Test!2032';
const SFX = String(Date.now()).slice(-6);
const P = (s) => `ITEST-DSH-${SFX}-${s}`;
const B1 = P('B1');
const S1 = P('S1');   // split sale: كاش 104 + شبكة 100 = 204
const S2 = P('S2');   // single cash 120
const FROM = '2032-06-01', TO = '2032-06-30';

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 300) : ''); } }
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
async function waitUp() { for (let i = 0; i < 120; i++) { const ok = await new Promise((z) => http.get('http://127.0.0.1:' + PORT + '/api/version', (s) => z(s.statusCode === 200)).on('error', () => z(false))); if (ok) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }
const mixOf = (body) => {
  const out = {};
  ((body?.paymentMix?.methods) || []).forEach((m) => { out[m.method] = { amount: r2(m.amount), count: Number(m.count) }; });
  return out;
};

async function cleanup() {
  const del = async (sql, a) => { try { await db.query(sql, a || []); } catch (_) {} };
  await del('DELETE FROM users WHERE username=?', [ADMIN]);
  await del("DELETE FROM analytics_payment_facts WHERE source_id LIKE 'ITEST-DSH-%'");
  await del("DELETE FROM analytics_order_facts WHERE sale_id LIKE 'ITEST-DSH-%' OR document_id LIKE 'ITEST-DSH-%'");
  await del("DELETE FROM analytics_till_facts WHERE source_id LIKE 'ITEST-DSH-%'");
  await del("DELETE FROM analytics_daily_branch WHERE branch_id LIKE 'ITEST-DSH-%'");
  await del("DELETE FROM analytics_rollup_dirty WHERE branch_id LIKE 'ITEST-DSH-%'");
  await del("DELETE FROM sales_items WHERE order_id LIKE 'ITEST-DSH-%'");
  await del("DELETE FROM sales WHERE id LIKE 'ITEST-DSH-%'");
  await del("DELETE FROM shifts WHERE id LIKE 'ITEST-DSH-%'");
}

async function fixtures() {
  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [ADMIN, hash, 'admin']);
  // sales.shift_id carries an FK → a real shifts row is required.
  await db.query("INSERT INTO shifts (id, username, status, start_time) VALUES (?,?,'CLOSED',NOW())", [P('SH'), ADMIN]);
  // Split sale — split_details_json in the pos-v2 ARRAY shape (what the fixed
  // routes/sales.js now persists for React 'split' checkouts).
  await db.query(
    `INSERT INTO sales (id, order_date, total_final, payment_method, split_details_json, username, shift_id, branch_id)
     VALUES (?, '2032-06-10 12:00:00', 204, ?, ?, ?, ?, ?)`,
    [S1, 'كاش:104/شبكة:100', JSON.stringify([{ method: 'كاش', amount: 104 }, { method: 'شبكة', amount: 100 }]), ADMIN, P('SH'), B1]);
  // Single-method cash sale.
  await db.query(
    `INSERT INTO sales (id, order_date, total_final, payment_method, username, shift_id, branch_id)
     VALUES (?, '2032-06-12 13:00:00', 120, ?, ?, ?, ?)`,
    [S2, 'كاش', ADMIN, P('SH'), B1]);
  // Project the facts exactly the way the live write path does (post-commit).
  const p1 = await projection.projectPosSale(db, S1);
  const p2 = await projection.projectPosSale(db, S2);
  if (p1.legs !== 2 || p2.legs !== 1) throw new Error('projection seed failed: ' + JSON.stringify({ p1, p2 }));
  // A direction='out' cash refund IN the window — must never enter the mix.
  await db.query(
    `INSERT INTO analytics_payment_facts
       (source_type, source_id, line_no, branch_id, method_raw, method_norm, direction, amount, status, occurred_at, occurred_at_local, business_day, provenance)
     VALUES ('cn_refund', ?, 0, ?, 'كاش', 'cash', 'out', 50, 'settled', '2032-06-11 12:00:00', '2032-06-11 12:00:00', '2032-06-11', 'live')`,
    [P('RF1'), B1]);
  // Rollup row with REAL COGS for the margin KPI (what the rollup worker
  // rebuilds from order facts): net 281.74 ex-VAT, cogs 90.
  await db.query(
    `INSERT INTO analytics_daily_branch
       (business_day, brand_id, branch_id, orders, gross_product, net_ex_vat, vat, invoice_total, cogs, gross_profit)
     VALUES ('2032-06-10', NULL, ?, 2, 281.74, 281.74, 42.26, 324, 90, 191.74)`,
    [B1]);
}

(async () => {
  await cleanup();
  await fixtures();

  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    const admin = await login(ADMIN);
    check('admin got a JWT', !!admin);

    // ── the phantom table is gone from the source ─────────────────────────
    console.log('\n▶ phantom-table code path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'dashboard.js'), 'utf8');
    check("routes/dashboard.js contains ZERO references to the phantom 'sale_payments' table", !src.includes('sale_payments'));

    // ── auth ──────────────────────────────────────────────────────────────
    const anon = await call('GET', `/api/dashboard/overview?from=${FROM}&to=${TO}`, null);
    check('anonymous overview is 401', anon.status === 401, anon.status);

    // ── facts-backed payment mix ──────────────────────────────────────────
    console.log('\n▶ payment mix from analytics_payment_facts (basis: facts)');
    const q = `/api/dashboard/overview?from=${FROM}&to=${TO}&compare=none`;
    const ov = await call('GET', q, admin);
    check('overview answers 200', ov.status === 200 && !!ov.body, ov.status);
    check('kpi.sales.value = 324 (204 split + 120 cash)', ov.body?.kpi?.sales?.value === 324, ov.body?.kpi?.sales);
    check('paymentMix.basis = facts', ov.body?.paymentMix?.basis === 'facts', ov.body?.paymentMix);
    const mix = mixOf(ov.body);
    check('cash bucket = 224 over 2 legs (104 split leg + 120 single)',
      mix.cash && mix.cash.amount === 224 && mix.cash.count === 2, mix);
    check('card bucket = 100 over 1 leg (the split sale counted PER TENDER, not per sale)',
      mix.card && mix.card.amount === 100 && mix.card.count === 1, mix);
    check("the direction='out' refund (cash 50) NEVER contaminates the mix",
      mix.cash && mix.cash.amount === 224 && Object.keys(mix).length === 2, mix);

    // ── margin: real COGS, labeled ────────────────────────────────────────
    console.log('\n▶ marginBasis');
    const gm = ov.body?.kpi?.grossMargin || {};
    check('marginBasis field present and = cogs (rollups exist for the window)', gm.marginBasis === 'cogs', gm);
    const expectCogs = ((281.74 - 90) / 281.74) * 100;
    check('grossMargin.value = (net_ex_vat − cogs) / net_ex_vat = ' + r2(expectCogs) + '%',
      Math.abs((gm.value || 0) - expectCogs) < 0.01, gm);

    // ── legacy response shape intact for existing consumers ───────────────
    console.log('\n▶ response shape (frontend contract)');
    check('kpi/ops/counts/charts/alerts all present',
      !!ov.body?.kpi && !!ov.body?.ops && !!ov.body?.counts && !!ov.body?.charts && !!ov.body?.alerts,
      Object.keys(ov.body || {}));
    check('ops.cashInHand is a number (facts-backed cash position query ran)',
      typeof ov.body?.ops?.cashInHand === 'number', ov.body?.ops);
    check('kpi keeps sales/orders/avgTicket/expenses/purchases/netIncome for KpiGrid',
      ['sales','orders','avgTicket','expenses','purchases','netIncome'].every((k) => ov.body?.kpi?.[k] && typeof ov.body.kpi[k].value === 'number'),
      ov.body?.kpi && Object.keys(ov.body.kpi));

    // ── un-backfilled fallback: derived mix + proxy margin ────────────────
    console.log('\n▶ un-backfilled DB fallback (basis: derived / proxy)');
    await db.query("DELETE FROM analytics_payment_facts WHERE source_id LIKE 'ITEST-DSH-%'");
    await db.query("DELETE FROM analytics_daily_branch WHERE branch_id LIKE 'ITEST-DSH-%'");
    const ov2 = await call('GET', q, admin);
    check('overview still answers 200 with facts gone', ov2.status === 200, ov2.status);
    check('paymentMix.basis = derived (recomputed from the sales rows)', ov2.body?.paymentMix?.basis === 'derived', ov2.body?.paymentMix);
    const mix2 = mixOf(ov2.body);
    check('derived buckets MATCH the facts buckets exactly (cash 224×2, card 100×1)',
      mix2.cash && mix2.cash.amount === 224 && mix2.cash.count === 2
        && mix2.card && mix2.card.amount === 100 && mix2.card.count === 1, mix2);
    const gm2 = ov2.body?.kpi?.grossMargin || {};
    check('marginBasis falls back to proxy (no rollups) — labeled, not silent', gm2.marginBasis === 'proxy', gm2);
    check('proxy value = (sales − purchases) / sales = 100% here (no purchases in window)',
      Math.abs((gm2.value || 0) - 100) < 0.01, gm2);

    // ── empty window stays honest ─────────────────────────────────────────
    const ov3 = await call('GET', '/api/dashboard/overview?from=2032-07-01&to=2032-07-31&compare=none', admin);
    check('empty window: paymentMix.methods = [] (nothing invented)',
      ov3.status === 200 && Array.isArray(ov3.body?.paymentMix?.methods) && ov3.body.paymentMix.methods.length === 0,
      ov3.body?.paymentMix);

    console.log(`\n${fail === 0 ? '✅' : '❌'} dashboardPayments: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
