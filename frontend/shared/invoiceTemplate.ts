/**
 * Shared invoice/receipt HTML template — the ONE renderer for every printed
 * money document across the two React apps (POS `/pos` and ERP `/app`).
 *
 * It grew out of `frontend/pos/src/lib/receipt.ts`: the paper-width CSS, the
 * seller-identity block, the ZATCA QR handling, the void/return stamp and the
 * split-payment / tendered-change rows all lived there and only there, so the
 * ERP invoice/credit-note screens re-invented "print" as a raw window.print()
 * of the React page — no QR, no owner identity, no thermal layout. This module
 * is that logic, generalized off the POS `LocalOrder` shape onto plain document
 * primitives, so BOTH apps build the identical HTML.
 *
 * Self-contained by design (works offline, no external assets, no inline
 * <script> — the print window is CSP-safe in both apps). English digits
 * throughout. Zero app/framework imports so `frontend/pos` and `frontend/erp`
 * can each import it with a plain relative path (same precedent as
 * frontend/shared/design-tokens.ts, which both tailwind configs already import).
 */

// ── Formatting (receipt-local copies — kept here so this module stays free of
// any app import; identical output to frontend/pos/src/lib/format.ts) ─────────
const num2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 1234.5 → "1,234.50" (English digits, tabular). */
function fmt2(n: number): string {
  return num2.format(Number.isFinite(n) ? n : 0);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "2026-07-03 14:05" — ISO-ish, unambiguous, English digits. */
function fmtDateTime(d: Date | number | string = new Date()): string {
  const t = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(t.getTime())) return "—";
  return `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())} ${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
}

/** HTML-escape untrusted text before it enters the printed document. */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Payment-method → Arabic label (built-in methods; unknown names pass through). */
export const PAY_LABELS: Record<string, string> = { cash: "كاش", card: "شبكة", credit: "آجل" };

// ── Paper width (owner setting: ReceiptPaperWidth '58'|'80'|'A4') ────────────
// 58mm thermal paper prints ~48mm wide; 80mm paper prints ~72mm (the historical
// hardcode); A4 gets a full-width layout.
export type PaperWidth = "58" | "80" | "A4";

const PAPER: Record<PaperWidth, { width: string; font: string; h1: string; grand: string; kitchen: string }> = {
  "58": { width: "48mm", font: "10px", h1: "13px", grand: "13px", kitchen: "15px" },
  "80": { width: "72mm", font: "12px", h1: "16px", grand: "15px", kitchen: "18px" },
  A4: { width: "190mm", font: "13px", h1: "19px", grand: "17px", kitchen: "20px" },
};

export function baseCss(paper: PaperWidth): string {
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

// ── Document primitives (framework-agnostic; each app adapts its own data
// shape into these before calling a builder) ─────────────────────────────────

/** Owner-configured seller identity a printed document renders. Superset of the
 *  POS `ReceiptIdentity` (re-exported from there as `ReceiptIdentity`). Every
 *  field is optional-in-practice: a builder omits any that is empty. */
export interface DocumentIdentity {
  sellerName: string;
  legalName: string;
  taxNumber: string;
  crNumber: string;
  address: string;
  nationalAddress: string;
  phone: string;
  email: string;
  logo: string;
  currency: string;
  vatRate: number;
  /** Optional custom tax name (server identity carries it; the POS type never did). */
  salesTaxName?: string;
  header: string;
  footer: string;
  thankYou: string;
  returnPolicy: string;
  branchName: string;
  branchCompanyName: string;
  brandName: string;
}

/** Which optional blocks the owner wants printed. Server defaults are all-on. */
export interface DocumentShowFields {
  logo: boolean;
  taxNumber: boolean;
  crNumber: boolean;
  nationalAddress: boolean;
  phone: boolean;
  email: boolean;
  cashier: boolean;
  customer: boolean;
  qr: boolean;
}

/** One printed line. `baseQty × unitPrice − lineDiscount` is the money authority
 *  for the line total; `qty` (+ `enteredUnitName` when the factor > 1) is what
 *  the human sees in the quantity column. */
export interface DocumentLine {
  name: string;
  qty: number;
  baseQty?: number;
  unitPrice: number;
  lineDiscount?: number;
  notes?: string;
  conversionFactorSnapshot?: number;
  enteredUnitName?: string;
}

/** Recorded (or computed) document totals — tax-inclusive, KSA retail
 *  convention: `subtotal` already contains the VAT shown as `vatTotal`, and
 *  `subtotal − discountAmount = total`. */
export interface DocumentTotals {
  subtotal: number;
  lineDiscountTotal: number;
  discountAmount: number;
  vatTotal: number;
  total: number;
}

export interface DocumentPayment {
  method: string;
  amount: number;
}

/** Order/service context a sale receipt may carry (a plain invoice omits all). */
export type ReceiptOrderType = "dine_in" | "takeaway" | "delivery";

// ── Shared identity/QR helpers ───────────────────────────────────────────────

function orderTypeLabel(orderType?: ReceiptOrderType | null): string {
  return orderType === "dine_in" ? "محلي" : orderType === "delivery" ? "توصيل" : orderType === "takeaway" ? "سفري" : "";
}

/** Render the seller identity block (h1 + the owner-configured sub-lines the
 *  showFields toggles allow). `fallbackSellerName` is the h1 when no identity is
 *  configured — the caller supplies it (POS: a tab-title fallback; ERP: a doc
 *  label) since a shared module can't assume either app's convention. */
function sellerBlock(
  idn: DocumentIdentity | null,
  show: DocumentShowFields | null,
  fallbackSellerName: string,
): { sellerName: string; lines: string[] } {
  const on = (k: keyof DocumentShowFields) => !show || show[k] !== false;
  const sellerName = idn?.sellerName || idn?.brandName || fallbackSellerName;
  const lines: string[] = [];
  if (idn) {
    if (idn.branchName) lines.push(`<div class="sub">${esc(idn.branchName)}</div>`);
    if (on("taxNumber") && idn.taxNumber) lines.push(`<div class="sub">الرقم الضريبي: <span class="num">${esc(idn.taxNumber)}</span></div>`);
    if (on("crNumber") && idn.crNumber) lines.push(`<div class="sub">س.ت: <span class="num">${esc(idn.crNumber)}</span></div>`);
    if (on("nationalAddress") && idn.nationalAddress) lines.push(`<div class="sub">${esc(idn.nationalAddress)}</div>`);
    if (on("phone") && idn.phone) lines.push(`<div class="sub num">${esc(idn.phone)}</div>`);
    if (idn.header) lines.push(`<div class="sub">${esc(idn.header)}</div>`);
  }
  return { sellerName, lines };
}

/** The ZATCA QR block: the server-stamped PNG, an honest "arrives after sync"
 *  note for a queued offline sale, or nothing. Never a client-side re-derivation
 *  (no QR encoder ships to the browser). */
function qrBlock(zatcaQrDataUrl: string | null | undefined, offlineRef: boolean, showQr: boolean): string {
  if (!showQr) return "";
  if (zatcaQrDataUrl) return `<div class="qr"><img src="${zatcaQrDataUrl}" alt="ZATCA QR" width="120" height="120"></div>`;
  if (offlineRef) return `<div class="sub">رمز الفاتورة الضريبي يصدر بعد المزامنة</div>`;
  return "";
}

function footerBlock(idn: DocumentIdentity | null, defaultThankYou: string): string {
  return `<div class="foot">${esc(idn?.thankYou || defaultThankYou)}</div>
  ${idn?.returnPolicy ? `<div class="sub">${esc(idn.returnPolicy)}</div>` : ""}
  ${idn?.footer ? `<div class="sub">${esc(idn.footer)}</div>` : ""}`;
}

// ── Sale receipt ─────────────────────────────────────────────────────────────

export interface SaleReceiptOptions {
  lines: DocumentLine[];
  payments: DocumentPayment[];
  /** Recorded/computed totals (the caller resolves any cart math first). */
  totals: DocumentTotals;
  invoiceNumber: string | null;
  /** h1 fallback when no identity is configured (POS: brand-name-from-title;
   *  ERP: a document label). Required — the shared module has no default. */
  fallbackSellerName: string;
  cashierName?: string;
  vatRate: number;
  paperWidth?: PaperWidth;
  identity?: DocumentIdentity | null;
  showFields?: DocumentShowFields | null;
  zatcaQrDataUrl?: string | null;
  /** A REPRINT passes the ORIGINAL sale datetime (a copy of that document). */
  printedAt?: Date;
  /** Bordered stamp under the header (e.g. "ملغاة · VOIDED"). */
  stamp?: string | null;
  /** true → offline queued sale: prints the local reference + "after sync" note. */
  offlineRef?: boolean;
  cashTendered?: number;
  changeDue?: number;
  orderType?: ReceiptOrderType | null;
  tableNo?: string | null;
  discountName?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  /** Short local reference for the offline ref line + the invoice-number fallback. */
  localRef?: string | null;
  /** Server sale id — the middle fallback for the invoice ref line. */
  saleId?: string | null;
}

export function buildSaleReceiptHtml(opts: SaleReceiptOptions): string {
  const paper = opts.paperWidth ?? "80";
  const totals = opts.totals;
  const show = opts.showFields ?? null;
  const on = (k: keyof DocumentShowFields) => !show || show[k] !== false;
  const label = orderTypeLabel(opts.orderType);
  const localRef = opts.localRef ?? "";

  const linesHtml = opts.lines
    .map((l) => {
      // qty column shows the ENTERED unit (e.g. "1 كرتون"); the line total uses
      // the BASE quantity × base price (money authority), matching cartTotals.
      const baseQty = Number(l.baseQty ?? l.qty);
      const factor = Number(l.conversionFactorSnapshot) || 1;
      const qtyLabel = factor > 1 && l.enteredUnitName ? `${fmt2(l.qty)} ${esc(l.enteredUnitName)}` : fmt2(l.qty);
      const lineGross = baseQty * l.unitPrice - (l.lineDiscount || 0);
      return `<tr>
        <td>${esc(l.name)}${l.notes ? `<div style="font-size:10px;color:#333">${esc(l.notes)}</div>` : ""}</td>
        <td class="l num">${qtyLabel}</td>
        <td class="l num">${fmt2(l.unitPrice)}</td>
        <td class="l num">${fmt2(lineGross)}</td>
      </tr>`;
    })
    .join("");

  const payHtml = opts.payments
    .map((p) => `<tr><td>${PAY_LABELS[p.method] ?? esc(p.method)}</td><td class="l num">${fmt2(p.amount)}</td></tr>`)
    .join("");

  const refLine = opts.offlineRef
    ? `<div class="sub">مرجع محلي: <span class="num">${esc(localRef)}</span> — سيُرحَّل عند عودة الاتصال</div>`
    : `<div class="sub">فاتورة: <span class="num">${esc(opts.invoiceNumber || opts.saleId || localRef)}</span></div>`;

  const { sellerName, lines: sellerLines } = sellerBlock(opts.identity ?? null, show, opts.fallbackSellerName);

  const cashierBits = [opts.cashierName ? `الكاشير: ${esc(opts.cashierName)}` : null, label || null].filter(Boolean);
  const cashierLine =
    on("cashier") && (cashierBits.length || opts.tableNo)
      ? `<div class="sub">${cashierBits.join(" · ")}${opts.tableNo ? ` · طاولة <span class="num">${esc(opts.tableNo)}</span>` : ""}</div>`
      : "";

  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
  <title>إيصال</title><style>${baseCss(paper)}</style></head><body data-paper="${paper}">
  <h1>${esc(sellerName)}</h1>
  ${sellerLines.join("\n  ")}
  ${opts.stamp ? `<div class="stamp">${esc(opts.stamp)}</div>` : ""}
  ${refLine}
  <div class="sub num">${fmtDateTime(opts.printedAt ?? new Date())}</div>
  ${cashierLine}
  ${on("customer") && (opts.customerName || opts.customerPhone) ? `<div class="sub">العميل: ${esc([opts.customerName, opts.customerPhone].filter(Boolean).join(" "))}</div>` : ""}
  <hr>
  <table>
    <thead><tr><th>الصنف</th><th class="l">كمية</th><th class="l">سعر</th><th class="l">إجمالي</th></tr></thead>
    <tbody>${linesHtml}</tbody>
  </table>
  <hr>
  <table class="tot">
    <tr><td>المجموع</td><td class="l num">${fmt2(totals.subtotal)}</td></tr>
    ${totals.lineDiscountTotal > 0 ? `<tr><td>خصومات الأسطر</td><td class="l num">-${fmt2(totals.lineDiscountTotal)}</td></tr>` : ""}
    ${totals.discountAmount > 0 ? `<tr><td>الخصم${opts.discountName ? ` (${esc(opts.discountName)})` : ""}</td><td class="l num">-${fmt2(totals.discountAmount)}</td></tr>` : ""}
    <tr><td>الضريبة (${fmt2(opts.vatRate)}% مشمولة)</td><td class="l num">${fmt2(totals.vatTotal)}</td></tr>
    <tr class="grand"><td>الإجمالي</td><td class="l num">${fmt2(totals.total)} ر.س</td></tr>
  </table>
  <hr>
  <table class="tot">${payHtml}
    ${opts.cashTendered ? `<tr><td>المستلَم</td><td class="l num">${fmt2(opts.cashTendered)}</td></tr>` : ""}
    ${opts.changeDue ? `<tr><td>الباقي</td><td class="l num">${fmt2(opts.changeDue)}</td></tr>` : ""}
  </table>
  ${qrBlock(opts.zatcaQrDataUrl, !!opts.offlineRef, on("qr"))}
  ${footerBlock(opts.identity ?? null, "شكرًا لزيارتكم")}
  </body></html>`;
}

// ── Credit note (مرتجع / إشعار دائن ضريبي) ────────────────────────────────────

export interface CreditNoteLine extends DocumentLine {
  /** Quantity actually returned on this credit note. */
  returnQty?: number;
  /** Quantity originally sold (shown for context alongside returnQty). */
  soldQty?: number;
}

export interface CreditNoteOptions {
  lines: CreditNoteLine[];
  totals: DocumentTotals;
  /** The credit note's own document number. */
  invoiceNumber: string | null;
  /** The invoice this credit note reverses (its document number). */
  originalInvoiceNumber: string | null;
  /** One reason per return document (the O2C model has no per-line reason). */
  returnReason?: string | null;
  fallbackSellerName: string;
  vatRate: number;
  paperWidth?: PaperWidth;
  identity?: DocumentIdentity | null;
  showFields?: DocumentShowFields | null;
  zatcaQrDataUrl?: string | null;
  printedAt?: Date;
  /** Overrides the default مرتجع stamp text when set. */
  stamp?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
}

export function buildCreditNoteHtml(opts: CreditNoteOptions): string {
  const paper = opts.paperWidth ?? "80";
  const totals = opts.totals;
  const show = opts.showFields ?? null;
  const on = (k: keyof DocumentShowFields) => !show || show[k] !== false;
  // The default stamp is what distinguishes this from a sale receipt at a glance.
  const stamp = opts.stamp || "مرتجع · إشعار دائن";

  const linesHtml = opts.lines
    .map((l) => {
      const baseQty = Number(l.baseQty ?? l.qty);
      const lineGross = baseQty * l.unitPrice - (l.lineDiscount || 0);
      // Returned / sold context under the item name.
      const qtyNote =
        l.returnQty != null || l.soldQty != null
          ? `<div style="font-size:10px;color:#333">مُرجَع <span class="num">${fmt2(Number(l.returnQty ?? l.qty))}</span>${l.soldQty != null ? ` من <span class="num">${fmt2(Number(l.soldQty))}</span> مباع` : ""}</div>`
          : "";
      return `<tr>
        <td>${esc(l.name)}${qtyNote}${l.notes ? `<div style="font-size:10px;color:#333">${esc(l.notes)}</div>` : ""}</td>
        <td class="l num">${fmt2(Number(l.returnQty ?? l.qty))}</td>
        <td class="l num">${fmt2(l.unitPrice)}</td>
        <td class="l num">${fmt2(lineGross)}</td>
      </tr>`;
    })
    .join("");

  const { sellerName, lines: sellerLines } = sellerBlock(opts.identity ?? null, show, opts.fallbackSellerName);

  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
  <title>إشعار دائن</title><style>${baseCss(paper)}</style></head><body data-paper="${paper}" data-doc="credit-note">
  <h1>${esc(sellerName)}</h1>
  ${sellerLines.join("\n  ")}
  <div class="stamp">${esc(stamp)}</div>
  <div class="sub">إشعار دائن ضريبي</div>
  <div class="sub">رقم: <span class="num">${esc(opts.invoiceNumber || "—")}</span></div>
  ${opts.originalInvoiceNumber ? `<div class="sub">الفاتورة الأصلية: <span class="num">${esc(opts.originalInvoiceNumber)}</span></div>` : ""}
  <div class="sub num">${fmtDateTime(opts.printedAt ?? new Date())}</div>
  ${on("customer") && (opts.customerName || opts.customerPhone) ? `<div class="sub">العميل: ${esc([opts.customerName, opts.customerPhone].filter(Boolean).join(" "))}</div>` : ""}
  ${opts.returnReason ? `<div class="sub">سبب المرتجع: ${esc(opts.returnReason)}</div>` : ""}
  <hr>
  <table>
    <thead><tr><th>الصنف</th><th class="l">مُرجَع</th><th class="l">سعر</th><th class="l">إجمالي</th></tr></thead>
    <tbody>${linesHtml}</tbody>
  </table>
  <hr>
  <table class="tot">
    <tr><td>المجموع</td><td class="l num">${fmt2(totals.subtotal)}</td></tr>
    ${totals.discountAmount > 0 ? `<tr><td>الخصم</td><td class="l num">-${fmt2(totals.discountAmount)}</td></tr>` : ""}
    <tr><td>الضريبة (${fmt2(opts.vatRate)}% مشمولة)</td><td class="l num">${fmt2(totals.vatTotal)}</td></tr>
    <tr class="grand"><td>إجمالي المرتجع</td><td class="l num">${fmt2(totals.total)} ر.س</td></tr>
  </table>
  ${qrBlock(opts.zatcaQrDataUrl, false, on("qr"))}
  ${footerBlock(opts.identity ?? null, "إشعار دائن ضريبي")}
  </body></html>`;
}

// ── Print ────────────────────────────────────────────────────────────────────

/** Open a print window, write the HTML, print. Popup-blocked → returns false. */
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
