/**
 * services/analytics/RollupService.js — rebuilds the analytics rollup tables
 * (analytics_daily_branch / analytics_daily_item / analytics_daily_payment /
 * analytics_hourly_branch) from the fact tables, one (branch_id, business_day)
 * pair at a time, driven by the analytics_rollup_dirty queue that
 * ProjectionService._enqueueDirty fills after every projection.
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
 *     Like the live `return` fact, NO r.status filter is applied — the
 *     registry's FROM has none, and adding one here would break parity.
 *   gross_profit = net_ex_vat − cogs (equations.grossProfit, additive form).
 *   The order fact keeps its `JOIN ar_documents doc` exactly like the
 *     registry FROM — an order fact whose document row is missing counts
 *     nowhere, same as live.
 *
 * Known, documented deviations forced by the rollup PKs (NOT NULL key parts):
 *   - daily_item skips lines with menu_id NULL (free-text lines) — live
 *     grouping puts them in a NULL group instead.
 *   - daily_payment folds method_norm NULL into 'other' — live grouping
 *     would show a NULL group.
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

/**
 * Recompute all 4 rollup tables for ONE (branchId, 'YYYY-MM-DD') pair.
 * Runs on the caller's connection — call inside a transaction (_inTx).
 */
async function _rebuildPair(conn, branchId, day) {
  const P = [day, branchId];

  await conn.query('DELETE FROM analytics_daily_branch  WHERE business_day = ? AND branch_id = ?', P);
  await conn.query('DELETE FROM analytics_daily_item    WHERE business_day = ? AND branch_id = ?', P);
  await conn.query('DELETE FROM analytics_daily_payment WHERE business_day = ? AND branch_id = ?', P);
  await conn.query('DELETE FROM analytics_hourly_branch WHERE business_day = ? AND branch_id = ?', P);

  // ── analytics_daily_branch ──
  // 1a. order-fact columns. The scan keeps voided rows (voids_count needs
  //     them) and applies excluded_voided per column via CASE; CN-source docs
  //     are excluded outright (they contribute to NO daily_branch column —
  //     their money lives in returns_net / refunds_amount).
  await conn.query(
    `INSERT INTO analytics_daily_branch
       (business_day, brand_id, branch_id, orders, guests, discounts, invoice_total,
        rounding, tips, fees, voids_count)
     SELECT f.business_day, MAX(f.brand_id), f.branch_id,
            SUM(CASE WHEN ${NOT_VOID} THEN 1 ELSE 0 END),
            SUM(CASE WHEN ${NOT_VOID} THEN COALESCE(f.guests, 0) ELSE 0 END),
            SUM(CASE WHEN ${NOT_VOID} THEN COALESCE(f.discount_total, 0) ELSE 0 END),
            SUM(CASE WHEN ${NOT_VOID} THEN COALESCE(doc.total_amount, 0) ELSE 0 END),
            SUM(CASE WHEN ${NOT_VOID} THEN COALESCE(f.rounding_amount, 0) ELSE 0 END),
            SUM(CASE WHEN ${NOT_VOID} THEN COALESCE(f.tips_amount, 0) ELSE 0 END),
            SUM(CASE WHEN ${NOT_VOID} THEN COALESCE(f.fees_amount, 0) ELSE 0 END),
            SUM(CASE WHEN f.status = 'voided' THEN 1 ELSE 0 END)
       FROM analytics_order_facts f
       JOIN ar_documents doc ON doc.id = f.document_id
      WHERE f.business_day = ? AND f.branch_id = ? AND ${NOT_CN}
      GROUP BY f.business_day, f.branch_id`, P);

  // 1b. line-fact money (gross/net/vat/cogs + gross_profit = net − cogs).
  await conn.query(
    `INSERT INTO analytics_daily_branch
       (business_day, brand_id, branch_id, gross_product, net_ex_vat, vat, cogs, gross_profit)
     SELECT f.business_day, MAX(f.brand_id), f.branch_id,
            COALESCE(SUM(d.gross_amount), 0),
            COALESCE(SUM(d.net_amount), 0),
            COALESCE(SUM(d.vat_amount), 0),
            COALESCE(SUM(d.cost_snapshot), 0),
            COALESCE(SUM(d.net_amount), 0) - COALESCE(SUM(d.cost_snapshot), 0)
       FROM ar_document_lines d
       JOIN ar_documents doc ON doc.id = d.document_id
       JOIN analytics_order_facts f ON f.document_id = doc.id
      WHERE f.business_day = ? AND f.branch_id = ? AND ${NOT_VOID} AND ${NOT_CN}
      GROUP BY f.business_day, f.branch_id
     ON DUPLICATE KEY UPDATE
       gross_product = VALUES(gross_product), net_ex_vat = VALUES(net_ex_vat),
       vat = VALUES(vat), cogs = VALUES(cogs), gross_profit = VALUES(gross_profit)`, P);

  // 1c. returns_net from the return fact (r.return_date IS its business day;
  //     no status filter — exactly the live `return` fact).
  await conn.query(
    `INSERT INTO analytics_daily_branch (business_day, branch_id, returns_net)
     SELECT r.return_date, r.branch_id, COALESCE(SUM(rl.net_amount), 0)
       FROM sales_return_lines rl
       JOIN sales_returns r ON r.id = rl.return_id
      WHERE r.return_date = ? AND r.branch_id = ?
      GROUP BY r.return_date, r.branch_id
     ON DUPLICATE KEY UPDATE returns_net = VALUES(returns_net)`, P);

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
  // 2a. sales side (lines of non-voided, non-CN docs). menu_id NULL lines are
  //     skipped — the PK cannot hold them (documented deviation).
  await conn.query(
    `INSERT INTO analytics_daily_item
       (business_day, branch_id, menu_id, category_id_snapshot,
        qty_sold, gross, discount_alloc, net_ex_vat, vat, cogs)
     SELECT f.business_day, f.branch_id, d.menu_id, MAX(d.category_id_snapshot),
            COALESCE(SUM(d.base_qty), 0),
            COALESCE(SUM(d.gross_amount), 0),
            COALESCE(SUM(d.discount_amount), 0),
            COALESCE(SUM(d.net_amount), 0),
            COALESCE(SUM(d.vat_amount), 0),
            COALESCE(SUM(d.cost_snapshot), 0)
       FROM ar_document_lines d
       JOIN ar_documents doc ON doc.id = d.document_id
       JOIN analytics_order_facts f ON f.document_id = doc.id
      WHERE f.business_day = ? AND f.branch_id = ? AND d.menu_id IS NOT NULL
        AND ${NOT_VOID} AND ${NOT_CN}
      GROUP BY f.business_day, f.branch_id, d.menu_id`, P);

  // 2b. qty_returned from return lines on the RETURN's day (a menu item can
  //     appear return-only on a day — the row is created with sales zeros).
  await conn.query(
    `INSERT INTO analytics_daily_item (business_day, branch_id, menu_id, qty_returned)
     SELECT r.return_date, r.branch_id, rl.menu_id, COALESCE(SUM(rl.base_qty), 0)
       FROM sales_return_lines rl
       JOIN sales_returns r ON r.id = rl.return_id
      WHERE r.return_date = ? AND r.branch_id = ? AND rl.menu_id IS NOT NULL
      GROUP BY r.return_date, r.branch_id, rl.menu_id
     ON DUPLICATE KEY UPDATE qty_returned = VALUES(qty_returned)`, P);

  // ── analytics_daily_payment ── (all directions, all statuses — same
  // population the live payment fact exposes; NULL method_norm → 'other').
  await conn.query(
    `INSERT INTO analytics_daily_payment
       (business_day, branch_id, method_norm, direction, amount, tx_count)
     SELECT p.business_day, p.branch_id, COALESCE(p.method_norm, 'other'), p.direction,
            COALESCE(SUM(p.amount), 0), COUNT(*)
       FROM analytics_payment_facts p
      WHERE p.business_day = ? AND p.branch_id = ?
      GROUP BY p.business_day, p.branch_id, COALESCE(p.method_norm, 'other'), p.direction`, P);

  // ── analytics_hourly_branch ── (slot30 buckets of the order fact's local
  // timestamp; voided + CN rows fully excluded — hourly has no voids column).
  await conn.query(
    `INSERT INTO analytics_hourly_branch (business_day, branch_id, slot30, orders, guests)
     SELECT f.business_day, f.branch_id, ${SLOT30},
            COUNT(*), SUM(COALESCE(f.guests, 0))
       FROM analytics_order_facts f
       JOIN ar_documents doc ON doc.id = f.document_id
      WHERE f.business_day = ? AND f.branch_id = ? AND ${NOT_VOID} AND ${NOT_CN}
      GROUP BY f.business_day, f.branch_id, ${SLOT30}`, P);

  await conn.query(
    `INSERT INTO analytics_hourly_branch (business_day, branch_id, slot30, net_ex_vat)
     SELECT f.business_day, f.branch_id, ${SLOT30}, COALESCE(SUM(d.net_amount), 0)
       FROM ar_document_lines d
       JOIN ar_documents doc ON doc.id = d.document_id
       JOIN analytics_order_facts f ON f.document_id = doc.id
      WHERE f.business_day = ? AND f.branch_id = ? AND ${NOT_VOID} AND ${NOT_CN}
      GROUP BY f.business_day, f.branch_id, ${SLOT30}
     ON DUPLICATE KEY UPDATE net_ex_vat = VALUES(net_ex_vat)`, P);
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
