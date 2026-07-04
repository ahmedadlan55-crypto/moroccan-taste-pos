'use strict';
/*
 * lib/unitConversion.js — PURE units-of-measure conversion engine.
 *
 * The whole system stores stock, lot balances, WAC and GL in the item's BASE
 * unit. This module converts an entered quantity (in any allowed unit) to the
 * base unit and back, using a per-item conversion factor:
 *
 *     1 <unit> = conversion_to_base × <base unit>
 *     baseQty  = enteredQty × conversion_to_base           (single-unit entry)
 *     baseQty  = majorQty × conversion_to_base + minorQty  (composite entry)
 *
 * No floats are trusted for storage — callers persist DECIMAL columns; this
 * module rounds deterministically (epsilon-safe) to a bounded precision so
 * repeated conversions never drift. It is intentionally dependency-free and
 * knows nothing about the database, so it is trivially unit-testable and can be
 * reused by every document route + the cashier.
 */

const MAX_PRECISION = 6; // qty columns are DECIMAL(…, ≤6)

// Deterministic, epsilon-safe rounding to `dp` decimal places.
function round(n, dp) {
  const p = Number.isFinite(dp) ? Math.max(0, Math.min(MAX_PRECISION, Math.trunc(dp))) : MAX_PRECISION;
  const f = Math.pow(10, p);
  // + Number.EPSILON * value scale guards against 0.1+0.2 style artifacts.
  return Math.round((Number(n) + Number.EPSILON * Math.sign(n || 1)) * f) / f;
}

function isValidFactor(factor) {
  const f = Number(factor);
  return Number.isFinite(f) && f > 0;
}

// enteredQty (in a unit whose factor is `factor`) → base units.
function toBase(enteredQty, factor, precision) {
  const q = Number(enteredQty);
  const f = Number(factor);
  if (!Number.isFinite(q)) throw new Error('INVALID_QTY');
  if (!isValidFactor(f)) throw new Error('INVALID_CONVERSION_FACTOR');
  return round(q * f, precision != null ? precision : MAX_PRECISION);
}

// base units → quantity expressed in the unit whose factor is `factor`.
function fromBase(baseQty, factor, precision) {
  const q = Number(baseQty);
  const f = Number(factor);
  if (!Number.isFinite(q)) throw new Error('INVALID_QTY');
  if (!isValidFactor(f)) throw new Error('INVALID_CONVERSION_FACTOR');
  return round(q / f, precision != null ? precision : MAX_PRECISION);
}

// Composite major+minor entry (e.g. 2 cartons + 3 pieces, factor 12) → 27 base.
// minorQty is always in BASE units (the minor unit IS the base unit).
function compositeToBase(majorQty, minorQty, factor, precision) {
  const maj = Number(majorQty) || 0;
  const min = Number(minorQty) || 0;
  const f = Number(factor);
  if (!Number.isFinite(maj) || !Number.isFinite(min)) throw new Error('INVALID_QTY');
  if (maj < 0 || min < 0) throw new Error('INVALID_QTY');
  if (!isValidFactor(f)) throw new Error('INVALID_CONVERSION_FACTOR');
  return round(maj * f + min, precision != null ? precision : MAX_PRECISION);
}

// base units → { major, minor } split by a major factor (e.g. 125, f=12 → 10 + 5).
// Only meaningful for integer-ish factors; for fractional factors major is the
// whole number of major units and minor is the remainder in base units.
function splitBaseToMajorMinor(baseQty, factor) {
  const q = Number(baseQty) || 0;
  const f = Number(factor);
  if (!isValidFactor(f)) return { major: 0, minor: round(q, MAX_PRECISION) };
  const major = Math.floor(round(q / f, MAX_PRECISION) + 1e-9);
  const minor = round(q - major * f, MAX_PRECISION);
  return { major, minor };
}

// Human label like "125 حبة = 10 كرتون + 5 حبة" (numbers rendered by caller; this
// returns the structured pieces + a default Arabic label using unit names).
function describeBase(baseQty, factor, baseUnitName, majorUnitName) {
  const q = round(Number(baseQty) || 0, MAX_PRECISION);
  const base = baseUnitName || '';
  if (!isValidFactor(factor) || !majorUnitName || Number(factor) <= 1) {
    return { major: 0, minor: q, factor: Number(factor) || 1, text: `${q} ${base}`.trim() };
  }
  const { major, minor } = splitBaseToMajorMinor(q, factor);
  const parts = [];
  if (major > 0) parts.push(`${major} ${majorUnitName}`);
  if (minor > 0 || major === 0) parts.push(`${minor} ${base}`);
  return { major, minor, factor: Number(factor), text: `${q} ${base} = ${parts.join(' + ')}`.trim() };
}

// ── validators over a list of item_units rows for one item ──────────────────
// row shape: { unitCode, isBase, conversionToBase, isActive }
function validateItemUnitSet(units) {
  const rows = Array.isArray(units) ? units : [];
  const bases = rows.filter((u) => u.isBase);
  if (bases.length !== 1) return { ok: false, code: bases.length === 0 ? 'NO_BASE_UNIT' : 'DUPLICATE_BASE_UNIT' };
  const base = bases[0];
  if (round(Number(base.conversionToBase), MAX_PRECISION) !== 1) return { ok: false, code: 'BASE_FACTOR_NOT_ONE' };
  const codes = new Set();
  for (const u of rows) {
    if (!isValidFactor(u.conversionToBase)) return { ok: false, code: 'INVALID_CONVERSION_FACTOR' };
    const c = String(u.unitCode || '').trim().toUpperCase();
    if (!c) return { ok: false, code: 'UNIT_REQUIRED' };
    if (codes.has(c)) return { ok: false, code: 'DUPLICATE_UNIT_CODE' };
    codes.add(c);
  }
  return { ok: true, base };
}

// context → the allow_* flag name on an item_units row.
const CONTEXT_FLAG = {
  purchase: 'allowPurchase', receipt: 'allowReceipt', issue: 'allowIssue',
  waste: 'allowIssue', transfer: 'allowTransfer', stocktake: 'allowStocktake',
  production: 'allowProduction', sale: 'allowSale', adjustment: 'allowStocktake',
};
function isUnitAllowed(unitRow, context) {
  if (!unitRow || unitRow.isActive === false) return false;
  const flag = CONTEXT_FLAG[context];
  if (!flag) return true; // unknown context → don't restrict
  // base unit is always allowed everywhere; major units gated by their flags
  if (unitRow.isBase) return true;
  return unitRow[flag] !== false && unitRow[flag] !== 0;
}

module.exports = {
  MAX_PRECISION,
  round,
  isValidFactor,
  toBase,
  fromBase,
  compositeToBase,
  splitBaseToMajorMinor,
  describeBase,
  validateItemUnitSet,
  isUnitAllowed,
  CONTEXT_FLAG,
};
