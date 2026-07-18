/**
 * Cashier V2 order state machine + cart math — PURE (no I/O, no DB).
 *
 * Lifecycle (pos_orders.status):
 *   open ⇄ held                    (hold / resume — no financial effect)
 *   open → submitted               (payment screen confirmed; payload frozen)
 *   submitted → completed          (legacy POST /api/sales succeeded → sale_id linked)
 *   submitted → open               (payment aborted / failed — back to cart)
 *   open|held → voided             (pre-financial void; NEVER after completed —
 *                                   a completed sale reverses via the legacy
 *                                   void/return credit-note flow, not here)
 *
 * The financial write path stays the battle-tested legacy POST /api/sales
 * (ZATCA chain, GL, stock deduction, shift totals) — V2 owns only the cart
 * lifecycle. clientOrderId = pos_orders.id (a client ULID) so checkout retries
 * and offline replays can never double-post a sale.
 *
 * Cart math mirrors the legacy POS: per-line VAT category (S=15%, Z/E/O=0%),
 * tax-inclusive prices (KSA retail convention), line discounts then an
 * order-level discount, 2dp rounding at the line level.
 */
'use strict';

const STATUSES = ['open', 'held', 'submitted', 'completed', 'voided'];
const VAT_RATES = { S: 0.15, Z: 0, E: 0, O: 0 };

function _err(code, msg) { const e = new Error(msg || code); e.code = code; return e; }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// ── Transitions ──────────────────────────────────────────────────────────────
function canEdit(s) { return s === 'open'; }
function canHold(s) { return s === 'open'; }
function canResume(s) { return s === 'held'; }
function canSubmit(s) { return s === 'open'; }
function canReopen(s) { return s === 'submitted'; } // payment aborted → back to cart
function canComplete(s) { return s === 'submitted'; }
function canVoid(s) { return s === 'open' || s === 'held'; }
function isTerminal(s) { return s === 'completed' || s === 'voided'; }

function assertCanEdit(s) { if (!canEdit(s)) throw _err('INVALID_STATE_TRANSITION', 'لا يمكن تعديل طلب حالته "' + s + '" — الطلبات المفتوحة فقط'); }
function assertCanHold(s) { if (!canHold(s)) throw _err('INVALID_STATE_TRANSITION', 'لا يمكن تعليق طلب حالته "' + s + '"'); }
function assertCanResume(s) { if (!canResume(s)) throw _err('INVALID_STATE_TRANSITION', 'لا يمكن استعادة طلب حالته "' + s + '" — المعلّق فقط'); }
function assertCanSubmit(s) { if (!canSubmit(s)) throw _err('INVALID_STATE_TRANSITION', 'لا يمكن إرسال طلب حالته "' + s + '" للدفع'); }
function assertCanReopen(s) { if (!canReopen(s)) throw _err('INVALID_STATE_TRANSITION', 'لا يمكن إعادة فتح طلب حالته "' + s + '" — المُرسل للدفع فقط'); }
function assertCanComplete(s) { if (!canComplete(s)) throw _err('INVALID_STATE_TRANSITION', 'لا يمكن إكمال طلب حالته "' + s + '" — أرسله للدفع أولًا'); }
function assertCanVoid(s) {
  if (!canVoid(s)) {
    throw _err('INVALID_STATE_TRANSITION', s === 'completed'
      ? 'الطلب مكتمل — الإلغاء بعد الإكمال يمر عبر مسار الاسترجاع/الإشعار الدائن الرسمي'
      : 'لا يمكن إلغاء طلب حالته "' + s + '"');
  }
}

// ── Order types / channels ───────────────────────────────────────────────────
const ORDER_TYPES = ['dine_in', 'takeaway', 'delivery'];
function normalizeOrderType(t) { return ORDER_TYPES.includes(String(t)) ? String(t) : 'takeaway'; }

// ── Cart math ────────────────────────────────────────────────────────────────
// line: { qty, unitPrice, lineDiscount?, vatCategory? }  (prices TAX-INCLUSIVE)
function lineTotals(line) {
  const qty = Number(line.qty) || 0;
  const unitPrice = Number(line.unitPrice) || 0;
  const discount = Math.min(Math.max(Number(line.lineDiscount) || 0, 0), qty * unitPrice);
  const gross = round2(qty * unitPrice - discount);
  const rate = VAT_RATES[String(line.vatCategory || 'S')] ?? VAT_RATES.S;
  const vat = rate > 0 ? round2(gross - gross / (1 + rate)) : 0;
  return { gross, vat, net: round2(gross - vat), discount: round2(discount) };
}

// orderDiscount: { type: 'PERCENT'|'FIXED', value } applied AFTER line discounts.
function cartTotals(lines, orderDiscount) {
  let subtotal = 0, lineDiscountTotal = 0;
  const perLine = [];
  for (const l of lines) {
    const t = lineTotals(l);
    perLine.push(t);
    subtotal += t.gross;
    lineDiscountTotal += t.discount;
  }
  subtotal = round2(subtotal);
  let discountAmount = 0;
  if (orderDiscount && Number(orderDiscount.value) > 0) {
    discountAmount = orderDiscount.type === 'PERCENT'
      ? round2(subtotal * Math.min(Number(orderDiscount.value), 100) / 100)
      : Math.min(round2(Number(orderDiscount.value)), subtotal);
  }
  const total = round2(subtotal - discountAmount);
  // VAT scales down proportionally with the order-level discount (inclusive pricing).
  const vatBase = perLine.reduce((s, t) => s + t.vat, 0);
  const factor = subtotal > 0 ? total / subtotal : 0;
  const vatTotal = round2(vatBase * factor);
  return {
    subtotal, lineDiscountTotal: round2(lineDiscountTotal), discountAmount, total,
    vatTotal, netTotal: round2(total - vatTotal), perLine,
  };
}

// ── Payments ─────────────────────────────────────────────────────────────────
// payments: [{ method: 'cash'|'card'|'credit', amount }] — must cover the total
// exactly (cash change is handled via cashTendered, not an over-payment line).
const PAY_METHODS = ['cash', 'card', 'credit'];
function validatePayments(payments, total) {
  if (!Array.isArray(payments) || payments.length === 0) throw _err('VALIDATION_ERROR', 'حدّد طريقة دفع واحدة على الأقل');
  let sum = 0;
  for (const p of payments) {
    if (!PAY_METHODS.includes(String(p.method))) throw _err('VALIDATION_ERROR', 'طريقة دفع غير معروفة: ' + p.method);
    const a = Number(p.amount);
    if (!Number.isFinite(a) || a <= 0) throw _err('VALIDATION_ERROR', 'مبلغ دفع غير صالح');
    sum += a;
  }
  if (round2(sum) !== round2(total)) {
    throw _err('PAYMENT_MISMATCH', 'مجموع الدفعات (' + round2(sum) + ') لا يساوي إجمالي الطلب (' + round2(total) + ')');
  }
  return round2(sum);
}

// Map V2 payments onto the legacy /api/sales contract: single method or split.
function legacyPaymentFields(payments) {
  if (payments.length === 1) {
    const m = payments[0].method;
    return { paymentMethod: m === 'cash' ? 'كاش' : m === 'card' ? 'شبكة' : 'كيتا', splitDetails: null };
  }
  return {
    paymentMethod: 'split',
    splitDetails: payments.map((p) => ({ method: p.method === 'cash' ? 'كاش' : p.method === 'card' ? 'شبكة' : 'كيتا', amount: round2(Number(p.amount)) })),
  };
}

// Build the EXACT legacy POST /api/sales payload from a V2 order + its lines
// + payments. clientOrderId = the order's ULID → server-side dedupe.
function buildLegacySalePayload(order, lines, payments, opts) {
  const totals = cartTotals(lines, order.discountType ? { type: order.discountType, value: order.discountValue } : null);
  const pay = legacyPaymentFields(payments);
  return {
    clientOrderId: order.id,
    shiftId: order.shiftId,
    warehouseId: order.warehouseId || undefined,
    channelId: order.channelId || undefined,
    channelName: order.channelName || undefined,
    // qty is ALWAYS the base quantity (stock/money authority). The entered-unit
    // snapshot rides along so /api/sales stores it in items_json → a return can
    // echo the SAME unit + base qty. Legacy piece lines carry no unit fields.
    items: lines.map((l) => ({
      id: l.menuId,
      name: l.nameSnapshot,
      qty: Number(l.qty),
      price: Number(l.unitPrice),
      lineDiscount: Number(l.lineDiscount) || 0,
      notes: l.notes || undefined,
      // Combos (العروض): the cashier's validated picks ride EXACTLY as the
      // legacy POS sent them — routes/sales.js reads item.comboChoices as
      // [{groupId, menuItemId}] to expand the combo into its components and
      // run the recipe deduction per CHOSEN option. Field name + shape are
      // load-bearing; do not rename.
      comboChoices: Array.isArray(l.comboChoices) && l.comboChoices.length
        ? l.comboChoices.map((c) => ({ groupId: String(c.groupId), menuItemId: String(c.menuItemId) }))
        : undefined,
      enteredUnitCode: l.enteredUnitCode || undefined,
      enteredQty: l.enteredQty != null ? Number(l.enteredQty) : undefined,
      conversionFactorSnapshot: l.conversionFactorSnapshot != null ? Number(l.conversionFactorSnapshot) : undefined,
      baseQty: l.baseQty != null ? Number(l.baseQty) : Number(l.qty),
    })),
    total: totals.subtotal,
    totalFinal: totals.total,
    discountName: order.discountName || undefined,
    discountAmount: totals.discountAmount,
    lineDiscountTotal: totals.lineDiscountTotal,
    paymentMethod: pay.paymentMethod,
    splitDetails: pay.splitDetails,
    // Structured payments (Order-to-Cash contract) sit ALONGSIDE the legacy
    // paymentMethod/splitDetails — no field is removed, so routes/sales.js + GL
    // stay unchanged. The O2C credit gate reads this clean shape (method 'credit'
    // + flat customerId) instead of parsing the Arabic 'كيتا' label.
    payments: payments.map((p) => ({ method: String(p.method), amount: round2(Number(p.amount)) })),
    cashTendered: opts && opts.cashTendered ? round2(opts.cashTendered) : undefined,
    changeDue: opts && opts.changeDue ? round2(opts.changeDue) : undefined,
    customer: order.customerId ? { id: order.customerId } : undefined,
    customerId: order.customerId || undefined,
    paymentNotes: (opts && opts.paymentNotes) || undefined,
  };
}

module.exports = {
  STATUSES, ORDER_TYPES, PAY_METHODS, VAT_RATES, round2,
  canEdit, canHold, canResume, canSubmit, canReopen, canComplete, canVoid, isTerminal,
  assertCanEdit, assertCanHold, assertCanResume, assertCanSubmit, assertCanReopen, assertCanComplete, assertCanVoid,
  normalizeOrderType, lineTotals, cartTotals, validatePayments, legacyPaymentFields, buildLegacySalePayload,
};
