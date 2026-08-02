#!/usr/bin/env node
'use strict';
/* ─── Analytics perf sandbox seeder ──────────────────────────────────────────
 *
 * Provisions a DISPOSABLE perf database and fills it with realistic sales
 * volume DIRECTLY in the analytics fact + O2C tables (the POS API is far too
 * slow for ~530k orders), then builds every rollup via RollupService so the
 * perf harness (scripts/analytics/perf-check.js) can measure both paths.
 *
 * VOLUME (defaults, override via flags):
 *   2 brands × 4 branches each (8 branches; one runs Europe/London)
 *   550 business days ending YESTERDAY
 *   ~120 orders/branch/day (±25% jitter) ≈ 530k orders
 *   1–5 ar_document_lines per order ≈ 1.6M lines
 *   split payments on ~25% of orders, modifier facts on ~30%
 *   1 shift + open_float/close_count till facts per branch/day,
 *   cash_sale till fact per cash order, ~1.5% voided orders,
 *   ~2% returns — REAL sales_returns + sales_return_lines (+ the refund
 *   payment/till facts), ~8% of them left 'cancelled'
 *   1 warehouse per branch + a NON-GLOBAL `perf_manager` user granted all of
 *   them, so a capability-masked, branch-scoped request can be measured
 *
 * DETERMINISM: a seeded LCG drives every random choice — same --seed, same
 * database, byte for byte. No Math.random anywhere.
 *
 * SAFETY: --db=NAME is REQUIRED, must differ from the .env DB_NAME (and its
 * _test/_e2e derivatives), must contain "perf" (the DROP target must be
 * unmistakably a sandbox), and the server must be local. The .env database is
 * never touched: the target is created fresh (DROP + CREATE), schema is booted
 * by spawning `MIGRATE_ONLY=1 node server.js` with the DB_NAME override — the
 * exact release-chain pattern (scripts/e2e/provision-e2e-db.js guards,
 * tests/integration/migrationConcurrency.test.js env shape).
 *
 * SIMPLIFICATIONS (documented, deliberate):
 *   - no `sales` rows: the analytics read path never touches the sales table
 *     (facts + ar_documents only), so seeding it would only slow the run;
 *   - a return writes sales_returns + sales_return_lines (the two tables the
 *     `return` fact actually reads — registry/facts.js) and its refund payment
 *     /till facts, but NO credit-note ar_document: the planner EXCLUDES
 *     source in ('sales_return','credit_note') from every order/line statement
 *     by default, so a CN document would be filtered straight back out of every
 *     measurement it could appear in;
 *   - a voided order keeps its lines and payment facts (that is what the
 *     projection actually leaves behind); only f.status flips, which is exactly
 *     what voids_count / voids_value and the excluded_voided default read;
 *   - the perf user is granted warehouse access but no `sales`/POS fixtures —
 *     it exists solely so lib/analytics/scope.js resolves a real non-global
 *     branch scope (its password hash is a non-loginable marker);
 *   - header discount is informational (net amounts are already post-discount),
 *     mirroring tests/fixtures/salesHubSeed.js F1.
 *
 * USAGE
 *   node scripts/analytics/seed-perf.js --db=mt_perf_sales_hub
 *     [--days=550] [--orders=120] [--seed=20260724] [--skip-provision]
 * ────────────────────────────────────────────────────────────────────────── */

require('dotenv').config();
const path = require('path');
const { spawnSync } = require('child_process');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..', '..');

// ── CLI ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name, dflt) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const TARGET_DB = flag('db', null);
const DAYS = Math.max(1, Number(flag('days', 550)) | 0);
const ORDERS_PER_BRANCH_DAY = Math.max(1, Number(flag('orders', 120)) | 0);
const SEED = (Number(flag('seed', 20260724)) >>> 0) || 20260724;
const SKIP_PROVISION = argv.includes('--skip-provision');

const HOST = process.env.DB_HOST || 'localhost';
const PORT = Number(process.env.DB_PORT) || 3306;
const USER = process.env.DB_USER || 'root';
const PASS = process.env.DB_PASSWORD || '';
const ENV_DB = process.env.DB_NAME || 'moroccan_taste_pos';

// The non-global analytics user the masked-metric scenario runs as.
// scripts/analytics/perf-check.js looks this username up by name — keep the two
// in step if you rename it.
const PERF_USER = 'perf_manager';
const PERF_ROLE = 'manager';

function fail(msg) { console.error('[seed-perf] REFUSING: ' + msg); process.exit(2); }

function guard() {
  if (!TARGET_DB) fail('--db=NAME is required (an explicit disposable perf database). Example: --db=mt_perf_sales_hub');
  if (!['localhost', '127.0.0.1', '::1'].includes(HOST)) fail(`DB_HOST is "${HOST}" — this script DROPs a database and only runs locally.`);
  for (const v of ['DATABASE_URL', 'MYSQL_URL', 'MYSQLHOST']) {
    if (process.env[v]) fail(`${v} is set — that smells like a managed/remote database.`);
  }
  const protectedNames = new Set([ENV_DB, ENV_DB + '_test', ENV_DB + '_e2e']);
  if (protectedNames.has(TARGET_DB)) fail(`target "${TARGET_DB}" collides with the .env database (or its _test/_e2e derivative). Pick a dedicated perf name.`);
  if (!/perf/i.test(TARGET_DB)) fail(`target "${TARGET_DB}" does not contain "perf" — the DROP target must be unmistakably a sandbox.`);
}

// ── deterministic PRNG (LCG, Numerical-Recipes constants) ────────────────────
let _s = SEED >>> 0;
function rand() { _s = (Math.imul(_s, 1664525) + 1013904223) >>> 0; return _s / 4294967296; }
function randInt(lo, hi) { return lo + Math.floor(rand() * (hi - lo + 1)); } // inclusive
function pick(arr) { return arr[Math.floor(rand() * arr.length)]; }
const r2 = (n) => Math.round(n * 100) / 100;

// ── calendar helpers (pure string math — no tz surprises) ────────────────────
function dayStr(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function addDays(iso, n) {
  const t = Date.parse(iso + 'T00:00:00Z') + n * 86400000;
  return dayStr(new Date(t));
}
function yesterdayIso() {
  const now = new Date();
  const local = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  return addDays(dayStr(local), -1);
}
const pad2 = (n) => String(n).padStart(2, '0');

// ── step 1: provision the sandbox schema via the release-chain pattern ───────
async function provision() {
  const root = await mysql.createConnection({ host: HOST, port: PORT, user: USER, password: PASS });
  if (!SKIP_PROVISION) {
    console.log(`[seed-perf] DROP + CREATE \`${TARGET_DB}\``);
    await root.query('DROP DATABASE IF EXISTS `' + TARGET_DB + '`');
    await root.query('CREATE DATABASE `' + TARGET_DB + '` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    console.log('[seed-perf] booting schema: MIGRATE_ONLY=1 node server.js (DB_NAME override)…');
    const env = { ...process.env, MIGRATE_ONLY: '1', DB_NAME: TARGET_DB, MYSQL_DATABASE: TARGET_DB, MYSQLDATABASE: TARGET_DB };
    delete env.DATABASE_URL; delete env.MYSQL_URL; delete env.MYSQLHOST;
    const t0 = Date.now();
    const res = spawnSync(process.execPath, ['server.js'], {
      cwd: ROOT, env, encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 * 1024,
    });
    if (res.status !== 0) {
      console.error((res.stdout || '').slice(-2000));
      console.error((res.stderr || '').slice(-2000));
      fail(`MIGRATE_ONLY boot exited ${res.status} — schema provisioning failed.`);
    }
    console.log(`[seed-perf] schema ready (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  const [[t]] = await root.query(
    'SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = ?', [TARGET_DB]);
  if (t.n < 50) fail(`"${TARGET_DB}" has only ${t.n} tables — provisioning did not complete.`);
  await root.end();
}

// ── batched insert buffers ───────────────────────────────────────────────────
function makeBuffer(db, table, cols, chunk = 1000) {
  const rows = [];
  let total = 0;
  return {
    push(row) { rows.push(row); },
    get pending() { return rows.length; },
    get total() { return total; },
    async flush(force) {
      while (rows.length >= chunk || (force && rows.length)) {
        const batch = rows.splice(0, chunk);
        await db.query(`INSERT INTO \`${table}\` (${cols.join(',')}) VALUES ?`, [batch]);
        total += batch.length;
      }
    },
  };
}

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  guard();
  const started = Date.now();
  await provision();

  // Bind THIS process's shared pool (db/connection) to the sandbox BEFORE the
  // first require — the testHarness activate() trick.
  process.env.DB_NAME = TARGET_DB;
  process.env.MYSQL_DATABASE = TARGET_DB;
  process.env.MYSQLDATABASE = TARGET_DB;
  delete process.env.DATABASE_URL; delete process.env.MYSQL_URL; delete process.env.MYSQLHOST;
  const db = require('../../db/connection');
  const RollupService = require('../../services/analytics/RollupService');

  const END_DAY = yesterdayIso();
  const START_DAY = addDays(END_DAY, -(DAYS - 1));
  console.log(`[seed-perf] window ${START_DAY} .. ${END_DAY} (${DAYS} business days), seed=${SEED}`);

  // ── masters ────────────────────────────────────────────────────────────────
  const BRANDS = [
    { id: 'PERF-BRAND-A', name: 'Perf Brand Alpha' },
    { id: 'PERF-BRAND-B', name: 'Perf Brand Beta' },
  ];
  const BRANCHES = [];
  for (let b = 0; b < 8; b++) {
    const brand = BRANDS[b < 4 ? 0 : 1];
    BRANCHES.push({
      id: `PERF-B${b + 1}`,
      name: `Perf Branch ${b + 1}`,
      brand: brand.id,
      tz: b === 3 ? 'Europe/London' : 'Asia/Riyadh', // one London branch
      cashiers: Array.from({ length: 5 }, (_, i) => `perf_cashier_b${b + 1}_${i + 1}`),
    });
  }
  const CHANNELS = ['PERF-CH-POS', 'PERF-CH-APP', 'PERF-CH-AGG', 'PERF-CH-WEB'];
  const ORDER_TYPES = ['dine_in', 'takeaway', 'delivery'];
  const CATEGORIES = Array.from({ length: 8 }, (_, i) => `PERF-CAT-${i + 1}`);

  // 40 menu items per brand; ~15% zero-rated. Prices in 0.25 steps keep every
  // computed amount exactly 2dp (15% VAT of a .25-step price is 4dp-safe after
  // r2, and totals stay Σ-consistent because we sum the rounded parts).
  const MENUS = {};
  for (const brand of BRANDS) {
    MENUS[brand.id] = Array.from({ length: 40 }, (_, i) => {
      const price = randInt(8, 120) + pick([0, 0.25, 0.5, 0.75]);
      const zeroRated = rand() < 0.15;
      return {
        id: `${brand.id}-M${pad2(i + 1)}`,
        name: `Perf Item ${brand.id.slice(-1)}${pad2(i + 1)}`,
        price,
        cost: r2(price * (0.25 + rand() * 0.25)),
        cat: pick(CATEGORIES),
        vatCat: zeroRated ? 'Z' : 'S',
        vatRate: zeroRated ? 0 : 15,
      };
    });
  }

  console.log('[seed-perf] inserting masters (brands/branches/menu)…');
  for (const brand of BRANDS) {
    await db.query('INSERT INTO brands (id, name) VALUES (?,?)', [brand.id, brand.name]);
  }
  for (const br of BRANCHES) {
    await db.query(
      'INSERT INTO branches (id, name, brand_id, timezone, day_close_time) VALUES (?,?,?,?,?)',
      [br.id, br.name, br.brand, br.tz, '04:00:00']);
  }
  for (const brand of BRANDS) {
    for (const m of MENUS[brand.id]) {
      await db.query(
        'INSERT INTO menu (id, name, price, cost, active, tax_category, is_tax_inclusive) VALUES (?,?,?,?,1,?,1)',
        [m.id, m.name, m.price, m.cost, m.vatCat]);
    }
  }

  // One warehouse per branch + a NON-GLOBAL analytics user granted all of them.
  //
  // WHY: lib/analytics/scope.js resolves branch scope through
  // user_warehouse_access → warehouses.branch_id, and gives GLOBAL users
  // (admin/developer — lib/warehouseScope.isGlobalScope) every capability. So an
  // admin token can never produce a capability-masked request, and there was no
  // way to measure one at volume. Role `manager` carries analytics.view but NOT
  // analytics.cost.view (role_permissions seed), so cogs / gross_profit /
  // margin_pct mask out while the branch grants still cover 100% of the seeded
  // rows — the masked request measures the same data as every other scenario,
  // plus the scope IN (…) clause the planner appends for non-global callers.
  console.log('[seed-perf] inserting warehouses + the non-global perf user…');
  for (const br of BRANCHES) {
    await db.query(
      'INSERT INTO warehouses (id, code, name, type, branch_id, brand_id) VALUES (?,?,?,?,?,?)',
      [`${br.id}-WH`, `${br.id}-WH`, `Perf WH ${br.id}`, 'branch', br.id, br.brand]);
  }
  // Password is a deliberate non-bcrypt marker: bcrypt.compare can never match
  // it, so this account authenticates by nothing but a harness-signed JWT.
  const [ures] = await db.query(
    'INSERT INTO users (username, password, role, active, token_version) VALUES (?,?,?,1,1)',
    [PERF_USER, '!perf-no-login', PERF_ROLE]);
  const perfUserId = ures.insertId;
  for (const br of BRANCHES) {
    await db.query('INSERT INTO user_warehouse_access (user_id, warehouse_id) VALUES (?,?)',
      [perfUserId, `${br.id}-WH`]);
  }
  console.log(`[seed-perf]   user "${PERF_USER}" (id=${perfUserId}, role=${PERF_ROLE}) → ${BRANCHES.length} warehouses`);

  // ── fact buffers ───────────────────────────────────────────────────────────
  const bufDocs = makeBuffer(db, 'ar_documents',
    ['id', 'document_number', 'document_type', 'source_type', 'source_id', 'brand_id', 'branch_id',
      'issue_date', 'subtotal', 'discount_amount', 'vat_amount', 'total_amount', 'status', 'created_by']);
  const bufLines = makeBuffer(db, 'ar_document_lines',
    ['id', 'document_id', 'source_line_id', 'menu_id', 'description', 'entered_qty', 'base_qty',
      'unit_price', 'discount_amount', 'vat_category', 'vat_rate', 'net_amount', 'vat_amount',
      'gross_amount', 'cost_snapshot', 'category_id_snapshot', 'snapshot_provenance']);
  const bufOfacts = makeBuffer(db, 'analytics_order_facts',
    ['document_id', 'sale_id', 'brand_id', 'branch_id', 'shift_id', 'channel_id', 'order_type',
      'source', 'guests', 'status', 'created_by', 'opened_at', 'closed_at', 'paid_at',
      'occurred_at_local', 'business_day', 'tz_snapshot', 'discount_total', 'rounding_amount',
      'tips_amount', 'fees_amount', 'provenance']);
  const bufPfacts = makeBuffer(db, 'analytics_payment_facts',
    ['source_type', 'source_id', 'line_no', 'document_id', 'branch_id', 'brand_id', 'shift_id',
      'method_raw', 'method_norm', 'direction', 'amount', 'status', 'occurred_at',
      'occurred_at_local', 'business_day', 'performed_by', 'provenance']);
  const bufMfacts = makeBuffer(db, 'analytics_modifier_facts',
    ['document_id', 'source_line_id', 'parent_menu_id', 'component_menu_id',
      'component_name_snapshot', 'qty', 'price_delta', 'cost_snapshot', 'kind', 'provenance']);
  const bufTfacts = makeBuffer(db, 'analytics_till_facts',
    ['shift_id', 'branch_id', 'movement_type', 'amount', 'occurred_at', 'occurred_at_local',
      'business_day', 'performed_by', 'source_type', 'source_id', 'provenance']);
  const bufShifts = makeBuffer(db, 'shifts',
    ['id', 'username', 'status', 'start_time', 'end_time', 'branch_id', 'opening_float', 'actual_cash']);
  // The `return` fact is sales_return_lines JOIN sales_returns … AND
  // r.status='posted' — both tables are needed for a returns metric to be
  // anything but a structural zero.
  const bufRets = makeBuffer(db, 'sales_returns',
    ['id', 'return_number', 'original_ar_document_id', 'brand_id', 'branch_id', 'warehouse_id',
      'return_date', 'reason_code', 'refund_method', 'subtotal', 'vat_amount', 'total_amount',
      'cost_total', 'status', 'created_by']);
  const bufRetLines = makeBuffer(db, 'sales_return_lines',
    ['id', 'return_id', 'original_line_id', 'menu_id', 'description', 'sold_qty',
      'previously_returned_qty', 'return_qty', 'base_qty', 'unit_price_snapshot',
      'discount_snapshot', 'vat_category', 'vat_rate', 'net_amount', 'vat_amount',
      'gross_amount', 'cost_snapshot']);
  const ALL_BUFS = [bufDocs, bufLines, bufOfacts, bufPfacts, bufMfacts, bufTfacts, bufShifts,
    bufRets, bufRetLines];

  // ── the generator loop ─────────────────────────────────────────────────────
  console.log('[seed-perf] generating orders…');
  let orderCount = 0, lineCount = 0;
  for (let dayIdx = 0; dayIdx < DAYS; dayIdx++) {
    const bd = addDays(START_DAY, dayIdx);         // business day
    const nextCal = addDays(bd, 1);                 // late-night calendar day
    const dayTag = bd.replace(/-/g, '');            // YYYYMMDD for ids

    for (const br of BRANCHES) {
      const shiftId = `${br.id}-SH-${dayTag}`;      // ≤ 50 chars ✓
      const menu = MENUS[br.brand];
      const nOrders = Math.max(1, Math.round(ORDERS_PER_BRANCH_DAY * (0.75 + rand() * 0.5)));
      let cashTotal = 0;

      for (let i = 0; i < nOrders; i++) {
        const docId = `${br.id}-D${dayTag}-${pad2(Math.floor(i / 100))}${pad2(i % 100)}`;
        const lateNight = rand() < 0.10;
        // late-night: 00:30–03:29 on the NEXT calendar day, same business day
        // (strictly before the 04:00 close — mirrors salesHubSeed F7).
        const h = lateNight ? randInt(0, 2) : randInt(5, 23);
        const mi = randInt(0, 59), sec = randInt(0, 59);
        const local = `${lateNight ? nextCal : bd} ${pad2(lateNight ? h : Math.min(h, 23))}:${pad2(mi)}:${pad2(sec)}`;
        const cal = lateNight ? nextCal : bd;

        const cashier = pick(br.cashiers);
        const channel = pick(CHANNELS);
        const orderType = pick(ORDER_TYPES);
        const guests = orderType === 'dine_in' ? randInt(1, 4) : null;
        // ~1.5% voided. The lines and payment facts stay — that is what the
        // projection actually leaves behind — so voids_value can read
        // doc.total_amount and the planner's excluded_voided default has
        // something real to exclude.
        const voided = rand() < 0.015;

        // lines
        const nLines = randInt(1, 5);
        const lineRows = [];   // the SAME row arrays pushed to bufLines (no copy)
        let subtotal = 0, vatSum = 0, costSum = 0;
        const discounted = rand() < 0.12;
        let discountTotal = 0;
        for (let L = 0; L < nLines; L++) {
          const m = pick(menu);
          const qty = randInt(1, 3);
          let net = r2(m.price * qty);
          let lineDiscount = 0;
          if (discounted && L === 0) {
            lineDiscount = r2(net * pick([0.05, 0.10, 0.15]));
            net = r2(net - lineDiscount);            // net is post-discount (F1 convention)
            discountTotal = lineDiscount;
          }
          const vat = m.vatCat === 'S' ? r2(net * 0.15) : 0;
          const gross = r2(net + vat);
          const cost = r2(m.cost * qty);
          subtotal = r2(subtotal + net); vatSum = r2(vatSum + vat); costSum = r2(costSum + cost);
          const lineRow = [`${docId}-L${L}`, docId, `L${L}`, m.id, m.name, qty, qty,
            m.price, lineDiscount, m.vatCat, m.vatRate, net, vat, gross, cost,
            m.cat, 'at_sale'];
          bufLines.push(lineRow);
          lineRows.push(lineRow);
          lineCount++;
        }
        const total = r2(subtotal + vatSum);

        bufDocs.push([docId, docId, 'invoice', 'pos', docId, br.brand, br.id,
          cal, subtotal, discountTotal, vatSum, total, 'paid', cashier]);
        bufOfacts.push([docId, null, br.brand, br.id, shiftId, channel, orderType, 'pos',
          guests, voided ? 'voided' : 'completed', cashier, local, local, local, local, bd, br.tz,
          discountTotal, 0, 0, 0, 'live']);

        // payments: 25% split (cash+card), else single cash/card/online
        const split = rand() < 0.25;
        if (split) {
          const cashPart = r2(total * (0.3 + rand() * 0.4));
          const cardPart = r2(total - cashPart);
          bufPfacts.push(['pos_split', docId, 0, docId, br.id, br.brand, shiftId,
            'Cash', 'cash', 'in', cashPart, 'captured', local, local, bd, cashier, 'live']);
          bufPfacts.push(['pos_split', docId, 1, docId, br.id, br.brand, shiftId,
            'Mada', 'card', 'in', cardPart, 'captured', local, local, bd, cashier, 'live']);
          cashTotal = r2(cashTotal + cashPart);
          bufTfacts.push([shiftId, br.id, 'cash_sale', cashPart, local, local, bd,
            cashier, 'sale', docId, 'live']);
        } else {
          const method = channel === 'PERF-CH-POS' ? (rand() < 0.55 ? 'cash' : 'card') : pick(['card', 'online']);
          const raw = method === 'cash' ? 'Cash' : method === 'card' ? 'Mada' : 'OnlineGw';
          bufPfacts.push(['pos_single', docId, 0, docId, br.id, br.brand, shiftId,
            raw, method, 'in', total, 'captured', local, local, bd, cashier, 'live']);
          if (method === 'cash') {
            cashTotal = r2(cashTotal + total);
            bufTfacts.push([shiftId, br.id, 'cash_sale', total, local, local, bd,
              cashier, 'sale', docId, 'live']);
          }
        }

        // modifiers on ~30% of orders (1–2 components on line 0)
        if (rand() < 0.30) {
          const parent = pick(menu);
          const nMods = randInt(1, 2);
          for (let k = 0; k < nMods; k++) {
            const comp = pick(menu);
            bufMfacts.push([docId, 'L0', parent.id, comp.id, comp.name, 1,
              k === 0 ? r2(1 + rand() * 5) : null, null,
              k === 0 ? 'modifier' : 'combo_choice', 'live']);
          }
        }

        // ~2% returns: a REAL sales_return (+ lines) the day after the sale,
        // with the 'out' payment fact and cash_refund till fact that go with it.
        // A PARTIAL return (1–2 of the order's lines) is the realistic case and
        // the one that makes returns_net ≠ net_ex_vat at every grain.
        // ~8% stay 'cancelled' so the fact's `AND r.status='posted'` predicate is
        // exercised rather than trivially true.
        if (!voided && rand() < 0.02) {
          const refundDay = addDays(bd, 1);
          const rLocal = `${refundDay} ${pad2(randInt(10, 20))}:00:00`;
          const cashBack = rand() < 0.5;
          const posted = rand() >= 0.08;
          const retId = `${docId}-R`;
          const nRet = Math.min(lineRows.length, randInt(1, 2));
          let rNet = 0, rVat = 0, rCost = 0;
          for (let k = 0; k < nRet; k++) {
            const LR = lineRows[k]; // [0]id [3]menu [4]desc [6]base_qty [7]price
            rNet = r2(rNet + LR[11]); rVat = r2(rVat + LR[12]); rCost = r2(rCost + LR[14]);
            bufRetLines.push([`${retId}-L${k}`, retId, LR[0], LR[3], LR[4], LR[6], 0,
              LR[6], LR[6], LR[7], 0, LR[9], LR[10], LR[11], LR[12], LR[13], LR[14]]);
          }
          const rTotal = r2(rNet + rVat);
          bufRets.push([retId, retId, docId, br.brand, br.id, `${br.id}-WH`, refundDay,
            pick(['damaged', 'wrong_item', 'customer_change', 'quality']),
            cashBack ? 'cash' : 'ar_reduction', rNet, rVat, rTotal, rCost,
            posted ? 'posted' : 'cancelled', cashier]);
          bufPfacts.push(['refund', docId, 0, docId, br.id, br.brand, null,
            cashBack ? 'cash' : 'ar_reduction', cashBack ? 'cash' : 'other', 'out',
            rTotal, 'settled', rLocal, rLocal, refundDay, cashier, 'live']);
          if (cashBack) {
            bufTfacts.push([null, br.id, 'cash_refund', rTotal, rLocal, rLocal,
              refundDay, cashier, 'sales_return', docId, 'live']);
          }
        }

        orderCount++;
      }

      // shift row + till open/close (close_count ≈ float + cash ± variance,
      // so till_variance has a realistic non-zero distribution)
      const variance = r2((rand() - 0.5) * 40);
      const counted = r2(500 + cashTotal + variance);
      bufShifts.push([shiftId, br.cashiers[0], 'closed',
        `${bd} 07:30:00`, `${nextCal} 02:30:00`, br.id, 500, counted]);
      bufTfacts.push([shiftId, br.id, 'open_float', 500, `${bd} 07:30:00`, `${bd} 07:30:00`,
        bd, br.cashiers[0], 'shift', shiftId, 'live']);
      bufTfacts.push([shiftId, br.id, 'close_count', counted,
        `${nextCal} 02:30:00`, `${nextCal} 02:30:00`, bd, br.cashiers[0], 'shift', shiftId, 'live']);
    }

    for (const b of ALL_BUFS) await b.flush(false);
    if ((dayIdx + 1) % 25 === 0 || dayIdx === DAYS - 1) {
      const pct = (((dayIdx + 1) / DAYS) * 100).toFixed(0);
      console.log(`[seed-perf]   day ${dayIdx + 1}/${DAYS} (${pct}%) — ${orderCount} orders, ${lineCount} lines, ${((Date.now() - started) / 1000).toFixed(0)}s`);
    }
  }
  for (const b of ALL_BUFS) await b.flush(true);

  console.log(`[seed-perf] facts done: ${bufDocs.total} docs, ${bufLines.total} lines, ` +
    `${bufOfacts.total} order facts, ${bufPfacts.total} payment facts, ` +
    `${bufMfacts.total} modifier facts, ${bufTfacts.total} till facts, ${bufShifts.total} shifts, ` +
    `${bufRets.total} returns, ${bufRetLines.total} return lines`);

  // ── refresh optimizer statistics ───────────────────────────────────────────
  // InnoDB samples index cardinality in the background and does NOT refresh it
  // synchronously after a bulk load. A sandbox that goes straight from
  // 0 → 530k rows therefore carries whatever cardinality it happened to sample
  // mid-load, and the optimizer picks plans from that: measured here, the SAME
  // 30-day order-fact query chose `range(ix_aof_day_branch)` before ANALYZE and
  // a full scan after it. A perf baseline taken on unrefreshed statistics is
  // not a baseline of anything — it is a measurement of when the load happened
  // to be interrupted, and it will not reproduce.
  console.log('[seed-perf] ANALYZE TABLE (refresh optimizer statistics)…');
  for (const t of ['analytics_order_facts', 'ar_documents', 'ar_document_lines',
    'analytics_payment_facts', 'analytics_modifier_facts', 'analytics_till_facts',
    'sales_returns', 'sales_return_lines']) {
    await db.query('ANALYZE TABLE `' + t + '`');
  }

  // ── rollups: enqueue every (branch, day) pair, then drain in batches ───────
  // rebuildRange caps at 400 days — chunk the window.
  console.log('[seed-perf] enqueueing rollup pairs…');
  let from = START_DAY;
  let pairs = 0;
  while (from <= END_DAY) {
    const to = addDays(from, 399) <= END_DAY ? addDays(from, 399) : END_DAY;
    const res = await RollupService.rebuildRange(db, { from, to });
    pairs += res.pairs;
    from = addDays(to, 1);
  }
  console.log(`[seed-perf] ${pairs} dirty pairs queued — draining…`);
  const t0 = Date.now();
  let drained = 0, failed = 0;
  for (;;) {
    const out = await RollupService.drainDirty(db, { limit: 500 });
    drained += out.rebuilt; failed += out.failed;
    if (out.claimed === 0) break;
    if (drained % 1000 < 500) {
      console.log(`[seed-perf]   rollups ${drained}/${pairs} (${((Date.now() - t0) / 1000).toFixed(0)}s, mode=${out.mode})`);
    }
  }
  if (failed) fail(`${failed} rollup pair rebuilds FAILED — the rollup tables are incomplete.`);
  console.log(`[seed-perf] rollups drained: ${drained} pairs in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // sanity counts straight from the sandbox
  const [[c1]] = await db.query('SELECT COUNT(*) n FROM analytics_order_facts');
  const [[c2]] = await db.query('SELECT COUNT(*) n FROM ar_document_lines');
  const [[c3]] = await db.query('SELECT COUNT(*) n FROM analytics_daily_branch');
  const [[c4]] = await db.query('SELECT COUNT(*) n FROM analytics_hourly_branch');
  const [[c5]] = await db.query("SELECT COUNT(*) n FROM sales_returns WHERE status='posted'");
  const [[c6]] = await db.query("SELECT COUNT(*) n FROM analytics_order_facts WHERE status='voided'");
  const [[c7]] = await db.query('SELECT COUNT(DISTINCT business_day) d, COUNT(DISTINCT branch_id) b FROM analytics_order_facts');
  console.log(`[seed-perf] verified: ${c1.n} order facts, ${c2.n} lines, ` +
    `${c3.n} daily_branch rollup rows, ${c4.n} hourly rollup rows`);
  console.log(`[seed-perf] verified: ${c5.n} POSTED returns, ${c6.n} voided orders, ` +
    `${c7.d} distinct business days, ${c7.b} branches`);
  // A perf run that measured a structurally-empty fact is not a measurement.
  if (!c5.n || !c6.n) fail('the returns and/or voids facts came out EMPTY — every returns/voids number would be a structural zero.');
  console.log(`[seed-perf] DONE in ${((Date.now() - started) / 60000).toFixed(1)} min — database \`${TARGET_DB}\` ready for perf-check.`);
  await db.end();
  process.exit(0);
})().catch((e) => {
  console.error('[seed-perf] ERROR:', e && e.stack || e);
  process.exit(1);
});
