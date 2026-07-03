/**
 * Receipt printing — self-contained RTL HTML in a print window. No external
 * assets (works offline). English digits throughout (fmt2 / fmtDateTime).
 *
 * Store header: the settings-lite source here is the app identity itself —
 * brand from the window title ("المذاق المغربي | كاشير V2" → first segment),
 * datetime from the client clock (catalog.serverTime is used by the caller to
 * detect gross clock skew, not printed).
 */
import { cartTotals } from "./cartMath";
import { fmt2, fmtDateTime, shortRef } from "./format";
import type { LocalOrder, Payment } from "./types";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function brandName(): string {
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
}

export function buildReceiptHtml(opts: ReceiptOptions): string {
  const { order, payments, invoiceNumber } = opts;
  const totals = cartTotals(order.lines, order.discountType ? { type: order.discountType, value: order.discountValue } : null);
  const orderTypeLabel = order.orderType === "dine_in" ? "محلي" : order.orderType === "delivery" ? "توصيل" : "سفري";

  const linesHtml = order.lines
    .map(
      (l) => `<tr>
        <td>${esc(l.name)}${l.notes ? `<div style="font-size:10px;color:#333">${esc(l.notes)}</div>` : ""}</td>
        <td class="l num">${fmt2(l.qty)}</td>
        <td class="l num">${fmt2(l.unitPrice)}</td>
        <td class="l num">${fmt2(l.qty * l.unitPrice - (l.lineDiscount || 0))}</td>
      </tr>`,
    )
    .join("");

  const payHtml = payments
    .map(
      (p) => `<tr><td>${PAY_LABELS[p.method] ?? esc(p.method)}</td><td class="l num">${fmt2(p.amount)}</td></tr>`,
    )
    .join("");

  const refLine = opts.offlineRef
    ? `<div class="sub">مرجع محلي: <span class="num">${esc(shortRef(order.id))}</span> — سيُرحَّل عند عودة الاتصال</div>`
    : `<div class="sub">فاتورة: <span class="num">${esc(invoiceNumber || order.saleId || shortRef(order.id))}</span></div>`;

  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
  <title>إيصال</title><style>${BASE_CSS}</style></head><body>
  <h1>${esc(brandName())}</h1>
  ${refLine}
  <div class="sub num">${fmtDateTime(new Date())}</div>
  <div class="sub">الكاشير: ${esc(opts.cashierName)} · ${orderTypeLabel}${order.tableNo ? ` · طاولة <span class="num">${esc(order.tableNo)}</span>` : ""}</div>
  ${order.customerName || order.customerPhone ? `<div class="sub">العميل: ${esc([order.customerName, order.customerPhone].filter(Boolean).join(" "))}</div>` : ""}
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
  <div class="foot">شكرًا لزيارتكم</div>
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
