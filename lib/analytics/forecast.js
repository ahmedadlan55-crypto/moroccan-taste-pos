/**
 * lib/analytics/forecast.js — robust per-slot forecasting from history.
 *
 * MODEL (deliberately boring): for each (weekday, slot30) cell, the point
 * forecast is the MEDIAN of the historical values and the band is
 * ±1.4826 × MAD (median absolute deviation, scaled so it estimates σ under
 * normality). Median/MAD instead of mean/stddev because restaurant slot data
 * is spiky — one Eid evening or one bulk order would drag a mean forecast
 * for weeks, while the median shrugs it off.
 *
 * SUPPRESSION (honesty beats coverage): a cell is reported as
 * { availability: 'insufficient_history' } instead of a number when
 *   - samples < opts.minSamples (default 6), OR
 *   - MAD / median > opts.maxDispersion (default 0.6) — the history is so
 *     volatile that a point forecast would be noise dressed as signal.
 *     A zero median with non-zero MAD is treated as infinitely dispersed
 *     (suppressed); a zero median with zero MAD is a confidently-dead slot
 *     (kept, forecast 0).
 *
 * Pure + deterministic: no clock, no RNG, no DB. Output is sorted by
 * (weekday, slot30) so a re-run is byte-identical.
 */
'use strict';

const MAD_SCALE = 1.4826;

/** Median of a numeric array (input is not mutated). Empty → null. */
function median(values) {
  const v = values.slice().sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Median absolute deviation around `center`. */
function mad(values, center) {
  return median(values.map((x) => Math.abs(x - center)));
}

/** Round half away from zero at 2dp (same edge contract as equations.js). */
function round2(n) {
  const sign = n < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(n) * 100 + 1e-9)) / 100;
}

/**
 * @param {Array<{weekday:number, slot30:number, value:number}>} historyRows
 *        One row per historical observation (one business day's value for
 *        that weekday+slot). weekday 0..6, slot30 0..47.
 * @param {object} [opts] { minSamples = 6, maxDispersion = 0.6,
 *                          clampLowAtZero = true }
 * @returns {Array} per distinct (weekday, slot30), sorted:
 *        { weekday, slot30, point, low, high, samples }  — forecastable
 *        { weekday, slot30, availability: 'insufficient_history', samples }
 */
function forecastSlots(historyRows, opts) {
  const o = opts || {};
  const minSamples = o.minSamples == null ? 6 : o.minSamples;
  const maxDispersion = o.maxDispersion == null ? 0.6 : o.maxDispersion;
  const clampLowAtZero = o.clampLowAtZero !== false;

  const cells = new Map(); // 'weekday:slot30' → number[]
  for (const row of historyRows || []) {
    const wd = Number(row.weekday), slot = Number(row.slot30), val = Number(row.value);
    if (!Number.isInteger(wd) || !Number.isInteger(slot) || !Number.isFinite(val)) continue;
    const key = wd + ':' + slot;
    let arr = cells.get(key);
    if (!arr) { arr = []; cells.set(key, arr); }
    arr.push(val);
  }

  const out = [];
  for (const [key, values] of cells) {
    const [wd, slot] = key.split(':').map(Number);
    const samples = values.length;

    if (samples < minSamples) {
      out.push({ weekday: wd, slot30: slot, availability: 'insufficient_history', samples });
      continue;
    }

    const point = median(values);
    const rawMad = mad(values, point);
    // Dispersion gate — see header for the zero-median cases.
    const tooDispersed = point === 0 ? rawMad > 0 : rawMad / Math.abs(point) > maxDispersion;
    if (tooDispersed) {
      out.push({ weekday: wd, slot30: slot, availability: 'insufficient_history', samples });
      continue;
    }

    const band = MAD_SCALE * rawMad;
    let low = point - band;
    // Clamp only for non-negative points: forcing a negative slot's low up to
    // zero would put `low` ABOVE `point`, which is incoherent.
    if (clampLowAtZero && low < 0 && point >= 0) low = 0;
    out.push({
      weekday: wd,
      slot30: slot,
      point: round2(point),
      low: round2(low),
      high: round2(point + band),
      samples,
    });
  }

  out.sort((a, b) => (a.weekday - b.weekday) || (a.slot30 - b.slot30));
  return out;
}

module.exports = { forecastSlots, median, mad, MAD_SCALE };
