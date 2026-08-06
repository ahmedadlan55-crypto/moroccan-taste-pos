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
 * Σ of `ar_document_lines.gross_amount` — the money the customer was INVOICED
 * for the product lines.
 *
 * READ THE BASIS BEFORE USING IT. Despite the "gross" in the name this is
 * NOT pre-discount and NOT ex-VAT. Both writers produce net + VAT AFTER the
 * discount:
 *   • POS      routes/sales.js:1991 `grossAmount: a.gross`
 *              ← lineAllocation.js:263 `gross: fromMinor(netMinor + vatMinor)`,
 *                where net/vat are the RECONCILED post-discount category
 *                buckets (routes/sales.js:836-837).
 *   • ERP AR   calculations.js:138 `grossAmount = money(net + vatAmount)`,
 *                where `net = money(gross - discount)` (:135).
 * So: TAX-INCLUSIVE, AFTER line AND order discount. lineAllocation.js:242
 * further asserts Σ gross_amount === ar_documents.total_amount per sale, i.e.
 * this figure IS the invoice total, not a step on the way to it.
 *
 * Accepts an array of decimals, or a single already-summed decimal.
 */
function grossProductSales(lineGrossAmounts) {
  if (Array.isArray(lineGrossAmounts)) return sumMoney(lineGrossAmounts);
  return fromMinor(toMinor(lineGrossAmounts));
}

/**
 * Sales BEFORE discount, tax-inclusive = invoiced (incl. VAT) + discounts given.
 *
 * The pre-discount figure is stored NOWHERE: the checkout applies the discount
 * in gross space (routes/sales.js:720-736) and persists only the post-discount
 * line money plus the applied discount total, so the only honest reconstruction
 * is to add the discount back — in the SAME (tax-inclusive) space it was
 * recorded in. Adding it to an ex-VAT figure, or splitting it by (1+r), would
 * be an invention: `sales.discount_amount` carries no VAT breakdown.
 */
function salesBeforeDiscount(invoicedInclVat, discounts) {
  return fromMinor(toMinor(invoicedInclVat) + toMinor(discounts));
}

/**
 * Net sales after returns, TAX-INCLUSIVE = invoiced (incl. VAT) − returns
 * (incl. VAT). Both operands carry VAT (`d.gross_amount` / `rl.gross_amount`,
 * SalesReturnService.js:151 `gross: money(net + vat)`), so the subtraction is
 * basis-clean. Discounts are NOT subtracted here — they are already out of
 * `d.gross_amount`.
 */
function netSalesInclVat(invoicedInclVat, returnsInclVat) {
  return fromMinor(toMinor(invoicedInclVat) - toMinor(returnsInclVat));
}

/**
 * Net sales after returns, EX-VAT = net (ex-VAT) − returns net (ex-VAT).
 * `d.net_amount` and `rl.net_amount` (SalesReturnService.js:92) are both
 * ex-VAT and both already net of the original line's discount.
 */
function netSalesExVat(netExVat, returnsNet) {
  return fromMinor(toMinor(netExVat) - toMinor(returnsNet));
}

/**
 * OUTPUT VAT for a filing period = VAT charged on sales − VAT credited back on
 * returns.
 *
 * This is the number that goes on the return, and it is NOT `vat_amount`. The
 * taxes report showed `vat_amount` alone, which is VAT on sales only: every
 * refund the branch issued still carried its VAT in the figure, so the report
 * OVERSTATED the liability by the whole of `returns_vat` — in a month with a
 * single large refund, materially.
 *
 * A return is credited in the period it was RECORDED, not the period of the
 * original sale, which is how a credit note works and is stated in the
 * report's basis of preparation.
 *
 * Both operands are VAT amounts (`d.vat_amount` / `rl.vat_amount`), so this is
 * basis-clean by construction: there is no ex/incl question about a tax figure.
 */
function netVat(vatOnSales, vatOnReturns) {
  return fromMinor(toMinor(vatOnSales) - toMinor(vatOnReturns));
}

/**
 * Invoice headers − invoice lines. A CONTROL, not a business figure: for every
 * POS sale lineAllocation.js:242 refuses to project unless
 * Σ line gross === total_amount, so this is 0.00 whenever the projection did
 * its job. It goes non-zero only for a header with no (or stale) lines — e.g.
 * the headers the early backfill wrote before the line projection existed
 * (InvoiceService.js:251-254). Printing it beats hiding it inside a total.
 */
function statementVariance(invoiceTotal, invoicedInclVat) {
  return fromMinor(toMinor(invoiceTotal) - toMinor(invoicedInclVat));
}

/** Net including VAT = net (ex-VAT) + stored VAT amount. Never derives VAT. */
function netInclVat(netExVat, vatAmount) {
  return fromMinor(toMinor(netExVat) + toMinor(vatAmount));
}

/**
 * Invoice total = products + modifiers − discounts + fees + tax + rounding.
 * `tax` is the STORED vat amount; `rounding` may be negative.
 *
 * DOCUMENTATION ONLY for the `invoice_total` metric, which is
 * SUM(doc.total_amount) — a stored column, never this expression (QueryService
 * evaluates equations for DERIVED metrics only). And the stored column does
 * NOT match this shape on the POS path: `sales.total_final` is
 * routes/sales.js:753 `invTotal = grossPrecise` = post-discount net + VAT, with
 * NO fee and NO rounding term. `sales.kita_service_fee` (→ `fees_total`) is
 * persisted beside the total, never inside it, and `rounding_amount` is written
 * as a literal 0 (ProjectionService.js:284). Adding either to reach the invoice
 * total overstates it.
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

/** Net COGS after returns = sales COGS - COGS actually reversed on restock. */
function cogsAfterReturns(cogs, reversedCogs) {
  const inputs = [cogs, reversedCogs];
  if (inputs.some((v) => v == null || v === '' || !Number.isFinite(Number(v)))) return null;
  return fromMinor(toMinor(cogs) - toMinor(reversedCogs));
}

/**
 * Gross profit after returns, on one EX-VAT basis:
 *
 *   (sales net - returns net) - (sales COGS - returned COGS)
 *
 * A missing operand stays unknown. In particular, a missing cost snapshot must
 * never be coerced to zero and published as profit. Numeric zero, however, is
 * a real value: a period with no activity has SAR 0 profit, and a genuinely
 * zero-cost line remains calculable. The additive metrics feeding this
 * equation read only the stored at-transaction snapshots; no current recipe or
 * percentage-of-revenue cost is inferred here.
 */
function grossProfitAfterReturns(netExVat, cogs, returnsNet, reversedCogs) {
  const inputs = [netExVat, cogs, returnsNet, reversedCogs];
  if (inputs.some((v) => v == null || v === '' || !Number.isFinite(Number(v)))) return null;
  const netSales = toMinor(netExVat) - toMinor(returnsNet);
  const netCogs = toMinor(cogs) - toMinor(reversedCogs);
  return fromMinor(netSales - netCogs);
}

/**
 * Margin after returns = grossProfitAfterReturns / net sales after returns.
 * Null means either an input is unknown or the after-return revenue denominator
 * is zero. It is never reported as 0% merely because the ratio is undefined.
 */
function marginPctAfterReturns(netExVat, cogs, returnsNet, reversedCogs) {
  const inputs = [netExVat, cogs, returnsNet, reversedCogs];
  if (inputs.some((v) => v == null || v === '' || !Number.isFinite(Number(v)))) return null;
  const netSales = toMinor(netExVat) - toMinor(returnsNet);
  if (netSales === 0) return null;
  const netCogs = toMinor(cogs) - toMinor(reversedCogs);
  return round2(((netSales - netCogs) / netSales) * 100);
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

/**
 * Discount rate = discounts ÷ sales BEFORE the discount × 100, 2dp.
 *
 * THE DENOMINATOR WAS WRONG, AND UNBOUNDED.
 *   `invoicedInclVat` is Σ d.gross_amount, which is POST-discount:
 *   calculations.js:131-138 sets net = gross − discount then grossAmount =
 *   net + vat, and lineAllocation.js:242 refuses to project unless the lines
 *   sum to the final invoiced total. Dividing by it computed D / (S − D)
 *   instead of D / S. A day at exactly 10% policy printed 11.11% — and,
 *   because Discounts.tsx paints a cell amber at ≥ 10, flagged a compliant day.
 *   A 50%-off promotion printed 100.00%. The error grows without bound as the
 *   discount approaches the whole sale, and no quantity called a "rate" may
 *   exceed 100%.
 *
 *   The denominator is reconstructed here rather than taken from the
 *   `sales_before_discount` metric because the planner expands a derived
 *   metric into ADDITIVE inputs only (planner.js: "derived metric X has a
 *   non-additive input") — so the arithmetic has to live in the equation,
 *   which is also where the mutation catalog can cover it.
 *
 * Null when there were no sales to discount at all.
 */
function discountPct(discounts, invoicedInclVat) {
  const before = toMinor(invoicedInclVat) + toMinor(discounts);
  if (before === 0) return null;
  return round2((toMinor(discounts) / before) * 100);
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
  salesBeforeDiscount,
  netSalesInclVat,
  netSalesExVat,
  netVat,
  statementVariance,
  netInclVat,
  invoiceTotal,
  grossProfit,
  marginPct,
  cogsAfterReturns,
  grossProfitAfterReturns,
  marginPctAfterReturns,
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
