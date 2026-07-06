/**
 * lib/order-to-cash/calculations.js — pure money / UoM / VAT / totals engine for
 * the Order-to-Cash cycle. Identical math contract to lib/procurement/calculations
 * (server-authoritative totals, half-up rounding at a fixed scale, 0%-safe VAT).
 *
 * VAT categories (ZATCA): S → standard (settings VATRate, default 15), Z → zero,
 * E → exempt, O → out-of-scope. A real 0 is NEVER clobbered to 15 (fixes the
 * legacy `vat_pct || 15` bug).
 */
'use strict';

const DEFAULT_STANDARD_RATE = 15;

function _num(v, dflt = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/** Normalize any date input to a calendar YYYY-MM-DD string (local, no tz shift). */
function ymd(input) {
  if (!input) {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
  }
  if (input instanceof Date) {
    return `${input.getFullYear()}-${String(input.getMonth() + 1).padStart(2, '0')}-${String(input.getDate()).padStart(2, '0')}`;
  }
  const s = String(input);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return s.slice(0, 10);
}

/** Half-up rounding at `dp` decimals, float-drift safe. */
function round(value, dp = 4) {
  const n = _num(value, 0);
  const f = Math.pow(10, dp);
  const eps = n >= 0 ? 1e-9 : -1e-9;
  return Math.round((n + eps) * f) / f;
}

const money = (v) => round(v, 2);   // presentation / GL scale (halalas)
const qty = (v) => round(v, 4);     // quantity scale
const rate = (v) => round(v, 6);    // unit price at base scale

/** Add days to a YYYY-MM-DD date (for due_date from payment terms/credit days). */
function addDays(dateInput, days) {
  const base = ymd(dateInput);
  const [y, m, d] = base.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + _num(days, 0));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/** Whole-day difference (asOf − date), never negative-normalized. */
function daysBetween(fromDate, toDate) {
  const a = new Date(ymd(fromDate) + 'T00:00:00Z').getTime();
  const b = new Date(ymd(toDate) + 'T00:00:00Z').getTime();
  return Math.floor((b - a) / 86400000);
}

/**
 * Resolve the effective VAT percentage. Never clobbers a real 0.
 * @returns {{ rate:number, taxable:boolean, code:string }}
 */
function resolveVatRate({ vatRate, vatCategory, standardRate } = {}) {
  const std = Number.isFinite(Number(standardRate)) ? Number(standardRate) : DEFAULT_STANDARD_RATE;
  if (vatRate != null && vatRate !== '' && Number.isFinite(Number(vatRate))) {
    const r = Number(vatRate);
    if (r < 0 || r > 100) throw Object.assign(new Error('نسبة ضريبة غير صالحة'), { code: 'VALIDATION_ERROR' });
    return { rate: r, taxable: r > 0, code: vatCategory || (r > 0 ? 'S' : 'Z') };
  }
  const code = String(vatCategory || 'S').toUpperCase();
  if (code === 'Z') return { rate: 0, taxable: false, code: 'Z' };
  if (code === 'E') return { rate: 0, taxable: false, code: 'E' };
  if (code === 'O') return { rate: 0, taxable: false, code: 'O' };
  if (code === 'S' || code === 'S15' || code === '') return { rate: std, taxable: std > 0, code: 'S' };
  throw Object.assign(new Error(`فئة ضريبية غير معروفة: ${vatCategory}`), { code: 'VALIDATION_ERROR' });
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

/**
 * Split a gross/exclusive unit price into { net, vat } honoring inclusive flag.
 * Server-authoritative (fixes legacy client-trusted inclusive/exclusive).
 */
function splitPrice(amount, rateValue, inclusive) {
  const a = money(amount);
  const r = _num(rateValue);
  if (r <= 0) return { net: a, vat: 0 };
  if (inclusive) {
    const net = money(a / (1 + r / 100));
    return { net, vat: money(a - net) };
  }
  return { net: a, vat: money(a * (r / 100)) };
}

/**
 * Compute a single AR document / order line.
 * @param {object} line { enteredQty, factor, unitPriceEntered, discount,
 *                        vatRate, vatCategory, inclusiveTax }
 */
function computeLine(line, standardRate) {
  const factor = _num(line.factor, 1);
  const enteredQty = _num(line.enteredQty);
  if (enteredQty <= 0) throw Object.assign(new Error('الكمية يجب أن تكون أكبر من صفر'), { code: 'VALIDATION_ERROR' });
  const unitPriceEntered = _num(line.unitPriceEntered);
  if (unitPriceEntered < 0) throw Object.assign(new Error('السعر لا يمكن أن يكون سالبًا'), { code: 'VALIDATION_ERROR' });

  const baseQty = toBaseQty(enteredQty, factor);
  const discount = money(_num(line.discount));
  const vr = resolveVatRate({ vatRate: line.vatRate, vatCategory: line.vatCategory, standardRate });

  const gross = money(enteredQty * unitPriceEntered);
  let net, vatAmount;
  if (line.inclusiveTax && vr.rate > 0) {
    const grossAfterDisc = money(gross - discount);
    net = money(grossAfterDisc / (1 + vr.rate / 100));
    vatAmount = money(grossAfterDisc - net);
  } else {
    net = money(gross - discount);
    vatAmount = money(net * (vr.rate / 100));
  }
  const grossAmount = money(net + vatAmount);

  return {
    baseQty,
    baseUnitPrice: toBaseUnitPrice(unitPriceEntered, factor),
    factor,
    enteredQty: qty(enteredQty),
    unitPriceEntered: money(unitPriceEntered),
    discountAmount: discount,
    vatRate: vr.rate,
    vatCategory: vr.code,
    inclusiveTax: !!line.inclusiveTax,
    netAmount: net,
    vatAmount,
    grossAmount,
  };
}

/** Aggregate document totals from computed lines. */
function computeTotals(computedLines) {
  let subtotal = 0, discountTotal = 0, vatTotal = 0;
  for (const l of computedLines) {
    subtotal += l.netAmount;
    discountTotal += l.discountAmount;
    vatTotal += l.vatAmount;
  }
  subtotal = money(subtotal);
  vatTotal = money(vatTotal);
  discountTotal = money(discountTotal);
  return { subtotal, discountAmount: discountTotal, vatAmount: vatTotal, total: money(subtotal + vatTotal) };
}

/** Standard AR aging buckets by days-past-due. */
function agingBucket(daysPastDue) {
  const d = _num(daysPastDue, 0);
  if (d <= 0) return 'current';
  if (d <= 30) return 'd1_30';
  if (d <= 60) return 'd31_60';
  if (d <= 90) return 'd61_90';
  if (d <= 120) return 'd91_120';
  return 'd120_plus';
}

module.exports = {
  round, money, qty, rate, ymd, addDays, daysBetween,
  resolveVatRate, toBaseQty, toBaseUnitPrice, splitPrice,
  computeLine, computeTotals, agingBucket,
  DEFAULT_STANDARD_RATE,
};
