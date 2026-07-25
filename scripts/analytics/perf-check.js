#!/usr/bin/env node
'use strict';
/* ─── Analytics perf harness ─────────────────────────────────────────────────
 *
 * Boots `node server.js` against the perf sandbox that seed-perf.js built,
 * signs an admin JWT exactly the way the integration tests do
 * (tests/integration/canary.api.test.js et al: jwt.sign({id,username,role,
 * tokenVersion}, JWT_SECRET)), and measures the canonical query suite over
 * POST /api/analytics/query with wall-clock timing.
 *
 * MEASUREMENT CONTRACT (decided + documented):
 *   Each query runs FOUR times —
 *     1. untimed warm-up with noCache:true   (JIT + buffer-pool warm)
 *     2. MEASURED COLD with noCache:true     ← the asserted number (pure SQL
 *        path; QueryService's 60s memo is bypassed on read AND write)
 *     3. untimed cache-populate (no noCache)
 *     4. MEASURED WARM (no noCache — served from the in-memory memo)
 *   The assertion is on COLD: rollout decisions need the SQL truth, not the
 *   memo. WARM is reported alongside so the memo's benefit is visible.
 *   Limits: COMMON < 2000ms, COMPLEX < 5000ms (cold).
 *
 * ROUTING HONESTY: meta.freshness.source is captured per query. In this wave
 * lib/analytics/freshness.js hard-codes source:'live' (rollup ROUTING is a
 * later wave — the rollup TABLES exist and are populated); the harness
 * therefore reports routing per query instead of asserting on it, and any
 * breach on a rollup-eligible query is reported as a planner-routing gap
 * rather than "the SQL is slow".
 *
 * EXPLAIN ASSERTIONS (run via mysql2 directly, EXPLAIN FORMAT=JSON):
 *   A. For 3 representative rollup-eligible queries the LIVE plan (built with
 *      lib/analytics/planner.js, global scope) must NOT full-scan any fact
 *      table — fails on e.g. "table_name":"analytics_order_facts" with
 *      "access_type":"ALL".
 *   B. The equivalent rollup-table reads (analytics_daily_branch /
 *      analytics_daily_payment / analytics_hourly_branch) must use their PK
 *      (access_type range on the business_day prefix, never ALL) — proving
 *      the rollup PKs serve these shapes scan-free once routing lands.
 *
 * USAGE
 *   node scripts/analytics/perf-check.js --db=mt_perf_sales_hub
 *     [--end=YYYY-MM-DD]   # defaults to MAX(business_day) in the sandbox
 * Exit 0 = all PASS; 1 = any breach / EXPLAIN failure; 2 = harness failure.
 * ────────────────────────────────────────────────────────────────────────── */

require('dotenv').config();
const net = require('net');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');

const ROOT = path.join(__dirname, '..', '..');

const argv = process.argv.slice(2);
function flag(name, dflt) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const TARGET_DB = flag('db', null);
const END_OVERRIDE = flag('end', null);

const HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = Number(process.env.DB_PORT) || 3306;
const USER = process.env.DB_USER || 'root';
const PASS = process.env.DB_PASSWORD || '';
const ENV_DB = process.env.DB_NAME || 'moroccan_taste_pos';

function fail(msg) { console.error('[perf-check] FATAL: ' + msg); process.exit(2); }
if (!TARGET_DB) fail('--db=NAME is required (the sandbox seed-perf.js built).');
if (TARGET_DB === ENV_DB) fail(`--db must not be the .env database "${ENV_DB}".`);
if (!['localhost', '127.0.0.1', '::1'].includes(HOST)) fail('perf runs are local-only.');
if (!process.env.JWT_SECRET) fail('JWT_SECRET missing from the environment (.env).');

const COMMON_LIMIT_MS = 2000;
const COMPLEX_LIMIT_MS = 5000;

// ── date helpers (string math, mirrors seed-perf.js) ─────────────────────────
function addDays(iso, n) {
  const t = Date.parse(iso + 'T00:00:00Z') + n * 86400000;
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// ── tiny HTTP client ─────────────────────────────────────────────────────────
function call(port, method, p, token, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', () => resolve({ status: 0, body: null }));
    if (data) req.write(data);
    req.end();
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

// ── EXPLAIN plan walking ─────────────────────────────────────────────────────
function collectTables(node, out) {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const n of node) collectTables(n, out); return out; }
  if (node.table_name && node.access_type) out.push({ table: node.table_name, access: node.access_type, key: node.key || null });
  for (const v of Object.values(node)) collectTables(v, out);
  return out;
}
async function explainJson(conn, sql, params) {
  const [rows] = await conn.query('EXPLAIN FORMAT=JSON ' + sql, params);
  const raw = rows[0] && (rows[0].EXPLAIN || rows[0]['EXPLAIN FORMAT=JSON'] || Object.values(rows[0])[0]);
  return collectTables(JSON.parse(String(raw)), []);
}

const FACT_TABLES = new Set([
  'analytics_order_facts', 'ar_document_lines', 'analytics_payment_facts',
  'analytics_till_facts', 'analytics_modifier_facts',
]);

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  // Direct sandbox connection (EXPLAIN + window discovery).
  const raw = await mysql.createConnection({
    host: HOST, port: DB_PORT, user: USER, password: PASS, database: TARGET_DB,
    timezone: process.env.DB_TIME_ZONE || '+03:00',
  });

  const [[win]] = await raw.query(
    "SELECT DATE_FORMAT(MAX(business_day), '%Y-%m-%d') mx, COUNT(*) n FROM analytics_order_facts");
  if (!win.n) fail(`"${TARGET_DB}" has no analytics_order_facts — run seed-perf.js first.`);
  const END = END_OVERRIDE || win.mx;
  const R = (days) => ({ from: addDays(END, -(days - 1)), to: END });
  console.log(`[perf-check] sandbox \`${TARGET_DB}\`: ${win.n} order facts, window ends ${END}`);

  // Boot the server against the sandbox (harness-token pattern from
  // tests/helpers/testHarness.js — proves the response comes from OUR child).
  const port = await getFreePort();
  const token = crypto.randomBytes(12).toString('hex');
  const env = {
    ...process.env,
    PORT: String(port),
    DB_NAME: TARGET_DB, MYSQL_DATABASE: TARGET_DB, MYSQLDATABASE: TARGET_DB,
    TEST_HARNESS_TOKEN: token,
    ANALYTICS_DISABLE_WORKER: '1', // no background rollup ticks during timing
  };
  delete env.DATABASE_URL; delete env.MYSQL_URL; delete env.MYSQLHOST;
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'inherit'] });
  const kill = () => { try { proc.kill(); } catch (_) {} };
  process.on('exit', kill);

  try {
    let up = false;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const r = await call(port, 'GET', '/api/version', null, null);
      if (r.status === 200 && r.body && r.body.harnessToken === token) { up = true; break; }
      await new Promise((z) => setTimeout(z, 500));
    }
    if (!up) fail('server.js did not come up (matching harness token) within 180s');
    console.log(`[perf-check] server up on :${port}`);

    // Admin JWT — the exact integration-test pattern.
    const admin = jwt.sign(
      { id: 1, username: 'admin', role: 'admin', tokenVersion: 1 },
      process.env.JWT_SECRET, { expiresIn: '2h' });

    // ── the canonical suite ──────────────────────────────────────────────────
    const D7 = R(7), D30 = R(30), D60 = R(60), D90 = R(90);
    const QUERIES = [
      // 10 COMMON (< 2000ms cold)
      { name: 'daily net by branch 30d', limit: COMMON_LIMIT_MS, explain: 'daily_branch', body: {
        metrics: ['net_ex_vat', 'orders'], dimensions: ['business_day', 'branch'], range: D30, limit: 500 } },
      { name: 'top-20 items 30d', limit: COMMON_LIMIT_MS, body: {
        metrics: ['net_ex_vat', 'qty_sold'], dimensions: ['menu_item'], range: D30,
        sort: [{ by: 'net_ex_vat', dir: 'desc' }], limit: 20 } },
      { name: 'payment mix 30d', limit: COMMON_LIMIT_MS, explain: 'daily_payment', body: {
        metrics: ['payments_in', 'refunds_out'], dimensions: ['payment_method'], range: D30 } },
      { name: 'hourly heatmap 7d', limit: COMMON_LIMIT_MS, explain: 'hourly_branch', body: {
        metrics: ['orders', 'net_ex_vat'], dimensions: ['half_hour'], range: D7 } },
      { name: 'cashier table 30d', limit: COMMON_LIMIT_MS, body: {
        metrics: ['orders', 'net_ex_vat', 'discounts_total', 'avg_ticket'], dimensions: ['cashier'], range: D30, limit: 100 } },
      { name: 'branch compare prevPeriod 30d', limit: COMMON_LIMIT_MS, body: {
        metrics: ['net_ex_vat', 'orders', 'invoice_total'], dimensions: ['branch'], range: D30, compare: 'prevPeriod' } },
      { name: 'executive KPIs 30d', limit: COMMON_LIMIT_MS, body: {
        metrics: ['net_ex_vat', 'orders', 'invoice_total', 'discounts_total', 'payments_in', 'refunds_out', 'avg_ticket', 'gross_profit'], range: D30 } },
      { name: 'discounts by day 30d', limit: COMMON_LIMIT_MS, body: {
        metrics: ['discounts_total', 'discounted_orders', 'discount_pct'], dimensions: ['business_day'], range: D30, limit: 40 } },
      { name: 'till variance by shift 7d', limit: COMMON_LIMIT_MS, body: {
        metrics: ['till_expected_cash', 'till_counted', 'till_variance'], dimensions: ['shift'], range: D7, limit: 100 } },
      { name: 'orders by channel 30d', limit: COMMON_LIMIT_MS, body: {
        metrics: ['orders'], dimensions: ['channel'], range: D30 } },
      // 5 COMPLEX (< 5000ms cold)
      { name: 'brand×branch×day 4-metric compare 90d', limit: COMPLEX_LIMIT_MS, body: {
        metrics: ['net_ex_vat', 'orders', 'qty_sold', 'invoice_total'],
        dimensions: ['brand', 'branch', 'business_day'], range: D90, compare: 'prevPeriod', limit: 500 } },
      { name: 'category×item pivot 90d', limit: COMPLEX_LIMIT_MS, body: {
        metrics: ['net_ex_vat', 'qty_sold', 'gross_product_sales'], dimensions: ['category', 'menu_item'], range: D90, limit: 500 } },
      { name: 'weekday×hour heatmap compare 90d', limit: COMPLEX_LIMIT_MS, body: {
        metrics: ['orders', 'net_ex_vat'], dimensions: ['weekday', 'hour'], range: D90, compare: 'prevPeriod', limit: 500 } },
      { name: 'cashier×day rates 60d', limit: COMPLEX_LIMIT_MS, body: {
        metrics: ['orders', 'discounted_orders', 'voids_count', 'discount_rate_by_cashier', 'void_rate_by_cashier'],
        dimensions: ['cashier', 'business_day'], range: D60, limit: 500 } },
      { name: 'method×day×branch 60d', limit: COMPLEX_LIMIT_MS, body: {
        metrics: ['payments_in', 'refunds_out'], dimensions: ['payment_method', 'business_day', 'branch'], range: D60, limit: 500 } },
    ];

    const timedCall = async (body) => {
      const t0 = process.hrtime.bigint();
      const r = await call(port, 'POST', '/api/analytics/query', admin, body);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      return { ms, r };
    };

    const results = [];
    for (const q of QUERIES) {
      const cold = Object.assign({}, q.body, { noCache: true });
      await timedCall(cold);                               // 1. warm-up (untimed)
      const { ms: coldMs, r: coldR } = await timedCall(cold); // 2. MEASURED COLD
      await timedCall(q.body);                             // 3. cache populate
      const { ms: warmMs, r: warmR } = await timedCall(q.body); // 4. MEASURED WARM
      const okShape = coldR.status === 200 && coldR.body && coldR.body.success === true &&
        coldR.body.data && (q.body.dimensions ? (coldR.body.data.rows || []).length > 0 : !!coldR.body.data.totals);
      const source = coldR.body && coldR.body.meta && coldR.body.meta.freshness
        ? coldR.body.meta.freshness.source : 'n/a';
      const pass = okShape && coldMs < q.limit;
      results.push({
        name: q.name, coldMs, warmMs, limit: q.limit, source, pass,
        rows: coldR.body && coldR.body.data ? (coldR.body.data.rows || []).length : 0,
        shapeErr: okShape ? null : `status=${coldR.status} success=${coldR.body && coldR.body.success} code=${coldR.body && coldR.body.code} rows=${coldR.body && coldR.body.data ? (coldR.body.data.rows || []).length : 'n/a'}`,
        warmStatus: warmR.status,
      });
      console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${q.name}: cold ${coldMs.toFixed(0)}ms / warm ${warmMs.toFixed(0)}ms (limit ${q.limit}ms, source=${source}, rows=${results[results.length - 1].rows})` +
        (results[results.length - 1].shapeErr ? '  ← ' + results[results.length - 1].shapeErr : ''));
    }

    // ── EXPLAIN assertions ───────────────────────────────────────────────────
    console.log('\n[perf-check] EXPLAIN assertions (FORMAT=JSON via mysql2)…');
    const planner = require('../../lib/analytics/planner');
    const { ANALYTICS_CAPS } = require('../../lib/analytics/scope');
    const scope = { all: true, branchIds: [], caps: new Set(ANALYTICS_CAPS) };
    const explainFailures = [];

    // A. live plans of the 3 representative rollup-eligible queries must not
    //    full-scan a fact table.
    const explainable = QUERIES.filter((q) => q.explain);
    for (const q of explainable) {
      const plan = planner.plan(Object.assign({}, q.body), scope, {});
      for (const st of plan.statements) {
        const tables = await explainJson(raw, st.rows.sql, st.rows.params);
        for (const t of tables) {
          if (FACT_TABLES.has(t.table) && t.access === 'ALL') {
            explainFailures.push(`LIVE "${q.name}" fact=${st.fact}: full scan of ${t.table} (access_type=ALL)`);
          }
        }
        const summary = tables.map((t) => `${t.table}:${t.access}${t.key ? '(' + t.key + ')' : ''}`).join(', ');
        console.log(`  live  ${q.name} [fact=${st.fact}] → ${summary}`);
      }
    }

    // B. the equivalent rollup reads must ride the rollup PK (range, never ALL).
    const ROLLUP_EQUIV = {
      daily_branch: {
        sql: 'SELECT business_day, branch_id, SUM(net_ex_vat), SUM(orders) FROM analytics_daily_branch WHERE business_day BETWEEN ? AND ? GROUP BY business_day, branch_id',
        params: [D30.from, D30.to], table: 'analytics_daily_branch',
      },
      daily_payment: {
        sql: 'SELECT method_norm, SUM(CASE WHEN direction=\'in\' THEN amount ELSE 0 END), SUM(CASE WHEN direction=\'out\' THEN amount ELSE 0 END) FROM analytics_daily_payment WHERE business_day BETWEEN ? AND ? GROUP BY method_norm',
        params: [D30.from, D30.to], table: 'analytics_daily_payment',
      },
      hourly_branch: {
        sql: 'SELECT slot30, SUM(orders), SUM(net_ex_vat) FROM analytics_hourly_branch WHERE business_day BETWEEN ? AND ? GROUP BY slot30',
        params: [D7.from, D7.to], table: 'analytics_hourly_branch',
      },
    };
    for (const [key, spec] of Object.entries(ROLLUP_EQUIV)) {
      const tables = await explainJson(raw, spec.sql, spec.params);
      const hit = tables.find((t) => t.table === spec.table);
      const summary = tables.map((t) => `${t.table}:${t.access}${t.key ? '(' + t.key + ')' : ''}`).join(', ');
      console.log(`  rollup ${key} → ${summary}`);
      if (!hit) explainFailures.push(`ROLLUP ${key}: ${spec.table} missing from the plan`);
      else if (hit.access === 'ALL') explainFailures.push(`ROLLUP ${key}: ${spec.table} full scan (access_type=ALL) — PK not used`);
      else if (hit.key !== 'PRIMARY') explainFailures.push(`ROLLUP ${key}: ${spec.table} used key=${hit.key}, expected the PRIMARY key`);
    }

    // ── report ───────────────────────────────────────────────────────────────
    const nameW = Math.max(...results.map((r) => r.name.length));
    console.log('\n── perf results (cold = noCache SQL path, warm = 60s memo) ──');
    console.log(`  ${'query'.padEnd(nameW)}  ${'cold ms'.padStart(8)}  ${'warm ms'.padStart(8)}  ${'limit'.padStart(6)}  source  result`);
    for (const r of results) {
      console.log(`  ${r.name.padEnd(nameW)}  ${r.coldMs.toFixed(0).padStart(8)}  ${r.warmMs.toFixed(0).padStart(8)}  ${String(r.limit).padStart(6)}  ${String(r.source).padEnd(6)}  ${r.pass ? 'PASS' : 'FAIL'}`);
    }
    const breaches = results.filter((r) => !r.pass);
    console.log('──────────────────────────────────────────────────────────────');
    console.log(`  queries: ${results.length - breaches.length}/${results.length} PASS`);
    console.log(`  EXPLAIN assertions: ${explainFailures.length === 0 ? 'ALL PASS' : explainFailures.length + ' FAILED'}`);
    for (const f of explainFailures) console.log('    ✗ ' + f);
    const liveRouted = results.filter((r) => r.source === 'live').length;
    console.log(`  routing: ${liveRouted}/${results.length} answered from source='live' — rollup ROUTING is not wired in this wave (lib/analytics/freshness.js hard-codes 'live'); the rollup tables are populated and their PK plans are asserted above.`);
    if (breaches.length) {
      console.log('\n  breaches:');
      for (const b of breaches) {
        console.log(`    ${b.name}: cold ${b.coldMs.toFixed(0)}ms vs ${b.limit}ms` +
          (b.shapeErr ? ` (shape: ${b.shapeErr})` : '') +
          (b.source === 'live' ? ' — rollup-eligible query answered live (planner routing, not SQL, if the live plan above is index-clean)' : ''));
      }
    }
    process.exit(breaches.length || explainFailures.length ? 1 : 0);
  } finally {
    kill();
    try { await raw.end(); } catch (_) {}
  }
})().catch((e) => {
  console.error('[perf-check] ERROR:', e && e.stack || e);
  process.exit(2);
});
