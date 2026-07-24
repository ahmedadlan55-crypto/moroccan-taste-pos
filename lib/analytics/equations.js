/**
 * lib/analytics/equations.js — the ONE arithmetic contract for sales analytics.
 *
 * WHY INTEGER HALALAS
 * Float sums do not close (`0.1 + 0.2 !== 0.3`), and the repo already carries
 * divergent rounding contracts (lib/pricing.js::_round2 with no epsilon vs
 * calculations.js::round with 1e-9) that disagree at .005 boundaries. Every
 * money function here accepts decimals, converts to integer halalas ONCE,
 * computes in integers, and converts back ONCE at the edge. Mirrors
 * lib/order-to-cash/lineAllocation.js.
 *
 * ROUNDING CONTRACT
 * Round half AWAY FROM ZERO at 2dp, exactly once, at the edge. A 1e-9 epsilon
 * on the magnitude absorbs binary representation error (so a literal 2.005
 * rounds to 2.01, and an accumulated 0.30000000000000004 rounds to 0.30)
 * without changing any honest value. Negative values mirror positives.
 *
 * NO VAT CONSTANTS
 * Nothing in this module knows a tax rate. VAT amounts arrive as stored data
 * (vat_amount columns) and are only ever added or subtracted, never derived.
 *
 * RATIOS
 * Ratio/percentage functions with a zero denominator return null (an honest
 * "undefined"), never 0 and never Infinity — a 0 would read as "0% margin"
 * on a day with no sales, which is a lie.
 *
 * This module is pure: no DB, no clock, no config. Same inputs → same output.
 */
'use strict';

/** Decimal SAR → integer halalas, half away from zero, epsilon-corrected. */
function toMinor(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const sign = n < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(n) * 100 + 1e-9);
}

/** Integer halalas → decimal SAR. */
function fromMinor(minor) {
  return minor / 100;
}

/** Round a decimal to 2dp, half away from zero (the ONE edge rounding). */
function roundMoney(value) {
  return fromMinor(toMinor(value));
}

/** Round an arbitrary ratio/percent to 2dp, half away from zero. */
function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const sign = n < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(n) * 100 + 1e-9)) / 100;
}

/** Σ of decimal money values — summed raw in halalas, rounded once. */
function sumMoney(values) {
  let total = 0;
  for (const v of values || []) total += toMinor(v);
  return fromMinor(total);
}

// ─── product sales ──────────────────────────────────────────────────────────

/**
 * Gross product sales: Σ line gross amounts (pre-discount product money).
 * Accepts an array of decimals, or a single already-summed decimal.
 */
function grossProductSales(lineGrossAmounts) {
  if (Array.isArray(lineGrossAmounts)) return sumMoney(lineGrossAmounts);
  return fromMinor(toMinor(lineGrossAmounts));
}

/** Net product sales = gross − discounts − net returns. */
function netProductSales(gross, discounts, returnsNet) {
  return fromMinor(toMinor(gross) - toMinor(discounts) - toMinor(returnsNet));
}

/** Net including VAT = net (ex-VAT) + stored VAT amount. Never derives VAT. */
function netInclVat(netExVat, vatAmount) {
  return fromMinor(toMinor(netExVat) + toMinor(vatAmount));
}

/**
 * Invoice total = products + modifiers − discounts + fees + tax + rounding.
 * `tax` is the STORED vat amount; `rounding` may be negative.
 */
function invoiceTotal(products, modifiers, discounts, fees, tax, rounding) {
  return fromMinor(
    toMinor(products) + toMinor(modifiers) - toMinor(discounts) +
    toMinor(fees) + toMinor(tax) + toMinor(rounding)
  );
}

// ─── profitability ──────────────────────────────────────────────────────────

/** Gross profit = net (ex-VAT) − COGS. */
function grossProfit(netExVat, cogs) {
  return fromMinor(toMinor(netExVat) - toMinor(cogs));
}

/** Margin % = grossProfit / netExVat × 100, 2dp; null when net is 0. */
function marginPct(netExVat, cogs) {
  const net = toMinor(netExVat);
  if (net === 0) return null;
  return round2(((net - toMinor(cogs)) / net) * 100);
}

// ─── collections & till ─────────────────────────────────────────────────────

/** Net collections = settled payments − refunds. */
function netCollections(settled, refunds) {
  return fromMinor(toMinor(settled) - toMinor(refunds));
}

/** Expected cash = openFloat + cashSales − cashReturns + payIns − payOuts. */
function expectedCash(openFloat, cashSales, cashReturns, payIns, payOuts) {
  return fromMinor(
    toMinor(openFloat) + toMinor(cashSales) - toMinor(cashReturns) +
    toMinor(payIns) - toMinor(payOuts)
  );
}

/** Till variance = counted − expected (negative = shortage). */
function tillVariance(counted, expected) {
  return fromMinor(toMinor(counted) - toMinor(expected));
}

// ─── averages & rates ───────────────────────────────────────────────────────

/** Average ticket = net (ex-VAT) / orders, 2dp; null when orders is 0. */
function avgTicket(netExVat, orders) {
  const n = Number(orders);
  if (!Number.isFinite(n) || n === 0) return null;
  return round2(fromMinor(toMinor(netExVat)) / n);
}

/** Average items per order, 2dp; null when orders is 0. */
function avgItemsPerOrder(itemsQty, orders) {
  const n = Number(orders);
  if (!Number.isFinite(n) || n === 0) return null;
  return round2(Number(itemsQty) / n);
}

/** Discount % = discounts / gross × 100, 2dp; null when gross is 0. */
function discountPct(discounts, gross) {
  const g = toMinor(gross);
  if (g === 0) return null;
  return round2((toMinor(discounts) / g) * 100);
}

/** Attach rate = modifier lines per 100 sold items, 2dp; null on 0 items. */
function attachRate(modifierCount, itemCount) {
  const items = Number(itemCount);
  if (!Number.isFinite(items) || items === 0) return null;
  return round2((Number(modifierCount) / items) * 100);
}

/** Average modifiers per item, 2dp; null when items is 0. */
function avgModifiersPerItem(modifierQty, itemCount) {
  const items = Number(itemCount);
  if (!Number.isFinite(items) || items === 0) return null;
  return round2(Number(modifierQty) / items);
}

/**
 * Generic rate % — part / whole × 100, 2dp; null when whole is 0.
 * Used for discount_rate_by_cashier, void_rate_by_cashier,
 * return_rate_by_cashier (counts in, percentage out).
 */
function ratePct(part, whole) {
  const w = Number(whole);
  if (!Number.isFinite(w) || w === 0) return null;
  return round2((Number(part) / w) * 100);
}

/** Contribution % — a row's share of the total, 2dp; null when total is 0. */
function contributionPct(part, whole) {
  return ratePct(part, whole);
}

/** Net quantity = sold − returned (quantities, not money; no rounding). */
function netQuantity(sold, returned) {
  return Number(sold || 0) - Number(returned || 0);
}

/**
 * Growth % = (current − previous) / |previous| × 100, 2dp.
 * null when previous is 0 (growth from nothing is undefined, not infinite).
 */
function growth(current, previous) {
  const prev = Number(previous);
  if (!Number.isFinite(prev) || prev === 0) return null;
  return round2(((Number(current) - prev) / Math.abs(prev)) * 100);
}

module.exports = {
  toMinor,
  fromMinor,
  roundMoney,
  round2,
  sumMoney,
  grossProductSales,
  netProductSales,
  netInclVat,
  invoiceTotal,
  grossProfit,
  marginPct,
  netCollections,
  expectedCash,
  tillVariance,
  avgTicket,
  avgItemsPerOrder,
  discountPct,
  attachRate,
  avgModifiersPerItem,
  ratePct,
  contributionPct,
  netQuantity,
  growth,
};
