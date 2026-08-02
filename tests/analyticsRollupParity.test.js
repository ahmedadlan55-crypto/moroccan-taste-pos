'use strict';
/**
 * tests/analyticsRollupParity.test.js — THE EQUALITY PROOF for every report
 * shape that lib/analytics/planner.js newly routes to a pre-aggregated rollup.
 * Run: node tests/analyticsRollupParity.test.js
 *
 * WHY THIS FILE EXISTS
 *   Routing a request to a rollup is only ever safe if the rollup returns the
 *   SAME NUMBER as the raw facts. A faster report that quietly disagrees with
 *   the ledger is worse than a slow one, and the disagreements the rollup
 *   builder can produce are silent by construction: a dropped free-text line, a
 *   NULL folded into a real bucket, a MAX() that merges two groups, a returns
 *   figure that still counts cancelled paperwork. None of those changes a
 *   column name, a row count or an HTTP status — they change a total.
 *
 *   So every shape is run TWICE against the SAME seeded truth: once normally
 *   (which must report meta.source === 'rollup') and once with
 *   `noRollup: true` (which must report 'live'). Then the two envelopes are
 *   compared field for field — the row KEY SET, every metric on every row,
 *   every subtotal level, and the grand total. Both preconditions are asserted:
 *   a run that silently went live both times would otherwise "pass" while
 *   proving nothing.
 *
 * THE FIXTURE IS BUILT AROUND THE FAILURE MODES, not around a happy path.
 * Its whole point is to contain, at least once each, every value the old
 * builder could not represent:
 *   - a FREE-TEXT line (ar_document_lines.menu_id IS NULL) — the rollup used to
 *     skip these because its PK cannot hold NULL, so item totals silently lost
 *     them;
 *   - a NULL vat_rate and a NULL created_by — same problem, other columns;
 *   - a payment with method_norm NULL **and** a payment whose method really is
 *     'other' — the builder used to fold the first into the second, which both
 *     invented a bucket and merged two;
 *   - a sale at 01:30 local on a 04:00-close branch, so business_day is the day
 *     BEFORE its calendar date — the exact case that makes YEARWEEK(business_day)
 *     differ from YEARWEEK(occurred_at_local);
 *   - a VOIDED order, so the void-inclusive population differs from the
 *     void-excluded one;
 *   - a CANCELLED return beside a posted one — the live `return` fact filters
 *     `r.status = 'posted'` and the rollup did not;
 *   - a credit-note document with POSITIVE lines and its own order fact, which
 *     the excluded_credit_note_docs default exists to neutralize;
 *   - a RETURNS-ONLY day (a return on a day with no trade at that branch), the
 *     case that made a rollup publish an all-zero sales row live never emits.
 *
 * The window is 2024-06 — in the PAST, so the rollup horizon can cover it (a
 * future window is never "closed" and would be answered live, proving nothing),
 * and disjoint from the other suites' windows (2031-03, 2031-07, 2032-03).
 * Every request is BRANCH-SCOPED to the two seeded branches so unrelated rows
 * in the same window cannot enter either side of the comparison.
 */
require('dotenv').config();

const db = require('../db/connection');
const analyticsSchema = require('../db/migrations/analytics/schema');
const RollupService = require('../services/analytics/RollupService');
const QueryService = require('../services/analytics/QueryService');
const { ANALYTICS_CAPS } = require('../lib/analytics/scope');

const P = 'ITEST-RPAR';
const I = {
  BRAND_A: `${P}-BRA`, BRAND_B: `${P}-BRB`,
  B1: `${P}-B1`, B2: `${P}-B2`,
  M1: `${P}-M1`, M2: `${P}-M2`, M3: `${P}-M3`,
  CA1: `${P}_ca1`, CA2: `${P}_ca2`,
  D1: `${P}-D1`, D2: `${P}-D2`, D3: `${P}-D3`, D4: `${P}-D4`, D5: `${P}-D5`,
  CN1: `${P}-CN1`,
  R1: `${P}-R1`, R2: `${P}-R2`,
};
const RANGE = { from: '2024-06-01', to: '2024-06-30' };

// Full capabilities, but a NON-GLOBAL branch scope: the planner then appends
// `branch_id IN (…)` to the rollup statement and to the fact statement alike,
// which is what keeps unrelated rows in the same window out of BOTH sides.
const SCOPE = { all: false, branchIds: [I.B1, I.B2], caps: new Set(ANALYTICS_CAPS) };

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅', name); return true; }
  fail++; failures.push(name);
  console.log('  ❌', name, extra !== undefined ? '→ ' + JSON.stringify(extra).slice(0, 500) : '');
  return false;
}

// ── fixture ──────────────────────────────────────────────────────────────────
async function cleanup() {
  const like = `${P}-%`;
  const likeUser = `${P}\\_%`;
  const del = async (sql, p) => { try { await db.query(sql, p || [like]); } catch (_) { /* table may not exist */ } };
  await del('DELETE FROM analytics_payment_facts WHERE source_id LIKE ? OR document_id LIKE ?', [like, like]);
  await del('DELETE FROM analytics_order_facts WHERE document_id LIKE ?');
  await del('DELETE FROM analytics_rollup_dirty WHERE branch_id LIKE ?');
  await del('DELETE FROM analytics_daily_branch WHERE branch_id LIKE ?');
  await del('DELETE FROM analytics_daily_item WHERE branch_id LIKE ?');
  await del('DELETE FROM analytics_daily_payment WHERE branch_id LIKE ?');
  await del('DELETE FROM analytics_hourly_branch WHERE branch_id LIKE ?');
  await del('DELETE FROM analytics_daily_cashier WHERE branch_id LIKE ?');
  await del('DELETE FROM analytics_daily_vat WHERE branch_id LIKE ?');
  await del('DELETE FROM ar_document_lines WHERE document_id LIKE ?');
  await del('DELETE FROM ar_documents WHERE id LIKE ?');
  await del('DELETE FROM sales_return_lines WHERE return_id LIKE ?');
  await del('DELETE FROM sales_returns WHERE id LIKE ?');
  await del('DELETE FROM menu WHERE id LIKE ?');
  await del('DELETE FROM branches WHERE id LIKE ?');
  await del('DELETE FROM brands WHERE id LIKE ?');
  await del('DELETE FROM users WHERE username LIKE ?', [likeUser]);
}

let lineSeq = 0, retSeq = 0;

const doc = (id, type, issueDate, t, x = {}) => db.query(
  `INSERT INTO ar_documents (id, document_number, document_type, source_type, source_id,
     brand_id, branch_id, issue_date, subtotal, discount_amount, vat_amount, total_amount,
     status, created_by)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  [id, id, type, x.sourceType || 'pos', null, x.brand || I.BRAND_A, x.branch || I.B1,
    issueDate, t.subtotal, t.discount || 0, t.vat, t.total, x.status || 'paid', I.CA1]);

/** menuId === null seeds a FREE-TEXT line — the shape the rollup used to drop. */
const line = (docId, menuId, qty, vat, a, x = {}) => db.query(
  `INSERT INTO ar_document_lines (id, document_id, source_line_id, menu_id, description,
     entered_qty, base_qty, unit_price, discount_amount, vat_category, vat_rate,
     net_amount, vat_amount, gross_amount, cost_snapshot, category_name_snapshot)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  [`${P}-L${++lineSeq}`, docId, x.srcLine || `L${lineSeq}`, menuId, x.desc || 'line',
    qty, qty, a.gross / (qty || 1), a.discount || 0, vat.cat, vat.rate,
    a.net, a.vat, a.gross, a.cost || 0, x.category !== undefined ? x.category : null]);

const ofact = (docId, branch, local, bday, x = {}) => db.query(
  `INSERT INTO analytics_order_facts
     (document_id, brand_id, branch_id, channel_id, order_type, source, guests, status,
      created_by, opened_at, closed_at, paid_at, occurred_at_local, business_day,
      tz_snapshot, discount_total, rounding_amount, tips_amount, fees_amount, provenance)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'live')`,
  [docId, x.brand || I.BRAND_A, branch, x.channel || null, x.orderType || 'dine_in',
    x.source || 'pos', x.guests != null ? x.guests : null, x.status || 'completed',
    x.by !== undefined ? x.by : I.CA1, local, local, local, local, bday,
    'Asia/Riyadh', x.discount || 0, 0, 0, 0]);

const pfact = (srcId, lineNo, docId, branch, dir, norm, amount, local, bday) => db.query(
  `INSERT INTO analytics_payment_facts
     (source_type, source_id, line_no, document_id, branch_id, brand_id, method_raw,
      method_norm, direction, amount, status, occurred_at, occurred_at_local,
      business_day, performed_by, provenance)
   VALUES ('pos_single',?,?,?,?,?,?,?,?,?,'captured',?,?,?,?,'live')`,
  [srcId, lineNo, docId, branch, I.BRAND_A, norm || 'raw', norm, dir, amount,
    local, local, bday, I.CA1]);

const ret = (id, branch, retDate, t, status) => db.query(
  `INSERT INTO sales_returns (id, return_number, original_sale_id, original_ar_document_id,
     brand_id, branch_id, return_date, reason_code, refund_method, subtotal, vat_amount,
     total_amount, status, created_by)
   VALUES (?,?,?,?,?,?,?,'quality','ar_reduction',?,?,?,?,?)`,
  [id, id, null, null, I.BRAND_A, branch, retDate, t.net, t.vat, t.total, status, I.CA1]);

const retLine = (retId, menuId, qty, vat, a) => db.query(
  `INSERT INTO sales_return_lines (id, return_id, menu_id, description, sold_qty,
     return_qty, base_qty, unit_price_snapshot, vat_category, vat_rate,
     net_amount, vat_amount, gross_amount, cost_snapshot)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  [`${P}-RL${++retSeq}`, retId, menuId, 'ret', qty, qty, qty, a.gross / (qty || 1),
    vat.cat, vat.rate, a.net, a.vat, a.gross, a.cost || 0]);

async function seed() {
  await analyticsSchema.apply(db);

  await db.query('INSERT INTO brands (id, name) VALUES (?,?)', [I.BRAND_A, 'RPAR Brand A']);
  await db.query('INSERT INTO brands (id, name) VALUES (?,?)', [I.BRAND_B, 'RPAR Brand B']);
  await db.query(
    "INSERT INTO branches (id, name, brand_id, timezone, day_close_time) VALUES (?,?,?,'Asia/Riyadh','04:00:00')",
    [I.B1, 'RPAR Branch 1', I.BRAND_A]);
  await db.query(
    "INSERT INTO branches (id, name, brand_id, timezone, day_close_time) VALUES (?,?,?,'Asia/Riyadh','04:00:00')",
    [I.B2, 'RPAR Branch 2', I.BRAND_B]);
  const menu = (id, name, price, cost, cat) => db.query(
    'INSERT INTO menu (id, name, price, cost, active, tax_category, is_tax_inclusive) VALUES (?,?,?,?,1,?,1)',
    [id, name, price, cost, cat]);
  await menu(I.M1, 'RPAR Burger', 57.5, 20, 'S');
  await menu(I.M2, 'RPAR Water', 20, 5, 'Z');
  await menu(I.M3, 'RPAR Juice', 20, 4, 'Z');

  // D1 — ordinary sale, two categories, an order-level discount.
  await doc(I.D1, 'invoice', '2024-06-10', { subtotal: 120, discount: 5, vat: 15, total: 135 });
  await line(I.D1, I.M1, 2, { cat: 'S', rate: 15 }, { net: 100, vat: 15, gross: 115, cost: 40, discount: 5 }, { category: 'Food' });
  await line(I.D1, I.M2, 1, { cat: 'Z', rate: 0 }, { net: 20, vat: 0, gross: 20, cost: 5 }, { category: 'Drinks' });
  await ofact(I.D1, I.B1, '2024-06-10 13:00:00', '2024-06-10', { guests: 2, discount: 5 });
  await pfact(I.D1, 0, I.D1, I.B1, 'in', 'cash', 135, '2024-06-10 13:00:00', '2024-06-10');

  // D2 — 01:30 LOCAL on a 04:00-close branch: business_day 06-09, calendar 06-10.
  //      This is the row that makes every calendar time dimension differ from
  //      business_day, which is why they may only be read off the HOURLY rollup.
  await doc(I.D2, 'invoice', '2024-06-09', { subtotal: 50, vat: 7.5, total: 57.5 });
  await line(I.D2, I.M1, 1, { cat: 'S', rate: 15 }, { net: 50, vat: 7.5, gross: 57.5, cost: 20 }, { category: 'Food' });
  await ofact(I.D2, I.B1, '2024-06-10 01:30:00', '2024-06-09', { by: I.CA2 });
  await pfact(I.D2, 0, I.D2, I.B1, 'in', 'card', 57.5, '2024-06-10 01:30:00', '2024-06-09');

  // D3 — brand B, a FREE-TEXT line (menu_id NULL) with a NULL vat_rate and a
  //      NULL category, sold by a NULL cashier and paid by a NULL method.
  await doc(I.D3, 'invoice', '2024-06-12', { subtotal: 30, vat: 4.5, total: 34.5 },
    { branch: I.B2, brand: I.BRAND_B });
  await line(I.D3, null, 1, { cat: 'S', rate: null }, { net: 30, vat: 4.5, gross: 34.5, cost: 0 },
    { desc: 'free text item' });
  await ofact(I.D3, I.B2, '2024-06-12 19:00:00', '2024-06-12', { brand: I.BRAND_B, by: null });
  await pfact(I.D3, 0, I.D3, I.B2, 'in', null, 34.5, '2024-06-12 19:00:00', '2024-06-12');

  // D4 — VOIDED, with a discount. Excluded by default; counted by voids_*.
  await doc(I.D4, 'invoice', '2024-06-13', { subtotal: 50, vat: 7.5, total: 57.5 });
  await line(I.D4, I.M1, 1, { cat: 'S', rate: 15 }, { net: 50, vat: 7.5, gross: 57.5, cost: 20 }, { category: 'Food' });
  await ofact(I.D4, I.B1, '2024-06-13 12:00:00', '2024-06-13', { status: 'voided', discount: 9 });

  // D5 — a payment whose method really IS 'other'. Beside D3's NULL method it
  //      proves the old NULL→'other' fold merged two distinct buckets.
  await doc(I.D5, 'invoice', '2024-06-14', { subtotal: 60, vat: 0, total: 60 });
  await line(I.D5, I.M3, 3, { cat: 'Z', rate: 0 }, { net: 60, vat: 0, gross: 60, cost: 12 }, { category: 'Drinks' });
  await ofact(I.D5, I.B1, '2024-06-14 12:00:00', '2024-06-14', { by: I.CA2 });
  await pfact(I.D5, 0, I.D5, I.B1, 'in', 'other', 60, '2024-06-14 12:00:00', '2024-06-14');

  // R1 — POSTED return on 06-20, a day with NO trade at B1: the returns-only
  //      row that used to make the rollup publish an all-zero sales group.
  //      Its credit note carries POSITIVE lines and its own order fact, exactly
  //      as SalesReturnService + ProjectionService write them.
  await ret(I.R1, I.B1, '2024-06-20', { net: 50, vat: 7.5, total: 57.5 }, 'posted');
  await retLine(I.R1, I.M1, 1, { cat: 'S', rate: 15 }, { net: 50, vat: 7.5, gross: 57.5, cost: 20 });
  await doc(I.CN1, 'credit_note', '2024-06-20', { subtotal: 50, vat: 7.5, total: 57.5 },
    { sourceType: 'manual', status: 'issued' });
  await line(I.CN1, I.M1, 1, { cat: 'S', rate: 15 }, { net: 50, vat: 7.5, gross: 57.5, cost: 20 }, { category: 'Food' });
  await ofact(I.CN1, I.B1, '2024-06-20 14:00:00', '2024-06-20', { source: 'sales_return' });
  await pfact(I.R1, 0, I.CN1, I.B1, 'out', 'other', 57.5, '2024-06-20 14:00:00', '2024-06-20');

  // R2 — CANCELLED return. The live `return` fact filters r.status='posted';
  //      the rollup builder did not, so this row is the one that used to show
  //      up in the rollup's returns figures and nowhere else.
  await ret(I.R2, I.B1, '2024-06-21', { net: 20, vat: 0, total: 20 }, 'cancelled');
  await retLine(I.R2, I.M3, 1, { cat: 'Z', rate: 0 }, { net: 20, vat: 0, gross: 20, cost: 4 });
}

// ── the comparison ───────────────────────────────────────────────────────────
const keyOf = (row, dims) => JSON.stringify(dims.map((d) => row.keys[d]));

/**
 * Run one request BOTH ways and compare everything the caller can see.
 * Returns the rollup envelope so a case can add its own assertions.
 */
async function parity(name, request) {
  const base = Object.assign({ range: RANGE, limit: 500, noCache: true }, request);
  const viaRollup = await QueryService.run(db, base, SCOPE);
  const viaLive = await QueryService.run(db, Object.assign({}, base, { noRollup: true }), SCOPE);
  const dims = base.dimensions || [];
  const metrics = base.metrics;

  // Preconditions FIRST: two live runs would agree trivially and prove nothing.
  const routed = check(`${name}: routed to a rollup`,
    viaRollup.meta.source === 'rollup', viaRollup.meta.rollup.blockers);
  check(`${name}: the control run really went live`, viaLive.meta.source === 'live');
  if (!routed) return viaRollup;

  const a = viaRollup.data.rows, b = viaLive.data.rows;
  const ka = a.map((r) => keyOf(r, dims)).sort();
  const kb = b.map((r) => keyOf(r, dims)).sort();
  check(`${name}: identical row KEY SET (${ka.length} rows)`,
    JSON.stringify(ka) === JSON.stringify(kb),
    { onlyRollup: ka.filter((k) => !kb.includes(k)), onlyLive: kb.filter((k) => !ka.includes(k)) });
  check(`${name}: the comparison is not vacuous (rows and money present)`,
    (dims.length === 0 || a.length > 0) &&
    metrics.some((m) => Number(viaRollup.data.totals.values[m]) !== 0));

  const bByKey = Object.fromEntries(b.map((r) => [keyOf(r, dims), r]));
  const diffs = [];
  for (const row of a) {
    const k = keyOf(row, dims);
    const other = bByKey[k];
    if (!other) continue; // already reported by the key-set check
    for (const m of metrics) {
      if (row.values[m] !== other.values[m]) {
        diffs.push({ key: k, metric: m, rollup: row.values[m], live: other.values[m] });
      }
    }
  }
  check(`${name}: EVERY metric on EVERY row is identical`, diffs.length === 0, diffs.slice(0, 6));

  const tDiffs = metrics.filter((m) =>
    viaRollup.data.totals.values[m] !== viaLive.data.totals.values[m]);
  check(`${name}: the grand total is identical`, tDiffs.length === 0,
    tDiffs.map((m) => ({ metric: m, rollup: viaRollup.data.totals.values[m], live: viaLive.data.totals.values[m] })));

  const norm = (env) => env.data.subtotals
    .map((s) => `${s.level}|${JSON.stringify(s.keys)}|${metrics.map((m) => s.values[m]).join(',')}`)
    .sort().join('\n');
  check(`${name}: every SUBTOTAL level is identical`, norm(viaRollup) === norm(viaLive),
    { rollup: norm(viaRollup).slice(0, 200), live: norm(viaLive).slice(0, 200) });

  // The envelope's own statement about which defaults were applied has to match
  // too — a response that claims it excluded voids when it did not is a false
  // statement about the population, even when the numbers agree.
  check(`${name}: meta.defaultsApplied matches the live path`,
    JSON.stringify([...viaRollup.meta.defaultsApplied].sort()) ===
    JSON.stringify([...viaLive.meta.defaultsApplied].sort()),
    { rollup: viaRollup.meta.defaultsApplied, live: viaLive.meta.defaultsApplied });

  return viaRollup;
}

/** Does any row carry a NULL for this dimension? Proves a sentinel really was
 *  mapped back to NULL, rather than both paths agreeing on an empty result. */
const hasNullKey = (env, dim) => env.data.rows.some((r) => r.keys[dim] === null);

(async () => {
  console.log('\n── analytics rollup parity ──');
  await cleanup();
  try {
    await seed();

    // ── build the rollups through the REAL service path ──────────────────────
    await RollupService.rebuildRange(db, { from: RANGE.from, to: RANGE.to, branchIds: [I.B1, I.B2] });
    let drained = { rebuilt: 0, failed: 0 };
    for (let i = 0; i < 50; i++) {
      const d = await RollupService.drainDirty(db, { limit: 200 });
      drained.rebuilt += d.rebuilt; drained.failed += d.failed;
      if (!d.claimed) break;
    }
    check('every dirty pair rebuilt without a failure', drained.failed === 0 && drained.rebuilt > 0, drained);

    // The rollup horizon is GLOBAL (min over analytics_rollup_dirty), so a
    // stale pair left by any other suite would push it before this window and
    // every case below would fall back to live. Say so plainly rather than
    // letting the preconditions fail one by one.
    const [[dirty]] = await db.query(
      'SELECT DATE_FORMAT(MIN(business_day), \'%Y-%m-%d\') mn, COUNT(*) n FROM analytics_rollup_dirty');
    check('the rollup horizon covers the test window',
      !dirty.n || dirty.mn > RANGE.to,
      { pendingPairs: dirty.n, oldestPendingDay: dirty.mn, windowEnd: RANGE.to });

    // ── structural invariant the brand mapping rests on ──────────────────────
    // daily_branch.brand_id is ONE column per (day, branch) read off the
    // non-void order facts. That is only sound while a (day, branch) pair
    // carries a single brand. Asserted over the WHOLE fact table, not just the
    // fixture — if this ever fails, `brand` must stop being routed.
    const [[mixed]] = await db.query(
      `SELECT COUNT(*) n FROM (
         SELECT business_day, branch_id FROM analytics_order_facts
          WHERE (status IS NULL OR status <> 'voided')
          GROUP BY business_day, branch_id
         HAVING COUNT(DISTINCT brand_id) > 1) x`);
    check('no (business_day, branch) pair carries two brands — the brand mapping\'s premise',
      Number(mixed.n) === 0, mixed);

    // ── 1. items, including the free-text line the rollup used to drop ───────
    const items = await parity('items by menu_item', {
      metrics: ['net_ex_vat', 'qty_sold', 'gross_product_sales', 'discounts_line'],
      dimensions: ['menu_item'],
    });
    check('a FREE-TEXT line appears as a NULL menu_item group, not as a dropped row',
      hasNullKey(items, 'menu_item'), items.data.rows.map((r) => r.keys.menu_item));

    await parity('category × menu_item pivot', {
      metrics: ['net_ex_vat', 'qty_sold', 'gross_product_sales'],
      dimensions: ['category', 'menu_item'],
    });

    await parity('items by branch × menu_item', {
      metrics: ['net_ex_vat', 'qty_sold', 'cogs', 'margin_pct'],
      dimensions: ['branch', 'menu_item'],
    });

    // ── 2. cashier, including the NULL cashier ───────────────────────────────
    const cash = await parity('cashier table', {
      metrics: ['orders', 'net_ex_vat', 'discounts_total', 'avg_ticket'],
      dimensions: ['cashier'],
    });
    check('a NULL created_by appears as a NULL cashier group',
      hasNullKey(cash, 'cashier'), cash.data.rows.map((r) => r.keys.cashier));

    // The void-lifted population: `orders` here is the denominator live computes
    // with the void exclusion DROPPED, so it must count the voided order too.
    await parity('cashier × day rates (void exclusion lifted)', {
      metrics: ['orders', 'discounted_orders', 'voids_count',
        'discount_rate_by_cashier', 'void_rate_by_cashier'],
      dimensions: ['cashier', 'business_day'],
    });

    // ── 3. brand ─────────────────────────────────────────────────────────────
    await parity('brand × branch × business_day', {
      metrics: ['net_ex_vat', 'orders', 'qty_sold', 'invoice_total'],
      dimensions: ['brand', 'branch', 'business_day'],
    });

    // ── 4. calendar time dimensions off the hourly rollup ────────────────────
    // D2 is booked to business_day 06-09 but occurred on calendar 06-10, so
    // these answers are only right if the rollup carries the LOCAL date. A
    // rollup that derived them from business_day would put D2 in the wrong
    // week/weekday and this comparison is what would catch it.
    await parity('weekday × hour heatmap', {
      metrics: ['orders', 'net_ex_vat'], dimensions: ['weekday', 'hour'],
    });
    await parity('calendar_day trend', {
      metrics: ['orders', 'net_ex_vat', 'guests'], dimensions: ['calendar_day'],
    });
    await parity('week trend', { metrics: ['orders', 'net_ex_vat'], dimensions: ['week'] });
    await parity('month × branch', {
      metrics: ['orders', 'net_ex_vat'], dimensions: ['month', 'branch'],
    });
    await parity('half_hour trend', { metrics: ['orders', 'net_ex_vat'], dimensions: ['half_hour'] });

    // Belt and braces on the point of the exercise: business_day and
    // calendar_day must NOT produce the same grouping on this fixture, or the
    // five comparisons above would be blind to the very error they exist for.
    const bd = await QueryService.run(db, {
      metrics: ['net_ex_vat'], dimensions: ['business_day'], range: RANGE, limit: 500, noCache: true,
    }, SCOPE);
    const cd = await QueryService.run(db, {
      metrics: ['net_ex_vat'], dimensions: ['calendar_day'], range: RANGE, limit: 500, noCache: true,
    }, SCOPE);
    check('the fixture really does separate business_day from calendar_day',
      JSON.stringify(bd.data.rows.map((r) => r.keys.business_day).sort()) !==
      JSON.stringify(cd.data.rows.map((r) => r.keys.calendar_day).sort()),
      { business: bd.data.rows.map((r) => r.keys.business_day), calendar: cd.data.rows.map((r) => r.keys.calendar_day) });

    // ── 5. VAT, including the NULL rate and the posted-only returns ──────────
    const vat = await parity('taxes by vat_category × vat_rate', {
      metrics: ['net_ex_vat', 'vat_amount', 'returns_net', 'returns_vat', 'net_vat'],
      dimensions: ['vat_category', 'vat_rate'],
    });
    check('a NULL vat_rate appears as a NULL group (the -1 sentinel is mapped back)',
      hasNullKey(vat, 'vat_rate'), vat.data.rows.map((r) => r.keys.vat_rate));

    // ── 6. payments: the NULL method and the real 'other' stay distinct ──────
    const pay = await parity('payment mix by method', {
      metrics: ['payments_in', 'refunds_out', 'net_collections'],
      dimensions: ['payment_method'],
    });
    check('a NULL method_norm is its own group, NOT folded into the real \'other\'',
      hasNullKey(pay, 'payment_method') &&
      pay.data.rows.some((r) => r.keys.payment_method === 'other'),
      pay.data.rows.map((r) => ({ m: r.keys.payment_method, in: r.values.payments_in })));

    await parity('payment method × day × branch', {
      metrics: ['payments_in', 'refunds_out'],
      dimensions: ['payment_method', 'business_day', 'branch'],
    });

    // ── 7. discounts, returns and voids on the daily rollup ──────────────────
    await parity('discounts by day', {
      metrics: ['discounts_total', 'discounted_orders', 'discount_pct'],
      dimensions: ['business_day'],
    });

    // Every order-fact metric here is itself a voids_* metric, so live keeps the
    // voided rows in and the rollup's voids columns are the same population.
    const rv = await parity('returns & voids by branch', {
      metrics: ['returns_value', 'returns_net', 'returns_count', 'qty_returned',
        'voids_count', 'voids_value'],
      dimensions: ['branch'],
    });
    check('the CANCELLED return is invisible on BOTH paths (r.status = posted)',
      Number(rv.data.totals.values.returns_count) === 1 &&
      Number(rv.data.totals.values.returns_net) === 50,
      rv.data.totals.values);

    // orders + voids_count: `orders` is void-INCLUSIVE here, so the rollup must
    // answer orders + voids_count, not its void-excluded orders column.
    const ov = await parity('orders beside voids_count (void-inclusive orders)', {
      metrics: ['orders', 'voids_count', 'invoice_total'], dimensions: ['branch'],
    });
    check('the void-inclusive order count really does include the voided order',
      Number(ov.data.totals.values.orders) === 5 && Number(ov.data.totals.values.voids_count) === 1,
      ov.data.totals.values);

    // ── 8. the returns-only day: presence, not a fabricated zero ─────────────
    // 2024-06-20 has a posted return at B1 and NO trade. A sales report by day
    // must not show a row for it — the live path emits none, so the rollup may
    // not invent one.
    const sales = await parity('sales by day (no fabricated zero row)', {
      metrics: ['net_ex_vat', 'orders', 'invoice_total', 'avg_ticket'],
      dimensions: ['business_day'],
    });
    check('the returns-only day is absent from a SALES report, on both paths',
      !sales.data.rows.some((r) => r.keys.business_day === '2024-06-20'),
      sales.data.rows.map((r) => r.keys.business_day));
    // …and present when the returns metric is the one being asked for.
    const retDays = await parity('returns by day', {
      metrics: ['returns_net', 'returns_count'], dimensions: ['business_day'],
    });
    check('…and the SAME day IS present when returns are what was asked for',
      retDays.data.rows.some((r) => r.keys.business_day === '2024-06-20'),
      retDays.data.rows.map((r) => r.keys.business_day));

    // ── 9. filters ride the same expressions as the grouping ────────────────
    await parity('filtered: a menu_item IN filter on the rollup', {
      metrics: ['net_ex_vat', 'qty_sold'], dimensions: ['business_day'],
      filters: [{ dimension: 'menu_item', op: 'in', values: [I.M1, I.M3] }],
    });
    await parity('filtered: a NOT_IN filter must keep the NULL group', {
      metrics: ['net_ex_vat', 'qty_sold'], dimensions: ['menu_item'],
      filters: [{ dimension: 'menu_item', op: 'not_in', values: [I.M2] }],
    });

    // ── 10. dimensionless totals ─────────────────────────────────────────────
    await parity('executive KPIs (no grouping)', {
      metrics: ['net_ex_vat', 'orders', 'invoice_total', 'discounts_total',
        'payments_in', 'refunds_out', 'avg_ticket', 'gross_profit'],
    });
  } finally {
    await cleanup();
    try { await db.end(); } catch (_) { /* pool may already be closed */ }
  }

  console.log(`\nAnalytics rollup parity: ${pass}/${pass + fail} passed, ${fail} failed`);
  if (fail) { console.log('failed:'); for (const f of failures) console.log('  · ' + f); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(2); });
