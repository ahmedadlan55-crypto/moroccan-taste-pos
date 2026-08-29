/**
 * The print/export snapshot contract, in one place.
 *
 * ─── THE PROBLEM ────────────────────────────────────────────────────────────
 * A report on screen is PAGED — 25, 50, at most 200 rows. Printing it printed
 * the page, not the report. The person holding the paper has no way to tell:
 * there is no "page 1 of 34" on a report that believes it is complete, and the
 * totals row at the bottom belongs to the whole set while the rows above it are
 * a fraction of it. That is a document that lies by omission.
 *
 * ─── THE CONTRACT ───────────────────────────────────────────────────────────
 * `?snapshot=1` asks for the WHOLE filtered set in one response:
 *
 *   • within the limit  → every row, plus `{ rowCount, limit, complete: true }`
 *   • beyond the limit  → **413 REPORT_TOO_LARGE** with `{ total, limit }`
 *
 * There is no partial snapshot. A caller either has the entire report or is
 * told, with numbers, to narrow the filters. Printing stays disabled until a
 * snapshot succeeds, so a short page can never reach paper wearing a total that
 * describes a larger set.
 *
 * This is not a new invention: `routes/inventory-items.js` and
 * `routes/inventory-lots.js` already implement exactly this, each with its own
 * private copy of the constant and the 413 body. This file is that pattern
 * named once so the next report inherits it instead of re-deriving it.
 *
 * ─── WHY 5,000 ──────────────────────────────────────────────────────────────
 * It is the number the two existing implementations chose, and a report a human
 * prints is not 50,000 rows — beyond a few thousand the answer is a filter, not
 * a bigger sheet of paper. Bulk extraction has its own door: the async export
 * job, which streams to a file and reports its own row count.
 */
'use strict';

/** Rows a single snapshot response may carry. Beyond this it is refused. */
const REPORT_SNAPSHOT_LIMIT = 5000;

/** `?snapshot=1` — accepts the string forms a query string actually produces. */
function wantsSnapshot(query) {
  const raw = (query || {}).snapshot;
  if (raw === true) return true;
  const s = String(raw == null ? '' : raw).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

/**
 * Fetch one more row than the limit so overflow is DETECTED rather than
 * inferred. Asking for exactly `limit` rows and getting `limit` back cannot
 * distinguish "exactly full" from "there is more" — and guessing wrong is how a
 * truncated set gets labelled complete.
 */
function probeSize(limit) {
  return (Number(limit) || REPORT_SNAPSHOT_LIMIT) + 1;
}

/** True when a probe result proves there are more rows than the limit allows. */
function overflowed(rows, limit) {
  const cap = Number(limit) || REPORT_SNAPSHOT_LIMIT;
  return Array.isArray(rows) && rows.length > cap;
}

/** The 413 body. `total` may be a known count or the probe's lower bound. */
function tooLarge(res, total, limit) {
  const cap = Number(limit) || REPORT_SNAPSHOT_LIMIT;
  return res.status(413).json({
    success: false,
    code: 'REPORT_TOO_LARGE',
    error: 'تجاوز التقرير الحد الأقصى (' + cap + ' صف). ضيّق الفلاتر ثم أعد المحاولة.',
    total: Number(total) || 0,
    limit: cap,
  });
}

/**
 * The completeness block every snapshot response carries, so a caller never has
 * to infer whether what it holds is the whole report.
 */
function meta(rowCount, limit) {
  const cap = Number(limit) || REPORT_SNAPSHOT_LIMIT;
  return { snapshot: true, rowCount: Number(rowCount) || 0, limit: cap, complete: true };
}

module.exports = {
  REPORT_SNAPSHOT_LIMIT,
  wantsSnapshot,
  probeSize,
  overflowed,
  tooLarge,
  meta,
};
