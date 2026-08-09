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
/** Which ZATCA categories are taxed at all. S = standard, Z/E/O always 0%. */
const TAXED_CATEGORIES = { S: true, Z: false, E: false, O: false };
/** Only a fallback for callers that pass no rate; settings.VATRate governs. */
const DEFAULT_VAT_RATE_PCT = 15;

function rateFor(category, vatRatePct) {
  if (!TAXED_CATEGORIES[String(category || 'S')]) return 0;
  const pct = Number(vatRatePct);
  return Number.isFinite(pct) && pct >= 0 ? pct / 100 : DEFAULT_VAT_RATE_PCT / 100;
}

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
// line: { qty, unitPrice, lineDiscount?, vatCategory?, taxInclusive? }
//
// THE TAX CONVENTION IS PER ITEM (v8.1). This used to assume every price was
// tax-INCLUSIVE while the database says the opposite — server.js's v7.1 boot
// migration set menu.is_tax_inclusive = 0 on every row and routes/sales.js
// honours it. The result was that this mirror froze `totalFinal` at the NET
// amount, routes/sales.js recomputed net × 1.15, and its reconciliation guard
// rejected every standard-rated sale. Both conventions are now explicit, and
// frontend/pos/src/lib/cartMath.ts is the byte-for-byte client twin: a change
// here without the matching change there re-opens exactly that bug.
//
// WHOLE-RIYAL SHELF PRICING (v8.2). The owner sells at whole riyals — a bottle
// is 35, not 34.99 — but prices are stored NET, so 30.4261 × 1.15 = 34.99 and
// the till printed halalas on every standard-rated row. The customer-facing
// price of ONE base unit is therefore rounded to a whole riyal, and net + vat
// are derived FROM that rounded gross so `net + vat === gross` holds exactly
// (routes/sales.js's journal invariant and ZATCA both require it).
//
// Rounded at the UNIT, not the invoice total: the customer is quoted "35 each"
// and two of them cost exactly 70. A total-level round would also desync this
// mirror from the client's line-by-line sum, which is what the reconciliation
// guard compares.
//
//   unitGross = round(taxInclusive ? unitPrice : unitPrice × (1+r))
//   gross     = qty × unitGross − discount
//   vat       = gross − gross/(1+r) ; net = gross − vat
function wholeUnitGross(unitPrice, vatCategory, taxInclusive, vatRatePct) {
  const p = Number(unitPrice) || 0;
  if (p <= 0) return 0; // free / not-yet-priced lines are left alone
  const rate = rateFor(vatCategory, vatRatePct);
  // round2 FIRST. 50 × 1.15 is 57.49999999999999 in IEEE-754, and rounding that
  // straight to a whole riyal gives 57 — a full riyal below the 58 every human
  // and every calculator gets. Snapping to halalas first restores the exact
  // 57.50 the arithmetic means, and only then do we round to the riyal.
  const gross = round2(taxInclusive === true ? p : p * (1 + rate));
  // Never round a real price down to nothing: a 0.40 item stays sellable at 1.
  return Math.max(1, Math.round(gross));
}

function lineTotals(line, vatRatePct) {
  const qty = Number(line.qty) || 0;
  const rate = rateFor(line.vatCategory, vatRatePct);
  // Absent flag → EXCLUSIVE: that is what routes/sales.js computes for every
  // current menu row, and it reads the flag from the DB per item rather than
  // trusting the cart doc, so this keeps the two sides in agreement.
  const unit = wholeUnitGross(line.unitPrice, line.vatCategory, line.taxInclusive, vatRatePct);
  // The cap is the line's own GROSS — the space the discount now lives in. It
  // used to be capped against the NET side (qty × unitPrice); leaving it there
  // would let a discount exceed a line it can no longer be compared to.
  const lineGross = round2(qty * unit);
  const discount = Math.min(Math.max(Number(line.lineDiscount) || 0, 0), lineGross);

  const gross = round2(lineGross - discount);
  const vat = rate > 0 ? round2(gross - gross / (1 + rate)) : 0;
  return { gross, vat, net: round2(gross - vat), discount: round2(discount) };
}

// orderDiscount: { type: 'PERCENT'|'FIXED', value } applied AFTER line discounts.
function cartTotals(lines, orderDiscount, vatRatePct) {
  let subtotal = 0, lineDiscountTotal = 0;
  const perLine = [];
  for (const l of lines) {
    const t = lineTotals(l, vatRatePct);
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
// payments: [{ method, amount }] — must cover the total exactly (cash change is
// handled via cashTendered, not an over-payment line). Valid methods are the
// BUILT-INS ∪ the owner-configured ACTIVE payment_methods rows the caller
// passes in (normalized: {id, name, nameAr, groupType, requiresNote}). The
// machine stays pure — the DB read happens in routes/pos-v2.js.
const PAY_METHODS = ['cash', 'card', 'credit'];

// Match a client-sent method string against the owner-configured methods:
// by id (as string), by name (case-insensitive) or by exact Arabic name.
function findOwnerMethod(method, ownerMethods) {
  const m = String(method);
  const lower = m.toLowerCase();
  return (ownerMethods || []).find((o) =>
    String(o.id) === m || String(o.name || '').toLowerCase() === lower || String(o.nameAr || '') === m) || null;
}

function validatePayments(payments, total, ownerMethods) {
  if (!Array.isArray(payments) || payments.length === 0) throw _err('VALIDATION_ERROR', 'حدّد طريقة دفع واحدة على الأقل');
  let sum = 0;
  for (const p of payments) {
    const m = String(p.method);
    if (!PAY_METHODS.includes(m) && !findOwnerMethod(m, ownerMethods)) {
      throw _err('VALIDATION_ERROR', 'طريقة دفع غير معروفة أو غير نشطة: ' + p.method);
    }
    const a = Number(p.amount);
    if (!Number.isFinite(a) || a <= 0) throw _err('VALIDATION_ERROR', 'مبلغ دفع غير صالح');
    sum += a;
  }
  if (round2(sum) !== round2(total)) {
    throw _err('PAYMENT_MISMATCH', 'مجموع الدفعات (' + round2(sum) + ') لا يساوي إجمالي الطلب (' + round2(total) + ')');
  }
  return round2(sum);
}

// The first payment whose method demands a payment note ('other'-group owner
// methods), or null. The caller enforces the ≥3-char note before freezing.
function paymentNoteRequirement(payments, ownerMethods) {
  for (const p of payments || []) {
    const own = findOwnerMethod(p.method, ownerMethods);
    if (own && own.requiresNote) return own;
  }
  return null;
}

// A payment is on-account when it uses the built-in `credit` key OR an active
// owner-configured method whose accounting group is `credit`. Matching through
// findOwnerMethod() is important: the client may submit its id, English name,
// or Arabic name, and none of those labels is itself a security boundary.
function paymentIsCredit(method, ownerMethods) {
  if (String(method || '').trim().toLowerCase() === 'credit') return true;
  const own = findOwnerMethod(method, ownerMethods);
  return !!own && String(own.groupType || '').trim().toLowerCase() === 'credit';
}

function paymentsCarryCredit(payments, ownerMethods) {
  return (payments || []).some((p) =>
    p && paymentIsCredit(p.method, ownerMethods) && (Number(p.amount) || 0) > 0);
}

// Pure policy gate shared by HTTP submission and focused unit tests. The
// caller resolves the authenticated user's capability; this keeps the two
// invariants identical for the built-in and owner-configured credit methods.
function assertCreditPaymentPolicy(payments, ownerMethods, policy) {
  if (!paymentsCarryCredit(payments, ownerMethods)) return false;
  const p = policy || {};
  if (!p.canSellOnCredit) {
    throw _err('PERMISSION_DENIED', 'البيع الآجل يتطلب صلاحية البيع الآجل');
  }
  if (p.requireCustomer && !String(p.customerId || '').trim()) {
    throw _err('VALIDATION_ERROR', 'البيع الآجل يتطلب اختيار عميل');
  }
  return true;
}

// The label the legacy /api/sales contract records for a method. Built-ins keep
// their historical Arabic labels; owner methods flow as their configured Arabic
// name (name_ar, falling back to name) — routes/sales.js normalizes BOTH
// name and name_ar when routing the GL leg, and shift aggregation matches the
// same strings.
function _methodLabel(method, ownerMethods) {
  const m = String(method);
  if (m === 'cash') return 'كاش';
  if (m === 'card') return 'شبكة';
  if (m === 'credit') return 'كيتا';
  const own = findOwnerMethod(m, ownerMethods);
  return own ? (own.nameAr || own.name || m) : m;
}

// Map V2 payments onto the legacy /api/sales contract: single method or split.
function legacyPaymentFields(payments, ownerMethods) {
  if (payments.length === 1) {
    return { paymentMethod: _methodLabel(payments[0].method, ownerMethods), splitDetails: null };
  }
  return {
    paymentMethod: 'split',
    splitDetails: payments.map((p) => ({ method: _methodLabel(p.method, ownerMethods), amount: round2(Number(p.amount)) })),
  };
}

// Build the EXACT legacy POST /api/sales payload from a V2 order + its lines
// + payments. clientOrderId = the order's ULID → server-side dedupe.
function buildLegacySalePayload(order, lines, payments, opts) {
  // The rate MUST be the same one routes/sales.js will use (settings.VATRate),
  // and each line must already carry its taxInclusive flag — the caller reads
  // both from the DB. Recomputing here with a different rate or convention is
  // what makes `totalFinal` disagree with the recomputed total and trips the
  // reconciliation guard.
  const vatRatePct = opts && opts.vatRatePct;
  const totals = cartTotals(lines, order.discountType ? { type: order.discountType, value: order.discountValue } : null, vatRatePct);
  const pay = legacyPaymentFields(payments, opts && opts.ownerMethods);
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
  STATUSES, ORDER_TYPES, PAY_METHODS, round2,
  // VAT_RATES (a fixed category→fraction map) is gone: the rate is no longer a
  // constant here, it comes from settings.VATRate via the caller. What remains
  // constant is WHICH categories are taxable at all.
  TAXED_CATEGORIES, DEFAULT_VAT_RATE_PCT, rateFor,
  canEdit, canHold, canResume, canSubmit, canReopen, canComplete, canVoid, isTerminal,
  assertCanEdit, assertCanHold, assertCanResume, assertCanSubmit, assertCanReopen, assertCanComplete, assertCanVoid,
  normalizeOrderType, lineTotals, cartTotals, validatePayments, legacyPaymentFields, buildLegacySalePayload,
  findOwnerMethod, paymentNoteRequirement,
  paymentIsCredit, paymentsCarryCredit, assertCreditPaymentPolicy,
};
