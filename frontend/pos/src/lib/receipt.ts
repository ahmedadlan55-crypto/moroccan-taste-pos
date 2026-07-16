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

const BASE_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: "Tajawal", "Segoe UI", Tahoma, Arial, sans-serif; direction: rtl;
         width: 72mm; margin: 0 auto; padding: 4mm 2mm; color: #000; background: #fff; font-size: 12px; }
  .num { direction: ltr; unicode-bidi: embed; font-variant-numeric: tabular-nums; }
  h1 { font-size: 16px; text-align: center; margin-bottom: 2px; }
  .sub { text-align: center; font-size: 11px; color: #333; }
  hr { border: none; border-top: 1px dashed #000; margin: 6px 0; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: right; font-size: 11px; border-bottom: 1px solid #000; padding: 2px 0; }
  td { padding: 2px 0; vertical-align: top; font-size: 12px; }
  .l { text-align: left; }
  .tot td { padding: 1px 0; }
  .grand { font-size: 15px; font-weight: 800; border-top: 1px solid #000; }
  .foot { text-align: center; margin-top: 8px; font-size: 12px; font-weight: 700; }
  .qr { text-align: center; margin-top: 8px; }
  .qr img { image-rendering: pixelated; }
  .kitchen { font-size: 18px; }
  .kitchen td { font-size: 18px; font-weight: 700; padding: 4px 0; }
  .kitchen .note { font-size: 14px; font-weight: 400; color: #111; }
  @media print { body { width: auto; } }
`;

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
}

export function buildReceiptHtml(opts: ReceiptOptions): string {
  const { order, payments, invoiceNumber } = opts;
  const totals = cartTotals(order.lines, order.discountType ? { type: order.discountType, value: order.discountValue } : null);
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
  <title>إيصال</title><style>${BASE_CSS}</style></head><body>
  <h1>${esc(sellerName)}</h1>
  ${sellerLines.join("\n  ")}
  ${refLine}
  <div class="sub num">${fmtDateTime(new Date())}</div>
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
export function buildKitchenTicketHtml(order: LocalOrder): string {
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
  <title>تذكرة مطبخ</title><style>${BASE_CSS}</style></head><body class="kitchen">
  <h1>المطبخ — ${orderTypeLabel}${order.tableNo ? ` · طاولة <span class="num">${esc(order.tableNo)}</span>` : ""}</h1>
  <div class="sub num">${fmtDateTime(new Date())} · ${esc(shortRef(order.id))}</div>
  <hr>
  <table><tbody>${linesHtml}</tbody></table>
  ${order.note ? `<hr><div class="note">${esc(order.note)}</div>` : ""}
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
