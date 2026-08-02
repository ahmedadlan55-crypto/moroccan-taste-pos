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
 *   Each query runs in FOUR phases —
 *     1. untimed warm-up with noCache:true   (JIT + buffer-pool warm)
 *     2. MEASURED COLD with noCache:true     ← the asserted number (pure SQL
 *        path; QueryService's 60s memo is bypassed on read AND write)
 *     3. untimed cache-populate (no noCache)
 *     4. MEASURED WARM (no noCache — served from the in-memory memo)
 *   Phases 2 and 4 are sampled REPEATS times and the MEDIAN is what is
 *   asserted and reported. Same protocol as before, sampled instead of
 *   guessed: a single wall-clock sample on a machine that is also running
 *   MySQL is noise, and a budget decided by noise is a budget that will flap
 *   in the gate. min/max ride along in the report so the spread is visible.
 *   The assertion is on COLD: rollout decisions need the SQL truth, not the
 *   memo. WARM is reported alongside so the memo's benefit is visible.
 *   Limits: COMMON < 2000ms, COMPLEX < 5000ms (cold), WARM < 250ms.
 *
 * TWO IDENTITIES. Most scenarios run as `admin` — global scope, every
 *   capability, no scope clause. One runs as the sandbox's `perf_manager`
 *   (seed-perf.js): role `manager` holds analytics.view but NOT
 *   analytics.cost.view, and its warehouse grants cover every seeded branch. It
 *   is the only way to measure a capability-MASKED, branch-SCOPED request at
 *   full volume — an admin token can never mask anything
 *   (lib/warehouseScope.isGlobalScope → scope.loadCaps returns the full set).
 *   That scenario ASSERTS meta.maskedMetrics: a masked request that silently
 *   stopped masking would otherwise pass while measuring the wrong plan.
 *

 * ROUTING HONESTY: meta.freshness.source is captured per query. In this wave
 * lib/analytics/freshness.js hard-codes source:'live' (rollup ROUTING is a
 * later wave — the rollup TABLES exist and are populated); the harness
 * therefore reports routing per query instead of asserting on it, and any
 * breach on a rollup-eligible query is reported as a planner-routing gap
 * rather than "the SQL is slow".
 *
 * EXPLAIN ASSERTIONS (run via mysql2 directly, EXPLAIN FORMAT=JSON):
 *   A. EVERY scenario's LIVE plan (built with lib/analytics/planner.js, under
 *      that scenario's own scope) must NOT full-scan a fact table — fails on
 *      e.g. "table_name":"analytics_order_facts" with "access_type":"ALL".
 *      Checking only a hand-picked few let an unindexed date basis or an
 *      unindexed returns path through unmeasured, which is precisely the class
 *      of defect this assertion exists to catch.
 *      A scan that is genuinely CORRECT is allowed only by an explicit
 *      EXPLAIN_ALLOWLIST entry naming the scenario, the table and the reason —
 *      never by relaxing the rule. (A range covering ~three quarters of the
 *      table is the honest case: an index range scan over almost every row,
 *      with a random-order row lookup per hit, is strictly worse than reading
 *      the table once, and MySQL choosing the scan there is the optimizer being
 *      right.)
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
// The memo is an in-process Map lookup plus JSON transport; anything slower
// means the request did NOT hit it (a cache key that varies per call, say).
const WARM_LIMIT_MS = 250;

// Username of the non-global identity seed-perf.js provisions. See the
// TWO IDENTITIES note above.
const PERF_USER = 'perf_manager';

// Samples per measured phase. 3 is the smallest count with a meaningful
// median; --repeats raises it when a number is being argued about.
const REPEATS = Math.max(1, Number(flag('repeats', 3)) | 0);
function median(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

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

/*
 * EXPLAIN FORMAT=JSON reports `table_name` as the ALIAS whenever the query
 * aliases the table — and EVERY fact's FROM clause aliases every table it
 * touches (registry/facts.js: `FROM analytics_order_facts f JOIN ar_documents
 * doc …`). So the old hard-coded FACT_TABLES set, matched against table_name,
 * compared "analytics_order_facts" to "f" and never matched: the "no full scan
 * of a fact table" assertion has been structurally incapable of failing. It
 * printed `f:ALL` on its own console line and reported ALL PASS underneath.
 *
 * Both halves are now derived from the registry's own FROM strings, so the
 * alias map and the table set cannot drift from the facts — and a fact added
 * later (a rollup fact, say) is covered the moment it is registered.
 */
const { FACTS } = require('../../lib/analytics/registry/facts');
const ALIAS_TO_TABLE = (() => {
  const map = new Map();
  for (const f of Object.values(FACTS)) {
    const re = /(?:FROM|JOIN)\s+([A-Za-z_]\w*)\s+([A-Za-z_]\w*)/g;
    let hit;
    while ((hit = re.exec(String(f.from || '')))) map.set(hit[2], hit[1]);
  }
  return map;
})();
/** alias (or a bare table name) → the real table it refers to. */
const resolveTable = (name) => ALIAS_TO_TABLE.get(String(name)) || String(name);
const FACT_TABLES = new Set(ALIAS_TO_TABLE.values());

/**
 * Scans that are the optimizer being RIGHT, not an index being missing.
 * { scenario: <exact name>, table, reason }. Anything not listed here fails.
 * A reason is mandatory — an allowlist without one is just a disabled check.
 */
const EXPLAIN_ALLOWLIST = [];

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

    // ── the second identity (masked + branch-scoped) ─────────────────────────
    // Resolved through the REAL resolver, against the REAL sandbox rows, then
    // asserted. A masked scenario whose user turned out to be global (nothing
    // masked) or grant-less (planner emits 1=0 → every number a fabricated
    // zero) would still return 200 quickly and would be pure theatre.
    const scopeLib = require('../../lib/analytics/scope');
    const [[pu]] = await raw.query(
      'SELECT id, username, role FROM users WHERE username = ? LIMIT 1', [PERF_USER]);
    if (!pu) fail(`sandbox has no "${PERF_USER}" user — re-run seed-perf.js (it provisions the non-global identity the masked scenario needs).`);
    const perfUser = { id: pu.id, username: pu.username, role: pu.role };
    const mgrScope = await scopeLib.resolveScope(raw, perfUser);
    if (mgrScope.all) fail(`"${PERF_USER}" resolves to GLOBAL scope (role=${pu.role}) — nothing can mask, the scenario would measure the admin plan.`);
    if (!mgrScope.branchIds.length) fail(`"${PERF_USER}" has ZERO branch grants — the planner would emit 1=0 and every measured number would be a fabricated zero.`);
    if (mgrScope.caps.has('analytics.cost.view')) fail(`"${PERF_USER}" HAS analytics.cost.view — the masked scenario would mask nothing.`);
    const scopedMgr = jwt.sign(
      { id: perfUser.id, username: perfUser.username, role: perfUser.role, tokenVersion: 1 },
      process.env.JWT_SECRET, { expiresIn: '2h' });
    console.log(`[perf-check] second identity: ${perfUser.username} (role=${perfUser.role}) → ` +
      `${mgrScope.branchIds.length} branches, ${mgrScope.caps.size} caps, no analytics.cost.view`);

    // Branch/channel ids for the drill-down filters, read from the sandbox so
    // the filter matches real rows instead of a guessed literal.
    const [brRows] = await raw.query(
      'SELECT branch_id FROM analytics_order_facts GROUP BY branch_id ORDER BY branch_id LIMIT 4');
    const FILTER_BRANCHES = brRows.map((r) => String(r.branch_id));
    const [chRows] = await raw.query(
      'SELECT channel_id FROM analytics_order_facts WHERE channel_id IS NOT NULL GROUP BY channel_id ORDER BY channel_id LIMIT 2');
    const FILTER_CHANNELS = chRows.map((r) => String(r.channel_id));
    if (FILTER_BRANCHES.length < 2 || !FILTER_CHANNELS.length) {
      fail('sandbox has too few branches/channels to pin a drill-down filter against.');
    }

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

      // ── W6 additions: the shapes the suite above never covered ─────────────
      // Sales BY DAY on its own. "daily net by branch" measures branch×day, and
      // "discounts by day" measures a discount column — neither exercises the
      // plain one-dimension sales trend, which is the single most-opened report.
      { name: 'sales by day 30d', limit: COMMON_LIMIT_MS, body: {
        metrics: ['net_ex_vat', 'gross_product_sales', 'orders', 'avg_ticket'],
        dimensions: ['business_day'], range: D30, limit: 40 } },
      // Sales BY BRANCH with no compare — "branch compare prevPeriod" plans two
      // windows, so it could never show what one window costs.
      { name: 'sales by branch 30d', limit: COMMON_LIMIT_MS, body: {
        metrics: ['net_ex_vat', 'orders', 'guests', 'avg_ticket'], dimensions: ['branch'], range: D30 } },
      // Returns + voids together: two facts (return + order), and the ONLY
      // shape where the planner keeps voided rows in (a voids_* metric on the
      // statement suppresses the excluded_voided default — planner.js).
      { name: 'returns & voids by branch 90d', limit: COMMON_LIMIT_MS, body: {
        metrics: ['returns_value', 'returns_net', 'returns_count', 'qty_returned', 'voids_count', 'voids_value'],
        dimensions: ['branch'], range: D90 } },
      // A filtered drill-down: three pinned filters + an item grouping. Every
      // metric here is line-fact on purpose — `orders` is order-fact and
      // menu_item does not exist there, which the planner rejects as
      // ANALYTICS_UNSUPPORTED_COMBINATION rather than silently mis-joining.
      { name: 'drill-down items, 3 filters pinned 30d', limit: COMMON_LIMIT_MS, body: {
        metrics: ['net_ex_vat', 'qty_sold', 'gross_product_sales', 'discounts_line'],
        dimensions: ['menu_item'], range: D30,
        filters: [
          { dimension: 'branch', op: 'in', values: FILTER_BRANCHES },
          { dimension: 'channel', op: 'in', values: FILTER_CHANNELS },
          { dimension: 'order_type', op: 'eq', value: 'dine_in' },
        ],
        sort: [{ by: 'net_ex_vat', dir: 'desc' }], limit: 50 } },
      // Capability-masked AND branch-scoped — runs as perf_manager, and asserts
      // that the cost metrics actually came back masked.
      { name: 'masked cost metrics, scoped manager 30d', limit: COMMON_LIMIT_MS,
        as: 'manager', expectMasked: ['cogs', 'gross_profit', 'margin_pct'], body: {
          metrics: ['net_ex_vat', 'orders', 'avg_ticket', 'cogs', 'gross_profit', 'margin_pct'],
          dimensions: ['branch'], range: D30 } },
      // Taxes by category × rate: STORED vat columns only, across the line fact
      // AND the return fact (net_vat = vat_amount − returns_vat is the only
      // figure a VAT return can actually be filed on).
      { name: 'taxes by vat category×rate 90d', limit: COMPLEX_LIMIT_MS, body: {
        metrics: ['net_ex_vat', 'vat_amount', 'returns_net', 'returns_vat', 'net_vat'],
        dimensions: ['vat_category', 'vat_rate'], range: D90, limit: 100 } },
      // The widest window the planner will accept (MAX_RANGE_DAYS = 400).
      { name: 'full-window 400d branch×day', limit: COMPLEX_LIMIT_MS, body: {
        metrics: ['net_ex_vat', 'orders', 'invoice_total', 'gross_product_sales'],
        dimensions: ['branch', 'business_day'], range: R(400), limit: 500 } },
    ];

    const timedCall = async (body, tok) => {
      const t0 = process.hrtime.bigint();
      const r = await call(port, 'POST', '/api/analytics/query', tok || admin, body);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      return { ms, r };
    };

    const results = [];
    for (const q of QUERIES) {
      const tok = q.as === 'manager' ? scopedMgr : admin;
      const cold = Object.assign({}, q.body, { noCache: true });
      await timedCall(cold, tok);                               // 1. warm-up (untimed)
      const coldSamples = [];                                   // 2. MEASURED COLD ×REPEATS
      let coldR = null;
      for (let i = 0; i < REPEATS; i++) { const s = await timedCall(cold, tok); coldSamples.push(s.ms); coldR = s.r; }
      await timedCall(q.body, tok);                             // 3. cache populate
      const warmSamples = [];                                   // 4. MEASURED WARM ×REPEATS
      let warmR = null;
      for (let i = 0; i < REPEATS; i++) { const s = await timedCall(q.body, tok); warmSamples.push(s.ms); warmR = s.r; }
      const coldMs = median(coldSamples), warmMs = median(warmSamples);
      let okShape = coldR.status === 200 && coldR.body && coldR.body.success === true &&
        coldR.body.data && (q.body.dimensions ? (coldR.body.data.rows || []).length > 0 : !!coldR.body.data.totals);
      const source = coldR.body && coldR.body.meta && coldR.body.meta.freshness
        ? coldR.body.meta.freshness.source : 'n/a';
      const masked = (coldR.body && coldR.body.meta && coldR.body.meta.maskedMetrics) || [];
      // A masked scenario that stopped masking is measuring the WRONG plan —
      // it would compute the cost metrics it claims to be proving are absent.
      let maskErr = null;
      if (q.expectMasked) {
        const missing = q.expectMasked.filter((m) => !masked.includes(m));
        if (missing.length) { maskErr = `expected masked [${missing.join(', ')}], meta.maskedMetrics=[${masked.join(', ')}]`; okShape = false; }
      }
      const warmOk = warmR.status === 200 && warmMs < WARM_LIMIT_MS;
      const pass = okShape && coldMs < q.limit && warmOk;
      results.push({
        name: q.name, coldMs, warmMs, limit: q.limit, source, pass, masked,
        as: q.as || 'admin',
        coldMin: Math.min(...coldSamples), coldMax: Math.max(...coldSamples),
        warmMin: Math.min(...warmSamples), warmMax: Math.max(...warmSamples),
        rows: coldR.body && coldR.body.data ? (coldR.body.data.rows || []).length : 0,
        shapeErr: okShape ? null : (maskErr || `status=${coldR.status} success=${coldR.body && coldR.body.success} code=${coldR.body && coldR.body.code} rows=${coldR.body && coldR.body.data ? (coldR.body.data.rows || []).length : 'n/a'}`),
        warmErr: warmOk ? null : `warm ${warmMs.toFixed(0)}ms vs ${WARM_LIMIT_MS}ms (status ${warmR.status})`,
        warmStatus: warmR.status,
      });
      const rec = results[results.length - 1];
      console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${q.name}: cold ${coldMs.toFixed(0)}ms / warm ${warmMs.toFixed(0)}ms (limit ${q.limit}ms, source=${source}, rows=${rec.rows}, as=${rec.as}` +
        (masked.length ? `, masked=[${masked.join(',')}]` : '') + ')' +
        (rec.shapeErr ? '  ← ' + rec.shapeErr : '') + (rec.warmErr ? '  ← ' + rec.warmErr : ''));
    }

    // ── EXPLAIN assertions ───────────────────────────────────────────────────
    console.log('\n[perf-check] EXPLAIN assertions (FORMAT=JSON via mysql2)…');
    const planner = require('../../lib/analytics/planner');
    const { ANALYTICS_CAPS } = require('../../lib/analytics/scope');
    const scope = { all: true, branchIds: [], caps: new Set(ANALYTICS_CAPS) };
    const explainFailures = [];
    const scanReport = [];   // every observed fact-table scan, allowed or not

    // A. EVERY scenario's live plan, under ITS OWN scope, must not full-scan a
    //    fact table. The scenario's scope matters: the manager plan carries an
    //    extra `f.branch_id IN (…)` the admin plan does not, and that changes
    //    which index the optimizer picks.
    for (const q of QUERIES) {
      const qScope = q.as === 'manager' ? mgrScope : scope;
      const plan = planner.plan(Object.assign({}, q.body), qScope, {});
      for (const st of plan.statements) {
        const tables = await explainJson(raw, st.rows.sql, st.rows.params);
        for (const t of tables) {
          const tbl = resolveTable(t.table);
          if (!FACT_TABLES.has(tbl)) continue;
          // access_type 'index' is a full scan of the INDEX — every row still
          // read, just in key order. Recorded, not failed: the rule the brief
          // sets is on ALL, and inflating it here would be moving the goalposts
          // in the other direction.
          if (t.access === 'index') { scanReport.push({ scenario: q.name, fact: st.fact, table: tbl, kind: 'index', allowed: true, reason: 'full INDEX scan (access_type=index) — reported, not asserted on' }); continue; }
          if (t.access !== 'ALL') continue;
          const allowed = EXPLAIN_ALLOWLIST.find(
            (a) => a.scenario === q.name && a.table === tbl && a.reason);
          scanReport.push({ scenario: q.name, fact: st.fact, table: tbl, kind: 'ALL', allowed: !!allowed, reason: allowed ? allowed.reason : null });
          if (!allowed) {
            explainFailures.push(`LIVE "${q.name}" fact=${st.fact}: full scan of ${tbl} (alias ${t.table}, access_type=ALL)`);
          }
        }
        const summary = tables.map((t) => `${resolveTable(t.table)}:${t.access}${t.key ? '(' + t.key + ')' : ''}`).join(', ');
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
    console.log(`\n── perf results (cold = noCache SQL path, warm = 60s memo; median of ${REPEATS}) ──`);
    console.log(`  ${'query'.padEnd(nameW)}  ${'cold ms'.padStart(8)}  ${'cold rng'.padStart(11)}  ${'warm ms'.padStart(8)}  ${'limit'.padStart(6)}  ${'rows'.padStart(5)}  source  result`);
    for (const r of results) {
      const rng = `${r.coldMin.toFixed(0)}-${r.coldMax.toFixed(0)}`;
      console.log(`  ${r.name.padEnd(nameW)}  ${r.coldMs.toFixed(0).padStart(8)}  ${rng.padStart(11)}  ${r.warmMs.toFixed(0).padStart(8)}  ${String(r.limit).padStart(6)}  ${String(r.rows).padStart(5)}  ${String(r.source).padEnd(6)}  ${r.pass ? 'PASS' : 'FAIL'}`);
    }
    const breaches = results.filter((r) => !r.pass);
    console.log('──────────────────────────────────────────────────────────────');
    console.log(`  scenarios: ${results.length - breaches.length}/${results.length} PASS  (warm limit ${WARM_LIMIT_MS}ms)`);
    console.log(`  EXPLAIN assertions: ${explainFailures.length === 0 ? 'ALL PASS' : explainFailures.length + ' FAILED'}`);
    for (const f of explainFailures) console.log('    ✗ ' + f);
    const allowedScans = scanReport.filter((s) => s.allowed);
    if (allowedScans.length) {
      console.log(`  allowed / reported scans (${allowedScans.length}) — each with a written reason:`);
      for (const s of allowedScans) console.log(`    · ${s.scenario} / ${s.table} [${s.kind}]: ${s.reason}`);
    }
    // ROUTING: reported, never asserted — this harness measures, it does not
    // decide whether rollup routing has landed. The breakdown IS the evidence.
    const bySource = new Map();
    for (const r of results) bySource.set(r.source, (bySource.get(r.source) || 0) + 1);
    const srcSummary = [...bySource.entries()].map(([s, n]) => `${s}=${n}`).join(', ');
    console.log(`  routing (meta.freshness.source): ${srcSummary} of ${results.length} scenarios.`);
    if (bySource.size === 1 && bySource.has('live')) {
      console.log(`    every scenario answered LIVE — rollup routing is not visible in the response envelope at this commit; the rollup tables are populated and their PK plans are asserted above.`);
    }
    if (breaches.length) {
      console.log('\n  breaches:');
      for (const b of breaches) {
        console.log(`    ${b.name}: cold ${b.coldMs.toFixed(0)}ms vs ${b.limit}ms` +
          (b.warmErr ? ` | ${b.warmErr}` : '') +
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
