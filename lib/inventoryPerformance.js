/**
 * Inventory performance mathematics — the metrics every warehouse system in the
 * world is judged by: ABC/XYZ, turnover, days-on-hand, stock ageing.
 *
 * ─── WHY THIS FILE IS PURE ──────────────────────────────────────────────────
 * Every function here takes plain numbers and returns plain numbers. No `db`,
 * no `req`, no SQL. That is deliberate: a turnover ratio that is only exercised
 * through an HTTP route can only be tested by standing up a database, so in
 * practice it never gets tested at all — and a wrong divisor in a turnover
 * ratio is invisible (it produces a plausible number, not an error).
 *
 * ─── THE HONESTY RULE ───────────────────────────────────────────────────────
 * A metric whose denominator is missing returns **null**, never 0 and never a
 * guess. Zero turnover means "nothing moved"; null turnover means "there is no
 * inventory to divide by". Printing 0 for the second is a lie the reader cannot
 * detect. Every caller therefore has to decide how to render null — which is
 * the point.
 */
'use strict';

// Pareto cut-offs. Not configurable on purpose: A=80/B=95 is the convention
// every auditor and every textbook uses, and a per-tenant cut-off makes two
// warehouses' "class A" incomparable.
const ABC_A_CUTOFF = 80;
const ABC_B_CUTOFF = 95;

// Demand-variability cut-offs on the coefficient of variation.
const XYZ_X_CUTOFF = 0.5;
const XYZ_Y_CUTOFF = 1.0;

const AGING_BUCKETS = Object.freeze(['0_30', '31_60', '61_90', '91_180', 'over_180', 'never']);

function round(value, digits) {
  const d = digits == null ? 2 : digits;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

/**
 * Finite number or null — never NaN, never Infinity leaking into JSON.
 *
 * null/undefined/'' are rejected BEFORE the Number() coercion. `Number(null)`
 * is 0, so without this guard an absent coefficient of variation coerces to a
 * perfectly finite zero and `xyzClass` classifies "no demand at all" as X —
 * the steadiest class there is.
 */
function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pareto-classify rows by `value`, descending.
 *
 * The boundary rule matters and is the thing a mutant would flip: the item that
 * CROSSES 80% is still class A. Classification reads the cumulative share
 * BEFORE the row is added, so a single item worth 95% of consumption is A on
 * its own rather than being pushed into C by its own weight.
 *
 * Non-positive values (a return-only item, a zero-cost item) cannot participate
 * in a Pareto share, so they are class C with a zero share. They still appear —
 * dropping them would silently change the item count.
 */
function classifyAbc(rows) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  const positive = list.filter((row) => Number(row && row.value) > 0);
  const total = positive.reduce((sum, row) => sum + Number(row.value), 0);
  const sorted = list.sort((a, b) => Number(b && b.value || 0) - Number(a && a.value || 0));

  let cumulative = 0;
  return sorted.map((row) => {
    const value = Number(row && row.value) || 0;
    if (total <= 0 || value <= 0) {
      return Object.assign({}, row, { share: 0, cumulativeShare: round(cumulative, 2), abcClass: 'C' });
    }
    const share = (value / total) * 100;
    // Read the running total BEFORE this row: the straddling item stays in the
    // lower class.
    const before = cumulative;
    cumulative += share;
    const abcClass = before < ABC_A_CUTOFF ? 'A' : before < ABC_B_CUTOFF ? 'B' : 'C';
    return Object.assign({}, row, {
      share: round(share, 2),
      cumulativeShare: round(Math.min(cumulative, 100), 2),
      abcClass,
    });
  });
}

/** Roll classified rows up into the three class totals, always all three. */
function summarizeAbc(classified) {
  const rows = Array.isArray(classified) ? classified : [];
  const totalValue = rows.reduce((sum, row) => sum + Math.max(Number(row && row.value) || 0, 0), 0);
  return ['A', 'B', 'C'].map((abcClass) => {
    const members = rows.filter((row) => row && row.abcClass === abcClass);
    const value = members.reduce((sum, row) => sum + Math.max(Number(row.value) || 0, 0), 0);
    return {
      abcClass,
      items: members.length,
      qty: round(members.reduce((sum, row) => sum + (Number(row.qty) || 0), 0), 3),
      value: round(value, 2),
      // Share of consumption VALUE, not of the item count — the two differ by
      // an order of magnitude and confusing them is the classic ABC error.
      sharePct: totalValue > 0 ? round((value / totalValue) * 100, 2) : 0,
      itemSharePct: rows.length > 0 ? round((members.length / rows.length) * 100, 2) : 0,
    };
  });
}

/**
 * Turnover and days-on-hand from period consumption and the two period ends.
 *
 * Average inventory is the two-point mean — the standard when a valued daily
 * ledger does not exist. It is stated as the basis rather than implied.
 *
 * Both figures share ONE definition so they can never disagree:
 *     turnover  = consumption / averageInventory
 *     daysOnHand = days / turnover
 * Deriving daysOnHand independently is how a report ends up saying "turnover 4×
 * a year, 30 days of cover" — arithmetically impossible, and nobody notices.
 */
function turnover(input) {
  const source = input || {};
  const consumptionValue = Number(source.consumptionValue) || 0;
  const openingValue = Number(source.openingValue) || 0;
  const closingValue = Number(source.closingValue) || 0;
  const days = Number(source.days) || 0;

  const averageInventoryValue = round((openingValue + closingValue) / 2, 2);
  if (!(averageInventoryValue > 0)) {
    return { averageInventoryValue, turnoverRatio: null, daysOnHand: null, annualizedTurnover: null };
  }
  const turnoverRatio = round(consumptionValue / averageInventoryValue, 3);
  if (!(turnoverRatio > 0) || !(days > 0)) {
    return { averageInventoryValue, turnoverRatio, daysOnHand: null, annualizedTurnover: null };
  }
  return {
    averageInventoryValue,
    turnoverRatio,
    daysOnHand: round(days / turnoverRatio, 1),
    // Periods of unequal length are not comparable until they are annualised.
    annualizedTurnover: round(turnoverRatio * (365 / days), 3),
  };
}

/** Days since last consumption → ageing bucket. `null` days means never consumed. */
function agingBucket(daysSinceLastConsumption) {
  const days = daysSinceLastConsumption;
  if (days == null || !Number.isFinite(Number(days))) return 'never';
  const d = Number(days);
  if (d <= 30) return '0_30';
  if (d <= 60) return '31_60';
  if (d <= 90) return '61_90';
  if (d <= 180) return '91_180';
  return 'over_180';
}

// A demand pattern is a claim about behaviour over time. Two observations
// cannot establish one, and ONE observation has a variance of exactly zero —
// which classifies "sold once, ever" as the steadiest item in the warehouse.
// Live data made this concrete: 13 of 15 top-consumed items had a single
// movement bucket and every one came back X.
const XYZ_MIN_OBSERVATIONS = 3;

/**
 * Coefficient of variation of a demand series — the X/Y/Z input.
 *
 * POPULATION standard deviation (÷ n), not the sample estimator (÷ n−1): the
 * buckets ARE the period, not a sample drawn from it. Using n−1 inflates every
 * short series and would push seasonal items into Z for no reason.
 *
 * Returns null when the mean is zero — an item with no demand has no demand
 * variability, and 0 would read as "perfectly stable" — and null below
 * XYZ_MIN_OBSERVATIONS buckets, where no pattern exists to measure.
 */
function coefficientOfVariation(series, options) {
  const minObservations = Number((options || {}).minObservations) || XYZ_MIN_OBSERVATIONS;
  const values = (Array.isArray(series) ? series : []).map(Number).filter(Number.isFinite);
  if (values.length < minObservations) return null;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  if (!(mean > 0)) return null;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  return round(Math.sqrt(variance) / mean, 3);
}

/** CV → X (steady) / Y (variable) / Z (erratic). Null CV has no class. */
function xyzClass(cv) {
  const value = finiteOrNull(cv);
  if (value == null) return null;
  if (value <= XYZ_X_CUTOFF) return 'X';
  if (value <= XYZ_Y_CUTOFF) return 'Y';
  return 'Z';
}

/**
 * Days-of-cover for ONE item: on-hand ÷ average daily consumption.
 *
 * Null when nothing was consumed — "infinite cover" is not a number a buyer can
 * act on, and rendering it as a very large number puts dead stock at the TOP of
 * a "best covered" sort.
 */
function daysOfCover(onHandQty, consumedQty, days) {
  const hand = Number(onHandQty) || 0;
  const consumed = Number(consumedQty) || 0;
  const span = Number(days) || 0;
  if (!(consumed > 0) || !(span > 0)) return null;
  const perDay = consumed / span;
  return round(hand / perDay, 1);
}

/** Inclusive day count of a [from, to] calendar range; at least 1. */
function rangeDays(from, to) {
  const start = Date.parse(String(from) + 'T00:00:00Z');
  const end = Date.parse(String(to) + 'T00:00:00Z');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 1;
  return Math.max(1, Math.round((end - start) / 86400000) + 1);
}

module.exports = {
  ABC_A_CUTOFF,
  ABC_B_CUTOFF,
  XYZ_X_CUTOFF,
  XYZ_Y_CUTOFF,
  XYZ_MIN_OBSERVATIONS,
  AGING_BUCKETS,
  round,
  finiteOrNull,
  classifyAbc,
  summarizeAbc,
  turnover,
  agingBucket,
  coefficientOfVariation,
  xyzClass,
  daysOfCover,
  rangeDays,
};
