/**
 * services/analytics/RollupService.js — rebuilds the analytics rollup tables
 * (analytics_daily_branch / analytics_daily_item / analytics_daily_payment /
 * analytics_hourly_branch / analytics_daily_cashier / analytics_daily_vat)
 * from the fact tables, one (branch_id, business_day) pair at a time, driven by
 * the analytics_rollup_dirty queue that ProjectionService._enqueueDirty fills
 * after every projection.
 *
 * PARITY CONTRACT (tests/integration/analyticsRollupParity.api.test.js): every
 * rollup number must equal what the LIVE planner/QueryService path computes for
 * the same slice, including the planner's DEFAULT filters:
 *
 *   excluded_voided       — order/line-derived columns (orders, guests,
 *     discounts, invoice_total, rounding, tips, fees, gross_product,
 *     net_ex_vat, vat, cogs, hourly orders/net/guests, daily_item sales
 *     columns) skip rows with f.status = 'voided'. voids_count is the ONE
 *     column computed FROM the voided rows (mirroring how the planner drops
 *     the excluded_voided default on statements that compute voids_*).
 *   excluded_credit_note_docs — every order/line-derived column skips fact
 *     rows whose f.source IS 'sales_return'/'credit_note' (the CN's own
 *     projected order fact + its POSITIVE ar_document_lines would otherwise
 *     double-count returned money). Returns are measured ONLY by:
 *       returns_net  ← SUM(rl.net_amount)  on sales_return_lines⋈sales_returns
 *       qty_returned ← SUM(rl.base_qty)    (same fact)
 *     keyed by r.return_date (the return fact's business_day basis — the
 *     registry documents that sales_returns has no local timestamp), and
 *       refunds_amount ← SUM(amount) of direction='out' payment facts
 *     keyed by p.business_day (the CN/refund day, never the sale's day).
 *     Every return read applies `r.status = 'posted'`, because the live
 *     `return` fact's FROM does (registry/facts.js). This file's header used to
 *     assert the opposite and the code matched the assertion; the predicate was
 *     added to the fact afterwards, and from that moment the rollup's returns
 *     columns counted drafts and cancellations the live path did not.
 *   gross_profit = net_ex_vat − cogs (equations.grossProfit, additive form).
 *   The order fact keeps its `JOIN ar_documents doc` exactly like the
 *     registry FROM — an order fact whose document row is missing counts
 *     nowhere, same as live.
 *
 * NULLABLE GROUPING COLUMNS vs NOT-NULL PK PARTS. A rollup key part cannot be
 * NULL, and the two places that used to be papered over were the only reason
 * item and payment-method reporting could not be routed at all:
 *   - daily_item stores menu_id NULL (a free-text line) as '' instead of
 *     SKIPPING the line;
 *   - daily_payment stores method_norm NULL as '' instead of FOLDING it into
 *     'other' (which is itself a real method value, so the fold both invented a
 *     bucket and merged two);
 *   - daily_cashier stores created_by NULL as '', daily_vat stores vat_rate
 *     NULL as -1.
 * The planner maps every one of them back with NULLIF(<col>, <sentinel>), so
 * the wire value is NULL exactly where live's is. See ROLLUP_SOURCES.
 *
 * PRESENCE COLUMNS (line_rows / return_lines / returns_count) are NOT metrics.
 * The live path emits a group only where the fact statement that owns the
 * metric returned a row; a rollup row exists as soon as ANY writer touched the
 * (day, branch) pair. Without these counts a day with a return but no trade
 * would publish an all-zero sales row that live never shows. The planner turns
 * them into a WHERE clause chosen from the requested metrics.
 *
 * CONCURRENCY: drainDirty claims pairs with SELECT … FOR UPDATE SKIP LOCKED
 * inside a claim transaction held for the whole batch (zatca-worker pattern):
 * concurrent workers skip each other's rows; each pair is rebuilt in its OWN
 * transaction (DELETE pair scope + INSERT…SELECT, atomic per pair) and its
 * dirty row is deleted on the claim connection only after the rebuild commits
 * — a crash re-queues nothing and loses nothing (rebuild is idempotent).
 * On MySQL versions that reject SKIP LOCKED the service detects the syntax
 * error ONCE, remembers, and falls back to claim-by-DELETE (re-enqueueing the
 * pair on rebuild failure).
 *
 * Every function takes `db` (pool) as its first argument, like every other
 * service in this codebase. No module-level DB require.
 */
'use strict';

const ProjectionService = require('./ProjectionService');
const freshness = require('../../lib/analytics/freshness');

const MAX_REPAIR_ATTEMPTS = 10;
const MAX_REBUILD_RANGE_DAYS = 400; // planner's MAX_RANGE_DAYS — same guardrail

// null = unknown, true/false once detected (per process, like zatca-worker).
let _skipLockedSupported = null;

// ── small helpers ────────────────────────────────────────────────────────────

/** mysql2 (timezone '+03:00') returns DATE as a shifted JS Date — recover the
 *  wall-clock 'YYYY-MM-DD' (same trick as QueryService.normDimValue). */
function _dbOffsetMinutes(db) {
  const tz = (db && db.DB_TIME_ZONE) || '+03:00';
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(String(tz));
  if (!m) return 180;
  const min = (+m[2]) * 60 + (+m[3]);
  return m[1] === '-' ? -min : min;
}

function _dayStr(v, offsetMin) {
  if (v == null) return null;
  if (v instanceof Date) {
    return new Date(v.getTime() + (offsetMin || 0) * 60000).toISOString().slice(0, 10);
  }
  return String(v).slice(0, 10);
}

function _isIsoDay(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

/** Run fn inside a transaction — reuse the pool's deadlock-aware
 *  withTransaction when present, else a plain BEGIN/COMMIT wrapper. */
async function _inTx(db, fn) {
  if (typeof db.withTransaction === 'function') return db.withTransaction(fn);
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (e) {
    try { await conn.rollback(); } catch (_) { /* already gone */ }
    throw e;
  } finally {
    try { conn.release(); } catch (_) { /* never throw from cleanup */ }
  }
}

function _isSyntaxError(e) {
  return !!e && (e.code === 'ER_PARSE_ERROR' || e.errno === 1064);
}

// ── pair rebuild (the parity-critical SQL) ───────────────────────────────────

// Planner default filters, verbatim semantics (lib/analytics/planner.js).
const NOT_VOID = "(f.status IS NULL OR f.status <> 'voided')";
const NOT_CN = "(f.source IS NULL OR f.source NOT IN ('sales_return','credit_note'))";
// half_hour registry expression on the order fact's local timestamp.
const SLOT30 = '(HOUR(f.occurred_at_local) * 2 + FLOOR(MINUTE(f.occurred_at_local) / 30))';
// The live `return` fact's FROM carries `AND r.status = 'posted'`
// (registry/facts.js) — a draft or cancelled return moved no goods and no
// money, and counting one inflates every returns figure and every profit
// figure net of returns. This module used to say, in its own header, that the
// registry had no status filter; that stopped being true when the predicate was
// added to the fact, and the rollup's returns_net silently drifted from live by
// every unposted return. Kept in ONE constant so the two cannot diverge again.
const RETURN_POSTED = "r.status = 'posted'";
// menu_id / created_by are NULLABLE on their source columns but are PK parts
// here, and a PK part cannot be NULL. '' is the stored stand-in; the planner
// maps it back with NULLIF(<col>, ''), which reproduces live's NULL group
// exactly. The sentinel is safe because '' is not a reachable id: menu.id and
// users.username are keys of their own tables.
const MENU_KEY = "COALESCE(d.menu_id, '')";
const RET_MENU_KEY = "COALESCE(rl.menu_id, '')";
const CASHIER_KEY = "COALESCE(f.created_by, '')";
// Same idea for a NULLABLE DECIMAL: -1 is not a reachable VAT rate.
const VAT_RATE_KEY = 'COALESCE(d.vat_rate, -1)';
const RET_VAT_RATE_KEY = 'COALESCE(rl.vat_rate, -1)';

/**
 * Recompute every rollup table for ONE (branchId, 'YYYY-MM-DD') pair.
 * Runs on the caller's connection — call inside a transaction (_inTx).
 *
 * GRAIN AMBIGUITY IS A HARD ERROR, ON PURPOSE. Two of these tables now carry a
 * column that the live path derives per ROW rather than per rollup key —
 * analytics_hourly_branch.calendar_day and analytics_daily_item.category_name.
 * Both are part of their INSERT's GROUP BY, so if a single rollup key ever
 * spans two of those values the statement collides on the primary key and the
 * pair's rebuild throws. That leaves the pair in analytics_rollup_dirty, which
 * pins the rollup horizon (QueryService.readRollupHorizon) at the day before —
 * so the affected day, and everything after it, is answered LIVE until a human
 * looks. Loud and slow beats a MAX() that silently merges two groups the live
 * path keeps apart.
 */
async function _rebuildPair(conn, branchId, day) {
  const P = [day, branchId];

  await conn.query('DELETE FROM analytics_daily_branch  WHERE business_day = ? AND branch_id = ?', P);
  await conn.query('DELETE FROM analytics_daily_item    WHERE business_day = ? AND branch_id = ?', P);
  await conn.query('DELETE FROM analytics_daily_payment WHERE business_day = ? AND branch_id = ?', P);
  await conn.query('DELETE FROM analytics_hourly_branch WHERE business_day = ? AND branch_id = ?', P);
  await conn.query('DELETE FROM analytics_daily_cashier WHERE business_day = ? AND branch_id = ?', P);
  await conn.query('DELETE FROM analytics_daily_vat     WHERE business_day = ? AND branch_id = ?', P);

  // ── analytics_daily_branch ──
  // 1a. order-fact columns. The scan keeps voided rows (voids_count/voids_value
  //     need them) and applies excluded_voided per column via CASE; CN-source
  //     docs are excluded outright (they contribute to NO daily_branch column —
  //     their money lives in returns_* / refunds_amount).
  //
  //     brand_id is read off the NON-VOID rows only, because that is the
  //     population a brand-grouped report sees. It is a per-sale denormalization
  //     of the branch's brand (ProjectionService writes sales.brand_id), so a
  //     (day, branch) pair carries one brand; the parity test asserts that over
  //     the whole fact table rather than leaving it as an assumption.
  await conn.query(
    `INSERT INTO analytics_daily_branch
       (business_day, brand_id, branch_id, orders, guests, discounts, invoice_total,
        rounding, tips, fees, voids_count, voids_value, discounted_orders)
     SELECT f.business_day, MAX(CASE WHEN ${NOT_VOID} THEN f.brand_id END), f.branch_id,
            SUM(CASE WHEN ${NOT_VOID} THEN 1 ELSE 0 END),
            SUM(CASE WHEN ${NOT_VOID} THEN COALESCE(f.guests, 0) ELSE 0 END),
            SUM(CASE WHEN ${NOT_VOID} THEN COALESCE(f.discount_total, 0) ELSE 0 END),
            SUM(CASE WHEN ${NOT_VOID} THEN COALESCE(doc.total_amount, 0) ELSE 0 END),
            SUM(CASE WHEN ${NOT_VOID} THEN COALESCE(f.rounding_amount, 0) ELSE 0 END),
            SUM(CASE WHEN ${NOT_VOID} THEN COALESCE(f.tips_amount, 0) ELSE 0 END),
            SUM(CASE WHEN ${NOT_VOID} THEN COALESCE(f.fees_amount, 0) ELSE 0 END),
            SUM(CASE WHEN f.status = 'voided' THEN 1 ELSE 0 END),
            SUM(CASE WHEN f.status = 'voided' THEN COALESCE(doc.total_amount, 0) ELSE 0 END),
            SUM(CASE WHEN ${NOT_VOID} AND f.discount_total > 0 THEN 1 ELSE 0 END)
       FROM analytics_order_facts f
       JOIN ar_documents doc ON doc.id = f.document_id
      WHERE f.business_day = ? AND f.branch_id = ? AND ${NOT_CN}
      GROUP BY f.business_day, f.branch_id`, P);

  // 1b. line-fact money (gross/net/vat/cogs + gross_profit = net − cogs).
  //     line_rows is the PRESENCE signal, not a metric: the live merge emits a
  //     group only where the fact statement returned a row, and the planner
  //     turns this count into that same existence test.
  await conn.query(
    `INSERT INTO analytics_daily_branch
       (business_day, brand_id, branch_id, gross_product, net_ex_vat, vat, cogs, gross_profit,
        qty_sold, line_rows)
     SELECT f.business_day, MAX(f.brand_id), f.branch_id,
            COALESCE(SUM(d.gross_amount), 0),
            COALESCE(SUM(d.net_amount), 0),
            COALESCE(SUM(d.vat_amount), 0),
            COALESCE(SUM(d.cost_snapshot), 0),
            COALESCE(SUM(d.net_amount), 0) - COALESCE(SUM(d.cost_snapshot), 0),
            COALESCE(SUM(d.base_qty), 0), COUNT(*)
       FROM ar_document_lines d
       JOIN ar_documents doc ON doc.id = d.document_id
       JOIN analytics_order_facts f ON f.document_id = doc.id
      WHERE f.business_day = ? AND f.branch_id = ? AND ${NOT_VOID} AND ${NOT_CN}
      GROUP BY f.business_day, f.branch_id
     ON DUPLICATE KEY UPDATE
       gross_product = VALUES(gross_product), net_ex_vat = VALUES(net_ex_vat),
       vat = VALUES(vat), cogs = VALUES(cogs), gross_profit = VALUES(gross_profit),
       qty_sold = VALUES(qty_sold), line_rows = VALUES(line_rows)`, P);

  // 1c. the return fact (r.return_date IS its business day), POSTED only —
  //     see RETURN_POSTED. returns_count is COUNT(DISTINCT r.id) and stays
  //     additive across days/branches because a return has exactly one of each.
  await conn.query(
    `INSERT INTO analytics_daily_branch
       (business_day, branch_id, returns_net, returns_value, returns_vat, returns_cogs,
        returns_count, qty_returned, return_lines)
     SELECT r.return_date, r.branch_id,
            COALESCE(SUM(rl.net_amount), 0),
            COALESCE(SUM(rl.gross_amount), 0),
            COALESCE(SUM(rl.vat_amount), 0),
            COALESCE(SUM(rl.cost_snapshot), 0),
            COUNT(DISTINCT r.id),
            COALESCE(SUM(rl.base_qty), 0),
            COUNT(*)
       FROM sales_return_lines rl
       JOIN sales_returns r ON r.id = rl.return_id AND ${RETURN_POSTED}
      WHERE r.return_date = ? AND r.branch_id = ?
      GROUP BY r.return_date, r.branch_id
     ON DUPLICATE KEY UPDATE
       returns_net = VALUES(returns_net), returns_value = VALUES(returns_value),
       returns_vat = VALUES(returns_vat), returns_cogs = VALUES(returns_cogs),
       returns_count = VALUES(returns_count), qty_returned = VALUES(qty_returned),
       return_lines = VALUES(return_lines)`, P);

  // 1d. refunds_amount from direction='out' payment facts (refunds_out).
  await conn.query(
    `INSERT INTO analytics_daily_branch (business_day, branch_id, refunds_amount)
     SELECT p.business_day, p.branch_id,
            COALESCE(SUM(CASE WHEN p.direction = 'out' THEN p.amount ELSE 0 END), 0)
       FROM analytics_payment_facts p
      WHERE p.business_day = ? AND p.branch_id = ?
      GROUP BY p.business_day, p.branch_id
     ON DUPLICATE KEY UPDATE refunds_amount = VALUES(refunds_amount)`, P);

  // ── analytics_daily_item ──
  // 2a. sales side (lines of non-voided, non-CN docs).
  //     menu_id NULL (a free-text line) is stored as '' rather than skipped —
  //     the live path puts those lines in a NULL group, so dropping them made
  //     the rollup's item totals differ from live's the moment one existed.
  //     category_name is a GROUP BY key: see the ambiguity note on this
  //     function.
  await conn.query(
    `INSERT INTO analytics_daily_item
       (business_day, branch_id, menu_id, category_id_snapshot, category_name,
        qty_sold, gross, discount_alloc, net_ex_vat, vat, cogs, line_rows)
     SELECT f.business_day, f.branch_id, ${MENU_KEY}, MAX(d.category_id_snapshot),
            d.category_name_snapshot,
            COALESCE(SUM(d.base_qty), 0),
            COALESCE(SUM(d.gross_amount), 0),
            COALESCE(SUM(d.discount_amount), 0),
            COALESCE(SUM(d.net_amount), 0),
            COALESCE(SUM(d.vat_amount), 0),
            COALESCE(SUM(d.cost_snapshot), 0),
            COUNT(*)
       FROM ar_document_lines d
       JOIN ar_documents doc ON doc.id = d.document_id
       JOIN analytics_order_facts f ON f.document_id = doc.id
      WHERE f.business_day = ? AND f.branch_id = ? AND ${NOT_VOID} AND ${NOT_CN}
      GROUP BY f.business_day, f.branch_id, ${MENU_KEY}, d.category_name_snapshot`, P);

  // 2b. qty_returned from POSTED return lines on the RETURN's day (a menu item
  //     can appear return-only on a day — the row is created with sales zeros,
  //     and line_rows = 0 keeps it out of every sales-metric answer).
  await conn.query(
    `INSERT INTO analytics_daily_item
       (business_day, branch_id, menu_id, qty_returned, return_lines)
     SELECT r.return_date, r.branch_id, ${RET_MENU_KEY},
            COALESCE(SUM(rl.base_qty), 0), COUNT(*)
       FROM sales_return_lines rl
       JOIN sales_returns r ON r.id = rl.return_id AND ${RETURN_POSTED}
      WHERE r.return_date = ? AND r.branch_id = ?
      GROUP BY r.return_date, r.branch_id, ${RET_MENU_KEY}
     ON DUPLICATE KEY UPDATE
       qty_returned = VALUES(qty_returned), return_lines = VALUES(return_lines)`, P);

  // ── analytics_daily_payment ── (all directions, all statuses — same
  // population the live payment fact exposes).
  // method_norm NULL is stored as '' and mapped back with NULLIF, NOT folded
  // into 'other': 'other' is itself a real method_norm value, so the fold both
  // invented a bucket live never shows AND merged two buckets live keeps apart.
  await conn.query(
    `INSERT INTO analytics_daily_payment
       (business_day, branch_id, method_norm, direction, amount, tx_count)
     SELECT p.business_day, p.branch_id, COALESCE(p.method_norm, ''), p.direction,
            COALESCE(SUM(p.amount), 0), COUNT(*)
       FROM analytics_payment_facts p
      WHERE p.business_day = ? AND p.branch_id = ?
      GROUP BY p.business_day, p.branch_id, COALESCE(p.method_norm, ''), p.direction`, P);

  // ── analytics_hourly_branch ── (slot30 buckets of the order fact's local
  // timestamp; voided + CN rows fully excluded — hourly has no voids column).
  // calendar_day = DATE(f.occurred_at_local) for the slot, and it is a GROUP BY
  // key so an ambiguous slot fails the pair rather than picking one date.
  await conn.query(
    `INSERT INTO analytics_hourly_branch
       (business_day, branch_id, slot30, calendar_day, orders, guests)
     SELECT f.business_day, f.branch_id, ${SLOT30}, DATE(f.occurred_at_local),
            COUNT(*), SUM(COALESCE(f.guests, 0))
       FROM analytics_order_facts f
       JOIN ar_documents doc ON doc.id = f.document_id
      WHERE f.business_day = ? AND f.branch_id = ? AND ${NOT_VOID} AND ${NOT_CN}
      GROUP BY f.business_day, f.branch_id, ${SLOT30}, DATE(f.occurred_at_local)`, P);

  await conn.query(
    `INSERT INTO analytics_hourly_branch
       (business_day, branch_id, slot30, calendar_day, net_ex_vat, line_rows)
     SELECT f.business_day, f.branch_id, ${SLOT30}, DATE(f.occurred_at_local),
            COALESCE(SUM(d.net_amount), 0), COUNT(*)
       FROM ar_document_lines d
       JOIN ar_documents doc ON doc.id = d.document_id
       JOIN analytics_order_facts f ON f.document_id = doc.id
      WHERE f.business_day = ? AND f.branch_id = ? AND ${NOT_VOID} AND ${NOT_CN}
      GROUP BY f.business_day, f.branch_id, ${SLOT30}, DATE(f.occurred_at_local)
     ON DUPLICATE KEY UPDATE net_ex_vat = VALUES(net_ex_vat), line_rows = VALUES(line_rows)`, P);

  // ── analytics_daily_cashier ── (grain: the order fact's created_by)
  // 3a. order-fact columns, BOTH populations. The void-excluded columns are the
  //     ordinary ones; voided_orders / voided_discounted_orders / voids_value
  //     are their voided twins, and the planner adds the pair together when a
  //     voids_* metric has lifted the exclusion for the whole statement.
  await conn.query(
    `INSERT INTO analytics_daily_cashier
       (business_day, branch_id, cashier, orders, voided_orders, discounted_orders,
        voided_discounted_orders, guests, discounts, invoice_total, voids_value)
     SELECT f.business_day, f.branch_id, ${CASHIER_KEY},
            SUM(CASE WHEN ${NOT_VOID} THEN 1 ELSE 0 END),
            SUM(CASE WHEN f.status = 'voided' THEN 1 ELSE 0 END),
            SUM(CASE WHEN ${NOT_VOID} AND f.discount_total > 0 THEN 1 ELSE 0 END),
            SUM(CASE WHEN f.status = 'voided' AND f.discount_total > 0 THEN 1 ELSE 0 END),
            SUM(CASE WHEN ${NOT_VOID} THEN COALESCE(f.guests, 0) ELSE 0 END),
            SUM(CASE WHEN ${NOT_VOID} THEN COALESCE(f.discount_total, 0) ELSE 0 END),
            SUM(CASE WHEN ${NOT_VOID} THEN COALESCE(doc.total_amount, 0) ELSE 0 END),
            SUM(CASE WHEN f.status = 'voided' THEN COALESCE(doc.total_amount, 0) ELSE 0 END)
       FROM analytics_order_facts f
       JOIN ar_documents doc ON doc.id = f.document_id
      WHERE f.business_day = ? AND f.branch_id = ? AND ${NOT_CN}
      GROUP BY f.business_day, f.branch_id, ${CASHIER_KEY}`, P);

  // 3b. line-fact money for the same cashier (the line fact's `cashier`
  //     dimension is the SAME column, f.created_by — registry/dimensions.js).
  await conn.query(
    `INSERT INTO analytics_daily_cashier
       (business_day, branch_id, cashier, gross_product, net_ex_vat, vat, cogs,
        qty_sold, line_rows)
     SELECT f.business_day, f.branch_id, ${CASHIER_KEY},
            COALESCE(SUM(d.gross_amount), 0),
            COALESCE(SUM(d.net_amount), 0),
            COALESCE(SUM(d.vat_amount), 0),
            COALESCE(SUM(d.cost_snapshot), 0),
            COALESCE(SUM(d.base_qty), 0), COUNT(*)
       FROM ar_document_lines d
       JOIN ar_documents doc ON doc.id = d.document_id
       JOIN analytics_order_facts f ON f.document_id = doc.id
      WHERE f.business_day = ? AND f.branch_id = ? AND ${NOT_VOID} AND ${NOT_CN}
      GROUP BY f.business_day, f.branch_id, ${CASHIER_KEY}
     ON DUPLICATE KEY UPDATE
       gross_product = VALUES(gross_product), net_ex_vat = VALUES(net_ex_vat),
       vat = VALUES(vat), cogs = VALUES(cogs), qty_sold = VALUES(qty_sold),
       line_rows = VALUES(line_rows)`, P);

  // ── analytics_daily_vat ── (grain: the STORED vat_category × vat_rate)
  // 4a. sales side.
  await conn.query(
    `INSERT INTO analytics_daily_vat
       (business_day, branch_id, vat_category, vat_rate, line_rows, qty_sold,
        gross, discount_alloc, net_ex_vat, vat, cogs)
     SELECT f.business_day, f.branch_id, d.vat_category, ${VAT_RATE_KEY},
            COUNT(*), COALESCE(SUM(d.base_qty), 0),
            COALESCE(SUM(d.gross_amount), 0),
            COALESCE(SUM(d.discount_amount), 0),
            COALESCE(SUM(d.net_amount), 0),
            COALESCE(SUM(d.vat_amount), 0),
            COALESCE(SUM(d.cost_snapshot), 0)
       FROM ar_document_lines d
       JOIN ar_documents doc ON doc.id = d.document_id
       JOIN analytics_order_facts f ON f.document_id = doc.id
      WHERE f.business_day = ? AND f.branch_id = ? AND ${NOT_VOID} AND ${NOT_CN}
      GROUP BY f.business_day, f.branch_id, d.vat_category, ${VAT_RATE_KEY}`, P);

  // 4b. return side, POSTED only, keyed on the RETURN LINE's own vat columns.
  await conn.query(
    `INSERT INTO analytics_daily_vat
       (business_day, branch_id, vat_category, vat_rate, return_lines,
        returns_net, returns_vat, returns_value, returns_cogs, qty_returned)
     SELECT r.return_date, r.branch_id, rl.vat_category, ${RET_VAT_RATE_KEY},
            COUNT(*),
            COALESCE(SUM(rl.net_amount), 0),
            COALESCE(SUM(rl.vat_amount), 0),
            COALESCE(SUM(rl.gross_amount), 0),
            COALESCE(SUM(rl.cost_snapshot), 0),
            COALESCE(SUM(rl.base_qty), 0)
       FROM sales_return_lines rl
       JOIN sales_returns r ON r.id = rl.return_id AND ${RETURN_POSTED}
      WHERE r.return_date = ? AND r.branch_id = ?
      GROUP BY r.return_date, r.branch_id, rl.vat_category, ${RET_VAT_RATE_KEY}
     ON DUPLICATE KEY UPDATE
       return_lines = VALUES(return_lines), returns_net = VALUES(returns_net),
       returns_vat = VALUES(returns_vat), returns_value = VALUES(returns_value),
       returns_cogs = VALUES(returns_cogs), qty_returned = VALUES(qty_returned)`, P);
}

async function _advanceWatermark(db) {
  await db.query(
    `INSERT INTO analytics_rollup_state (k, v) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE v = VALUES(v)`,
    [freshness.WATERMARK_KEY, new Date().toISOString()]);
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Claim up to `limit` dirty (branch_id, business_day) pairs and rebuild all 4
 * rollup tables for each. Returns { claimed, rebuilt, failed, mode }.
 * Watermark advances only when nothing in the batch failed (an empty batch
 * counts — the queue being drained IS freshness).
 */
async function drainDirty(db, opts = {}) {
  const limit = Math.min(Math.max(1, Number(opts.limit) || 50), 500);
  const offsetMin = _dbOffsetMinutes(db);
  const out = { claimed: 0, rebuilt: 0, failed: 0, mode: null };

  if (_skipLockedSupported !== false) {
    const conn = await db.getConnection();
    let inTx = false;
    let rows = null;
    try {
      await conn.beginTransaction();
      inTx = true;
      try {
        [rows] = await conn.query(
          `SELECT branch_id, business_day FROM analytics_rollup_dirty
            ORDER BY queued_at, branch_id, business_day
            LIMIT ? FOR UPDATE SKIP LOCKED`, [limit]);
        _skipLockedSupported = true;
      } catch (e) {
        if (_isSyntaxError(e)) {
          _skipLockedSupported = false; // detected once — remembered for the process
          rows = null;
        } else {
          throw e;
        }
      }
      if (rows) {
        out.mode = 'skip_locked';
        out.claimed = rows.length;
        for (const r of rows) {
          const branchId = String(r.branch_id);
          const day = _dayStr(r.business_day, offsetMin);
          try {
            await _inTx(db, (tx) => _rebuildPair(tx, branchId, day));
            // delete on the CLAIM connection — the row lock is ours; the
            // delete becomes visible only when the claim tx commits below.
            await conn.query(
              'DELETE FROM analytics_rollup_dirty WHERE branch_id = ? AND business_day = ?',
              [branchId, day]);
            out.rebuilt++;
          } catch (e) {
            out.failed++;
            console.error('[analytics-rollup] pair rebuild failed:', branchId, day,
              (e && (e.code || '')) || '', e && e.message);
          }
        }
      }
      await conn.commit();
      inTx = false;
    } finally {
      if (inTx) { try { await conn.rollback(); } catch (_) {} }
      try { conn.release(); } catch (_) {}
    }
  }

  if (_skipLockedSupported === false && out.mode === null) {
    // Fallback: claim-by-DELETE (older MySQL). A pair whose rebuild fails is
    // re-enqueued so it is never lost.
    out.mode = 'plain';
    const [rows] = await db.query(
      `SELECT branch_id, business_day FROM analytics_rollup_dirty
        ORDER BY queued_at, branch_id, business_day LIMIT ?`, [limit]);
    for (const r of rows) {
      const branchId = String(r.branch_id);
      const day = _dayStr(r.business_day, offsetMin);
      const [del] = await db.query(
        'DELETE FROM analytics_rollup_dirty WHERE branch_id = ? AND business_day = ?',
        [branchId, day]);
      if (!del.affectedRows) continue; // another worker claimed it first
      out.claimed++;
      try {
        await _inTx(db, (tx) => _rebuildPair(tx, branchId, day));
        out.rebuilt++;
      } catch (e) {
        out.failed++;
        console.error('[analytics-rollup] pair rebuild failed:', branchId, day,
          (e && (e.code || '')) || '', e && e.message);
        try {
          await db.query(
            'INSERT IGNORE INTO analytics_rollup_dirty (branch_id, business_day) VALUES (?,?)',
            [branchId, day]);
        } catch (_) { /* re-enqueue is best-effort */ }
      }
    }
  }

  if (out.failed === 0) {
    try { await _advanceWatermark(db); }
    catch (e) { console.error('[analytics-rollup] watermark update failed:', e && e.message); }
  }
  return out;
}

/**
 * Enqueue every (branch, day) pair in [from..to] into analytics_rollup_dirty
 * (INSERT IGNORE — pending pairs stay pending). Used after a backfill.
 * branchIds optional; when omitted the branch set is derived from the fact
 * tables' rows inside the range (plus sales_returns).
 * Returns { pairs, branches, days }.
 */
async function rebuildRange(db, opts = {}) {
  const from = String(opts.from || '');
  const to = String(opts.to || '');
  if (!_isIsoDay(from) || !_isIsoDay(to)) {
    throw new Error('rebuildRange: from/to must be YYYY-MM-DD');
  }
  const fromMs = Date.parse(from + 'T00:00:00Z');
  const toMs = Date.parse(to + 'T00:00:00Z');
  if (!(fromMs <= toMs)) throw new Error('rebuildRange: to precedes from');
  const days = Math.floor((toMs - fromMs) / 86400000) + 1;
  if (days > MAX_REBUILD_RANGE_DAYS) {
    throw new Error(`rebuildRange: ${days} days exceeds the ${MAX_REBUILD_RANGE_DAYS}-day cap`);
  }

  let branchIds = Array.isArray(opts.branchIds)
    ? [...new Set(opts.branchIds.map(String).filter(Boolean))] : [];
  if (!branchIds.length) {
    const [rows] = await db.query(
      `SELECT DISTINCT branch_id FROM analytics_order_facts   WHERE business_day BETWEEN ? AND ?
       UNION SELECT DISTINCT branch_id FROM analytics_payment_facts WHERE business_day BETWEEN ? AND ?
       UNION SELECT DISTINCT branch_id FROM analytics_till_facts    WHERE business_day BETWEEN ? AND ?
       UNION SELECT DISTINCT branch_id FROM sales_returns           WHERE return_date  BETWEEN ? AND ?`,
      [from, to, from, to, from, to, from, to]);
    branchIds = [...new Set(rows.map((r) => r.branch_id).filter((b) => b != null).map(String))];
  }
  if (!branchIds.length) return { pairs: 0, branches: 0, days };

  const dayList = [];
  for (let ms = fromMs; ms <= toMs; ms += 86400000) {
    dayList.push(new Date(ms).toISOString().slice(0, 10));
  }

  let pairs = 0;
  const CHUNK = 400; // value tuples per INSERT
  let tuples = [];
  const flush = async () => {
    if (!tuples.length) return;
    const ph = tuples.map(() => '(?,?)').join(',');
    await db.query(
      `INSERT IGNORE INTO analytics_rollup_dirty (branch_id, business_day) VALUES ${ph}`,
      tuples.flat());
    pairs += tuples.length;
    tuples = [];
  };
  for (const b of branchIds) {
    for (const d of dayList) {
      tuples.push([b, d]);
      if (tuples.length >= CHUNK) await flush();
    }
  }
  await flush();
  return { pairs, branches: branchIds.length, days };
}

// ── repair drain ─────────────────────────────────────────────────────────────

/** Map a repair row's source_type (the exact strings routes/services pass to
 *  safeProject) to its ProjectionService replay call. */
function _repairReplay(db, sourceType, sourceId) {
  const P = ProjectionService;
  switch (String(sourceType)) {
    case 'sale': return () => P.projectPosSale(db, sourceId);
    case 'credit_note': return () => P.projectReturn(db, { creditNoteId: sourceId });
    case 'sales_return': return () => P.projectReturn(db, { returnId: sourceId });
    case 'customer_payment': return () => P.projectArReceipt(db, sourceId);
    case 'shift_open': return () => P.projectTillMovement(db, { type: 'open_float', shiftId: sourceId });
    case 'shift_close': return () => P.projectTillMovement(db, { type: 'close_count', shiftId: sourceId });
    case 'cash_receipt': return () => P.projectCashVoucher(db, 'cash_receipt', sourceId);
    case 'cash_payment': return () => P.projectCashVoucher(db, 'cash_payment', sourceId);
    default: return null;
  }
}

/**
 * Replay up to `limit` analytics_projection_repair rows through
 * ProjectionService (via safeProject — a failed replay bumps the SAME row's
 * attempts/last_error through safeProject's upsert). Success deletes the row;
 * rows that reach attempts >= 10 are never selected again — permanently
 * flagged for a human. Returns { scanned, healed, failed, unknown }.
 */
async function drainRepair(db, opts = {}) {
  const limit = Math.min(Math.max(1, Number(opts.limit) || 25), 200);
  const [rows] = await db.query(
    `SELECT source_type, source_id, attempts FROM analytics_projection_repair
      WHERE attempts < ? ORDER BY queued_at LIMIT ?`,
    [MAX_REPAIR_ATTEMPTS, limit]);
  const out = { scanned: rows.length, healed: 0, failed: 0, unknown: 0 };
  for (const row of rows) {
    const sourceType = String(row.source_type);
    const sourceId = String(row.source_id);
    const replay = _repairReplay(db, sourceType, sourceId);
    if (!replay) {
      out.unknown++;
      try {
        await db.query(
          `UPDATE analytics_projection_repair SET attempts = attempts + 1, last_error = ?
            WHERE source_type = ? AND source_id = ?`,
          ['no replay mapping for source_type "' + sourceType + '"', sourceType, sourceId]);
      } catch (_) { /* best-effort */ }
      continue;
    }
    // safeProject NEVER throws: null = failure (attempts already bumped on
    // this exact row by its ON DUPLICATE KEY UPDATE), anything else = success.
    const res = await ProjectionService.safeProject(db, sourceType, sourceId, replay);
    if (res !== null) {
      await db.query(
        'DELETE FROM analytics_projection_repair WHERE source_type = ? AND source_id = ?',
        [sourceType, sourceId]);
      out.healed++;
    } else {
      out.failed++;
    }
  }
  return out;
}

module.exports = {
  drainDirty,
  rebuildRange,
  drainRepair,
  MAX_REPAIR_ATTEMPTS,
  // exported for tests
  _rebuildPair,
  _dayStr,
  _inTx,
};
