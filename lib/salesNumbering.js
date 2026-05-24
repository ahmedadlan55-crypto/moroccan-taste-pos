/**
 * ─── Sales Numbering Helper ───────────────────────────────────────
 *
 * Atomic per-day sequential numbering for sales-related artefacts:
 *
 *   invoice    INV-YYYYMMDD-NNNN   (every new sale)
 *   void       VOI-YYYYMMDD-NNNN   (when a sale is voided)
 *   return     RET-YYYYMMDD-NNNN   (when a sale is returned / refunded)
 *
 * Uses the `sales_daily_counter` table created in migration 0002.
 * Race-safe: relies on `LAST_INSERT_ID(expr)` which atomically
 * increments and returns the new value inside a single statement —
 * no SELECT-then-UPDATE window. Same pattern proven in
 * routes/workflow.js:nextDailySerial.
 *
 * All helpers tolerate older deploys where the columns / counter
 * table don't exist yet (returns null silently). Callers should
 * treat the return value as "use it if present, otherwise fall
 * back to the legacy id".
 *
 * v6.11.0 — Phase: cashier invoice + void/return numbering
 */
'use strict';

function _ymd(d) {
  d = d || new Date();
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return '' + y + m + day;
}

/**
 * Atomically reserve the next per-day serial for the given key.
 * Returns the integer serial (1, 2, 3, ...). Returns null if the
 * counter table is missing (older deploy that hasn't run migration
 * 0002 yet) so callers can fall back gracefully.
 */
async function _nextSerial(db, counterKey) {
  try {
    await db.query(
      'INSERT INTO sales_daily_counter (counter_key, last_serial) VALUES (?, 1) ' +
      'ON DUPLICATE KEY UPDATE last_serial = LAST_INSERT_ID(last_serial + 1)',
      [counterKey]
    );
    var [rows] = await db.query('SELECT LAST_INSERT_ID() AS id');
    var serial = rows && rows[0] && Number(rows[0].id);
    if (serial && serial > 0) return serial;
    // First insert returns 0 from LAST_INSERT_ID — re-read
    var [r2] = await db.query(
      'SELECT last_serial FROM sales_daily_counter WHERE counter_key = ?',
      [counterKey]
    );
    return r2.length ? Number(r2[0].last_serial) : 1;
  } catch (e) {
    // Counter table missing or other schema drift — let the caller
    // decide whether to fall back to a legacy identifier.
    return null;
  }
}

function _format(prefix, ymd, serial) {
  return prefix + '-' + ymd + '-' + String(serial).padStart(4, '0');
}

/**
 * Generate INV-YYYYMMDD-NNNN for a brand-new sale.
 * Pass an optional `ymd` (already-computed YYYYMMDD string) to keep
 * the invoice number tied to the order date in edge cases where the
 * caller computes the date elsewhere.
 */
async function nextInvoiceNumber(db, ymd) {
  var y = ymd || _ymd();
  var n = await _nextSerial(db, 'invoice|' + y);
  return n == null ? null : _format('INV', y, n);
}

/**
 * Generate VOI-YYYYMMDD-NNNN when a sale is being voided.
 */
async function nextVoidSerial(db, ymd) {
  var y = ymd || _ymd();
  var n = await _nextSerial(db, 'void|' + y);
  return n == null ? null : _format('VOI', y, n);
}

/**
 * Generate RET-YYYYMMDD-NNNN when a sale is being refunded.
 */
async function nextReturnSerial(db, ymd) {
  var y = ymd || _ymd();
  var n = await _nextSerial(db, 'return|' + y);
  return n == null ? null : _format('RET', y, n);
}

module.exports = {
  nextInvoiceNumber,
  nextVoidSerial,
  nextReturnSerial,
  // Exposed for tests
  _ymd,
  _format
};
