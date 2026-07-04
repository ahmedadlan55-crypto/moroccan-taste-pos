/**
 * Cart math — EXACT client mirror of lib/posOrderMachine.js (server).
 * Prices are TAX-INCLUSIVE (KSA retail convention).
 *
 *   lineGross = round2(qty*unitPrice − lineDiscount)
 *   vat(S)    = gross − gross/1.15 ; Z/E/O → 0
 *   order discount (PERCENT/FIXED) applies AFTER line discounts, capped at
 *   subtotal; VAT scales by total/subtotal factor.
 *
 * Any change here MUST be mirrored server-side (and vice-versa) or the
 * client-shown totals will diverge from what /submit freezes.
 */
import type { CartLine, CartTotals, OrderDiscount, Payment, TaxCategory } from "./types";

export const VAT_RATES: Record<TaxCategory, number> = { S: 0.15, Z: 0, E: 0, O: 0 };

export function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export interface LineTotals {
  gross: number;
  vat: number;
  net: number;
  discount: number;
}

export function lineTotals(line: Pick<CartLine, "qty" | "unitPrice" | "lineDiscount" | "vatCategory" | "baseQty">): LineTotals {
  // Phase U — money uses the BASE quantity (= enteredQty × factor), matching the
  // server (which stores qty as base). A single-unit line has baseQty == qty.
  const qty = Number(line.baseQty ?? line.qty) || 0;
  const unitPrice = Number(line.unitPrice) || 0;
  const discount = Math.min(Math.max(Number(line.lineDiscount) || 0, 0), qty * unitPrice);
  const gross = round2(qty * unitPrice - discount);
  const rate = VAT_RATES[line.vatCategory] ?? VAT_RATES.S;
  const vat = rate > 0 ? round2(gross - gross / (1 + rate)) : 0;
  return { gross, vat, net: round2(gross - vat), discount: round2(discount) };
}

export function cartTotals(
  lines: ReadonlyArray<Pick<CartLine, "qty" | "unitPrice" | "lineDiscount" | "vatCategory" | "baseQty">>,
  orderDiscount?: Pick<OrderDiscount, "type" | "value"> | null,
): CartTotals {
  let subtotal = 0;
  let lineDiscountTotal = 0;
  let vatBase = 0;
  for (const l of lines) {
    const t = lineTotals(l);
    subtotal += t.gross;
    lineDiscountTotal += t.discount;
    vatBase += t.vat;
  }
  subtotal = round2(subtotal);
  let discountAmount = 0;
  if (orderDiscount && Number(orderDiscount.value) > 0) {
    discountAmount =
      orderDiscount.type === "PERCENT"
        ? round2((subtotal * Math.min(Number(orderDiscount.value), 100)) / 100)
        : Math.min(round2(Number(orderDiscount.value)), subtotal);
  }
  const total = round2(subtotal - discountAmount);
  // VAT scales down proportionally with the order-level discount (inclusive pricing).
  const factor = subtotal > 0 ? total / subtotal : 0;
  const vatTotal = round2(vatBase * factor);
  return {
    subtotal,
    lineDiscountTotal: round2(lineDiscountTotal),
    discountAmount,
    total,
    vatTotal,
    netTotal: round2(total - vatTotal),
  };
}

/**
 * Client-side mirror of M.validatePayments — returns an Arabic error message
 * or null when valid. The server re-validates; this only powers instant UI.
 */
export function paymentsError(payments: ReadonlyArray<Payment>, total: number): string | null {
  if (!payments.length) return "حدّد طريقة دفع واحدة على الأقل";
  let sum = 0;
  for (const p of payments) {
    const a = Number(p.amount);
    if (!Number.isFinite(a) || a <= 0) return "مبلغ دفع غير صالح";
    sum += a;
  }
  if (round2(sum) !== round2(total)) {
    return `مجموع الدفعات (${round2(sum)}) لا يساوي إجمالي الطلب (${round2(total)})`;
  }
  return null;
}

/** Order-level discount % of subtotal — for the cashier-ceiling warning. */
export function orderDiscountPct(totals: CartTotals): number {
  return totals.subtotal > 0 ? (totals.discountAmount / totals.subtotal) * 100 : 0;
}
