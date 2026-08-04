'use strict';
/**
 * lib/salesPosting/capture.js — write one queue row per economic event.
 *
 * This is the ONLY thing the sale path calls. Everything else in the
 * subsystem (aggregation, preview, posting, reversal) reads what this wrote.
 *
 * ─── WHY IT RUNS INSIDE THE SALE TRANSACTION ────────────────────────────────
 *
 * `routes/sales.js` shadows the pool with the transaction connection
 * (`const db = _conn`) for the whole handler, commits at one point, and has
 * THREE rollback sites. Critically, the idempotent-replay path (a duplicate
 * `client_order_id`) rolls back and returns HTTP 200 without ever reaching the
 * post-commit region.
 *
 * So a capture placed after the commit would be skipped on every replay and on
 * every rollback — reproducing exactly the hole the queue exists to close: a
 * sale that exists with no posting record and nothing pointing at it. Inside
 * the transaction, the queue row and the sale are atomic: either both exist or
 * neither does.
 *
 * The cost of being inside is that this function must never open its own
 * connection (it would deadlock against the transaction holding the row locks)
 * and must be cheap. It is: every value is already in memory at the call site,
 * there is no account resolution and no balance check — those move to posting
 * time, which is the point of the whole change.
 *
 * ─── WHY IT NEVER THROWS BY DEFAULT ─────────────────────────────────────────
 *
 * A queue-write failure must not lose a sale that the customer already paid
 * for. `capture()` swallows and reports. The compensating control is the
 * health check in this module: `countUnqueuedSales()` is a standing query that
 * must return zero, so a swallowed failure is visible rather than silent.
 *
 * That trade is deliberate and it is the opposite of the GL posting rule,
 * where a failure IS fatal to the sale. The difference: a missing journal
 * means the money was never recorded, while a missing queue row means the
 * money was recorded and merely needs re-queuing, which the health check makes
 * possible.
 */

const businessDay = require('../analytics/businessDay');
const acctDate = require('../accountingDate');

/** Economic events this queue accepts. */
const SOURCE_TYPES = Object.freeze(['sale', 'return', 'void']);

/** Terminal-ish states that a re-capture must not overwrite. */
const IMMUTABLE_STATUSES = Object.freeze(['posting', 'posted', 'posted_legacy']);

const money = (v) => Math.round((Number(v) || 0) * 100) / 100;

/**
 * Apply the event's sign to every `amount` in a split array.
 *
 * `Math.abs` first, so a caller that already passed negatives for a return
 * cannot double-negate its way back to positive. The sign of the ROW is the
 * only thing that decides direction.
 */
function signAll(list, sign) {
  if (!Array.isArray(list)) return [];
  return list.map((x) => ({ ...x, amount: money(Math.abs(Number(x.amount) || 0)) * sign }));
}

/**
 * Compute the two dates a queue row carries.
 *
 * They are different on purpose. `business_day` rolls at the branch close time
 * so a 01:00 sale groups with the previous trading night — the way every sales
 * report in this system already reads. `calendar_date` is the Riyadh calendar
 * date, because the journal must carry the same date as the ZATCA-stamped
 * invoice. For after-midnight trade these differ by one day, and both are
 * correct for their own question.
 *
 * Stamped at CAPTURE, never at post time: deriving them when someone presses
 * Post would date the batch by when the button was clicked.
 */
function stampDates(occurredAt, { tz, dayCloseTime } = {}) {
  const when = occurredAt instanceof Date ? occurredAt : new Date(occurredAt || Date.now());
  const { businessDay: bd } = businessDay.computeLocal(when, tz || 'Asia/Riyadh', dayCloseTime || '04:00:00');
  return { businessDay: bd, calendarDate: acctDate.journalDate(when, tz) };
}

/**
 * Build the row to insert. Pure — no DB — so the shape can be tested without
 * a transaction, and so the sale path can be read without chasing SQL.
 */
function buildQueueRow(evt) {
  const type = String(evt.sourceType || 'sale').toLowerCase();
  if (!SOURCE_TYPES.includes(type)) {
    throw new Error('salesPosting.capture: unknown sourceType ' + type);
  }
  if (!evt.sourceId) throw new Error('salesPosting.capture: sourceId is required');

  const { businessDay: bd, calendarDate } = stampDates(evt.occurredAt, evt);

  // A return is a NEGATIVE economic event carried on the same accounts, not a
  // netting-off of the original sale. Keeping the sign here means the
  // aggregator can add rows up without knowing what each one was, and the
  // owner still sees sales and returns as separate lines.
  const sign = type === 'sale' ? 1 : -1;

  return {
    source_type: type,
    source_id: String(evt.sourceId),
    business_day: bd,
    calendar_date: calendarDate,
    brand_id: evt.brandId || null,
    branch_id: evt.branchId || null,
    net_amount: money(evt.net) * sign,
    tax_amount: money(evt.tax) * sign,
    gross_amount: money(evt.gross) * sign,
    cogs_amount: money(evt.cogs) * sign,
    payload_json: JSON.stringify({
      // The splits four totals cannot reconstruct.
      //
      // SIGNED, exactly like the money columns above. ONE convention for the
      // whole row: everything a return carries is negative.
      //
      // An earlier version stored these unsigned and left the aggregator to
      // apply the sign. That is two conventions in one row, and it failed the
      // first time it was exercised — the aggregator negated an already
      // negative amount, so a refund produced «Dr cash / Cr revenue», the
      // exact direction of a sale. A refund that books as a sale is the worst
      // possible failure for this subsystem, and nothing about the row's shape
      // made the mistake visible.
      payments: signAll(evt.payments, sign),
      revenue: signAll(evt.revenue, sign),
      cogsByWarehouse: signAll(evt.cogsByWarehouse, sign),
      // Delivery-platform commission is part of the sale snapshot. It used
      // to be posted in a second journal per invoice; carrying both account
      // codes here lets the daily/monthly batch post it atomically instead.
      commissions: signAll(evt.commissions, sign),
      channelId: evt.channelId || null,
      sign,
    }),
    invoice_number: evt.invoiceNumber || null,
    status: evt.status || 'pending',
  };
}

/**
 * Insert the queue row on the CALLER'S connection.
 *
 * @param {{query:Function}} conn  MUST be the sale's transaction connection
 * @param {object} evt
 * @param {{throwOnError?:boolean}} [opts]  default false — see the header
 * @returns {Promise<{ok:boolean, skipped?:string, error?:string}>}
 */
async function capture(conn, evt, opts = {}) {
  let row;
  try {
    row = buildQueueRow(evt);
  } catch (e) {
    // A malformed event is a programming error, not a runtime condition.
    if (opts.throwOnError) throw e;
    return { ok: false, error: e.message };
  }

  try {
    const cols = Object.keys(row);
    // ON DUPLICATE rather than INSERT IGNORE: a re-captured event (a retried
    // checkout, a re-run backfill) should REFRESH its snapshot while it is
    // still pending — but must never disturb one that is already posted or
    // mid-flight, which is what the status guard in the UPDATE clause does.
    // Writing this as IGNORE would silently keep a stale snapshot instead.
    await conn.query(
      `INSERT INTO sales_posting_queue (${cols.join(', ')})
       VALUES (${cols.map(() => '?').join(', ')})
       ON DUPLICATE KEY UPDATE
         business_day  = IF(status IN (${IMMUTABLE_STATUSES.map(() => '?').join(',')}), business_day,  VALUES(business_day)),
         calendar_date = IF(status IN (${IMMUTABLE_STATUSES.map(() => '?').join(',')}), calendar_date, VALUES(calendar_date)),
         net_amount    = IF(status IN (${IMMUTABLE_STATUSES.map(() => '?').join(',')}), net_amount,    VALUES(net_amount)),
         tax_amount    = IF(status IN (${IMMUTABLE_STATUSES.map(() => '?').join(',')}), tax_amount,    VALUES(tax_amount)),
         gross_amount  = IF(status IN (${IMMUTABLE_STATUSES.map(() => '?').join(',')}), gross_amount,  VALUES(gross_amount)),
         cogs_amount   = IF(status IN (${IMMUTABLE_STATUSES.map(() => '?').join(',')}), cogs_amount,   VALUES(cogs_amount)),
         payload_json  = IF(status IN (${IMMUTABLE_STATUSES.map(() => '?').join(',')}), payload_json,  VALUES(payload_json))`,
      [...cols.map((c) => row[c]), ...Array(7).fill(IMMUTABLE_STATUSES).flat()]
    );
    return { ok: true };
  } catch (e) {
    // ER_NO_SUCH_TABLE on a deployment where the migration has not landed yet
    // is tolerated only by explicitly lenient callers. Checkout passes
    // `throwOnError:true`: now that the queue is its accounting source, a sale
    // committed without this row would have neither an invoice journal nor a
    // future batch journal.
    if (opts.throwOnError) throw e;
    if (e && e.code === 'ER_NO_SUCH_TABLE') return { ok: false, skipped: 'schema' };
    console.warn('[sales-posting] capture failed for ' + row.source_type + ' ' + row.source_id + ':', e.code || e.message);
    return { ok: false, error: e.code || e.message };
  }
}

/**
 * THE HEALTH INVARIANT: every sale has a queue row.
 *
 * This is the standing check that makes the swallowed-failure trade above
 * honest. It must return 0 forever. Anything else means a sale exists that no
 * batch will ever pick up — the exact failure mode the queue was built to make
 * impossible, so it is measured rather than assumed.
 *
 * Scoped to sales captured after the cutover: everything before it is
 * backfilled as `posted_legacy`, and a sale from before the backfill ran is
 * not evidence of a leak.
 */
async function countUnqueuedSales(conn, sinceISO) {
  const [[r]] = await conn.query(
    `SELECT COUNT(*) AS n
       FROM sales s
       LEFT JOIN sales_posting_queue q
              ON q.source_type = 'sale' AND q.source_id = s.id
      WHERE q.id IS NULL
        AND (? IS NULL OR s.order_date >= ?)`,
    [sinceISO || null, sinceISO || null]);
  return Number(r.n) || 0;
}

module.exports = {
  capture,
  buildQueueRow,
  stampDates,
  countUnqueuedSales,
  SOURCE_TYPES,
  IMMUTABLE_STATUSES,
};
