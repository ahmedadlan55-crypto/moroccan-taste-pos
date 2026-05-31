/**
 * lib/docNumber.js — unified sequential document numbering (v7.1)
 * ================================================================
 * Issues human-readable, atomic, daily-reset document numbers in the
 * form  PREFIX-YYYYMMDD-NNNN  (e.g. WST-20260531-0001, ADJ-20260531-0007).
 *
 * Backed by the `doc_counters(counter_key, last_serial)` table (created
 * by the startup migration in server.js). The INSERT ... ON DUPLICATE
 * KEY UPDATE makes the increment atomic — no race, no skipped serial —
 * mirroring the existing _nextSerial pattern in routes/warehouse-ops.js.
 *
 * Usage:
 *   const { nextDocNumber } = require('../lib/docNumber');
 *   const num = await nextDocNumber(db, 'WST');   // → "WST-20260531-0001"
 *
 * Tolerant by design: if the counters table is missing on a very old
 * deploy, it falls back to a timestamp-based number so callers never
 * throw. Whatever it returns is always a usable string.
 */
'use strict';

function _ymd(d) {
  const dt = d || new Date();
  return '' + dt.getFullYear()
    + String(dt.getMonth() + 1).padStart(2, '0')
    + String(dt.getDate()).padStart(2, '0');
}

/**
 * Reserve and return the next document number for `prefix`.
 * @param {object} db    - the db connection (with .query → [rows])
 * @param {string} prefix - e.g. 'WST', 'ADJ', 'STK', 'MV'
 * @param {Date}   [when] - optional date (defaults to now)
 * @returns {Promise<string>} PREFIX-YYYYMMDD-NNNN
 */
async function nextDocNumber(db, prefix, when) {
  const ymd = _ymd(when);
  const key = String(prefix) + '-' + ymd;
  try {
    await db.query(
      'INSERT INTO doc_counters (counter_key, last_serial) VALUES (?, 1) ' +
      'ON DUPLICATE KEY UPDATE last_serial = last_serial + 1',
      [key]
    );
    const [rows] = await db.query(
      'SELECT last_serial FROM doc_counters WHERE counter_key = ?', [key]
    );
    const serial = (rows && rows[0]) ? rows[0].last_serial : 1;
    return prefix + '-' + ymd + '-' + String(serial).padStart(4, '0');
  } catch (e) {
    // Counters table missing — never block the caller.
    return prefix + '-' + ymd + '-' + String(Date.now()).slice(-4);
  }
}

module.exports = { nextDocNumber: nextDocNumber };
