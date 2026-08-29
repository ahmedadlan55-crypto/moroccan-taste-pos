/**
 * The ONE CSV writer. Every export in the product goes through this file.
 *
 * ─── THE DEFECT THIS EXISTS TO END ──────────────────────────────────────────
 * `lib/procurement/http.js` and `lib/order-to-cash/http.js` each carried a
 * byte-identical copy of this:
 *
 *     function toCsv(rows, columns) {
 *       const capped = rows.slice(0, CSV_ROW_CAP);      // ← row 50,001 vanishes
 *       ...
 *     }
 *     function sendCsv(res, filename, rows, columns) {
 *       return res.status(200).send(toCsv(rows, columns));   // ← 200. Complete.
 *     }
 *
 * A 60,000-row A/P ageing downloaded as a 50,000-row file, with HTTP 200, no
 * header, no warning, and no way for the person reading it to know that ten
 * thousand invoices are missing. It is the worst class of reporting bug: the
 * artifact looks finished, so nobody goes looking.
 *
 * ─── THE RULE ───────────────────────────────────────────────────────────────
 * A CSV is COMPLETE or it is REFUSED. There is no partial success. Overflow
 * answers **413 REPORT_TOO_LARGE** carrying `{ total, limit }` so the caller
 * can say "narrow the filters" with real numbers instead of a shrug.
 *
 * This is not a new policy — `lib/csvExport.js` has thrown `EXPORT_LIMIT` since
 * it was written, and `routes/warehouse-reports.js` already turns that into a
 * 413. Two of the three CSV paths were right; this makes it three.
 *
 * ─── THE NEGATIVE-NUMBER RULE ───────────────────────────────────────────────
 * The formula-injection guard neutralizes a leading `= + @ TAB CR`, and `-`
 * ONLY when what follows is not a plain number. The clones quoted every leading
 * `-`, which turned every negative amount in a financial export — credit
 * balances, variances, reversals — into the text `'-1500`. Excel then refuses
 * to sum the column, and the reader is looking at a financial report whose
 * totals do not add up. `lib/csvExport.js` already made this distinction; the
 * clones did not.
 */
'use strict';

/** Beyond this, a file is refused rather than quietly shortened. */
const CSV_ROW_CAP = 50000;

/** UTF-8 BOM — without it Excel opens Arabic as mojibake. */
const BOM = '﻿';

function csvCell(value) {
  let s = value == null ? '' : String(value);
  if (s === '') return s;
  // Formula injection: a cell starting with these is executed by Excel and
  // Sheets. The leading apostrophe forces text.
  if (/^[=+@\t\r]/.test(s)) s = "'" + s;
  // `-` is ambiguous: `-1500` is a number, `-cmd|' /C calc'!A0` is an attack.
  // Quote only the non-numeric case, so real negatives stay summable.
  else if (s[0] === '-' && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** The error a caller translates into 413. */
function tooLargeError(total, limit) {
  const error = new Error('Report exceeds the export row limit');
  error.code = 'REPORT_TOO_LARGE';
  error.http = 413;
  error.total = Number(total) || 0;
  error.limit = Number(limit) || CSV_ROW_CAP;
  return error;
}

/**
 * Render rows to CSV text, or THROW when the set is too large to render whole.
 *
 * @param {Array<object>} rows
 * @param {Array<{key:string,label:string}>} columns
 * @param {{limit?:number}} [options]
 */
function toCsv(rows, columns, options) {
  const list = Array.isArray(rows) ? rows : [];
  const limit = Number((options || {}).limit) || CSV_ROW_CAP;
  if (list.length > limit) throw tooLargeError(list.length, limit);
  const head = columns.map((c) => csvCell(c.label)).join(',');
  const body = list.map((r) => columns.map((c) => csvCell(r[c.key])).join(',')).join('\r\n');
  return BOM + head + '\r\n' + body + '\r\n';
}

/**
 * Send a COMPLETE csv, or 413. Never a short file with a success status.
 */
function sendCsv(res, filename, rows, columns, options) {
  let text;
  try {
    text = toCsv(rows, columns, options);
  } catch (error) {
    if (error && error.code === 'REPORT_TOO_LARGE') {
      return res.status(413).json({
        success: false,
        code: 'REPORT_TOO_LARGE',
        error: 'تجاوز التقرير الحد الأقصى للتصدير (' + error.limit + ' صف). ضيّق الفلاتر ثم أعد المحاولة.',
        total: error.total,
        limit: error.limit,
      });
    }
    throw error;
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // The row count travels with the file so a caller can prove completeness
  // without reopening it.
  res.setHeader('X-Report-Row-Count', String(Array.isArray(rows) ? rows.length : 0));
  res.setHeader('X-Report-Complete', 'true');
  return res.status(200).send(text);
}

module.exports = { CSV_ROW_CAP, BOM, csvCell, toCsv, sendCsv, tooLargeError };
