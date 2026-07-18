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
import { baseCss, esc, buildSaleReceiptHtml } from "../../../shared/invoiceTemplate";
import type { PaperWidth } from "../../../shared/invoiceTemplate";

// Re-exported so existing POS call sites keep their import paths unchanged:
//   import { printHtml } from "./receipt"  /  from "@/lib/receipt"
export { printHtml } from "../../../shared/invoiceTemplate";
export type { PaperWidth } from "../../../shared/invoiceTemplate";

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
export function buildKitchenTicketHtml(order: LocalOrder, paperWidth: PaperWidth = "80"): string {
  const orderTypeLabel = order.orderType === "dine_in" ? "محلي" : order.orderType === "delivery" ? "توصيل" : "سفري";
  const linesHtml = order.lines
    .map(
      (l) => `<tr>
        <td><span class="num">${fmt2(l.qty)}</span> ×</td>
        <td>${esc(l.name)}${l.notes ? `<div class="note">${esc(l.notes)}</div>` : ""}</td>
      </tr>`,
    )
    .join("");
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
  <title>تذكرة مطبخ</title><style>${baseCss(paperWidth)}</style></head><body class="kitchen" data-paper="${paperWidth}">
  <h1>المطبخ — ${orderTypeLabel}${order.tableNo ? ` · طاولة <span class="num">${esc(order.tableNo)}</span>` : ""}</h1>
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

export function buildShiftReportHtml(rep: ShiftReportData, opts: { mode: "X" | "Z"; paperWidth?: PaperWidth }): string {
  const paper = opts.paperWidth ?? "80";
  const isZ = opts.mode === "Z";
  const f = rep.financials ?? {};
  const title = isZ ? "تقرير إغلاق وردية · Z" : "تقرير منتصف وردية · X";
  const cashier = rep.cashier ?? {};
  const methods = rep.methods ?? [];
  const denoms = (rep.denominations ?? []).filter((d) => Number(d.count) > 0);
  const items = rep.soldItems ?? [];

  const methodRows = methods
    .map((m) => {
      const label = esc(m.nameAr || m.name || "—");
      if (!isZ) return `<tr><td>${label}</td><td class="l num">${fmt2(m.expected ?? 0)}</td></tr>`;
      const v = m.variance ?? 0;
      return `<tr><td>${label}</td><td class="l num">${fmt2(m.expected ?? 0)}</td><td class="l num">${fmt2(m.actual ?? 0)}</td><td class="l num">${v > 0 ? "+" : ""}${fmt2(v)}</td></tr>`;
    })
    .join("");

  const denomRows = denoms
    .map((d) => {
      const val = Number(d.value) || 0;
      const face = val < 1 ? `${Math.round(val * 100)} هللة` : `${fmt2(val)} ر.س`;
      return `<tr><td>${face}</td><td class="l num">× ${Number(d.count) || 0}</td><td class="l num">${fmt2(val * (Number(d.count) || 0))}</td></tr>`;
    })
    .join("");

  const itemRows = items
    .map((i) => `<tr><td>${esc(i.name || "—")}</td><td class="l num">${fmt2(i.qty ?? 0)}</td><td class="l num">${fmt2(i.total ?? 0)}</td></tr>`)
    .join("");

  const variance = f.variance ?? 0;

  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
  <title>${title}</title><style>${baseCss(paper)}</style></head><body data-paper="${paper}">
  <h1>${esc(rep.company?.name || rep.company?.nameAr || brandNameFallback())}</h1>
  ${rep.branch?.name ? `<div class="sub">${esc(rep.branch.name)}</div>` : ""}
  <div class="stamp">${title}</div>
  <div class="sub">وردية: <span class="num">${esc(rep.shiftId)}</span></div>
  <div class="sub">الكاشير: ${esc(cashier.name || cashier.username || "—")}${cashier.empNo ? ` · <span class="num">${esc(cashier.empNo)}</span>` : ""}</div>
  ${rep.times?.start ? `<div class="sub">البداية: <span class="num">${fmtDateTime(new Date(rep.times.start))}</span></div>` : ""}
  ${isZ && rep.times?.end ? `<div class="sub">الإغلاق: <span class="num">${fmtDateTime(new Date(rep.times.end))}</span></div>` : ""}
  <div class="sub">طُبع: <span class="num">${fmtDateTime(new Date())}</span></div>
  <hr>
  <table class="tot">
    <tr><td>عدد الفواتير</td><td class="l num">${Number(rep.orderCount ?? 0)}</td></tr>
    <tr><td>عدد الأصناف المباعة</td><td class="l num">${Number(rep.itemsCount ?? 0)}</td></tr>
    <tr><td>رصيد افتتاحي</td><td class="l num">${fmt2(f.openingFloat ?? 0)}</td></tr>
  </table>
  <hr>
  <table>
    <thead><tr><th>طريقة الدفع</th><th class="l">متوقع</th>${isZ ? '<th class="l">معدود</th><th class="l">فرق</th>' : ""}</tr></thead>
    <tbody>${methodRows}</tbody>
  </table>
  <table class="tot">
    <tr class="grand"><td>الإجمالي المتوقع</td><td class="l num">${fmt2(f.expectedTotal ?? 0)}</td></tr>
    ${isZ ? `<tr class="grand"><td>الإجمالي المعدود</td><td class="l num">${fmt2(f.actualTotal ?? 0)}</td></tr>
    <tr class="grand"><td>الفرق</td><td class="l num">${variance > 0 ? "+" : ""}${fmt2(variance)}</td></tr>` : ""}
    ${(f.unmatched ?? 0) > 0 ? `<tr><td>غير مطابق لأي طريقة</td><td class="l num">${fmt2(f.unmatched ?? 0)}</td></tr>` : ""}
  </table>
  ${isZ && denomRows ? `<hr><table><thead><tr><th>الفئة</th><th class="l">العدد</th><th class="l">الإجمالي</th></tr></thead><tbody>${denomRows}</tbody></table>` : ""}
  ${itemRows ? `<hr><table><thead><tr><th>الصنف</th><th class="l">كمية</th><th class="l">إجمالي</th></tr></thead><tbody>${itemRows}</tbody></table>` : ""}
  ${rep.notes ? `<hr><div class="sub">${esc(rep.notes)}</div>` : ""}
  ${!isZ ? `<div class="foot">تقرير X — الوردية ما زالت مفتوحة</div>` : `<div class="foot">نهاية تقرير الوردية</div>`}
  </body></html>`;
}
