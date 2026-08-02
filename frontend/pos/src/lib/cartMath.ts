/**
 * Cart math — EXACT client mirror of lib/posOrderMachine.js (server).
 *
 * TAX CONVENTION IS PER ITEM, NOT GLOBAL (v8.1).
 *   This file used to hardcode "prices are TAX-INCLUSIVE". The database says
 *   otherwise: server.js's v7.1 boot migration set `menu.is_tax_inclusive = 0`
 *   on EVERY row, and routes/sales.js honours that flag — so for a 16.00 item
 *   the register showed 16.00 while the server computed 16 × 1.15 = 18.40 and
 *   the reconciliation guard rejected the sale outright («الإجمالي المعروض
 *   (16) لا يطابق الإجمالي المحسوب (18)»). Every standard-rated sale failed.
 *   The flag now rides on the catalog item and on the cart line, and the two
 *   conventions are computed explicitly:
 *
 *     inclusive → gross = qty*unitPrice − lineDiscount ; vat = gross − gross/(1+r)
 *     exclusive → net   = qty*unitPrice − lineDiscount ; vat = net*r ; gross = net + vat
 *
 *   Order discount (PERCENT/FIXED) applies AFTER line discounts in GROSS space,
 *   capped at subtotal; VAT scales by total/subtotal factor. Unchanged.
 *
 * THE RATE COMES FROM THE SERVER (settings.VATRate, shipped as catalog.vatRate).
 *   It used to be hardcoded 0.15 here while the server read the setting, so an
 *   owner changing the rate desynced the register from the books silently.
 *
 * Any change here MUST be mirrored in lib/posOrderMachine.js (and vice-versa)
 * or the client-shown totals diverge from what /submit freezes.
 */
import type { CartLine, CartTotals, CatalogItem, OrderDiscount, Payment, TaxCategory } from "./types";
import type { TFunction } from "@/i18n/types";

/** Which categories are taxed at all. S = standard; Z/E/O are always 0%. */
export const TAXED_CATEGORIES: Record<TaxCategory, boolean> = { S: true, Z: false, E: false, O: false };

/** Fallback when the catalog has not loaded yet (offline cold start). The
 *  server is authoritative; this only keeps the UI sane for a moment. */
export const DEFAULT_VAT_RATE_PCT = 15;

/** Effective fraction (0.15) for a line, given the shipped rate in PERCENT. */
export function rateFor(category: TaxCategory, vatRatePct: number = DEFAULT_VAT_RATE_PCT): number {
  if (!TAXED_CATEGORIES[category]) return 0;
  const pct = Number(vatRatePct);
  return Number.isFinite(pct) && pct >= 0 ? pct / 100 : DEFAULT_VAT_RATE_PCT / 100;
}

export function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Quantity precision. Lives here (not in the store) so the cart badge in App
 *  and the store's own line math round base quantities identically. */
export function round6(n: number): number {
  return Math.round(((Number(n) || 0) + Number.EPSILON) * 1e6) / 1e6;
}

/**
 * THE price to charge for one base unit of a catalog item.
 *
 * `price` is the CHANNEL-RESOLVED price (routes/pos-v2.js resolves
 * override > channel price list > base menu price and ships the winner here).
 * `basePrice` is the raw, UNRESOLVED menu price and is provenance only.
 *
 * This function exists because the store used to read `item.basePrice ?? item.price`.
 * The server ALWAYS ships basePrice, so that `??` never fell through — every
 * channel price list and every per-channel override was silently discarded, and
 * the card advertised one price while the cart line charged another.
 */
export function effectiveUnitPrice(item: Pick<CatalogItem, "price" | "basePrice">): number {
  return Number(item.price) || 0;
}

export interface LineTotals {
  gross: number;
  vat: number;
  net: number;
  discount: number;
}

type MoneyLine = Pick<CartLine, "qty" | "unitPrice" | "lineDiscount" | "vatCategory" | "baseQty" | "taxInclusive">;

/**
 * WHOLE-RIYAL SHELF PRICING.
 *
 * The customer-facing price of one base unit, rounded to a whole riyal.
 *
 * The owner sells at whole riyals: a bottle is 35, not 34.99. But menu prices
 * are stored NET, so 30.4261 × 1.15 = 34.99 and the till printed halalas on
 * every standard-rated row. Tuning the stored prices fixes it too, but only
 * after somebody edits the database — and until they do, the register lies to
 * the customer. Rounding HERE means the till is right no matter what is stored.
 *
 * ROUNDED AT THE UNIT, NOT AT THE INVOICE TOTAL. Two reasons:
 *   • The customer is told "35 each" and 2 of them cost exactly 70. Rounding a
 *     total instead makes the unit price unquotable — 2 × 34.99 = 69.98 → 70,
 *     but 3 × 34.99 = 104.97 → 105, and neither divides back into a price.
 *   • The register's own reconciliation compares a line-by-line sum against the
 *     server's; a total-level round would make those two disagree by design.
 *
 * NET AND VAT ARE DERIVED FROM THE ROUNDED GROSS, never the other way round, so
 * `net + vat === gross` holds EXACTLY. That invariant is what ZATCA validates
 * and what routes/sales.js's journal asserts — a rounded total with unrounded
 * components would break both.
 */
export function wholeUnitGross(
  unitPrice: number,
  vatCategory: TaxCategory,
  taxInclusive: boolean | undefined,
  vatRatePct: number = DEFAULT_VAT_RATE_PCT,
): number {
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

export function lineTotals(line: MoneyLine, vatRatePct: number = DEFAULT_VAT_RATE_PCT): LineTotals {
  // Phase U — money uses the BASE quantity (= enteredQty × factor), matching the
  // server (which stores qty as base). A single-unit line has baseQty == qty.
  const qty = Number(line.baseQty ?? line.qty) || 0;
  const rate = rateFor(line.vatCategory, vatRatePct);
  // Absent flag → EXCLUSIVE, matching what the server will compute: every
  // menu row is is_tax_inclusive=0 (server.js v7.1 migration) and the server
  // reads the flag from the DB per item, not from the cart doc. Only carts
  // persisted before this field existed can reach here without it.
  const unit = wholeUnitGross(line.unitPrice, line.vatCategory, line.taxInclusive, vatRatePct);
  // The discount cap is the line's own gross — the space the discount is now
  // expressed in. It used to be capped against `qty × unitPrice`, which was the
  // NET side; leaving it there would let a discount exceed a line it can no
  // longer be compared to.
  const lineGross = round2(qty * unit);
  const discount = Math.min(Math.max(Number(line.lineDiscount) || 0, 0), lineGross);

  const gross = round2(lineGross - discount);
  const vat = rate > 0 ? round2(gross - gross / (1 + rate)) : 0;
  return { gross, vat, net: round2(gross - vat), discount: round2(discount) };
}

/**
 * The customer-facing shelf price of ONE unit — what the cashier and the
 * customer both read off the card.
 *
 * Every menu row is stored tax-EXCLUSIVE, so a card printing `price` raw showed
 * 13.04 for an item that rings up at 15.00. Two numbers for one product, on the
 * same screen, is how a queue argument starts.
 *
 * Routed through lineTotals so there is exactly ONE VAT rule in the app: a
 * second formula here would drift from the cart the first time a rate or a
 * category changed.
 */
export function displayUnitPrice(
  item: Pick<CatalogItem, "price" | "taxCategory" | "taxInclusive">,
  vatRatePct: number = DEFAULT_VAT_RATE_PCT,
): number {
  return lineTotals(
    {
      qty: 1,
      unitPrice: Number(item.price) || 0,
      lineDiscount: 0,
      vatCategory: item.taxCategory,
      taxInclusive: item.taxInclusive === true,
    },
    vatRatePct,
  ).gross;
}

export function cartTotals(
  lines: ReadonlyArray<MoneyLine>,
  orderDiscount?: Pick<OrderDiscount, "type" | "value"> | null,
  vatRatePct: number = DEFAULT_VAT_RATE_PCT,
): CartTotals {
  let subtotal = 0;
  let lineDiscountTotal = 0;
  let vatBase = 0;
  for (const l of lines) {
    const t = lineTotals(l, vatRatePct);
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
 * Client-side mirror of M.validatePayments — returns an error message or null
 * when valid. The server re-validates; this only powers instant UI.
 *
 * i18n: pass the live `t` (from useT) to get a localized message; called
 * without `t` (e.g. pure-function unit tests) it returns the Arabic default,
 * so those tests keep asserting the Arabic strings unchanged.
 */
export function paymentsError(payments: ReadonlyArray<Payment>, total: number, t?: TFunction): string | null {
  if (!payments.length) return t ? t("cartMath.noPaymentMethod") : "حدّد طريقة دفع واحدة على الأقل";
  let sum = 0;
  for (const p of payments) {
    const a = Number(p.amount);
    if (!Number.isFinite(a) || a <= 0) return t ? t("cartMath.invalidAmount") : "مبلغ دفع غير صالح";
    sum += a;
  }
  if (round2(sum) !== round2(total)) {
    return t
      ? t("cartMath.sumMismatch", { sum: round2(sum), total: round2(total) })
      : `مجموع الدفعات (${round2(sum)}) لا يساوي إجمالي الطلب (${round2(total)})`;
  }
  return null;
}

/** Order-level discount % of subtotal — for the cashier-ceiling warning. */
export function orderDiscountPct(totals: CartTotals): number {
  return totals.subtotal > 0 ? (totals.discountAmount / totals.subtotal) * 100 : 0;
}
