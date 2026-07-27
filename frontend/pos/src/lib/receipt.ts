/**
 * Receipt printing — a thin POS wrapper over the shared invoice template
 * (frontend/shared/invoiceTemplate.ts). The sale-receipt HTML, paper-width CSS,
 * identity block, ZATCA QR and stamp handling now live in that ONE shared module
 * so the ERP `/app` invoice/credit-note screens render byte-identical documents.
 *
 * What STAYS here is POS-specific: the `LocalOrder → DocumentLine[]` adaptation,
 * the cart-math / totalsOverride resolution, the tab-title brand fallback, the
 * defensive catalog readers (paper width / auto-print), and the kitchen ticket +
 * shift X/Z report (no ERP consumer — kitchen tickets carry no money/identity,
 * shift reports are POS-shift-specific).
 *
 * English digits throughout. The print window is self-contained and CSP-safe in
 * both apps (window.open + document.write + .print(), no inline <script>).
 */
import { cartTotals } from "./cartMath";
import { fmt2, fmtDateTime, shortRef } from "./format";
import type { LocalOrder, Payment, ReceiptIdentity, ReceiptShowFields } from "./types";
import { baseCss, esc, buildSaleReceiptHtml, printHtml as printHtmlShared } from "../../../shared/invoiceTemplate";
import type { PaperWidth } from "../../../shared/invoiceTemplate";
import { receipt as receiptAr } from "../i18n/dictionaries/ar/receipt";
import { receipt as receiptEn } from "../i18n/dictionaries/en/receipt";

/** Language for the two POS-only print builders below (kitchen ticket + shift
 *  X/Z report). Default "ar" everywhere so existing callers that don't pass it
 *  keep printing exactly what they printed before this migration. */
export type ReceiptLanguage = "ar" | "en";

// Re-exported so existing POS call sites keep their import paths unchanged:
//   import { printHtml } from "./receipt"  /  from "@/lib/receipt"
export { printHtml } from "../../../shared/invoiceTemplate";
export type { PaperWidth, DocumentLanguage } from "../../../shared/invoiceTemplate";

/**
 * Write a document into an ALREADY-OPEN print window and print it.
 *
 * Why this exists: `printHtml` calls `window.open` ITSELF, and a browser only
 * honours that inside the task of a real user gesture. Auto-print necessarily
 * fires AFTER `await engine.checkout(...)` — a different task — so a window
 * opened there is popup-blocked and the receipt is silently lost. The payment
 * screen therefore opens a blank window SYNCHRONOUSLY inside the confirm click,
 * parks the handle in a ref, and hands it here once the sale lands.
 *
 * Returns false — WITHOUT ever opening a window of its own — when the handle is
 * missing or already closed, so the caller can fall back to the manual print
 * button + a toast instead of firing a second, certainly-blocked popup.
 */
export function printHtmlInto(html: string, win: Window | null | undefined): boolean {
  // The guard is the whole point: printHtml(html, null) would fall back to
  // opening a window, which is exactly the blocked-popup case we are avoiding,
  // and a CLOSED handle would be written to and reported as a success.
  if (!win || win.closed) return false;
  try {
    return printHtmlShared(html, win);
  } catch {
    // Dead/cross-origin handle: leave nothing dangling and report failure so
    // the caller toasts instead of pretending the receipt printed.
    try {
      win.close();
    } catch {
      /* already gone */
    }
    return false;
  }
}

/** Tab-title fallback ONLY for when no identity is cached (first run, resolver
 *  failure). A configured identity always wins. */
function brandNameFallback(): string {
  const title = typeof document !== "undefined" ? document.title : "";
  return title.split("|")[0]?.trim() || "المذاق المغربي";
}

// ── Paper width (owner setting: ReceiptPaperWidth '58'|'80'|'A4') ────────────
// The setting rides in the catalog as `receiptSettings.{paperWidth,autoPrint}`
// (server stream); both resolvers are DEFENSIVE — any missing/foreign shape
// falls back to 80mm / autoprint-on.

export function resolvePaperWidth(catalog: unknown): PaperWidth {
  const rs = (catalog as { receiptSettings?: { paperWidth?: unknown } } | null | undefined)?.receiptSettings;
  const raw = String(rs?.paperWidth ?? "80").trim().toUpperCase();
  return raw === "58" ? "58" : raw === "A4" ? "A4" : "80";
}

/** ReceiptAutoPrint ('1' default). '0' → the payment screen must NOT auto-invoke
 *  print; the manual receipt button always works either way. */
export function resolveAutoPrint(catalog: unknown): boolean {
  const rs = (catalog as { receiptSettings?: { autoPrint?: unknown } } | null | undefined)?.receiptSettings;
  return String(rs?.autoPrint ?? "1").trim() !== "0";
}

export interface ReceiptOptions {
  order: LocalOrder;
  payments: Payment[];
  invoiceNumber: string | null;
  cashTendered?: number;
  changeDue?: number;
  cashierName: string;
  vatRate: number;
  /** true → offline queued sale: prints the local reference instead. */
  offlineRef?: boolean;
  /** Owner-configured seller block from the cached catalog. Absent → the receipt
   *  prints what it has (tab-title name), never fabricated fields. */
  identity?: ReceiptIdentity | null;
  /** Owner's print toggles; absent → print everything present. */
  showFields?: ReceiptShowFields | null;
  /** Server-rendered ZATCA QR PNG. Absent on a queued offline sale — the receipt
   *  states the stamp arrives after sync instead of inventing one. */
  zatcaQrDataUrl?: string | null;
  /** Paper width per the owner setting (ReceiptPaperWidth). Default 80mm. */
  paperWidth?: PaperWidth;
  /** The moment shown on paper. A REPRINT passes the ORIGINAL sale datetime —
   *  the receipt is a copy of that document, not a new one. Default: now. */
  printedAt?: Date;
  /** Bordered stamp under the header for reprints of reversed documents
   *  (e.g. "ملغاة · VOIDED" / "مرتجع · RETURNED"). */
  stamp?: string | null;
  /** RECORDED figures for reprints. A reprint must show the sale's stored
   *  numbers, not a recomputation from lines whose vat categories the
   *  invoice endpoint does not echo. When present these replace cartTotals. */
  totalsOverride?: {
    subtotal: number;
    lineDiscountTotal: number;
    discountAmount: number;
    vatTotal: number;
    total: number;
  };
}

/** Adapt a POS `LocalOrder` + resolved totals into the shared sale-receipt
 *  renderer. All the presentation lives in buildSaleReceiptHtml now. */
export function buildReceiptHtml(opts: ReceiptOptions): string {
  const { order } = opts;
  const totals =
    opts.totalsOverride ??
    cartTotals(order.lines, order.discountType ? { type: order.discountType, value: order.discountValue } : null);

  return buildSaleReceiptHtml({
    lines: order.lines.map((l) => ({
      name: l.name,
      qty: l.qty,
      baseQty: l.baseQty,
      unitPrice: l.unitPrice,
      lineDiscount: l.lineDiscount,
      notes: l.notes ?? undefined,
      conversionFactorSnapshot: l.conversionFactorSnapshot,
      enteredUnitName: l.enteredUnitName ?? undefined,
    })),
    payments: opts.payments.map((p) => ({ method: p.method, amount: p.amount })),
    totals: {
      subtotal: totals.subtotal,
      lineDiscountTotal: totals.lineDiscountTotal,
      discountAmount: totals.discountAmount,
      vatTotal: totals.vatTotal,
      total: totals.total,
    },
    invoiceNumber: opts.invoiceNumber,
    fallbackSellerName: brandNameFallback(),
    cashierName: opts.cashierName,
    vatRate: opts.vatRate,
    paperWidth: opts.paperWidth ?? "80",
    identity: opts.identity ?? null,
    showFields: opts.showFields ?? null,
    zatcaQrDataUrl: opts.zatcaQrDataUrl ?? null,
    printedAt: opts.printedAt,
    stamp: opts.stamp ?? null,
    offlineRef: opts.offlineRef,
    cashTendered: opts.cashTendered,
    changeDue: opts.changeDue,
    orderType: order.orderType,
    tableNo: order.tableNo,
    discountName: order.discountName,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    localRef: shortRef(order.id),
    saleId: order.saleId,
  });
}

/** Kitchen ticket — items + qty + notes + table only, big font. Stays in POS:
 *  no ERP consumer, and it carries no money or seller identity. */
export function buildKitchenTicketHtml(
  order: LocalOrder,
  paperWidth: PaperWidth = "80",
  language: ReceiptLanguage = "ar",
): string {
  const t = (language === "en" ? receiptEn : receiptAr).kitchen;
  const dir = language === "en" ? "ltr" : "rtl";
  const orderTypeLabel =
    order.orderType === "dine_in"
      ? t.orderType.dine_in
      : order.orderType === "delivery"
        ? t.orderType.delivery
        : t.orderType.takeaway;
  const linesHtml = order.lines
    .map(
      (l) => `<tr>
        <td><span class="num">${fmt2(l.qty)}</span> ×</td>
        <td>${esc(l.name)}${l.notes ? `<div class="note">${esc(l.notes)}</div>` : ""}</td>
      </tr>`,
    )
    .join("");
  return `<!doctype html><html lang="${language}" dir="${dir}"><head><meta charset="utf-8">
  <title>${t.docTitle}</title><style>${baseCss(paperWidth)}</style></head><body class="kitchen" data-paper="${paperWidth}">
  <h1>${t.heading} — ${orderTypeLabel}${order.tableNo ? ` · ${t.table} <span class="num">${esc(order.tableNo)}</span>` : ""}</h1>
  <div class="sub num">${fmtDateTime(new Date())} · ${esc(shortRef(order.id))}</div>
  <hr>
  <table><tbody>${linesHtml}</tbody></table>
  ${order.note ? `<hr><div class="note">${esc(order.note)}</div>` : ""}
  </body></html>`;
}

// ── Shift X/Z report (thermal) ───────────────────────────────────────────────
// Data = GET /api/shifts/:id/full-report (declared structurally here so this
// module keeps zero dependency on the API layer). Z = after close (counted vs
// expected + variance + denominations); X = mid-shift snapshot (expected only —
// nothing has been counted yet, and printing zero "counted" would read as a
// perfect drawer). Stays in POS: shift reports are POS-shift-specific.
export interface ShiftReportData {
  shiftId: string;
  status?: string;
  cashier?: { username?: string; name?: string; empNo?: string };
  branch?: { name?: string; companyName?: string };
  company?: { name?: string; nameAr?: string; taxNumber?: string };
  times?: { start?: string | null; end?: string | null };
  financials?: { openingFloat?: number; expectedTotal?: number; actualTotal?: number; variance?: number; unmatched?: number };
  methods?: Array<{ name?: string; nameAr?: string | null; expected?: number; actual?: number; variance?: number }>;
  soldItems?: Array<{ name?: string; qty?: number; price?: number; total?: number }>;
  denominations?: Array<{ value?: number; kind?: string; count?: number }>;
  orderCount?: number;
  itemsCount?: number;
  notes?: string;
}

export function buildShiftReportHtml(
  rep: ShiftReportData,
  opts: { mode: "X" | "Z"; paperWidth?: PaperWidth; language?: ReceiptLanguage },
): string {
  const paper = opts.paperWidth ?? "80";
  const language = opts.language ?? "ar";
  const dir = language === "en" ? "ltr" : "rtl";
  const t = (language === "en" ? receiptEn : receiptAr).shift;
  const isZ = opts.mode === "Z";
  const f = rep.financials ?? {};
  const title = isZ ? t.titleZ : t.titleX;
  const cashier = rep.cashier ?? {};
  const methods = rep.methods ?? [];
  const denoms = (rep.denominations ?? []).filter((d) => Number(d.count) > 0);
  const items = rep.soldItems ?? [];

  const methodRows = methods
    .map((m) => {
      const label = esc(m.nameAr || m.name || t.dash);
      if (!isZ) return `<tr><td>${label}</td><td class="l num">${fmt2(m.expected ?? 0)}</td></tr>`;
      const v = m.variance ?? 0;
      return `<tr><td>${label}</td><td class="l num">${fmt2(m.expected ?? 0)}</td><td class="l num">${fmt2(m.actual ?? 0)}</td><td class="l num">${v > 0 ? "+" : ""}${fmt2(v)}</td></tr>`;
    })
    .join("");

  const denomRows = denoms
    .map((d) => {
      const val = Number(d.value) || 0;
      const face = val < 1 ? `${Math.round(val * 100)} ${t.halala}` : `${fmt2(val)} ${t.currency}`;
      return `<tr><td>${face}</td><td class="l num">× ${Number(d.count) || 0}</td><td class="l num">${fmt2(val * (Number(d.count) || 0))}</td></tr>`;
    })
    .join("");

  const itemRows = items
    .map((i) => `<tr><td>${esc(i.name || t.dash)}</td><td class="l num">${fmt2(i.qty ?? 0)}</td><td class="l num">${fmt2(i.total ?? 0)}</td></tr>`)
    .join("");

  const variance = f.variance ?? 0;

  return `<!doctype html><html lang="${language}" dir="${dir}"><head><meta charset="utf-8">
  <title>${title}</title><style>${baseCss(paper)}</style></head><body data-paper="${paper}">
  <h1>${esc(rep.company?.name || rep.company?.nameAr || brandNameFallback())}</h1>
  ${rep.branch?.name ? `<div class="sub">${esc(rep.branch.name)}</div>` : ""}
  <div class="stamp">${title}</div>
  <div class="sub">${t.shift} <span class="num">${esc(rep.shiftId)}</span></div>
  <div class="sub">${t.cashier} ${esc(cashier.name || cashier.username || t.dash)}${cashier.empNo ? ` · <span class="num">${esc(cashier.empNo)}</span>` : ""}</div>
  ${rep.times?.start ? `<div class="sub">${t.start} <span class="num">${fmtDateTime(new Date(rep.times.start))}</span></div>` : ""}
  ${isZ && rep.times?.end ? `<div class="sub">${t.end} <span class="num">${fmtDateTime(new Date(rep.times.end))}</span></div>` : ""}
  <div class="sub">${t.printed} <span class="num">${fmtDateTime(new Date())}</span></div>
  <hr>
  <table class="tot">
    <tr><td>${t.orderCount}</td><td class="l num">${Number(rep.orderCount ?? 0)}</td></tr>
    <tr><td>${t.itemsCount}</td><td class="l num">${Number(rep.itemsCount ?? 0)}</td></tr>
    <tr><td>${t.openingFloat}</td><td class="l num">${fmt2(f.openingFloat ?? 0)}</td></tr>
  </table>
  <hr>
  <table>
    <thead><tr><th>${t.paymentMethod}</th><th class="l">${t.expected}</th>${isZ ? `<th class="l">${t.counted}</th><th class="l">${t.variance}</th>` : ""}</tr></thead>
    <tbody>${methodRows}</tbody>
  </table>
  <table class="tot">
    <tr class="grand"><td>${t.expectedTotal}</td><td class="l num">${fmt2(f.expectedTotal ?? 0)}</td></tr>
    ${isZ ? `<tr class="grand"><td>${t.countedTotal}</td><td class="l num">${fmt2(f.actualTotal ?? 0)}</td></tr>
    <tr class="grand"><td>${t.difference}</td><td class="l num">${variance > 0 ? "+" : ""}${fmt2(variance)}</td></tr>` : ""}
    ${(f.unmatched ?? 0) > 0 ? `<tr><td>${t.unmatched}</td><td class="l num">${fmt2(f.unmatched ?? 0)}</td></tr>` : ""}
  </table>
  ${isZ && denomRows ? `<hr><table><thead><tr><th>${t.denomFace}</th><th class="l">${t.count}</th><th class="l">${t.total}</th></tr></thead><tbody>${denomRows}</tbody></table>` : ""}
  ${itemRows ? `<hr><table><thead><tr><th>${t.item}</th><th class="l">${t.qty}</th><th class="l">${t.itemTotal}</th></tr></thead><tbody>${itemRows}</tbody></table>` : ""}
  ${rep.notes ? `<hr><div class="sub">${esc(rep.notes)}</div>` : ""}
  ${!isZ ? `<div class="foot">${t.footerX}</div>` : `<div class="foot">${t.footerZ}</div>`}
  </body></html>`;
}
