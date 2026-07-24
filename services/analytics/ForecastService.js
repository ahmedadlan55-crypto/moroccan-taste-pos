/**
 * services/analytics/ForecastService.js — per-slot hourly forecast for one
 * branch, computed from the analytics_hourly_branch ROLLUP (basis 'rollup' —
 * never the raw facts: the rollup is the parity-tested aggregate and this
 * read stays O(branch × 56 days)).
 *
 * WINDOW: the trailing 8 FULL weeks — the 56 days ending YESTERDAY
 * (server-local). Today is always excluded: a partial trading day would drag
 * every slot's median down. Each (weekday, slot30) cell therefore has at most
 * 8 samples; lib/analytics/forecast.forecastSlots suppresses cells with fewer
 * than 6 samples or dispersion above 0.6 — this service ADDS NOTHING to that:
 * a suppressed cell is served as { availability: 'insufficient_history' },
 * and a branch with ZERO rollup rows in the window gets the GLOBAL
 * { availability: 'insufficient_history' } response. NEVER a fabricated
 * number.
 *
 * weekday numbering is JS Date#getUTCDay: 0=Sunday … 6=Saturday (the
 * business_day DATE is parsed as UTC midnight — weekday of the calendar date
 * itself, no timezone drift possible).
 *
 * meta.weeksUsed counts the DISTINCT trailing week buckets (0..7, yesterday
 * backwards) that contributed at least one rollup row — 8 means a full
 * history, 1 means the forecast leans on a single week.
 *
 * Scope: the caller must already hold analytics.view (router middleware);
 * the requested branch must be inside the caller's branch scope → 403
 * otherwise (an out-of-scope branch's demand curve is still someone else's
 * data).
 */
'use strict';

const { forecastSlots } = require('../../lib/analytics/forecast');

const WINDOW_WEEKS = 8;
const METRICS = Object.freeze({
  net_ex_vat: 'net_ex_vat',
  orders: 'orders',
  guests: 'guests',
});

function err(code, http, message) {
  const e = new Error(message);
  e.code = code;
  e.http = http;
  return e;
}

/** mysql2 (+03:00 session) DATE → wall-clock 'YYYY-MM-DD' (house recovery). */
function _dbOffsetMinutes(db) {
  const tz = (db && db.DB_TIME_ZONE) || '+03:00';
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(String(tz));
  if (!m) return 180;
  const min = (+m[2]) * 60 + (+m[3]);
  return m[1] === '-' ? -min : min;
}
function _dayStr(v, offsetMin) {
  if (v == null) return null;
  if (v instanceof Date) {
    return new Date(v.getTime() + (offsetMin || 0) * 60000).toISOString().slice(0, 10);
  }
  return String(v).slice(0, 10);
}

function _isoDay(ms) { return new Date(ms).toISOString().slice(0, 10); }

/**
 * @param {object} db  mysql2 pool
 * @param {object} p   { scope, branchId, weekday?, metric?, now? }
 *                     weekday 0=Sun..6=Sat filters the response to one weekday;
 *                     metric ∈ net_ex_vat|orders|guests (default net_ex_vat);
 *                     now — injected clock for tests.
 * @returns {Promise<object>} { availability?, slots, meta }
 */
async function hourly(db, { scope, branchId, weekday, metric, now } = {}) {
  const branch = String(branchId || '').trim();
  if (!branch) throw err('VALIDATION_ERROR', 422, 'branchId مطلوب');
  if (!scope || (!scope.all && !((scope.branchIds || []).map(String).includes(branch)))) {
    throw err('PERMISSION_DENIED', 403, 'الفرع خارج نطاق صلاحياتك');
  }
  let wd = null;
  if (weekday != null && weekday !== '') {
    wd = Number(weekday);
    if (!Number.isInteger(wd) || wd < 0 || wd > 6) {
      throw err('VALIDATION_ERROR', 422, 'weekday يجب أن يكون رقمًا بين 0 (الأحد) و6 (السبت)');
    }
  }
  const metricKey = metric == null || metric === '' ? 'net_ex_vat' : String(metric);
  const valueCol = METRICS[metricKey];
  if (!valueCol) {
    throw err('VALIDATION_ERROR', 422, 'metric يجب أن يكون net_ex_vat أو orders أو guests');
  }

  // window: 56 days ending yesterday (server-local calendar).
  const nowDate = now instanceof Date ? now : new Date();
  const todayMs = Date.UTC(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate());
  const endMs = todayMs - 86400000;                       // yesterday
  const fromMs = endMs - (WINDOW_WEEKS * 7 - 1) * 86400000; // 56 days inclusive
  const from = _isoDay(fromMs);
  const to = _isoDay(endMs);

  const offsetMin = _dbOffsetMinutes(db);
  const [rows] = await db.query(
    `SELECT business_day, slot30, ${valueCol} AS value
       FROM analytics_hourly_branch
      WHERE branch_id = ? AND business_day BETWEEN ? AND ?`,
    [branch, from, to]);

  const meta = {
    basis: 'rollup',
    branchId: branch,
    metric: metricKey,
    from, to,
    weeksUsed: 0,
    generatedAt: new Date().toISOString(),
  };

  if (!rows.length) {
    // empty rollups → GLOBAL insufficient_history — never fabricate.
    return { availability: 'insufficient_history', slots: [], meta };
  }

  const history = [];
  const weekBuckets = new Set();
  for (const r of rows) {
    const day = _dayStr(r.business_day, offsetMin);
    const dayMs = Date.parse(day + 'T00:00:00Z');
    if (!Number.isFinite(dayMs)) continue;
    weekBuckets.add(Math.floor((endMs - dayMs) / (7 * 86400000)));
    history.push({
      weekday: new Date(dayMs).getUTCDay(),
      slot30: Number(r.slot30),
      value: Number(r.value),
    });
  }
  meta.weeksUsed = weekBuckets.size;

  let slots = forecastSlots(history); // defaults: minSamples 6, maxDispersion 0.6
  if (wd != null) slots = slots.filter((s) => s.weekday === wd);

  return { slots, meta };
}

module.exports = { hourly, WINDOW_WEEKS };
