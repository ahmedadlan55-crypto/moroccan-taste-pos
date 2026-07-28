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
 *
 * ── The typographic system (2026-07-28 redesign) ─────────────────────────────
 * A thermal receipt is 1-bit, fixed-width, and often printed on cheap paper, so
 * every distinction has to survive with NO colour and NO fill. Two rules govern
 * the layout:
 *
 *   1. RULES SEPARATE, THEY DO NOT DECORATE. Exactly three weights are used and
 *      each one means one thing:
 *        · solid  1px  — a section boundary (identity | transaction | items |
 *                        money | payment | closing)
 *        · dotted 1px  — a subdivision inside a section (the served-by band, the
 *                        savings badge)
 *        · double 3px  — the grand total, and nothing else
 *      No background fills anywhere: a browser print dialog defaults "background
 *      graphics" OFF, so an inverted total band prints white-on-white — i.e. an
 *      invisible total. Double rules can never fail that way.
 *   2. NUMBERS ARE A COLUMN, NOT A WORD. Every amount sits in a `.money` cell:
 *      its own LTR isolate, tabular figures, shrink-to-fit width, aligned to the
 *      trailing edge — so decimal points land on one axis in both ar and en.
 *
 * Hierarchy, top to bottom: logo → seller → welcome → fine print → document type
 * → transaction meta → served by → items → money → grand total → payment →
 * ZATCA QR → closing. Vertical rhythm does the grouping; rules only mark the six
 * boundaries above.
 */

// ── Formatting (receipt-local copies — kept here so this module stays free of
// any app import; identical output to frontend/pos/src/lib/format.ts) ─────────
const num2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Quantities are counts, not money: "2" (not "2.00"), "0.5" (not "0.50"). Three
// decimals is enough for a weighed item and buys back ~3 characters of width per
// row — which is real estate at 58mm.
const numQty = new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 3 });

/** 1234.5 → "1,234.50" (English digits, tabular). */
function fmt2(n: number): string {
  return num2.format(Number.isFinite(n) ? n : 0);
}

/** 2 → "2", 0.5 → "0.5" (English digits). See numQty above. Exported so the
 *  POS-only kitchen ticket prints quantities the same way this template does. */
export function fmtQty(n: number): string {
  return numQty.format(Number.isFinite(n) ? n : 0);
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

// A social handle, an e-mail address or a URL sitting inside Arabic free text.
// The bidi algorithm resolves the LEADING "@"/"#"/"w" boundary neutrals to the
// surrounding RTL level, so an Arabic footer reading «تابعنا @mathaq_sa» prints
// as «تابعنا mathaq_sa@» — the sigil jumps to the wrong end. Rendering the
// receipt in a browser is what surfaced it.
const LTR_TOKEN = /(?:[@#][A-Za-z0-9._+-]+|[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+|(?:https?:\/\/|www\.)[^\s]+)/g;

/** esc() for OWNER-ENTERED free text (header/thankYou/returnPolicy/footer/branch
 *  name). Identical to esc() except that handles, e-mails and URLs are wrapped
 *  in an explicit LTR isolate so they survive an RTL paragraph intact. Anything
 *  without such a token comes out byte-identical to esc(), so a purely Arabic or
 *  purely English line is untouched. */
export function escFree(s: string): string {
  let out = "";
  let last = 0;
  LTR_TOKEN.lastIndex = 0;
  for (let m = LTR_TOKEN.exec(s); m; m = LTR_TOKEN.exec(s)) {
    out += esc(s.slice(last, m.index)) + `<span class="ltr">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(s.slice(last));
}

// ── Bilingual labels ─────────────────────────────────────────────────────────
// 'ar' (default, unchanged historical behavior) | 'en' | 'both' (stacked ar
// then en in one printed document). Owner-entered free text on DocumentIdentity
// (header/footer/thankYou/returnPolicy/branchName/…) is NEVER translated here —
// it prints verbatim in whichever language the owner typed it; only the STATIC
// chrome around it (column headers, "الضريبة"/"VAT", payment-method names, …)
// is bilingual.
export type DocumentLanguage = "ar" | "en" | "both";

/** Defensive coercion: an old server / an unrecognized ReceiptLanguage setting
 *  value prints today's Arabic-only behavior instead of throwing. */
function normalizeLanguage(raw: unknown): DocumentLanguage {
  return raw === "en" || raw === "both" ? raw : "ar";
}

/** Payment-method → Arabic label (built-in methods; unknown names pass through). */
export const PAY_LABELS: Record<string, string> = { cash: "كاش", card: "شبكة", credit: "آجل" };
/** English counterpart of PAY_LABELS. */
export const PAY_LABELS_EN: Record<string, string> = { cash: "Cash", card: "Card", credit: "Credit" };

interface DocLabels {
  pay: Record<string, string>;
  orderType: { dine_in: string; delivery: string; takeaway: string };
  taxNumber: string;
  crNumber: string;
  /** "تم خدمتكم عن طريق" — the owner's own wording for the cashier credit. */
  servedBy: string;
  /** Key column of the transaction-meta grid. */
  dateLabel: string;
  serviceType: string;
  table: string;
  customer: string;
  offlineRef: string;
  offlineRefNote: string;
  invoiceRef: string;
  /** Document-type band under the seller block. */
  simplifiedTaxInvoice: string;
  taxInvoice: string;
  provisionalReceipt: string;
  /** Greeting printed when the owner configured no ReceiptHeader. */
  defaultWelcome: string;
  colItem: string;
  colQty: string;
  colPrice: string;
  colTotal: string;
  itemsCount: string;
  subtotal: string;
  lineDiscounts: string;
  discount: string;
  vat: string;
  vatIncluded: string;
  grandTotal: string;
  youSaved: string;
  paymentSection: string;
  received: string;
  change: string;
  currency: string;
  defaultThankYou: string;
  qrCaption: string;
  qrPending: string;
  receiptTitle: string;
  creditNoteTitle: string;
  creditNoteDefaultStamp: string;
  creditNoteSubtitle: string;
  docNumber: string;
  originalInvoice: string;
  returnReason: string;
  colReturned: string;
  returnedWord: string;
  ofWord: string;
  soldWord: string;
  creditGrandTotal: string;
}

/** Every static printed label the two builders below use, per language. */
const LABELS: Record<"ar" | "en", DocLabels> = {
  ar: {
    pay: PAY_LABELS,
    orderType: { dine_in: "محلي", delivery: "توصيل", takeaway: "سفري" },
    taxNumber: "الرقم الضريبي:",
    crNumber: "س.ت:",
    servedBy: "تم خدمتكم عن طريق",
    dateLabel: "التاريخ:",
    serviceType: "الطلب:",
    table: "طاولة",
    customer: "العميل:",
    offlineRef: "مرجع محلي:",
    offlineRefNote: "سيُرحَّل عند عودة الاتصال",
    invoiceRef: "فاتورة:",
    simplifiedTaxInvoice: "فاتورة ضريبية مبسطة",
    taxInvoice: "فاتورة ضريبية",
    provisionalReceipt: "إيصال مبدئي — لم يُرحَّل بعد",
    defaultWelcome: "أهلاً وسهلاً بكم",
    colItem: "الصنف",
    colQty: "كمية",
    colPrice: "سعر",
    colTotal: "إجمالي",
    itemsCount: "عدد الأصناف",
    subtotal: "المجموع",
    lineDiscounts: "خصومات الأسطر",
    discount: "الخصم",
    vat: "الضريبة",
    vatIncluded: "مشمولة",
    grandTotal: "الإجمالي",
    youSaved: "وفّرت في هذه الفاتورة",
    paymentSection: "المدفوع",
    received: "المستلَم",
    change: "الباقي",
    currency: "ر.س",
    defaultThankYou: "شكرًا لزيارتكم",
    qrCaption: "امسح الرمز للتحقق من الفاتورة",
    qrPending: "رمز الفاتورة الضريبي يصدر بعد المزامنة",
    receiptTitle: "إيصال",
    creditNoteTitle: "إشعار دائن",
    creditNoteDefaultStamp: "مرتجع · إشعار دائن",
    creditNoteSubtitle: "إشعار دائن ضريبي",
    docNumber: "رقم:",
    originalInvoice: "الفاتورة الأصلية:",
    returnReason: "سبب المرتجع:",
    colReturned: "مُرجَع",
    returnedWord: "مُرجَع",
    ofWord: "من",
    soldWord: "مباع",
    creditGrandTotal: "إجمالي المرتجع",
  },
  en: {
    pay: PAY_LABELS_EN,
    orderType: { dine_in: "Dine-in", delivery: "Delivery", takeaway: "Takeaway" },
    taxNumber: "VAT Number:",
    crNumber: "CR:",
    servedBy: "Served by",
    dateLabel: "Date:",
    serviceType: "Order:",
    table: "Table",
    customer: "Customer:",
    offlineRef: "Local ref:",
    offlineRefNote: "will sync once back online",
    invoiceRef: "Invoice:",
    simplifiedTaxInvoice: "Simplified Tax Invoice",
    taxInvoice: "Tax Invoice",
    provisionalReceipt: "Provisional receipt — not filed yet",
    defaultWelcome: "Welcome",
    colItem: "Item",
    colQty: "Qty",
    colPrice: "Price",
    colTotal: "Total",
    itemsCount: "Items",
    subtotal: "Subtotal",
    lineDiscounts: "Line discounts",
    discount: "Discount",
    vat: "VAT",
    vatIncluded: "incl.",
    grandTotal: "Grand Total",
    youSaved: "You saved on this invoice",
    paymentSection: "Paid",
    received: "Received",
    change: "Change",
    currency: "SAR",
    defaultThankYou: "Thank you for visiting us",
    qrCaption: "Scan to verify this invoice",
    qrPending: "The tax QR code will be issued after sync",
    receiptTitle: "Receipt",
    creditNoteTitle: "Credit Note",
    creditNoteDefaultStamp: "RETURN · CREDIT NOTE",
    creditNoteSubtitle: "Tax Credit Note",
    docNumber: "No.:",
    originalInvoice: "Original Invoice:",
    returnReason: "Return Reason:",
    colReturned: "Returned",
    returnedWord: "Returned",
    ofWord: "of",
    soldWord: "sold",
    creditGrandTotal: "Credit Total",
  },
};

// ── Paper width (owner setting: ReceiptPaperWidth '58'|'80'|'A4') ────────────
// 58mm thermal paper prints ~48mm wide; 80mm paper prints ~72mm (the historical
// hardcode); A4 gets a full-width layout.
export type PaperWidth = "58" | "80" | "A4";

interface PaperMetrics {
  width: string;
  font: string;
  h1: string;
  grand: string;
  kitchen: string;
  /** Body padding. Thermal gets a deep bottom pad so the tear-off never bites
   *  into the closing lines (the cutter fires a few mm past the last dot row). */
  pad: string;
  /** Cap on the owner logo so a 1000px upload cannot push the items off page 1. */
  logo: string;
  /** Head tracking — a hair of letter-spacing is what makes a 1-bit brand line
   *  read as typeset rather than as printer output. */
  track: string;
}

const PAPER: Record<PaperWidth, PaperMetrics> = {
  "58": { width: "48mm", font: "10px", h1: "13px", grand: "13px", kitchen: "15px", pad: "3mm 1.5mm 8mm", logo: "11mm", track: "0.02em" },
  "80": { width: "72mm", font: "12px", h1: "16px", grand: "15px", kitchen: "18px", pad: "4mm 2mm 9mm", logo: "15mm", track: "0.03em" },
  A4: { width: "190mm", font: "13px", h1: "19px", grand: "17px", kitchen: "20px", pad: "4mm 2mm", logo: "24mm", track: "0.02em" },
};

export function baseCss(paper: PaperWidth): string {
  const p = PAPER[paper];
  return `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  /* NO writing direction is declared here, deliberately. This rule used to pin
     the body to RTL, which overrode the <html dir="ltr"> every builder emits for
     an English document — so a shop set to English printed English text in a
     right-to-left frame: "Invoice:" came out ":Invoice", "Table 12" came out
     "12 Table", and the money column sat on the wrong edge. The direction is the
     DOCUMENT's: declared once on <html> by whichever builder ran, inherited from
     there, and overridden only by the <div dir="ltr"> wrapper of the English
     half of a bilingual receipt. */
  body { font-family: "Tajawal", "Segoe UI", Tahoma, Arial, sans-serif;
         width: ${p.width}; margin: 0 auto; padding: ${p.pad};
         color: var(--mt-text, CanvasText); background: var(--mt-surface, Canvas); font-size: ${p.font};
         line-height: 1.42; -webkit-text-size-adjust: 100%; }
  /* Numbers stay LTR inside RTL text and every digit takes the same advance, so
     decimal points line up down a column. isolate (not embed) also keeps the
     Arabic punctuation on either side from being dragged into the number run. */
  .num, .money .n, .line-calc .n { direction: ltr; unicode-bidi: isolate;
         font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1; }
  /* CENTRED owner-entered text takes its base direction from its OWN first
     strong character, so a Latin line inside an Arabic receipt (and vice versa)
     orders its neutrals correctly. Deliberately NOT applied to the item-name
     column: there, plaintext also flips text-align:start per row, so an Arabic
     dish inside an English receipt would hug the right while the "Item" header
     hugs the left. A ragged column is worse than a neutral that leans. */
  h1, .branch, .welcome, .sub, .foot, .policy { unicode-bidi: plaintext; }
  /* Each meta value is its own bidi island, so a name and a phone number keep
     their order regardless of which script either one is in. */
  .bidi { unicode-bidi: isolate; }
  h1 { font-size: ${p.h1}; text-align: center; margin-bottom: 1px; line-height: 1.18;
       font-weight: 800; letter-spacing: ${p.track}; }
  .sub { text-align: center; font-size: 0.92em; color: var(--mt-text-muted, GrayText); }
  .branch { text-align: center; font-size: 0.95em; font-weight: 700; }
  hr { border: none; border-top: 1px dashed currentColor; margin: 6px 0; }
  /* The ONE section boundary. Everything else is whitespace. */
  hr.rule { border-top: 1px solid currentColor; margin: 7px 0 5px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: start; font-size: 0.92em; border-bottom: 1px solid currentColor; padding: 2px 0; }
  td { padding: 2px 0; vertical-align: top; }
  .l { text-align: left; }
  .tot td { padding: 1px 0; }

  /* ── identity ─────────────────────────────────────────────────────────────*/
  .logo { text-align: center; margin-bottom: 3px; }
  .logo img { max-width: 62%; max-height: ${p.logo}; object-fit: contain; }
  .welcome { text-align: center; font-weight: 700; font-size: 1.05em; margin: 5px 0 4px;
             line-height: 1.35; }
  .doctype { text-align: center; font-weight: 800; font-size: 0.95em; letter-spacing: ${p.track};
             border-top: 1px solid currentColor; border-bottom: 1px solid currentColor;
             padding: 2px 0; margin: 6px 0 5px; }

  /* ── transaction meta (label → value, value pinned to the far edge) ───────*/
  .meta td { padding: 1px 0; font-size: 0.95em; }
  .meta .k { width: 1%; white-space: nowrap; padding-inline-end: 10px;
             color: var(--mt-text-muted, GrayText); }
  .meta .v { text-align: end; font-weight: 700; }

  /* ── served by — the cashier credit, its own band, never a metadata crumb ─*/
  .served { text-align: center; margin: 6px 0 2px; padding: 4px 0;
            border-top: 1px dotted currentColor; border-bottom: 1px dotted currentColor; }
  .served .k { display: block; font-size: 0.85em; letter-spacing: ${p.track};
               color: var(--mt-text-muted, GrayText); }
  .served .v { display: block; font-size: 1.12em; font-weight: 800; margin-top: 1px; }

  /* ── items — whitespace separates rows; no rule per row ───────────────────*/
  .items td { padding: 3px 0; }
  .items .nm { overflow-wrap: anywhere; padding-inline-end: 8px; }
  .items td.money.b { font-weight: 700; }
  .line-note { font-size: 0.85em; font-weight: 400; color: var(--mt-text-muted, GrayText); }
  /* "2 × 68.00" under the item name — the 58mm layout's unit economics. Kept in
     one LTR isolate so the quantity stays on the left of the × in both scripts. */
  .line-calc { font-size: 0.88em; text-align: start; color: var(--mt-text-muted, GrayText); }
  .ltr { direction: ltr; unicode-bidi: isolate; }

  /* ── the money column ──────────────────────────────────────────────────────
     width:1% + nowrap shrinks the cell to the widest amount in the column, so it
     hugs the paper's trailing edge; text-align:right (physical — the END of a
     number is on the right in ar and en alike) puts every decimal point on one
     axis; padding-inline-start opens the gutter toward the PREVIOUS column.
     Two things here are load-bearing and both were shipped wrong in the first
     cut of this redesign, and both were caught by rendering it:
       · the selector must be td.money (0,1,1), not .money (0,1,0) — the
         ".items td { padding: 3px 0 }" shorthand above outranks a bare class and
         silently zeroes the gutter, so 1,234.50 and 1,234.50 print touching;
       · the LTR isolate belongs on the INNER span. On the cell it would make
         padding-inline-start resolve to the LEFT, i.e. the paper edge in RTL,
         and the gutter opens on the wrong side. */
  td.money, th.mh { text-align: right; width: 1%; white-space: nowrap;
                    padding-inline-start: 7px; }
  td.money .n { display: inline-block; }

  /* ── money ────────────────────────────────────────────────────────────────*/
  .sec { font-size: 0.85em; font-weight: 700; letter-spacing: ${p.track};
         color: var(--mt-text-muted, GrayText); margin: 5px 0 1px; }
  .grand { font-size: ${p.grand}; font-weight: 800; border-top: 1px solid currentColor; }
  /* The total, and only the total, gets the double rule. It also lives in its
     OWN table: sharing one with the subtotal/VAT rows let the widest amount
     (the total, which carries a currency suffix) size the whole money column,
     squeezing the VAT label onto two lines at 58mm.
     NOTE: comments in here ship inside every printed document, so keep them
     ASCII and backtick-free (this is a JS template literal) — a stray currency
     glyph shows up in a not.toContain test and in the document's own source. */
  .total-tbl td { font-size: ${p.grand}; font-weight: 900; padding: 4px 0;
                  border-top: 1px solid currentColor; border-bottom: 3px double currentColor; }
  .savings { text-align: center; font-weight: 700; font-size: 0.95em; margin: 5px 0;
             padding: 3px 0; border-top: 1px dotted currentColor;
             border-bottom: 1px dotted currentColor; }
  .change td { font-weight: 800; }

  /* ── closing ──────────────────────────────────────────────────────────────*/
  .foot { text-align: center; margin-top: 9px; font-weight: 700; font-size: 1.05em; }
  .policy { text-align: center; font-size: 0.9em; color: var(--mt-text-muted, GrayText);
            margin-top: 3px; line-height: 1.35; }
  .qr { text-align: center; margin-top: 9px; }
  .qr img { image-rendering: pixelated; }
  .qr-cap { text-align: center; font-size: 0.82em; margin-top: 2px;
            color: var(--mt-text-muted, GrayText); }
  .stamp { border: 2px solid currentColor; text-align: center; font-weight: 900;
           letter-spacing: ${p.track}; padding: 3px 8px; margin: 6px auto; width: fit-content; }
  .kitchen { font-size: ${p.kitchen}; }
  .kitchen td { font-weight: 700; padding: 4px 0; }
  .kitchen .note { font-size: 0.8em; font-weight: 400; color: var(--mt-text, currentColor); }
  /* On paper there is no "muted": a thermal head is 1-bit, so grey renders as a
     dither pattern and small dithered type turns to mush. The greys exist for
     the ERP's on-screen live preview only — printing takes full ink and lets
     size and weight carry the hierarchy instead. */
  @media print { .sub, .policy, .qr-cap, .line-note, .line-calc, .sec,
    .meta .k, .served .k { color: CanvasText; } }
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
  /** 'ar' (default when absent) | 'en' | 'both'. Server-resolved from the
   *  ReceiptLanguage setting (lib/invoiceIdentity.js) — every existing caller
   *  that never set it keeps today's Arabic-only output exactly. */
  language?: DocumentLanguage;
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
  /**
   * The line's TAX-INCLUSIVE total and unit price, when the caller can compute
   * them (the POS can — it owns cartMath and the per-item tax convention).
   *
   * WHY THIS EXISTS. `subtotal` on DocumentTotals is tax-INCLUSIVE, but the row
   * fallback below computes `baseQty × unitPrice − lineDiscount`, and for a
   * tax-EXCLUSIVE menu row — which is every row in this database — that is the
   * NET figure. So the printed lines summed to 185.57 under a «المجموع» of
   * 213.40: a tax invoice whose own items do not add up to its own total. A
   * customer checking the paper finds a 28-riyal hole and is right to.
   *
   * Passing the figure in (rather than teaching this template the tax rules)
   * keeps ONE money authority — cartMath — exactly as the product card does.
   * Absent ⇒ the historical formula, so the ERP's own callers are untouched.
   */
  lineTotalGross?: number;
  unitPriceGross?: number;
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

function orderTypeLabel(orderType: ReceiptOrderType | null | undefined, lang: "ar" | "en"): string {
  const t = LABELS[lang].orderType;
  return orderType === "dine_in" ? t.dine_in : orderType === "delivery" ? t.delivery : orderType === "takeaway" ? t.takeaway : "";
}

/** The printed currency word. `identity.currency` is an ISO code the owner can
 *  change; SAR (and an unset value — the historical default) keeps the localized
 *  "ر.س"/"SAR" glyph, any other currency prints its own code rather than lying
 *  about riyals. */
function currencyLabel(idn: DocumentIdentity | null, lang: "ar" | "en"): string {
  const code = String(idn?.currency ?? "").trim().toUpperCase();
  return !code || code === "SAR" ? LABELS[lang].currency : esc(code);
}

/** The owner's logo, when they configured one AND left the toggle on. Only an
 *  inline data-image or an http(s)/root-relative URL is emitted — anything else
 *  (a `javascript:` or `data:text/html` value that reached the settings row) is
 *  dropped rather than written into the print document. */
function logoBlock(idn: DocumentIdentity | null, show: DocumentShowFields | null): string {
  if (!idn?.logo) return "";
  if (show && show.logo === false) return "";
  const src = String(idn.logo).trim();
  if (!/^(?:data:image\/[a-z0-9.+-]+;[a-z0-9-]+,|https?:\/\/|\/)/i.test(src)) return "";
  return `<div class="logo"><img src="${esc(src)}" alt=""></div>`;
}

/** Render the seller identity block (h1 + the owner-configured sub-lines the
 *  showFields toggles allow). `fallbackSellerName` is the h1 when no identity is
 *  configured — the caller supplies it (POS: a tab-title fallback; ERP: a doc
 *  label) since a shared module can't assume either app's convention. Only the
 *  static labels ("الرقم الضريبي:"/"VAT Number:", …) are bilingual — every value
 *  is owner-entered free text and prints verbatim regardless of `lang`.
 *
 *  `identity.header` is deliberately NOT part of this block any more: it is the
 *  owner's greeting and now prints as its own `.welcome` line under the brand
 *  (see welcomeBlock), instead of as a fourth anonymous `.sub` indistinguishable
 *  from the VAT number above it. */
function sellerBlock(
  idn: DocumentIdentity | null,
  show: DocumentShowFields | null,
  fallbackSellerName: string,
  lang: "ar" | "en",
): { sellerName: string; lines: string[] } {
  const on = (k: keyof DocumentShowFields) => !show || show[k] !== false;
  const t = LABELS[lang];
  const sellerName = idn?.sellerName || idn?.brandName || fallbackSellerName;
  const lines: string[] = [];
  if (idn) {
    if (on("taxNumber") && idn.taxNumber) lines.push(`<div class="sub">${t.taxNumber} <span class="num">${esc(idn.taxNumber)}</span></div>`);
    if (on("crNumber") && idn.crNumber) lines.push(`<div class="sub">${t.crNumber} <span class="num">${esc(idn.crNumber)}</span></div>`);
    // nationalAddress (the ZATCA short address) is the authoritative one; the
    // branch street address is printed only when there is no national address,
    // so the header never carries two competing addresses on 48mm of paper.
    // Both answer "where is this shop", so both ride the one existing toggle —
    // DocumentShowFields has no `address` key and adding a REQUIRED one would
    // break every caller that builds the 9-key literal.
    const place = on("nationalAddress") ? idn.nationalAddress || idn.address || "" : "";
    if (place) lines.push(`<div class="sub">${escFree(place)}</div>`);
    // Phone and e-mail share one line: two contact crumbs, one row of paper.
    const contact = [
      on("phone") && idn.phone ? `<span class="num">${esc(idn.phone)}</span>` : "",
      on("email") && idn.email ? esc(idn.email) : "",
    ].filter(Boolean);
    if (contact.length) lines.push(`<div class="sub">${contact.join(" · ")}</div>`);
  }
  return { sellerName, lines };
}

/** The رسالة ترحيبية. Source of truth is settings.ReceiptHeader (resolved onto
 *  `identity.header`, snapshotted per invoice, catalog-shipped so it survives
 *  offline) — there is deliberately no second settings key for a greeting.
 *
 *  `allowDefault` prints "أهلاً وسهلاً بكم"/"Welcome" when the owner configured
 *  nothing. The two builders pass it only for a customer-facing till receipt on
 *  thermal paper: greeting an A4 B2B tax invoice or a credit note would be
 *  tone-deaf, so those print the owner's own words or nothing. */
function welcomeBlock(idn: DocumentIdentity | null, lang: "ar" | "en", allowDefault: boolean): string {
  const text = idn?.header || (allowDefault ? LABELS[lang].defaultWelcome : "");
  return text ? `<div class="welcome">${escFree(text)}</div>` : "";
}

/** The ZATCA QR block: the server-stamped PNG, an honest "arrives after sync"
 *  note for a queued offline sale, or nothing. Never a client-side re-derivation
 *  (no QR encoder ships to the browser).
 *
 *  120×120 css px is ~32mm on a 203dpi thermal head — comfortably scannable and
 *  still only two thirds of the 48mm printable width, so it must not shrink. */
function qrBlock(zatcaQrDataUrl: string | null | undefined, offlineRef: boolean, showQr: boolean, lang: "ar" | "en"): string {
  if (!showQr) return "";
  if (zatcaQrDataUrl) {
    return `<div class="qr"><img src="${zatcaQrDataUrl}" alt="ZATCA QR" width="120" height="120"></div>
  <div class="qr-cap">${LABELS[lang].qrCaption}</div>`;
  }
  if (offlineRef) return `<div class="sub">${LABELS[lang].qrPending}</div>`;
  return "";
}

/** `defaultThankYou`, when passed, must already be the caller's language-correct
 *  fallback (the two builders below pass a per-language value from LABELS). */
function footerBlock(idn: DocumentIdentity | null, lang: "ar" | "en", defaultThankYou?: string): string {
  const thankYou = idn?.thankYou || defaultThankYou || LABELS[lang].defaultThankYou;
  return `<div class="foot">${escFree(thankYou)}</div>
  ${idn?.returnPolicy ? `<div class="policy">${escFree(idn.returnPolicy)}</div>` : ""}
  ${idn?.footer ? `<div class="policy">${escFree(idn.footer)}</div>` : ""}`;
}

/** One row of the transaction-meta grid. */
function metaRow(key: string, value: string): string {
  return `<tr><td class="k">${key}</td><td class="v">${value}</td></tr>`;
}

/** A money cell. Layout lives on the `<td>` (which keeps the DOCUMENT direction
 *  so its logical padding lands on the side facing the previous column); the LTR
 *  isolate lives on the inner span, which is the only part that needs it. */
function money(inner: string, extraClass = ""): string {
  return `<td class="money${extraClass ? ` ${extraClass}` : ""}"><span class="n">${inner}</span></td>`;
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
  /** Overrides the document-type band. Optional — the default is derived from
   *  the paper and the offline flag (see docTypeLabel), which is right for every
   *  caller that exists today. */
  docTitle?: string | null;
}

/** The document-type band. A POS thermal sale is a ZATCA *simplified* tax
 *  invoice (routes/sales.js stamps zatcaType 'simplified'); an A4 document from
 *  the ERP is titled just "فاتورة ضريبية" because it may carry a registered
 *  buyer. An offline queued sale is neither yet — it has no invoice number and
 *  no ZATCA stamp — so it is labelled a provisional receipt rather than claiming
 *  a tax-invoice title it has not earned. */
function docTypeLabel(opts: SaleReceiptOptions, lang: "ar" | "en", thermal: boolean): string {
  if (opts.docTitle != null) return opts.docTitle;
  const t = LABELS[lang];
  if (opts.offlineRef) return t.provisionalReceipt;
  return thermal ? t.simplifiedTaxInvoice : t.taxInvoice;
}

/** Everything between `<body>` and `</body>` for one language — factored out so
 *  language==='both' can render the SAME content twice (ar, then en) inside one
 *  document shell without duplicating the whole builder. */
function saleReceiptBody(opts: SaleReceiptOptions, lang: "ar" | "en", paper: PaperWidth): string {
  const totals = opts.totals;
  const show = opts.showFields ?? null;
  const on = (k: keyof DocumentShowFields) => !show || show[k] !== false;
  const t = LABELS[lang];
  const idn = opts.identity ?? null;
  const thermal = paper !== "A4";
  // 48mm cannot carry four columns AND a readable dish name: the three numeric
  // columns eat ~110px of 175px and every name wraps twice. At 58mm the unit
  // economics move to a "2 × 68.00" line under the name — the returning-goods
  // clerk still sees the unit price, and the name gets the full width.
  const compact = paper === "58";
  const cur = currencyLabel(idn, lang);
  const label = orderTypeLabel(opts.orderType, lang);
  const localRef = opts.localRef ?? "";

  const linesHtml = opts.lines
    .map((l) => {
      // qty column shows the ENTERED unit (e.g. "1 كرتون"); the line total uses
      // the BASE quantity × base price (money authority), matching cartTotals.
      const baseQty = Number(l.baseQty ?? l.qty);
      const factor = Number(l.conversionFactorSnapshot) || 1;
      const qtyLabel = factor > 1 && l.enteredUnitName ? `${fmtQty(l.qty)} ${esc(l.enteredUnitName)}` : fmtQty(l.qty);
      // Caller-supplied gross wins. The fallback is the historical formula and
      // is NET for a tax-exclusive row — see DocumentLine.lineTotalGross for
      // why that made the receipt fail to add up to its own total.
      const lineGross = l.lineTotalGross ?? baseQty * l.unitPrice - (l.lineDiscount || 0);
      const unitShown = l.unitPriceGross ?? l.unitPrice;
      const note = l.notes ? `<div class="line-note">${esc(l.notes)}</div>` : "";
      const calc = `<div class="line-calc"><span class="n">${qtyLabel} × ${fmt2(unitShown)}</span></div>`;
      return compact
        ? `<tr>
        <td class="nm">${esc(l.name)}${calc}${note}</td>
        ${money(fmt2(lineGross), "b")}
      </tr>`
        : `<tr>
        <td class="nm">${esc(l.name)}${note}</td>
        ${money(qtyLabel)}
        ${money(fmt2(unitShown))}
        ${money(fmt2(lineGross), "b")}
      </tr>`;
    })
    .join("");

  const itemHead = compact
    ? `<tr><th>${t.colItem}</th><th class="mh">${t.colTotal}</th></tr>`
    : `<tr><th>${t.colItem}</th><th class="mh">${t.colQty}</th><th class="mh">${t.colPrice}</th><th class="mh">${t.colTotal}</th></tr>`;

  const payHtml = opts.payments
    .map((p) => `<tr><td>${t.pay[p.method] ?? esc(p.method)}</td>${money(fmt2(p.amount))}</tr>`)
    .join("");

  const { sellerName, lines: sellerLines } = sellerBlock(idn, show, opts.fallbackSellerName, lang);

  // ── transaction meta: reference, moment, service context, customer ────────
  const metaRows = [
    opts.offlineRef
      ? metaRow(t.offlineRef, `<span class="num">${esc(localRef)}</span>`)
      : metaRow(t.invoiceRef, `<span class="num">${esc(opts.invoiceNumber || opts.saleId || localRef)}</span>`),
    metaRow(t.dateLabel, `<span class="num">${fmtDateTime(opts.printedAt ?? new Date())}</span>`),
    label || opts.tableNo
      ? metaRow(
          t.serviceType,
          [label, opts.tableNo ? `${t.table} <span class="num">${esc(opts.tableNo)}</span>` : ""].filter(Boolean).join(" · "),
        )
      : "",
    on("customer") && (opts.customerName || opts.customerPhone)
      ? metaRow(
          t.customer,
          [opts.customerName ? `<span class="bidi">${esc(opts.customerName)}</span>` : "", opts.customerPhone ? `<span class="num">${esc(opts.customerPhone)}</span>` : ""]
            .filter(Boolean)
            .join(" · "),
        )
      : "",
  ]
    .filter(Boolean)
    .join("\n    ");

  // «تم خدمتكم عن طريق …» — the owner's request: the person who served the
  // customer gets a named credit line of their own, not a slash-separated crumb
  // in a metadata row. Still gated by the `cashier` toggle for shops that do not
  // want staff names on paper.
  const servedBy =
    on("cashier") && opts.cashierName
      ? `<div class="served"><span class="k">${t.servedBy}</span><span class="v">${esc(opts.cashierName)}</span></div>`
      : "";

  const saved = (totals.lineDiscountTotal || 0) + (totals.discountAmount || 0);
  const taxName = idn?.salesTaxName ? esc(idn.salesTaxName) : t.vat;
  const docType = docTypeLabel(opts, lang, thermal);

  return `${logoBlock(idn, show)}<h1>${escFree(sellerName)}</h1>
  ${idn?.branchName ? `<div class="branch">${escFree(idn.branchName)}</div>` : ""}
  ${welcomeBlock(idn, lang, thermal)}
  ${sellerLines.join("\n  ")}
  ${docType ? `<div class="doctype">${esc(docType)}</div>` : ""}
  ${opts.stamp ? `<div class="stamp">${esc(opts.stamp)}</div>` : ""}
  <table class="meta">
    ${metaRows}
  </table>
  ${opts.offlineRef ? `<div class="sub">${t.offlineRefNote}</div>` : ""}
  ${servedBy}
  <hr class="rule">
  <table class="items">
    <thead>${itemHead}</thead>
    <tbody>${linesHtml}</tbody>
  </table>
  <hr class="rule">
  <table class="tot">
    <tr><td>${t.itemsCount}</td>${money(String(opts.lines.length))}</tr>
    <tr><td>${t.subtotal}</td>${money(fmt2(totals.subtotal))}</tr>
    ${totals.lineDiscountTotal > 0 ? `<tr><td>${t.lineDiscounts}</td>${money(`-${fmt2(totals.lineDiscountTotal)}`)}</tr>` : ""}
    ${totals.discountAmount > 0 ? `<tr><td>${t.discount}${opts.discountName ? ` (${esc(opts.discountName)})` : ""}</td>${money(`-${fmt2(totals.discountAmount)}`)}</tr>` : ""}
    <tr><td>${taxName} (${fmtQty(opts.vatRate)}% ${t.vatIncluded})</td>${money(fmt2(totals.vatTotal))}</tr>
  </table>
  <table class="tot total-tbl">
    <tr class="total"><td>${t.grandTotal}</td>${money(`${fmt2(totals.total)} ${cur}`)}</tr>
  </table>
  ${saved > 0 ? `<div class="savings">${t.youSaved} <span class="num">${fmt2(saved)} ${cur}</span></div>` : ""}
  ${payHtml || opts.cashTendered || opts.changeDue ? `<div class="sec">${t.paymentSection}</div>` : ""}
  <table class="tot">${payHtml}
    ${opts.cashTendered ? `<tr><td>${t.received}</td>${money(fmt2(opts.cashTendered))}</tr>` : ""}
    ${opts.changeDue ? `<tr class="change"><td>${t.change}</td>${money(fmt2(opts.changeDue))}</tr>` : ""}
  </table>
  ${qrBlock(opts.zatcaQrDataUrl, !!opts.offlineRef, on("qr"), lang)}
  ${footerBlock(idn, lang)}`;
}

export function buildSaleReceiptHtml(opts: SaleReceiptOptions): string {
  const paper = opts.paperWidth ?? "80";
  const language = normalizeLanguage(opts.identity?.language);

  if (language === "both") {
    // Stacked (not side-by-side): the least invasive way to fit a full second
    // language block into the existing thermal/A4 layout without redesigning
    // every table into two columns. Arabic block first (today's primary
    // audience), English block second, separated by a heavier divider.
    const arBody = saleReceiptBody(opts, "ar", paper);
    const enBody = saleReceiptBody(opts, "en", paper);
    return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
  <title>${LABELS.ar.receiptTitle} / ${LABELS.en.receiptTitle}</title><style>${baseCss(paper)}</style></head>
  <body data-paper="${paper}" data-lang="both">
  ${arBody}
  <hr style="border-top: 3px double currentColor; margin: 10px 0;">
  <div dir="ltr" lang="en">
  ${enBody}
  </div>
  </body></html>`;
  }

  const dir = language === "en" ? "ltr" : "rtl";
  const body = saleReceiptBody(opts, language, paper);
  return `<!doctype html><html lang="${language}" dir="${dir}"><head><meta charset="utf-8">
  <title>${LABELS[language].receiptTitle}</title><style>${baseCss(paper)}</style></head>
  <body data-paper="${paper}" data-lang="${language}">
  ${body}
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

/** Everything between `<body>` and `</body>` for one language — factored out for
 *  the same reason as saleReceiptBody above (language==='both' reuses it twice). */
function creditNoteBody(opts: CreditNoteOptions, lang: "ar" | "en", paper: PaperWidth): string {
  const totals = opts.totals;
  const show = opts.showFields ?? null;
  const on = (k: keyof DocumentShowFields) => !show || show[k] !== false;
  const t = LABELS[lang];
  const idn = opts.identity ?? null;
  const cur = currencyLabel(idn, lang);
  const compact = paper === "58";
  // The default stamp is what distinguishes this from a sale receipt at a glance.
  const stamp = opts.stamp || t.creditNoteDefaultStamp;

  const linesHtml = opts.lines
    .map((l) => {
      const baseQty = Number(l.baseQty ?? l.qty);
      const lineGross = baseQty * l.unitPrice - (l.lineDiscount || 0);
      const retQty = fmtQty(Number(l.returnQty ?? l.qty));
      // Returned / sold context under the item name.
      const qtyNote =
        l.returnQty != null || l.soldQty != null
          ? `<div class="line-note">${t.returnedWord} <span class="num">${retQty}</span>${l.soldQty != null ? ` ${t.ofWord} <span class="num">${fmtQty(Number(l.soldQty))}</span> ${t.soldWord}` : ""}</div>`
          : "";
      const note = l.notes ? `<div class="line-note">${esc(l.notes)}</div>` : "";
      const calc = `<div class="line-calc"><span class="n">${retQty} × ${fmt2(l.unitPrice)}</span></div>`;
      return compact
        ? `<tr>
        <td class="nm">${esc(l.name)}${calc}${qtyNote}${note}</td>
        ${money(fmt2(lineGross), "b")}
      </tr>`
        : `<tr>
        <td class="nm">${esc(l.name)}${qtyNote}${note}</td>
        ${money(retQty)}
        ${money(fmt2(l.unitPrice))}
        ${money(fmt2(lineGross), "b")}
      </tr>`;
    })
    .join("");

  const itemHead = compact
    ? `<tr><th>${t.colItem}</th><th class="mh">${t.colTotal}</th></tr>`
    : `<tr><th>${t.colItem}</th><th class="mh">${t.colReturned}</th><th class="mh">${t.colPrice}</th><th class="mh">${t.colTotal}</th></tr>`;

  const { sellerName, lines: sellerLines } = sellerBlock(idn, show, opts.fallbackSellerName, lang);
  const taxName = idn?.salesTaxName ? esc(idn.salesTaxName) : t.vat;

  const metaRows = [
    metaRow(t.docNumber, `<span class="num">${esc(opts.invoiceNumber || "—")}</span>`),
    opts.originalInvoiceNumber ? metaRow(t.originalInvoice, `<span class="num">${esc(opts.originalInvoiceNumber)}</span>`) : "",
    metaRow(t.dateLabel, `<span class="num">${fmtDateTime(opts.printedAt ?? new Date())}</span>`),
    on("customer") && (opts.customerName || opts.customerPhone)
      ? metaRow(
          t.customer,
          [opts.customerName ? `<span class="bidi">${esc(opts.customerName)}</span>` : "", opts.customerPhone ? `<span class="num">${esc(opts.customerPhone)}</span>` : ""]
            .filter(Boolean)
            .join(" · "),
        )
      : "",
    opts.returnReason ? metaRow(t.returnReason, esc(opts.returnReason)) : "",
  ]
    .filter(Boolean)
    .join("\n    ");

  // A credit note carries the owner's header if they wrote one, but never the
  // default greeting — "أهلاً وسهلاً بكم" on a refund document reads as sarcasm.
  return `${logoBlock(idn, show)}<h1>${escFree(sellerName)}</h1>
  ${idn?.branchName ? `<div class="branch">${escFree(idn.branchName)}</div>` : ""}
  ${welcomeBlock(idn, lang, false)}
  ${sellerLines.join("\n  ")}
  <div class="stamp">${esc(stamp)}</div>
  <div class="doctype">${t.creditNoteSubtitle}</div>
  <table class="meta">
    ${metaRows}
  </table>
  <hr class="rule">
  <table class="items">
    <thead>${itemHead}</thead>
    <tbody>${linesHtml}</tbody>
  </table>
  <hr class="rule">
  <table class="tot">
    <tr><td>${t.itemsCount}</td>${money(String(opts.lines.length))}</tr>
    <tr><td>${t.subtotal}</td>${money(fmt2(totals.subtotal))}</tr>
    ${totals.discountAmount > 0 ? `<tr><td>${t.discount}</td>${money(`-${fmt2(totals.discountAmount)}`)}</tr>` : ""}
    <tr><td>${taxName} (${fmtQty(opts.vatRate)}% ${t.vatIncluded})</td>${money(fmt2(totals.vatTotal))}</tr>
  </table>
  <table class="tot total-tbl">
    <tr class="total"><td>${t.creditGrandTotal}</td>${money(`${fmt2(totals.total)} ${cur}`)}</tr>
  </table>
  ${qrBlock(opts.zatcaQrDataUrl, false, on("qr"), lang)}
  ${footerBlock(idn, lang, t.creditNoteSubtitle)}`;
}

export function buildCreditNoteHtml(opts: CreditNoteOptions): string {
  const paper = opts.paperWidth ?? "80";
  const language = normalizeLanguage(opts.identity?.language);

  if (language === "both") {
    const arBody = creditNoteBody(opts, "ar", paper);
    const enBody = creditNoteBody(opts, "en", paper);
    return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
  <title>${LABELS.ar.creditNoteTitle} / ${LABELS.en.creditNoteTitle}</title><style>${baseCss(paper)}</style></head>
  <body data-paper="${paper}" data-doc="credit-note" data-lang="both">
  ${arBody}
  <hr style="border-top: 3px double currentColor; margin: 10px 0;">
  <div dir="ltr" lang="en">
  ${enBody}
  </div>
  </body></html>`;
  }

  const dir = language === "en" ? "ltr" : "rtl";
  const body = creditNoteBody(opts, language, paper);
  return `<!doctype html><html lang="${language}" dir="${dir}"><head><meta charset="utf-8">
  <title>${LABELS[language].creditNoteTitle}</title><style>${baseCss(paper)}</style></head>
  <body data-paper="${paper}" data-doc="credit-note" data-lang="${language}">
  ${body}
  </body></html>`;
}

// ── Print ────────────────────────────────────────────────────────────────────

/**
 * Write the HTML into a print window and print it. Returns false when there is
 * no window to print into (popup-blocked).
 *
 * `win` — an ALREADY-OPEN window to render into. Omit it and the behavior is
 * exactly as it always was: this function calls window.open itself.
 *
 * Why the parameter exists: a browser only honors window.open inside the user
 * gesture that triggered it. AUTO-PRINT fires after an `await` (the checkout
 * round-trip), by which time the gesture is spent and the self-opened popup is
 * blocked — auto-print could never work. The caller now opens the window
 * SYNCHRONOUSLY on the click, awaits its data, and hands the live window here.
 * Passing null (the caller's own window.open was already blocked) falls back to
 * opening one here, so the answer is still an honest true/false — never a
 * silent no-op.
 */
export function printHtml(html: string, win?: Window | null): boolean {
  const w = win ?? window.open("", "_blank", "width=420,height=640");
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
