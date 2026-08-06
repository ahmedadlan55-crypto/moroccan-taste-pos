'use strict';
/**
 * db/migrations/sales-posting/schema.js — «ترحيل المبيعات» (deferred sales posting).
 *
 * THE OWNER'S COMPLAINT: «كل عملية بيع ترحل بقيد وهذا ليس جيدا» — every single
 * sale writes its own journal entry, so the general ledger is a firehose of
 * one-line-per-order noise instead of an accounting record anyone can read.
 *
 * THE MODEL: a sale no longer posts. It ENQUEUES an economic event. Later, a
 * human picks a granularity — daily or monthly — presses
 * Post, and one aggregated journal is created for the whole batch. The detail
 * stays visible in every mode, because the queue keeps a row per event no
 * matter how those rows are grouped.
 *
 * ─── WHY A QUEUE TABLE AND NOT A FLAG ───────────────────────────────────────
 *
 * Two cheaper designs were rejected:
 *
 *   • `ar_documents.gl_journal_id IS NULL`. Governed by ORDER_TO_CASH_ENABLE,
 *     so a sale can slip past it silently when the flag is off. And NULL is
 *     not a state: it cannot express `failed`, `posting`, or `stranded`, which
 *     are exactly the states an operator needs to see.
 *
 *   • a column on `sales`. It cannot hold RETURNS — those live in
 *     `sales_returns` — so a trial balance would show credit notes with no
 *     sales behind them. A void can also hard-DELETE the `sales` row
 *     (routes/sales.js, `opts.deleteSale`), taking the posting state with it.
 *
 * The queue is its own table so an economic event outlives the document that
 * created it.
 *
 * ─── THE KEY THAT MAKES DOUBLE-POSTING UNREPRESENTABLE ──────────────────────
 *
 * `uq_spq_source (source_type, source_id)`. Nothing in the GL core is
 * idempotent: `postJournal` never looks for an existing journal by reference,
 * and `ix_glj_ref` is deliberately NON-unique (a reference legitimately maps
 * to several journals). So the ledger will not stop a double post — the queue
 * has to, and it does it structurally rather than by convention.
 *
 * ─── STATUS ─────────────────────────────────────────────────────────────────
 *
 *   pending        — captured, not yet posted. The normal state.
 *   posting        — claimed by a batch that is mid-flight.
 *   posted         — included in a posted batch (batch_id points at it).
 *   failed         — a post attempt rejected it; `last_error` says why.
 *   stranded       — its period was force-closed with it still unposted.
 *                    Deliberately NOT deleted: an operator must still see it.
 *   posted_legacy  — posted the old way, one journal per sale, before this
 *                    subsystem existed. Backfilled so that "every sale has a
 *                    queue row" is true for ALL history, which is what makes
 *                    the no-sale-escapes health check meaningful.
 *
 * ─── business_day, NOT business_date ────────────────────────────────────────
 *
 * The repo's convention is `business_day`, computed by
 * lib/analytics/businessDay.js, which rolls at the branch's `day_close_time`
 * (04:00 default) — a 01:00 sale belongs to the previous TRADING night. That
 * is the right key for grouping a daily batch, because it matches how the
 * owner already reads every sales report.
 *
 * It is deliberately NOT the journal date. The journal date is the Riyadh
 * CALENDAR date (lib/accountingDate.js) because a tax invoice is dated by the
 * calendar. The two may differ by one day for after-midnight trade, and that
 * is correct: analytics groups by trading night, accounting posts by calendar.
 */

const H = require('../order-to-cash/ddlHelpers');

const TBL = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
const ID = 'VARCHAR(50)';
const ACTOR = 'VARCHAR(100)';
const MONEY = 'DECIMAL(14,2)';

async function apply(db, log = () => {}) {
  // ── The queue: one row per economic event ────────────────────────────────
  await H.createTable(db, 'sales_posting_queue', `
    CREATE TABLE sales_posting_queue (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,

      -- 'sale' | 'return' | 'void'. Kept generic so a future economic event
      -- (a manual O2C invoice, say) can join the same queue.
      source_type VARCHAR(20) NOT NULL,
      source_id ${ID} NOT NULL,

      -- The trading night this belongs to (lib/analytics/businessDay.js), and
      -- the calendar date its journal must carry (lib/accountingDate.js).
      -- Both are stamped at CAPTURE time: computing them at post time would
      -- date a batch by when someone happened to press the button.
      business_day DATE NOT NULL,
      calendar_date DATE NOT NULL,

      brand_id ${ID} NULL,
      branch_id ${ID} NULL,

      -- Money, as it was at capture. A SNAPSHOT, not a pointer: the same
      -- principle as ar_document_line_components. Re-reading the sale at post
      -- time would let an edit silently change a number that was already
      -- reported.
      net_amount ${MONEY} NOT NULL DEFAULT 0,
      tax_amount ${MONEY} NOT NULL DEFAULT 0,
      gross_amount ${MONEY} NOT NULL DEFAULT 0,
      cogs_amount ${MONEY} NOT NULL DEFAULT 0,

      -- The legs that cannot be reconstructed from four totals: payment split
      -- by method, revenue split by account, COGS split by warehouse.
      payload_json JSON NULL,

      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      batch_id ${ID} NULL,
      attempts INT NOT NULL DEFAULT 0,
      last_error TEXT NULL,

      invoice_number VARCHAR(60) NULL,
      captured_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      posted_at TIMESTAMP NULL,

      -- Makes "this sale is in two batches" impossible to represent, rather
      -- than merely unlikely. See the header.
      UNIQUE KEY uq_spq_source (source_type, source_id),

      -- The pending-screen query: status + day, scoped by brand/branch.
      KEY ix_spq_status_day (status, business_day),
      KEY ix_spq_status_calendar (status, calendar_date),
      KEY ix_spq_batch (batch_id),
      KEY ix_spq_scope (brand_id, branch_id, business_day)
    ) ${TBL}`, log);

  // ── Batches: one posted journal per row ──────────────────────────────────
  await H.createTable(db, 'sales_posting_batches', `
    CREATE TABLE sales_posting_batches (
      id ${ID} PRIMARY KEY,

      -- 'daily' | 'monthly' — how the queue was sliced.
      -- Invoice drill-down is in batch_items; the GL is
      -- intentionally never posted invoice-by-invoice.
      granularity VARCHAR(20) NOT NULL,

      -- The bucket key this batch covers, e.g. '2026-07-29' or '2026-07'.
      bucket_key VARCHAR(40) NOT NULL,
      brand_id ${ID} NULL,
      branch_id ${ID} NULL,

      journal_date DATE NOT NULL,
      journal_id ${ID} NULL,
      reversal_journal_id ${ID} NULL,

      status VARCHAR(20) NOT NULL DEFAULT 'posted',

      item_count INT NOT NULL DEFAULT 0,
      net_amount ${MONEY} NOT NULL DEFAULT 0,
      tax_amount ${MONEY} NOT NULL DEFAULT 0,
      gross_amount ${MONEY} NOT NULL DEFAULT 0,
      cogs_amount ${MONEY} NOT NULL DEFAULT 0,

      -- The journal exactly as posted. The batch screen renders THIS rather
      -- than recomputing, so what the owner reviews is what actually hit the
      -- ledger even after accounts are later renamed or re-parented.
      legs_json JSON NULL,

      -- Guards the double-click. A unique key, not a check-then-insert.
      idempotency_key VARCHAR(120) NULL,

      created_by ${ACTOR} NULL,
      posted_by ${ACTOR} NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      posted_at TIMESTAMP NULL,
      reversed_at TIMESTAMP NULL,
      reversed_by ${ACTOR} NULL,
      reverse_reason VARCHAR(300) NULL,

      UNIQUE KEY uq_spb_idem (idempotency_key),
      KEY ix_spb_bucket (granularity, bucket_key),
      KEY ix_spb_status (status, journal_date)
    ) ${TBL}`, log);

  // One durable counter per accounting bucket. Posting may happen more than
  // once for the same day/month when late sales arrive after an earlier batch.
  // Incrementing this row inside the posting transaction serialises those
  // generations and keeps their idempotency keys distinct.
  await H.createTable(db, 'sales_posting_bucket_sequences', `
    CREATE TABLE sales_posting_bucket_sequences (
      granularity VARCHAR(20) NOT NULL,
      bucket_key VARCHAR(190) NOT NULL,
      last_cycle INT UNSIGNED NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (granularity, bucket_key)
    ) ${TBL}`, log);

  // ── Batch membership: append-only ────────────────────────────────────────
  // A separate table rather than relying on queue.batch_id, because a reversal
  // sets the queue rows back to `pending` so they can be re-posted — and
  // "which batch was this invoice in on the 12th" must stay answerable
  // forever. queue.batch_id is the CURRENT batch; this is the history.
  await H.createTable(db, 'sales_posting_batch_items', `
    CREATE TABLE sales_posting_batch_items (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      batch_id ${ID} NOT NULL,
      queue_id BIGINT NOT NULL,
      source_type VARCHAR(20) NOT NULL,
      source_id ${ID} NOT NULL,
      net_amount ${MONEY} NOT NULL DEFAULT 0,
      tax_amount ${MONEY} NOT NULL DEFAULT 0,
      gross_amount ${MONEY} NOT NULL DEFAULT 0,
      added_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY ix_spbi_batch (batch_id),
      KEY ix_spbi_source (source_type, source_id)
    ) ${TBL}`, log);

  log('sales-posting schema ready');
}

module.exports = { apply };
