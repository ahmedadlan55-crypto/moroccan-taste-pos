'use strict';
/**
 * routes/erp/sales-posting.js — «ترحيل المبيعات».
 *
 * GET  /api/erp/sales-posting/pending    — the queue, sliced by granularity
 * GET  /api/erp/sales-posting/preview    — the exact journal a post would write
 * POST /api/erp/sales-posting/post       — post one bucket
 * GET  /api/erp/sales-posting/batches    — what has been posted
 * GET  /api/erp/sales-posting/batches/:id— one batch, as it was posted
 * POST /api/erp/sales-posting/batches/:id/reverse
 * GET  /api/erp/sales-posting/health     — preflight: what would block a post
 *
 * Every route is gated. Reading a sales ledger is `finance.reports.view`;
 * writing to the general ledger is `finance.gl.post`. They are different
 * permissions because they are different acts — an accountant reviewing the
 * day should not need the right to post it.
 */

const router = require('express').Router();
const db = require('../../db/connection');
const requireCapability = require('../../middleware/requireCapability');
const salesPost = require('../../lib/salesPosting/post');
const aggregate = require('../../lib/salesPosting/aggregate');

const actorOf = (req) => (req.user && (req.user.username || req.user.id)) || '';

/** Never leak a raw SQL message to the browser. */
function fail(res, e, fallback) {
  const status = e && e.status ? e.status : 500;
  const body = { success: false, error: (e && e.code) || fallback || 'error' };
  if (e && e.status && e.status < 500) body.message = e.message;
  if (e && e.warnings) body.warnings = e.warnings;
  if (status >= 500) console.error('[sales-posting]', e && (e.code || e.message));
  return res.status(status).json(body);
}

const filtersOf = (q) => ({
  from: q.from || null, to: q.to || null,
  brandId: q.brandId || null, branchId: q.branchId || null,
});

// ── The pending queue, sliced ────────────────────────────────────────────
// The granularity selector reslices THIS SAME list. There are not two
// queues, and every bucket carries its own `sources` so the screen can expand
// any row to its invoices in both modes — the owner's stated requirement.
router.get('/pending', requireCapability('finance.reports.view'), async (req, res) => {
  try {
    const granularity = String(req.query.granularity || 'daily');
    if (!aggregate.GRANULARITIES.includes(granularity)) {
      return res.status(400).json({ success: false, error: 'bad_granularity' });
    }
    const { batches } = await salesPost.preview(db, { granularity, filters: filtersOf(req.query) });
    const totals = batches.reduce((t, b) => ({
      batches: t.batches + 1, items: t.items + b.itemCount,
      net: Math.round((t.net + b.net) * 100) / 100,
      tax: Math.round((t.tax + b.tax) * 100) / 100,
      gross: Math.round((t.gross + b.gross) * 100) / 100,
      blocked: t.blocked + (b.postable ? 0 : 1),
    }), { batches: 0, items: 0, net: 0, tax: 0, gross: 0, blocked: 0 });
    res.json({ success: true, granularity, batches, totals });
  } catch (e) { fail(res, e, 'pending_failed'); }
});

// ── Preview ──────────────────────────────────────────────────────────────
// The same `planBatches` call the post path makes. Not a second
// implementation — this is what turns a broken chart of accounts from a silent
// posting failure into something a human sees before pressing the button.
router.get('/preview', requireCapability('finance.reports.view'), async (req, res) => {
  try {
    const granularity = String(req.query.granularity || 'daily');
    const bucketKey = req.query.bucketKey ? String(req.query.bucketKey) : null;
    const { accounts, batches } = await salesPost.preview(db, { granularity, filters: filtersOf(req.query) });
    const found = bucketKey ? batches.filter((b) => b.key === bucketKey) : batches;
    if (bucketKey && !found.length) return res.status(404).json({ success: false, error: 'bucket_not_found' });
    res.json({ success: true, accounts, batches: found });
  } catch (e) { fail(res, e, 'preview_failed'); }
});

// ── Post ─────────────────────────────────────────────────────────────────
router.post('/post', requireCapability('finance.gl.post'), async (req, res) => {
  try {
    const { granularity = 'daily', bucketKey, idempotencyKey } = req.body || {};
    const result = await salesPost.postBatch(db, {
      granularity, bucketKey, idempotencyKey,
      filters: filtersOf(req.body || {}),
      actor: actorOf(req),
    });
    res.json({ success: true, ...result });
  } catch (e) {
    // A duplicate idempotency key is a double-click, not an error worth
    // alarming anyone about — report the batch that already exists.
    if (e && e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, error: 'already_posted' });
    }
    fail(res, e, 'post_failed');
  }
});

// ── Posted batches ───────────────────────────────────────────────────────
router.get('/batches', requireCapability('finance.reports.view'), async (req, res) => {
  try {
    const where = [];
    const args = [];
    if (req.query.from) { where.push('journal_date >= ?'); args.push(req.query.from); }
    if (req.query.to) { where.push('journal_date <= ?'); args.push(req.query.to); }
    if (req.query.status) { where.push('status = ?'); args.push(String(req.query.status)); }
    const page = Math.max(1, Math.min(1000000, Number.parseInt(req.query.page, 10) || 1));
    const pageSize = Math.max(1, Math.min(100, Number.parseInt(req.query.pageSize, 10) || 25));
    const offset = (page - 1) * pageSize;
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const [[countRow]] = await db.query(
      `SELECT COUNT(*) AS total FROM sales_posting_batches ${whereSql}`, args);
    const [rows] = await db.query(
      `SELECT b.*, j.journal_number
         FROM sales_posting_batches b
         LEFT JOIN gl_journals j ON j.id = b.journal_id
        ${whereSql}
        ORDER BY b.journal_date DESC, b.created_at DESC
        LIMIT ? OFFSET ?`, args.concat([pageSize, offset]));
    const total = Number(countRow.total) || 0;
    res.json({ success: true, batches: rows, pagination: {
      page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)),
    } });
  } catch (e) { fail(res, e, 'batches_failed'); }
});

router.get('/batches/:id', requireCapability('finance.reports.view'), async (req, res) => {
  try {
    const [[batch]] = await db.query(
      `SELECT b.*, j.journal_number FROM sales_posting_batches b
         LEFT JOIN gl_journals j ON j.id = b.journal_id
        WHERE b.id = ? LIMIT 1`, [req.params.id]);
    if (!batch) return res.status(404).json({ success: false, error: 'not_found' });
    // The invoices that fed it — append-only, so this stays answerable even
    // after a reversal has put the queue rows back to pending.
    const [items] = await db.query(
      `SELECT i.*, q.invoice_number, q.business_day, q.status AS queue_status
         FROM sales_posting_batch_items i
         LEFT JOIN sales_posting_queue q ON q.id = i.queue_id
        WHERE i.batch_id = ? ORDER BY i.id`, [req.params.id]);
    // The journal AS POSTED, from legs_json — not recomputed. What the owner
    // reviews is what actually hit the ledger, even after accounts are later
    // renamed or re-parented.
    let legs = [];
    try { legs = typeof batch.legs_json === 'string' ? JSON.parse(batch.legs_json) : (batch.legs_json || []); } catch (_) {}
    res.json({ success: true, batch, legs, items });
  } catch (e) { fail(res, e, 'batch_failed'); }
});

router.post('/batches/:id/reverse', requireCapability('finance.gl.reverse'), async (req, res) => {
  try {
    const out = await salesPost.reverseBatch(db, {
      batchId: req.params.id,
      actor: actorOf(req),
      reason: (req.body && req.body.reason) || '',
    });
    res.json({ success: true, ...out });
  } catch (e) { fail(res, e, 'reverse_failed'); }
});

// ── Preflight ────────────────────────────────────────────────────────────
//
// Deferred posting trades a LOUD, IMMEDIATE failure (the sale rolls back at
// the till) for a QUIET, DELAYED one (the batch refuses days later). That is
// the point — a broken chart of accounts should not be able to stop the
// register — but it makes this endpoint load-bearing rather than decorative:
// it is the only thing that turns the quiet failure back into a visible one.
router.get('/health', requireCapability('finance.reports.view'), async (req, res) => {
  try {
    const problems = [];

    // 1. Sales with no queue row — the invariant that must hold forever.
    const [[gap]] = await db.query(
      `SELECT COUNT(*) AS n FROM sales s
         LEFT JOIN sales_posting_queue q ON q.source_type = 'sale' AND q.source_id = s.id
        WHERE q.id IS NULL`);
    if (Number(gap.n) > 0) {
      problems.push({ severity: 'critical', code: 'UNQUEUED_SALES', count: Number(gap.n),
        message: Number(gap.n) + ' بيعة بلا صف في الطابور — لن تُرحَّل في أي دفعة' });
    }

    // 2. Buckets that cannot post, with the reason.
    const { accounts, batches } = await salesPost.preview(db, { granularity: 'daily', filters: {} });
    for (const b of batches.filter((x) => !x.postable)) {
      problems.push({ severity: 'blocking', code: 'BATCH_BLOCKED', bucket: b.label,
        warnings: b.warnings,
        message: b.warnings.join(' · ') });
    }

    // 3. Accounts the batch would post to that do not exist. This is the
    //    check that catches a renumbered chart BEFORE a month of trade is
    //    stuck behind it.
    const wanted = [...new Set(Object.values(accounts))];
    const [present] = await db.query(
      `SELECT code FROM gl_accounts WHERE code IN (${wanted.map(() => '?').join(',')})`, wanted);
    const have = new Set(present.map((r) => String(r.code)));
    for (const code of wanted) {
      if (!have.has(code)) {
        problems.push({ severity: 'critical', code: 'MISSING_ACCOUNT', account: code,
          message: 'الحساب ' + code + ' غير موجود في الدليل — لن تُرحَّل أي دفعة' });
      }
    }

    // 4. Rows that failed a previous attempt.
    const [[failed]] = await db.query(
      "SELECT COUNT(*) AS n FROM sales_posting_queue WHERE status = 'failed'");
    if (Number(failed.n) > 0) {
      problems.push({ severity: 'warning', code: 'FAILED_ROWS', count: Number(failed.n),
        message: Number(failed.n) + ' صف فشل ترحيله سابقًا' });
    }

    // 5. Rows stuck mid-flight — a process died between claim and post.
    const [[stuck]] = await db.query(
      "SELECT COUNT(*) AS n FROM sales_posting_queue WHERE status = 'posting' AND captured_at < NOW() - INTERVAL 1 HOUR");
    if (Number(stuck.n) > 0) {
      problems.push({ severity: 'warning', code: 'STUCK_CLAIMS', count: Number(stuck.n),
        message: Number(stuck.n) + ' صف عالق في حالة «جارٍ الترحيل»' });
    }

    res.json({
      success: true,
      healthy: problems.filter((p) => p.severity !== 'warning').length === 0,
      accounts, problems,
    });
  } catch (e) { fail(res, e, 'health_failed'); }
});

/**
 * PERIOD-CLOSE GUARD — exported for the two close implementations to call.
 *
 * Closing a period with sales still unposted would seal a month whose revenue
 * has not reached the ledger. The trial balance would look finished and be
 * wrong, and the queue rows would have nowhere legal to go afterwards.
 *
 * Mounted on BOTH close paths (routes/erp/periods.js and the older one in
 * routes/erp.js). Guarding only one makes the bypass trivial.
 *
 * Override needs `force` AND the capability AND a recorded reason — and what
 * is left behind becomes `stranded`, not deleted, so it stays visible.
 */
async function assertNoUnpostedSales(conn, { from, to, brandId, branchId } = {}) {
  const where = ["status IN ('pending', 'failed', 'posting')"];
  const args = [];
  if (from) { where.push('calendar_date >= ?'); args.push(from); }
  if (to) { where.push('calendar_date <= ?'); args.push(to); }
  if (brandId) { where.push('(brand_id = ? OR brand_id IS NULL)'); args.push(brandId); }
  if (branchId) { where.push('(branch_id = ? OR branch_id IS NULL)'); args.push(branchId); }
  let rows;
  try {
    [rows] = await conn.query(
      `SELECT COUNT(*) AS n, MIN(calendar_date) AS first_day, MAX(calendar_date) AS last_day
         FROM sales_posting_queue WHERE ${where.join(' AND ')}`, args);
  } catch (e) {
    // Missing/broken accounting source must block the close. The release chain
    // creates this schema before the app accepts traffic.
    throw e;
  }
  const n = Number(rows[0] && rows[0].n) || 0;
  if (n > 0) {
    const err = new Error(n + ' مبيعة غير مُرحَّلة في هذه الفترة — رحّلها أولًا من شاشة «ترحيل المبيعات»');
    err.code = 'UNPOSTED_SALES_IN_PERIOD';
    err.status = 409;
    err.unpostedCount = n;
    err.firstDay = rows[0].first_day;
    err.lastDay = rows[0].last_day;
    throw err;
  }
}

/** Mark what a forced close left behind, so it stays visible instead of vanishing. */
async function strandUnposted(conn, { from, to, brandId, branchId } = {}) {
  const where = ["status IN ('pending', 'failed')"];
  const args = [];
  if (from) { where.push('calendar_date >= ?'); args.push(from); }
  if (to) { where.push('calendar_date <= ?'); args.push(to); }
  if (brandId) { where.push('(brand_id = ? OR brand_id IS NULL)'); args.push(brandId); }
  if (branchId) { where.push('(branch_id = ? OR branch_id IS NULL)'); args.push(branchId); }
  const [r] = await conn.query(
    `UPDATE sales_posting_queue SET status = 'stranded' WHERE ${where.join(' AND ')}`, args);
  return r.affectedRows;
}

/** Re-open makes forced-close rows postable again, in the exact same scope. */
async function recoverStranded(conn, { from, to, brandId, branchId } = {}) {
  const where = ["status = 'stranded'"];
  const args = [];
  if (from) { where.push('calendar_date >= ?'); args.push(from); }
  if (to) { where.push('calendar_date <= ?'); args.push(to); }
  if (brandId) { where.push('(brand_id = ? OR brand_id IS NULL)'); args.push(brandId); }
  if (branchId) { where.push('(branch_id = ? OR branch_id IS NULL)'); args.push(branchId); }
  const [r] = await conn.query(
    `UPDATE sales_posting_queue SET status = 'pending' WHERE ${where.join(' AND ')}`, args);
  return r.affectedRows;
}

module.exports = router;
module.exports.assertNoUnpostedSales = assertNoUnpostedSales;
module.exports.strandUnposted = strandUnposted;
module.exports.recoverStranded = recoverStranded;
