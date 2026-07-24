/**
 * lib/analytics/compare.js — comparison-window arithmetic for the query engine.
 *
 * shiftRange({from,to}, mode) → {from,to} of the comparison window:
 *   prevPeriod — the same-LENGTH window ending immediately before `from`
 *                (a 31-day March compares against Jan-31→Feb-29/28, not
 *                "last month": equal-length windows are the only honest
 *                like-for-like for additive metrics).
 *   prevYear   — the same calendar dates minus one year. Feb 29 clamps to
 *                Feb 28 in a non-leap target year (the adjacent real date,
 *                never an invalid one).
 *
 * Pure date-string math on 'YYYY-MM-DD' (UTC-space day arithmetic — no
 * timezone, no DST, no ambient clock). Throws on malformed input; a silent
 * NaN window would corrupt every delta downstream.
 */
'use strict';

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseIsoDate(s) {
  const m = ISO_DATE_RE.exec(String(s || ''));
  if (!m) throw new Error(`compare: unparseable ISO date "${s}"`);
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  // Reject rollovers ('2032-02-31' silently becoming March 2)
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    throw new Error(`compare: invalid calendar date "${s}"`);
  }
  return dt;
}

function fmt(dt) {
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function addDays(dt, days) {
  return new Date(dt.getTime() + days * 86400000);
}

/** Inclusive day count of a from..to range. */
function rangeDays(range) {
  const from = parseIsoDate(range.from), to = parseIsoDate(range.to);
  return Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
}

/**
 * @param {{from:string,to:string}} range  inclusive ISO date window (from<=to)
 * @param {'prevPeriod'|'prevYear'} mode
 * @returns {{from:string,to:string}}
 */
function shiftRange(range, mode) {
  const from = parseIsoDate(range && range.from);
  const to = parseIsoDate(range && range.to);
  if (to.getTime() < from.getTime()) throw new Error('compare: range.to precedes range.from');

  if (mode === 'prevPeriod') {
    const lenDays = Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
    const prevTo = addDays(from, -1);
    const prevFrom = addDays(prevTo, -(lenDays - 1));
    return { from: fmt(prevFrom), to: fmt(prevTo) };
  }
  if (mode === 'prevYear') {
    return { from: fmt(minusOneYear(from)), to: fmt(minusOneYear(to)) };
  }
  throw new Error(`compare: unknown mode "${mode}"`);
}

/** Same calendar date one year earlier; Feb 29 → Feb 28 when target isn't leap. */
function minusOneYear(dt) {
  const y = dt.getUTCFullYear() - 1, mo = dt.getUTCMonth(), d = dt.getUTCDate();
  const candidate = new Date(Date.UTC(y, mo, d));
  if (candidate.getUTCMonth() !== mo) {
    // rolled over (Feb 29 in a non-leap year) → clamp to the month's last day
    return new Date(Date.UTC(y, mo + 1, 0));
  }
  return candidate;
}

module.exports = { shiftRange, rangeDays, parseIsoDate };
