/**
 * lib/pricing.js — Central tax + pricing math (v6.20.0)
 * ============================================================
 * THE SINGLE SOURCE OF TRUTH for VAT calculations.  Used by:
 *   • routes/sales.js — when a sale is posted
 *   • routes/erp/vat.js — when VAT reports are generated
 *   • Implicitly by frontend (POS + Admin) which duplicate the
 *     splitLinePrice math; backend is authoritative.
 *
 * Why this exists
 *   Pre-v6.20.0, VAT rate was hardcoded in two ways:
 *     - `const VAT_RATE = Number(process.env.VAT_RATE) || 15` in sales.js
 *     - `total / 1.15` literals scattered in vat.js, app.js, etc.
 *   The settings table held a `VATRate` key that was ignored at sale
 *   time.  Owner now wants:
 *     1) VAT rate read from settings (configurable, live-effective)
 *     2) Per-product "is tax inclusive" flag honored
 *     3) Customer-facing total rounded to a WHOLE number (no decimals)
 *
 * Public API
 *   splitLinePrice(price, isInclusive, ratePct)
 *     → { net, vat, grossPrecise, grossWhole }
 *
 *   computeCartTotals(items, ratePct, discount)
 *     → { subtotalNet, vatTotal, grandTotalPrecise, grandTotalWhole }
 *
 *   getVatRateFromSettings(settingsObjectOrRow, fallback)
 *     → number (defaults 15)
 *
 *   getVatRateFromDb(db, fallback) → Promise<number>
 *
 *   roundToWhole(amount) → integer
 *
 * Invariants
 *   • All amounts are floats internally.
 *   • Rounding for storage: 2 decimals on net/vat (financial precision),
 *     0 decimals on customer-facing total (owner request).
 *   • Tax breakdown (net + vat) must always sum to grossPrecise exactly
 *     to satisfy ZATCA invoice validation.
 *   • grossWhole = Math.round(grossPrecise) — used ONLY for display
 *     and as the sales.total_final stored value.
 */
'use strict';

const DEFAULT_VAT_RATE = 15;

/**
 * Round to 2 decimal places (financial precision).  Used for net / vat
 * intermediates so the ZATCA breakdown stays consistent.
 */
function _round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Round to whole integer (customer-facing display + total_final
 * persistence).  Standard half-up rounding via Math.round.
 */
function roundToWhole(amount) {
  return Math.round(Number(amount) || 0);
}

/**
 * Decompose a single line's price into net / vat / gross.
 *
 * @param {number} price       - the stored price for this line item
 * @param {boolean} isInclusive - true if `price` already includes VAT
 * @param {number} ratePct     - VAT rate as percent (e.g. 15 = 15%)
 * @returns {object} { net, vat, grossPrecise, grossWhole }
 *
 * Behavior:
 *   isInclusive === true:
 *     - grossPrecise = price (already tax-inclusive)
 *     - net = price / (1 + rate/100)
 *     - vat = grossPrecise - net
 *   isInclusive === false:
 *     - net = price (price is net of tax)
 *     - vat = net * (rate/100)
 *     - grossPrecise = net + vat
 *
 *   grossWhole = Math.round(grossPrecise) — the customer-facing total.
 *   When the cart contains multiple lines, prefer computing
 *   grossPrecise at the CART level and rounding ONCE; per-line rounding
 *   accumulates drift.  See computeCartTotals().
 */
function splitLinePrice(price, isInclusive, ratePct) {
  const p = Number(price) || 0;
  const r = Number(ratePct);
  const rate = (Number.isFinite(r) && r >= 0) ? r : DEFAULT_VAT_RATE;

  let net, vat, grossPrecise;
  if (isInclusive) {
    grossPrecise = p;
    net = p / (1 + rate / 100);
    vat = grossPrecise - net;
  } else {
    net = p;
    vat = net * (rate / 100);
    grossPrecise = net + vat;
  }

  return {
    net: _round2(net),
    vat: _round2(vat),
    grossPrecise: _round2(grossPrecise),
    grossWhole: roundToWhole(grossPrecise)
  };
}

/** Round to 4 decimal places — the precision menu.price is stored at (see
 *  db/migrations/0023_whole_riyal_pricing.sql for why 2 is not enough). */
function _round4(n) {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

/** Tax categories that actually carry VAT. Z (zero-rated), E (exempt) and
 *  O (out-of-scope) are always 0%, so their price IS already the final one. */
const TAXED_CATEGORIES = { S: true, Z: false, E: false, O: false };

/**
 * Snap a stored price so the CUSTOMER-FACING (VAT-inclusive) amount lands on a
 * whole riyal.
 *
 * The register advertises the inclusive amount on the product card, and the
 * owner wants that number free of halalas. Prices are stored NET for every
 * current row (is_tax_inclusive=0), so the whole-riyal target has to be hit by
 * adjusting the stored net: net = target / (1 + rate).
 *
 * VERIFIES ITS OWN RESULT. `menu.price` is DECIMAL(10,4) and at that precision
 * every integer target is reachable — but the caller may be writing to a column
 * that has not been widened yet, or a future VAT rate may behave differently.
 * Rather than trust the arithmetic, the round-trip is recomputed and `exact`
 * reports whether it actually landed. A caller that gets exact=false must
 * surface the row for review, never silently persist a price that would put the
 * screen and the invoice back out of step.
 *
 * @param {number} price        - stored price (net, unless isInclusive)
 * @param {object} opts
 * @param {string} opts.taxCategory - 'S' | 'Z' | 'E' | 'O' (default 'S')
 * @param {boolean} opts.isInclusive - true if `price` already contains VAT
 * @param {number} opts.ratePct  - VAT rate as percent (default 15)
 * @returns {object} {
 *   price,        // the price to store (4dp) — unchanged when already whole
 *   target,       // the whole-riyal inclusive amount aimed for
 *   inclusiveBefore, // what the inclusive amount was
 *   changed,      // whether `price` differs from the input
 *   exact         // whether the round-trip actually lands on `target`
 * }
 */
function snapToWholeRiyal(price, opts) {
  const o = opts || {};
  const p = Number(price) || 0;
  const category = o.taxCategory == null ? 'S' : String(o.taxCategory);
  const r = Number(o.ratePct);
  const ratePct = (Number.isFinite(r) && r >= 0) ? r : DEFAULT_VAT_RATE;
  // Z/E/O never carry VAT, so their stored price IS the customer-facing one.
  const rate = TAXED_CATEGORIES[category] === false ? 0 : ratePct / 100;

  // A price stored INCLUSIVE is already the customer-facing figure.
  const inclusiveBefore = _round2(o.isInclusive ? p : p * (1 + rate));
  let target = roundToWhole(inclusiveBefore);
  // Never zero out a sellable item: a 0.40 SAR row would round to 0 and become
  // free. Floor at 1 riyal and let the caller flag it for a human.
  if (target < 1 && p > 0) target = 1;

  const next = _round4(o.isInclusive ? target : target / (1 + rate));
  const roundTrip = _round2(o.isInclusive ? next : next * (1 + rate));

  return {
    price: next,
    target: target,
    inclusiveBefore: inclusiveBefore,
    changed: next !== _round4(p),
    exact: roundTrip === target
  };
}

/**
 * Aggregate totals for a multi-line cart, applying an optional
 * cart-level discount BEFORE computing VAT (the standard order in
 * Saudi POS — discount the net, then add VAT on the net-after-discount).
 *
 * @param {Array<object>} items
 *   Each item must have:
 *     - price: number (stored price)
 *     - qty: number
 *     - isInclusive: boolean (resolved from menu.is_tax_inclusive)
 * @param {number} ratePct - VAT rate (15)
 * @param {number} discount - cart-level discount amount (in net SAR)
 * @returns {object} {
 *   subtotalNet,       // total net before discount
 *   discountApplied,   // capped at subtotalNet
 *   netAfterDiscount,  // subtotalNet - discountApplied
 *   vatTotal,          // VAT on netAfterDiscount
 *   grandTotalPrecise, // netAfterDiscount + vatTotal  (decimal)
 *   grandTotalWhole    // Math.round(grandTotalPrecise) (integer)
 * }
 */
function computeCartTotals(items, ratePct, discount) {
  const rate = Number.isFinite(Number(ratePct)) ? Number(ratePct) : DEFAULT_VAT_RATE;
  const list = Array.isArray(items) ? items : [];

  let subtotalNet = 0;
  list.forEach(function (it) {
    const qty = Number(it.qty) || 0;
    const split = splitLinePrice(it.price, !!it.isInclusive, rate);
    subtotalNet += split.net * qty;
  });
  subtotalNet = _round2(subtotalNet);

  const rawDisc = Math.max(0, Number(discount) || 0);
  const discountApplied = Math.min(rawDisc, subtotalNet);
  const netAfterDiscount = _round2(subtotalNet - discountApplied);

  const vatTotal = _round2(netAfterDiscount * (rate / 100));
  const grandTotalPrecise = _round2(netAfterDiscount + vatTotal);
  const grandTotalWhole = roundToWhole(grandTotalPrecise);

  return {
    subtotalNet: subtotalNet,
    discountApplied: discountApplied,
    netAfterDiscount: netAfterDiscount,
    vatTotal: vatTotal,
    grandTotalPrecise: grandTotalPrecise,
    grandTotalWhole: grandTotalWhole
  };
}

/**
 * Read the VAT rate from a settings object (key/value map already
 * loaded) or a raw rows array.  Always falls back to 15.
 */
function getVatRateFromSettings(settings, fallback) {
  const fb = Number.isFinite(Number(fallback)) ? Number(fallback) : DEFAULT_VAT_RATE;
  if (!settings) return fb;
  // Map shape: { VATRate: '15', ... }
  if (typeof settings.VATRate !== 'undefined') {
    const v = Number(settings.VATRate);
    return Number.isFinite(v) && v >= 0 ? v : fb;
  }
  // Row-array shape: [{ setting_key, setting_value }]
  if (Array.isArray(settings)) {
    const row = settings.find(function (r) { return r && r.setting_key === 'VATRate'; });
    if (row) {
      const v = Number(row.setting_value);
      return Number.isFinite(v) && v >= 0 ? v : fb;
    }
  }
  return fb;
}

/**
 * Live DB lookup of the VAT rate.  Used by routes that want the
 * most-current value without depending on cached settings.  Tolerates
 * a missing settings table (older deploys) by returning fallback.
 */
async function getVatRateFromDb(db, fallback) {
  const fb = Number.isFinite(Number(fallback)) ? Number(fallback) : DEFAULT_VAT_RATE;
  if (!db || typeof db.query !== 'function') return fb;
  try {
    const [rows] = await db.query(
      "SELECT setting_value FROM settings WHERE setting_key = 'VATRate' LIMIT 1"
    );
    if (rows && rows.length) {
      const v = Number(rows[0].setting_value);
      if (Number.isFinite(v) && v >= 0) return v;
    }
  } catch (e) {
    // Settings table missing on legacy deploys — fall through to fb.
  }
  return fb;
}

module.exports = {
  DEFAULT_VAT_RATE: DEFAULT_VAT_RATE,
  TAXED_CATEGORIES: TAXED_CATEGORIES,
  splitLinePrice: splitLinePrice,
  computeCartTotals: computeCartTotals,
  roundToWhole: roundToWhole,
  snapToWholeRiyal: snapToWholeRiyal,
  getVatRateFromSettings: getVatRateFromSettings,
  getVatRateFromDb: getVatRateFromDb
};
