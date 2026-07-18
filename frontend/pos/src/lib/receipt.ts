/**
 * Receipt printing — self-contained RTL HTML in a print window. No external
 * assets (works offline). English digits throughout (fmt2 / fmtDateTime).
 *
 * Seller identity comes from the owner-configured ReceiptIdentity that rides in
 * the cached catalog (lib/invoiceIdentity.js server-side) — resolvable OFFLINE.
 * It used to be derived from the browser tab title, and none of the configured
 * fields (tax number, CR, national address, header, thank-you, return policy)
 * ever reached paper even though the API returned every one of them.
 *
 * The ZATCA QR is a server-rendered PNG data-URL captured at checkout. The
 * client never encodes QRs (the legacy template pulled an encoder from a CDN —
 * an online dependency inside an offline-first POS). A queued offline sale has
 * no stamp yet, and the receipt SAYS so rather than printing a substitute.
 */
import { cartTotals } from "./cartMath";
import { fmt2, fmtDateTime, shortRef } from "./format";
import type { LocalOrder, Payment, ReceiptIdentity, ReceiptShowFields } from "./types";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Tab-title fallback ONLY for when no identity is cached (first run, resolver
 *  failure). A configured identity always wins. */
function brandNameFallback(): string {
  const title = typeof document !== "undefined" ? document.title : "";
  return title.split("|")[0]?.trim() || "المذاق المغربي";
}

const PAY_LABELS: Record<string, string> = { cash: "كاش", card: "شبكة", credit: "آجل" };

// ── Paper width (owner setting: ReceiptPaperWidth '58'|'80'|'A4') ────────────
// 58mm thermal paper prints ~48mm wide; 80mm paper prints ~72mm (the historical
// hardcode); A4 gets a full-width layout. The setting rides in the catalog as
// `receiptSettings.{paperWidth,autoPrint}` (server stream); both resolvers are
// DEFENSIVE — any missing/foreign shape falls back to 80mm / autoprint-on.
export type PaperWidth = "58" | "80" | "A4";

const PAPER: Record<PaperWidth, { width: string; font: string; h1: string; grand: string; kitchen: string }> = {
  "58": { width: "48mm", font: "10px", h1: "13px", grand: "13px", kitchen: "15px" },
  "80": { width: "72mm", font: "12px", h1: "16px", grand: "15px", kitchen: "18px" },
  A4: { width: "190mm", font: "13px", h1: "19px", grand: "17px", kitchen: "20px" },
};

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

function baseCss(paper: PaperWidth): string {
  const p = PAPER[paper];
  return `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: "Tajawal", "Segoe UI", Tahoma, Arial, sans-serif; direction: rtl;
         width: ${p.width}; margin: 0 auto; padding: 4mm 2mm; color: #000; background: #fff; font-size: ${p.font}; }
  .num { direction: ltr; unicode-bidi: embed; font-variant-numeric: tabular-nums; }
  h1 { font-size: ${p.h1}; text-align: center; margin-bottom: 2px; }
  .sub { text-align: center; font-size: 0.92em; color: #333; }
  hr { border: none; border-top: 1px dashed #000; margin: 6px 0; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: right; font-size: 0.92em; border-bottom: 1px solid #000; padding: 2px 0; }
  td { padding: 2px 0; vertical-align: top; }
  .l { text-align: left; }
  .tot td { padding: 1px 0; }
  .grand { font-size: ${p.grand}; font-weight: 800; border-top: 1px solid #000; }
  .foot { text-align: center; margin-top: 8px; font-weight: 700; }
  .qr { text-align: center; margin-top: 8px; }
  .qr img { image-rendering: pixelated; }
  .stamp { border: 2px solid #000; text-align: center; font-weight: 900; padding: 3px 6px; margin: 6px auto; width: fit-content; }
  .kitchen { font-size: ${p.kitchen}; }
  .kitchen td { font-weight: 700; padding: 4px 0; }
  .kitchen .note { font-size: 0.8em; font-weight: 400; color: #111; }
  ${paper === "A4" ? "" : "@media print { body { width: auto; } }"}
`;
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

export function buildReceiptHtml(opts: ReceiptOptions): string {
  const { order, payments, invoiceNumber } = opts;
  const paper = opts.paperWidth ?? "80";
  const totals =
    opts.totalsOverride ??
    cartTotals(order.lines, order.discountType ? { type: order.discountType, value: order.discountValue } : null);
  const orderTypeLabel = order.orderType === "dine_in" ? "محلي" : order.orderType === "delivery" ? "توصيل" : "سفري";

  const linesHtml = order.lines
    .map((l) => {
      // qty column shows the ENTERED unit (e.g. "1 كرتون"); the line total uses the
      // BASE quantity × base price (money authority), matching cartTotals.
      const baseQty = Number(l.baseQty ?? l.qty);
      const factor = Number(l.conversionFactorSnapshot) || 1;
      const qtyLabel = factor > 1 && l.enteredUnitName
        ? `${fmt2(l.qty)} ${esc(l.enteredUnitName)}`
        : fmt2(l.qty);
      const lineGross = baseQty * l.unitPrice - (l.lineDiscount || 0);
      return `<tr>
        <td>${esc(l.name)}${l.notes ? `<div style="font-size:10px;color:#333">${esc(l.notes)}</div>` : ""}</td>
        <td class="l num">${qtyLabel}</td>
        <td class="l num">${fmt2(l.unitPrice)}</td>
        <td class="l num">${fmt2(lineGross)}</td>
      </tr>`;
    })
    .join("");

  const payHtml = payments
    .map(
      (p) => `<tr><td>${PAY_LABELS[p.method] ?? esc(p.method)}</td><td class="l num">${fmt2(p.amount)}</td></tr>`,
    )
    .join("");

  const refLine = opts.offlineRef
    ? `<div class="sub">مرجع محلي: <span class="num">${esc(shortRef(order.id))}</span> — سيُرحَّل عند عودة الاتصال</div>`
    : `<div class="sub">فاتورة: <span class="num">${esc(invoiceNumber || order.saleId || shortRef(order.id))}</span></div>`;

  // ── seller block: only what the owner configured, gated by their toggles ──
  const idn = opts.identity ?? null;
  const show = opts.showFields ?? null;
  const on = (k: keyof ReceiptShowFields) => !show || show[k] !== false;
  const sellerName = idn?.sellerName || idn?.brandName || brandNameFallback();
  const sellerLines: string[] = [];
  if (idn) {
    if (idn.branchName) sellerLines.push(`<div class="sub">${esc(idn.branchName)}</div>`);
    if (on("taxNumber") && idn.taxNumber) sellerLines.push(`<div class="sub">الرقم الضريبي: <span class="num">${esc(idn.taxNumber)}</span></div>`);
    if (on("crNumber") && idn.crNumber) sellerLines.push(`<div class="sub">س.ت: <span class="num">${esc(idn.crNumber)}</span></div>`);
    if (on("nationalAddress") && idn.nationalAddress) sellerLines.push(`<div class="sub">${esc(idn.nationalAddress)}</div>`);
    if (on("phone") && idn.phone) sellerLines.push(`<div class="sub num">${esc(idn.phone)}</div>`);
    if (idn.header) sellerLines.push(`<div class="sub">${esc(idn.header)}</div>`);
  }

  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
  <title>إيصال</title><style>${baseCss(paper)}</style></head><body data-paper="${paper}">
  <h1>${esc(sellerName)}</h1>
  ${sellerLines.join("\n  ")}
  ${opts.stamp ? `<div class="stamp">${esc(opts.stamp)}</div>` : ""}
  ${refLine}
  <div class="sub num">${fmtDateTime(opts.printedAt ?? new Date())}</div>
  ${on("cashier") ? `<div class="sub">الكاشير: ${esc(opts.cashierName)} · ${orderTypeLabel}${order.tableNo ? ` · طاولة <span class="num">${esc(order.tableNo)}</span>` : ""}</div>` : ""}
  ${on("customer") && (order.customerName || order.customerPhone) ? `<div class="sub">العميل: ${esc([order.customerName, order.customerPhone].filter(Boolean).join(" "))}</div>` : ""}
  <hr>
  <table>
    <thead><tr><th>الصنف</th><th class="l">كمية</th><th class="l">سعر</th><th class="l">إجمالي</th></tr></thead>
    <tbody>${linesHtml}</tbody>
  </table>
  <hr>
  <table class="tot">
    <tr><td>المجموع</td><td class="l num">${fmt2(totals.subtotal)}</td></tr>
    ${totals.lineDiscountTotal > 0 ? `<tr><td>خصومات الأسطر</td><td class="l num">-${fmt2(totals.lineDiscountTotal)}</td></tr>` : ""}
    ${totals.discountAmount > 0 ? `<tr><td>الخصم${order.discountName ? ` (${esc(order.discountName)})` : ""}</td><td class="l num">-${fmt2(totals.discountAmount)}</td></tr>` : ""}
    <tr><td>الضريبة (${fmt2(opts.vatRate)}% مشمولة)</td><td class="l num">${fmt2(totals.vatTotal)}</td></tr>
    <tr class="grand"><td>الإجمالي</td><td class="l num">${fmt2(totals.total)} ر.س</td></tr>
  </table>
  <hr>
  <table class="tot">${payHtml}
    ${opts.cashTendered ? `<tr><td>المستلَم</td><td class="l num">${fmt2(opts.cashTendered)}</td></tr>` : ""}
    ${opts.changeDue ? `<tr><td>الباقي</td><td class="l num">${fmt2(opts.changeDue)}</td></tr>` : ""}
  </table>
  ${(() => {
    // ZATCA QR: the stamped one or an honest absence — never a client-side
    // re-derivation. A queued offline sale is not stamped until it syncs.
    if (!on("qr")) return "";
    if (opts.zatcaQrDataUrl) return `<div class="qr"><img src="${opts.zatcaQrDataUrl}" alt="ZATCA QR" width="120" height="120"></div>`;
    if (opts.offlineRef) return `<div class="sub">رمز الفاتورة الضريبي يصدر بعد المزامنة</div>`;
    return "";
  })()}
  <div class="foot">${esc(idn?.thankYou || "شكرًا لزيارتكم")}</div>
  ${idn?.returnPolicy ? `<div class="sub">${esc(idn.returnPolicy)}</div>` : ""}
  ${idn?.footer ? `<div class="sub">${esc(idn.footer)}</div>` : ""}
  </body></html>`;
}

/** Kitchen ticket — items + qty + notes + table only, big font. */
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
// perfect drawer).
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

/** Open a print window, write, print. Popup-blocked → returns false. */
export function printHtml(html: string): boolean {
  const w = window.open("", "_blank", "width=420,height=640");
  if (!w) return false;
  w.document.open();
  w.document.write(html);
  w.document.close();
  // Give the layout a beat before printing (some webviews need it).
  w.setTimeout(() => {
    w.focus();
    w.print();
  }, 150);
  return true;
}
