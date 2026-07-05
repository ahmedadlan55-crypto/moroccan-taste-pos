/**
 * lib/procurement/calculations.js — pure money / UoM / VAT / totals engine.
 *
 * All monetary + quantity math is centralized here so totals are computed on
 * the server and the client is never trusted. Rounding is half-up at a fixed
 * scale to avoid binary-float drift (we never carry a float as the accounting
 * source of truth — every persisted number is rounded through `round()`).
 *
 * UoM model (matches inv_items.unit / big_unit / conv_rate and po_lines):
 *   factor      = base units per ENTERED unit   (e.g. 12 pieces per carton)
 *   baseQty     = enteredQty * factor
 *   baseUnitPrice = unitPriceEntered / factor   (majorPrice = basePrice*factor)
 *
 * VAT:
 *   resolveVatRate never does `rate || 15` — a real 0 is preserved. Tax codes:
 *     S / S15 → standard (settings VATRate, default 15)
 *     Z       → zero-rated (0)
 *     E       → exempt (0)
 *     O       → out of scope (0)
 */
'use strict';

const DEFAULT_STANDARD_RATE = 15;

function _num(v, dflt = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/** Half-up rounding at `dp` decimals, float-drift safe. */
function round(value, dp = 4) {
  const n = _num(value, 0);
  const f = Math.pow(10, dp);
  // add a tiny epsilon proportional to magnitude to counter 0.005 → 0.00499999
  const eps = n >= 0 ? 1e-9 : -1e-9;
  return Math.round((n + eps) * f) / f;
}

const money = (v) => round(v, 2);   // presentation / GL scale
const qty = (v) => round(v, 4);     // quantity scale
const rate = (v) => round(v, 6);    // unit price at base scale

/**
 * Resolve the effective VAT percentage. Never clobbers a real 0.
 * @returns {{ rate:number, taxable:boolean, code:string }}
 */
function resolveVatRate({ vatRate, taxCode, standardRate } = {}) {
  const std = Number.isFinite(Number(standardRate)) ? Number(standardRate) : DEFAULT_STANDARD_RATE;
  // explicit numeric rate wins (including 0)
  if (vatRate != null && vatRate !== '' && Number.isFinite(Number(vatRate))) {
    const r = Number(vatRate);
    if (r < 0 || r > 100) throw Object.assign(new Error('نسبة ضريبة غير صالحة'), { code: 'TAX_CONFIGURATION_ERROR' });
    return { rate: r, taxable: r > 0, code: taxCode || (r > 0 ? 'S' : 'Z') };
  }
  const code = String(taxCode || 'S').toUpperCase();
  if (code === 'Z') return { rate: 0, taxable: false, code: 'Z' };
  if (code === 'E') return { rate: 0, taxable: false, code: 'E' };
  if (code === 'O') return { rate: 0, taxable: false, code: 'O' };
  if (code === 'S' || code === 'S15' || code === '') return { rate: std, taxable: std > 0, code: 'S' };
  // unknown code → configuration error (never silently default to 15)
  throw Object.assign(new Error(`رمز ضريبي غير معروف: ${taxCode}`), { code: 'TAX_CONFIGURATION_ERROR' });
}

/** baseQty = enteredQty * factor. */
function toBaseQty(enteredQty, factor) {
  const f = _num(factor, 1);
  if (f <= 0) throw Object.assign(new Error('معامل تحويل غير صالح'), { code: 'UNIT_CONVERSION_CONFLICT' });
  return qty(_num(enteredQty) * f);
}

/** baseUnitPrice = unitPriceEntered / factor. */
function toBaseUnitPrice(unitPriceEntered, factor) {
  const f = _num(factor, 1);
  if (f <= 0) throw Object.assign(new Error('معامل تحويل غير صالح'), { code: 'UNIT_CONVERSION_CONFLICT' });
  return rate(_num(unitPriceEntered) / f);
}

/** majorPrice = basePrice * factor (spec §8.6). */
function toMajorPrice(basePrice, factor) {
  return money(_num(basePrice) * _num(factor, 1));
}

/**
 * Compute a single line's financials.
 * @param {object} line { enteredQty, factor, unitPriceEntered, discount,
 *                        vatRate, taxCode, inclusiveTax }
 * @param {number} standardRate settings VATRate
 * @returns full line breakdown
 */
function computeLine(line, standardRate) {
  const factor = _num(line.factor, 1);
  const enteredQty = _num(line.enteredQty);
  if (enteredQty <= 0) throw Object.assign(new Error('الكمية يجب أن تكون أكبر من صفر'), { code: 'VALIDATION_ERROR' });
  const unitPriceEntered = _num(line.unitPriceEntered);
  if (unitPriceEntered < 0) throw Object.assign(new Error('السعر لا يمكن أن يكون سالبًا'), { code: 'VALIDATION_ERROR' });

  const baseQty = toBaseQty(enteredQty, factor);
  const discount = money(_num(line.discount));
  const vr = resolveVatRate({ vatRate: line.vatRate, taxCode: line.taxCode, standardRate });

  const gross = money(enteredQty * unitPriceEntered);   // in entered units
  let net, vatAmount;
  if (line.inclusiveTax && vr.rate > 0) {
    const grossAfterDisc = money(gross - discount);
    net = money(grossAfterDisc / (1 + vr.rate / 100));
    vatAmount = money(grossAfterDisc - net);
  } else {
    net = money(gross - discount);
    vatAmount = money(net * (vr.rate / 100));
  }
  const lineTotal = money(net + vatAmount);
  const baseUnitPrice = toBaseUnitPrice(unitPriceEntered, factor);

  return {
    baseQty,
    baseUnitPrice,
    factor,
    enteredQty: qty(enteredQty),
    unitPriceEntered: money(unitPriceEntered),
    discount,
    vatRate: vr.rate,
    taxCode: vr.code,
    inclusiveTax: !!line.inclusiveTax,
    net,
    vatAmount,
    lineTotal,
  };
}

/** Aggregate document totals from computed lines. */
function computeTotals(computedLines) {
  let subtotal = 0, discountTotal = 0, vatTotal = 0;
  for (const l of computedLines) {
    subtotal += l.net;
    discountTotal += l.discount;
    vatTotal += l.vatAmount;
  }
  subtotal = money(subtotal);
  vatTotal = money(vatTotal);
  discountTotal = money(discountTotal);
  return { subtotal, discountAmount: discountTotal, vatAmount: vatTotal, total: money(subtotal + vatTotal) };
}

/** Weighted-average cost after receiving qty at unitCost onto an existing stock. */
function newWAC(stockBefore, costBefore, addQty, addUnitCost) {
  const sb = _num(stockBefore), cb = _num(costBefore), aq = _num(addQty), au = _num(addUnitCost);
  const denom = sb + aq;
  if (denom <= 0) return rate(au);
  return rate((sb * cb + aq * au) / denom);
}

module.exports = {
  round, money, qty, rate,
  resolveVatRate, toBaseQty, toBaseUnitPrice, toMajorPrice,
  computeLine, computeTotals, newWAC,
  DEFAULT_STANDARD_RATE,
};
