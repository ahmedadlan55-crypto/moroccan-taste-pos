/**
 * lib/analytics/mealPeriods.js — map a local time to a configured meal period.
 *
 * Config rows come from analytics_meal_periods (global rows have branch_id
 * NULL; a branch's own rows OVERRIDE the global set entirely — resolveRows()
 * implements that). Ranges are INCLUSIVE on both ends and may cross midnight
 * (dinner 17:00:00–04:59:59 matches 23:00 and 01:30 alike).
 *
 * Overlaps resolve by `sort` ascending (then period_key for determinism) —
 * first match wins. No match → null; callers label that bucket 'other'.
 *
 * Pure: no DB, no clock, no settings. The default rows mirror the migration
 * seed (db/migrations/analytics/schema.js §4).
 */
'use strict';

/** Mirror of the migration's global seed — for callers with no DB rows yet. */
const DEFAULT_MEAL_PERIODS = Object.freeze([
  Object.freeze({ branch_id: null, period_key: 'breakfast', start_time: '05:00:00', end_time: '11:59:59', sort: 1 }),
  Object.freeze({ branch_id: null, period_key: 'lunch', start_time: '12:00:00', end_time: '16:59:59', sort: 2 }),
  Object.freeze({ branch_id: null, period_key: 'dinner', start_time: '17:00:00', end_time: '04:59:59', sort: 3 }),
]);

/** 'HH:mm[:ss]' (or a DATETIME string — the time part is taken) → seconds. */
function toSeconds(value) {
  const s = String(value == null ? '' : value);
  // Accept 'YYYY-MM-DD HH:mm:ss', 'HH:mm:ss', 'HH:mm'.
  const m = /(?:^|[T ])(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) throw new Error(`mealPeriods: unparseable time "${s}"`);
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+(m[3] || 0));
}

/**
 * Does `sec` (seconds since local midnight) fall inside [start, end],
 * inclusive, where start > end means the range crosses midnight?
 */
function inRange(sec, startSec, endSec) {
  if (startSec <= endSec) return sec >= startSec && sec <= endSec;
  return sec >= startSec || sec <= endSec; // overnight
}

/**
 * Bucket a local timestamp into a meal period.
 *
 * @param {string|Date} occurredAtLocal 'YYYY-MM-DD HH:mm:ss' local wall-clock
 *                                      (or 'HH:mm[:ss]', or a Date whose
 *                                      LOCAL fields are already wall-clock).
 * @param {Array}  configRows rows shaped like analytics_meal_periods
 *                            ({ period_key, start_time, end_time, sort });
 *                            defaults to DEFAULT_MEAL_PERIODS.
 * @returns {string|null} period_key, or null when nothing matches.
 */
function bucket(occurredAtLocal, configRows) {
  let sec;
  if (occurredAtLocal instanceof Date) {
    sec = occurredAtLocal.getHours() * 3600 + occurredAtLocal.getMinutes() * 60 + occurredAtLocal.getSeconds();
  } else {
    sec = toSeconds(occurredAtLocal);
  }

  const rows = (configRows && configRows.length ? configRows : DEFAULT_MEAL_PERIODS)
    .slice()
    .sort((a, b) => {
      const sa = Number(a.sort) || 0, sb = Number(b.sort) || 0;
      if (sa !== sb) return sa - sb;
      const ka = String(a.period_key), kb = String(b.period_key);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

  for (const row of rows) {
    if (inRange(sec, toSeconds(row.start_time), toSeconds(row.end_time))) {
      return row.period_key;
    }
  }
  return null;
}

/**
 * Pick the effective row set for a branch: if the branch has ANY rows of its
 * own they replace the global set entirely (a partial override producing a
 * mixed set would make the effective config depend on row order).
 *
 * @param {Array} allRows every analytics_meal_periods row
 * @param {string|null} branchId
 */
function resolveRows(allRows, branchId) {
  const rows = allRows || [];
  const own = rows.filter((r) => r.branch_id != null && String(r.branch_id) === String(branchId));
  if (own.length) return own;
  const globals = rows.filter((r) => r.branch_id == null);
  return globals.length ? globals : DEFAULT_MEAL_PERIODS.slice();
}

module.exports = { bucket, resolveRows, DEFAULT_MEAL_PERIODS, toSeconds, inRange };
