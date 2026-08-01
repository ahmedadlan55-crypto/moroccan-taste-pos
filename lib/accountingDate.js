'use strict';
/**
 * lib/accountingDate.js — the calendar date a journal entry belongs to.
 *
 * THE BUG THIS EXISTS TO KILL
 *
 * Journal dates were computed as `now.toISOString().slice(0, 10)`, which is
 * UTC. Riyadh is UTC+3, so every sale rung between 00:00 and 02:59 local was
 * posted to the LEDGER under the previous calendar day — while the same sale's
 * invoice number (`routes/sales.js`, local getters) and its ZATCA stamp
 * (`lib/zatca.js`, Intl) both said today. One sale, two dates, and the
 * disagreement is invisible until someone reconciles a tax return.
 *
 * It also broke period locks in both directions: a 01:00 sale on the 1st of a
 * month was checked against — and posted into — the PREVIOUS month, so it was
 * refused whenever that month had been closed, and it slipped into a month
 * that was supposed to be finished whenever it had not.
 *
 * WHY NOT THE BUSINESS DAY
 *
 * `lib/analytics/businessDay.js` rolls the day at the branch's close time
 * (default 04:00), which is right for «how did last night trade» and wrong
 * here. A tax invoice is dated by the CALENDAR, so a 01:00 sale is legally the
 * 1st. Dating its journal to the 31st to match the trading night would put the
 * ledger and the ZATCA-stamped invoice in different months.
 *
 * So: analytics groups by business day, accounting posts by calendar day, and
 * they are allowed to differ. What is not allowed is the ledger and the
 * invoice disagreeing — which is what UTC was doing.
 *
 * The timezone comes from the parameter, not from process.env.TZ. server.js
 * defaults TZ to Asia/Riyadh, but a deployment that overrides it would have
 * silently re-dated the whole ledger.
 */

const { localParts } = require('./analytics/businessDay');

const DEFAULT_TZ = 'Asia/Riyadh';
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * The local calendar date (YYYY-MM-DD) a journal posted at `when` belongs to.
 *
 * @param {Date|string|number} [when]  defaults to now
 * @param {string} [tz]                IANA zone; defaults to Asia/Riyadh
 */
function journalDate(when, tz) {
  const d = when == null ? new Date() : (when instanceof Date ? when : new Date(when));
  if (isNaN(d.getTime())) throw new TypeError('journalDate: invalid date');
  const p = localParts(d, tz || DEFAULT_TZ);
  return `${p.y}-${pad2(p.mo)}-${pad2(p.d)}`;
}

/**
 * Normalise anything a caller might hold — a Date, a DATETIME string, an
 * ISO string — to the calendar date to lock against. A string that already
 * carries a date is trusted as a local date and simply truncated; converting
 * it through Date() would re-introduce the UTC shift this module exists to
 * remove.
 */
function toAccountingDate(value, tz) {
  if (value == null) return journalDate(undefined, tz);
  if (value instanceof Date) return journalDate(value, tz);
  const s = String(value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return journalDate(new Date(s), tz);
}

module.exports = { journalDate, toAccountingDate, DEFAULT_TZ };
