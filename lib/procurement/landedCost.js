/**
 * lib/procurement/landedCost.js — PURE landed-cost allocation.
 *
 * A goods receipt may carry import charges (freight, customs, insurance,
 * handling, other) that are part of what the goods cost to land. Those charges
 * are spread over the receipt lines and the resulting *landed* unit cost is
 * what enters the warehouse WAC, the lot and the item cost roll-up — the
 * supplier's invoice price alone understates every later COGS figure.
 *
 * No I/O here. The receipts route persists the result; POST /:id/post
 * recomputes it from the stored charge rows so those rows stay the single
 * source of truth.
 *
 * ─── THE EXACT-SUM RULE ─────────────────────────────────────────────────────
 * Every allocation is rounded to 4 dp, and the rounding residual is placed on
 * the LARGEST line (largest weight; the first one on a tie), so the allocated
 * amounts sum EXACTLY to the charge total. Without this, a 100.00 freight
 * spread over three equal lines becomes 33.3333 × 3 = 99.9999, and the GL
 * inventory debit no longer equals the GRNI credit by a cent that nobody can
 * explain.
 *
 * ─── NULL IS NOT ZERO ───────────────────────────────────────────────────────
 * A receipt with no charges gets landedChargeAmount = null and
 * landedUnitCost = null on every line. A zero would read as "charges were
 * allocated and came to nothing", which is a different (and false) statement.
 */
'use strict';

const calc = require('./calculations');

const CHARGE_TYPES = Object.freeze(['freight', 'customs', 'insurance', 'handling', 'other']);
const ALLOCATION_METHODS = Object.freeze(['value', 'qty']);
/** Allocation scale — purchase_receipt_lines.landed_charge_amount is DECIMAL(14,4). */
const ALLOC_DP = 4;

function _fail(message, details) {
  // Plain Error carrying the canonical code: lib/procurement/errors.resolve()
  // maps `.code === 'VALIDATION_ERROR'` to 422 without this module depending
  // on the HTTP layer.
  const e = new Error(message);
  e.code = 'VALIDATION_ERROR';
  e.details = details || null;
  return e;
}

function _pick(obj, camel, snake) {
  if (obj[camel] !== undefined) return obj[camel];
  if (obj[snake] !== undefined) return obj[snake];
  return undefined;
}

/**
 * Validate + normalize a client (or stored) charge list.
 * Accepts camelCase (API) or snake_case (DB row) keys. Throws VALIDATION_ERROR
 * with an Arabic message on anything malformed — a charge is money, and money
 * is never coerced silently.
 *
 * @returns {Array<{chargeType, description, supplierId, amount, vatAmount, allocationMethod}>}
 */
function normalizeCharges(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw _fail('مصاريف الاستيراد يجب أن تكون قائمة');
  return raw.map((c, i) => {
    const n = i + 1;
    if (!c || typeof c !== 'object') throw _fail(`سطر المصروف ${n} غير صالح`);
    const chargeType = String(_pick(c, 'chargeType', 'charge_type') || '').trim().toLowerCase();
    if (!CHARGE_TYPES.includes(chargeType)) {
      throw _fail(`نوع مصروف الاستيراد غير معروف في السطر ${n}: ${chargeType || '—'}`, { chargeType, allowed: CHARGE_TYPES });
    }
    const amountRaw = Number(c.amount);
    if (!Number.isFinite(amountRaw)) throw _fail(`مبلغ المصروف غير صالح في السطر ${n}`);
    const amount = calc.money(amountRaw);
    if (amount <= 0) throw _fail(`مبلغ المصروف يجب أن يكون موجبًا (السطر ${n})`);
    const vatRaw = _pick(c, 'vatAmount', 'vat_amount');
    const vatNum = vatRaw == null || vatRaw === '' ? 0 : Number(vatRaw);
    if (!Number.isFinite(vatNum) || vatNum < 0) throw _fail(`ضريبة المصروف لا يمكن أن تكون سالبة (السطر ${n})`);
    const methodRaw = _pick(c, 'allocationMethod', 'allocation_method');
    const allocationMethod = String(methodRaw == null || methodRaw === '' ? 'value' : methodRaw).trim().toLowerCase();
    if (!ALLOCATION_METHODS.includes(allocationMethod)) {
      throw _fail(`طريقة توزيع المصروف غير معروفة في السطر ${n}: ${allocationMethod}`, { allocationMethod, allowed: ALLOCATION_METHODS });
    }
    const descRaw = c.description;
    const description = descRaw == null ? null : (String(descRaw).trim().slice(0, 200) || null);
    const supRaw = _pick(c, 'supplierId', 'supplier_id');
    const supplierId = supRaw == null ? null : (String(supRaw).trim() || null);
    return { chargeType, description, supplierId, amount, vatAmount: calc.money(vatNum), allocationMethod };
  });
}

/**
 * Split `total` across `weights` at `dp` decimals so the parts sum EXACTLY to
 * `total`; the residual lands on the largest weight (first on a tie). A zero
 * or negative weight receives nothing.
 */
function splitExact(total, weights, dp = ALLOC_DP) {
  const t = calc.round(total, dp);
  const w = (weights || []).map((x) => {
    const v = Number(x);
    return Number.isFinite(v) && v > 0 ? v : 0;
  });
  const sumW = w.reduce((s, x) => s + x, 0);
  if (!(sumW > 0)) throw _fail('لا يمكن توزيع مصروف الاستيراد: أوزان التوزيع كلها صفر');
  const parts = w.map((x) => (x > 0 ? calc.round((t * x) / sumW, dp) : 0));
  const allocated = parts.reduce((s, p) => s + p, 0);
  const residual = calc.round(t - allocated, dp);
  if (residual !== 0) {
    let largest = -1;
    for (let i = 0; i < w.length; i++) {
      if (w[i] > 0 && (largest < 0 || w[i] > w[largest])) largest = i;
    }
    parts[largest] = calc.round(parts[largest] + residual, dp);
  }
  return parts;
}

/**
 * Round each raw part to `dp` and force the rounded parts to sum EXACTLY to
 * `total` by placing the residual on the largest part. Used for the per-
 * warehouse inventory debits so Σ(warehouse) == landed total to the cent.
 */
function roundExactTo(parts, total, dp = 2) {
  const t = calc.round(total, dp);
  const out = (parts || []).map((p) => calc.round(p, dp));
  if (!out.length) return out;
  const residual = calc.round(t - out.reduce((s, p) => s + p, 0), dp);
  if (residual !== 0) {
    let largest = 0;
    for (let i = 1; i < out.length; i++) if (out[i] > out[largest]) largest = i;
    out[largest] = calc.round(out[largest] + residual, dp);
  }
  return out;
}

/**
 * Allocate charges over receipt lines.
 *
 * @param lines   [{ id?, line_total|lineTotal, base_qty|baseQty }]
 * @param charges normalized charges (see normalizeCharges) — or raw; they are
 *                normalized here again, which is idempotent.
 * @returns {{ chargesTotal:number, lines:[{ index, id, landedChargeAmount, landedUnitCost }] }}
 *   landedChargeAmount / landedUnitCost are null when there are no charges.
 */
function allocateCharges(lines, charges) {
  const L = (lines || []).map((l, i) => ({
    index: i,
    id: l && l.id != null ? l.id : null,
    lineTotal: calc.money(_pick(l || {}, 'lineTotal', 'line_total')),
    baseQty: calc.qty(_pick(l || {}, 'baseQty', 'base_qty')),
  }));
  const C = normalizeCharges(charges);
  if (!C.length) {
    return { chargesTotal: 0, lines: L.map((l) => ({ index: l.index, id: l.id, landedChargeAmount: null, landedUnitCost: null })) };
  }
  if (!L.length) throw _fail('لا يمكن توزيع مصاريف الاستيراد على استلام بلا سطور');
  const chargesTotal = calc.money(C.reduce((s, c) => s + c.amount, 0));
  const shares = new Array(L.length).fill(0);
  for (const c of C) {
    const weights = L.map((l) => (c.allocationMethod === 'qty' ? l.baseQty : l.lineTotal));
    let parts;
    try {
      parts = splitExact(c.amount, weights, ALLOC_DP);
    } catch (e) {
      // Name the method that failed — "all weights zero" by VALUE means every
      // line is free goods, which is a real business situation, not a bug.
      throw _fail(c.allocationMethod === 'qty'
        ? 'لا يمكن توزيع المصروف بالكمية: كميات السطور كلها صفر'
        : 'لا يمكن توزيع المصروف بالقيمة: قيم السطور كلها صفر (وزّع بالكمية بدلًا من ذلك)');
    }
    parts.forEach((p, i) => { shares[i] = calc.round(shares[i] + p, ALLOC_DP); });
  }
  return {
    chargesTotal,
    lines: L.map((l, i) => ({
      index: l.index,
      id: l.id,
      landedChargeAmount: shares[i],
      landedUnitCost: l.baseQty > 0 ? calc.rate((l.lineTotal + shares[i]) / l.baseQty) : null,
    })),
  };
}

module.exports = {
  CHARGE_TYPES, ALLOCATION_METHODS, ALLOC_DP,
  normalizeCharges, splitExact, roundExactTo, allocateCharges,
};
