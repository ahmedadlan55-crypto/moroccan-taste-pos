/**
 * The shared invoice/receipt renderer — the ONE template both the POS (/pos) and
 * the ERP (/app) apps print through. These assertions mirror the POS
 * receipt.test.ts structurally (each is a field reaching PAPER, not merely
 * existing in a payload) and add the credit-note document the ERP returns screen
 * needs.
 *
 * Co-located in the POS test tree (not frontend/shared/__tests__) on purpose:
 * Vitest fails to LOAD a test file located outside the project root when the
 * repo's absolute path is non-ASCII (the `../` escape gets percent-encoded and
 * no longer resolves). Importing the shared module FROM inside-root files works
 * fine — which is exactly how both apps consume it — so this file lives here and
 * imports the shared module directly. The ERP side additionally exercises the
 * same module through its adapter + print-wiring tests.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildSaleReceiptHtml,
  buildCreditNoteHtml,
  printHtml,
  type CreditNoteOptions,
  type DocumentIdentity,
  type SaleReceiptOptions,
} from "../../../../shared/invoiceTemplate";

const IDENTITY: DocumentIdentity = {
  sellerName: "مطاعم الأصالة",
  legalName: "شركة الأصالة للأغذية",
  taxNumber: "310122393500003",
  crNumber: "1010999999",
  address: "شارع التحلية",
  nationalAddress: "RRRD2929 حي العليا، الرياض",
  phone: "0112345678",
  email: "info@example.com",
  logo: "",
  currency: "SAR",
  vatRate: 15,
  header: "فرع العليا — فاتورة ضريبية مبسطة",
  footer: "سجل معنا في برنامج الولاء",
  thankYou: "نشكر لكم زيارتكم ونتشرف بخدمتكم",
  returnPolicy: "الاسترجاع خلال ٣ أيام بالفاتورة",
  branchName: "فرع العليا",
  branchCompanyName: "",
  brandName: "الأصالة",
};

// Owner-entered free text (header/footer/thankYou/branchName/…) stays exactly
// as typed regardless of `language` — only the STATIC chrome around it (column
// headers, "الضريبة"/"VAT", …) switches. Same values as IDENTITY, +language.
const IDENTITY_EN: DocumentIdentity = { ...IDENTITY, language: "en" };
const IDENTITY_BOTH: DocumentIdentity = { ...IDENTITY, language: "both" };

function saleOpts(partial?: Partial<SaleReceiptOptions>): SaleReceiptOptions {
  return {
    lines: [{ name: "برجر", qty: 2, unitPrice: 20, lineDiscount: 0 }],
    payments: [{ method: "cash", amount: 46 }],
    totals: { subtotal: 40, lineDiscountTotal: 0, discountAmount: 0, vatTotal: 5.22, total: 40 },
    invoiceNumber: "INV-20260715-0001",
    fallbackSellerName: "المذاق المغربي",
    cashierName: "أحمد",
    vatRate: 15,
    identity: IDENTITY,
    zatcaQrDataUrl: "data:image/png;base64,iVBORw0KGgoTEST",
    orderType: "takeaway",
    localRef: "ABCD1234",
    saleId: "SALE-1",
    ...partial,
  };
}

describe("buildSaleReceiptHtml — identity reaches paper", () => {
  it("prints the CONFIGURED seller, not the fallback name", () => {
    const html = buildSaleReceiptHtml(saleOpts());
    expect(html).toContain("<h1>الأصالة</h1>");
    expect(html).toContain('class="legal">مطاعم الأصالة');
    expect(html).not.toContain("المذاق المغربي");
  });

  it("prints every owner-configured seller field", () => {
    const html = buildSaleReceiptHtml(saleOpts());
    expect(html).toContain('class="legal"');
    expect(html).toContain(IDENTITY.legalName);
    expect(html).toContain(`<h1>${IDENTITY.brandName}</h1>`);
    expect(html).toContain("310122393500003"); // taxNumber
    expect(html).toContain("1010999999"); // crNumber
    expect(html).toContain("RRRD2929 حي العليا، الرياض"); // nationalAddress
    expect(html).toContain("فرع العليا — فاتورة ضريبية مبسطة"); // header
    expect(html).toContain("نشكر لكم زيارتكم ونتشرف بخدمتكم"); // thankYou
    expect(html).toContain("الاسترجاع خلال ٣ أيام بالفاتورة"); // returnPolicy
    expect(html).toContain("سجل معنا في برنامج الولاء"); // footer
  });

  it("thankYou REPLACES the hardcoded footer instead of duplicating it", () => {
    const html = buildSaleReceiptHtml(saleOpts());
    expect(html).not.toContain("شكرًا لزيارتكم");
  });

  it("prints the server-stamped QR as an image — never re-derives it", () => {
    const html = buildSaleReceiptHtml(saleOpts());
    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgoTEST"');
  });

  it("an OFFLINE queued sale says the stamp comes after sync — no fake QR", () => {
    const html = buildSaleReceiptHtml(saleOpts({ offlineRef: true, zatcaQrDataUrl: null }));
    expect(html).toContain("رمز الفاتورة الضريبي يصدر بعد المزامنة");
    expect(html).toContain("مرجع محلي");
    expect(html).not.toContain("<img");
  });

  it("no identity → the caller's fallback name and NO fabricated fields", () => {
    const html = buildSaleReceiptHtml(saleOpts({ identity: null, zatcaQrDataUrl: null }));
    expect(html).toContain("المذاق المغربي");
    expect(html).not.toContain("الرقم الضريبي");
    expect(html).not.toContain("س.ت:");
    // the default thank-you survives when no identity configured one
    expect(html).toContain("شكرًا لزيارتكم");
  });

  it("owner toggles: qr=false suppresses even a present stamp", () => {
    const html = buildSaleReceiptHtml(
      saleOpts({ showFields: { logo: true, taxNumber: true, crNumber: true, nationalAddress: true, phone: true, email: true, cashier: true, customer: true, qr: false } }),
    );
    expect(html).not.toContain("<img");
  });

  it("owner toggles: taxNumber=false hides it while the rest print", () => {
    const html = buildSaleReceiptHtml(
      saleOpts({ showFields: { logo: true, taxNumber: false, crNumber: true, nationalAddress: true, phone: true, email: true, cashier: true, customer: true, qr: true } }),
    );
    expect(html).not.toContain("310122393500003");
    expect(html).toContain("1010999999");
  });
});

describe("buildSaleReceiptHtml — paper width, reprint, payments", () => {
  it("defaults to 80mm → the historical 72mm printable body", () => {
    const html = buildSaleReceiptHtml(saleOpts());
    expect(html).toContain('data-paper="80"');
    expect(html).toContain("width: 72mm");
  });

  it("58 switches to a 48mm body with smaller type", () => {
    const html = buildSaleReceiptHtml(saleOpts({ paperWidth: "58" }));
    expect(html).toContain('data-paper="58"');
    expect(html).toContain("width: 48mm");
    expect(html).toContain("font-size: 10px");
  });

  it("A4 keeps the full-width layout when printing", () => {
    const html = buildSaleReceiptHtml(saleOpts({ paperWidth: "A4" }));
    expect(html).toContain('data-paper="A4"');
    expect(html).toContain("width: 190mm");
    expect(html).not.toContain("@media print { body { width: auto; } }");
  });

  it("prints the ORIGINAL sale datetime when printedAt is passed", () => {
    const html = buildSaleReceiptHtml(saleOpts({ printedAt: new Date("2026-01-05T09:30:00") }));
    expect(html).toContain("2026-01-05");
    expect(html).toContain("09:30");
  });

  it("RECORDED totals are what render", () => {
    const html = buildSaleReceiptHtml(
      saleOpts({ totals: { subtotal: 76, lineDiscountTotal: 0, discountAmount: 5, vatTotal: 9.26, total: 71 } }),
    );
    expect(html).toContain("71.00");
    expect(html).toContain("9.26");
    expect(html).toContain("-5.00");
  });

  it("stamps a reversed-document reprint", () => {
    const html = buildSaleReceiptHtml(saleOpts({ stamp: "ملغاة · VOIDED" }));
    expect(html).toContain('class="stamp"');
    expect(html).toContain("ملغاة · VOIDED");
  });

  it("split payments + tendered/change rows survive", () => {
    const html = buildSaleReceiptHtml(
      saleOpts({ payments: [{ method: "cash", amount: 46 }, { method: "card", amount: 30 }], cashTendered: 50, changeDue: 4 }),
    );
    expect(html).toContain("كاش");
    expect(html).toContain("شبكة");
    expect(html).toContain("المستلَم");
    expect(html).toContain("الباقي");
  });

  it("an unknown payment method name passes through escaped, not dropped", () => {
    const html = buildSaleReceiptHtml(saleOpts({ payments: [{ method: "STC Pay", amount: 46 }] }));
    expect(html).toContain("STC Pay");
  });

  it("a plain invoice with no cashier renders no served-by band at all", () => {
    const html = buildSaleReceiptHtml(saleOpts({ cashierName: undefined, orderType: null }));
    expect(html).not.toContain("الكاشير:");
    expect(html).not.toContain('class="served"');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The owner's request (2026-07-28): «تم خدمتكم عن طريق» + a welcome message +
// more detail — every one of them a field reaching PAPER, at 58mm as well as
// 80mm.
// ═════════════════════════════════════════════════════════════════════════════

describe("cashier identity — compact, inside the transaction metadata", () => {
  it("prints the cashier as a compact labelled row", () => {
    const html = buildSaleReceiptHtml(saleOpts({ cashierName: "أحمد عدلان" }));
    expect(html).not.toContain('<div class="served">');
    expect(html).toContain("الكاشير:");
    expect(html).toContain("أحمد عدلان");
  });

  it("keeps cashier and service type in distinct metadata rows", () => {
    const html = buildSaleReceiptHtml(saleOpts({ cashierName: "أحمد عدلان", orderType: "dine_in", tableNo: "7" }));
    const meta = html.slice(html.indexOf('<table class="meta">'), html.indexOf('<hr class="rule">'));
    expect(meta).toContain("أحمد عدلان");
    expect(meta).toContain("نوع الطلب:");
    expect(html).toContain("محلي");
    expect(html).toContain("طاولة");
  });

  it("an empty name prints NO band rather than a credit line with nobody in it", () => {
    const html = buildSaleReceiptHtml(saleOpts({ cashierName: "" }));
    expect(html).not.toContain('class="served"');
  });

  it("the owner's cashier toggle still suppresses it", () => {
    const html = buildSaleReceiptHtml(
      saleOpts({
        cashierName: "أحمد عدلان",
        showFields: { logo: true, taxNumber: true, crNumber: true, nationalAddress: true, phone: true, email: true, cashier: false, customer: true, qr: true },
      }),
    );
    expect(html).not.toContain("الكاشير:");
    expect(html).not.toContain("أحمد عدلان");
  });
});

describe("رسالة ترحيبية — settings.ReceiptHeader, promoted to its own line", () => {
  it("the owner's ReceiptHeader prints as the welcome line, not as another .sub crumb", () => {
    const html = buildSaleReceiptHtml(saleOpts());
    expect(html).toContain('<div class="welcome">فرع العليا — فاتورة ضريبية مبسطة</div>');
  });

  it("falls back to a default greeting on a thermal till receipt when unset", () => {
    const html = buildSaleReceiptHtml(saleOpts({ identity: { ...IDENTITY, header: "" } }));
    expect(html).toContain("أهلاً وسهلاً بكم");
    const en = buildSaleReceiptHtml(saleOpts({ identity: { ...IDENTITY_EN, header: "" } }));
    expect(en).toContain("Welcome");
  });

  it("does NOT greet an A4 document — that is a B2B tax invoice, not a till receipt", () => {
    const html = buildSaleReceiptHtml(saleOpts({ identity: { ...IDENTITY, header: "" }, paperWidth: "A4" }));
    expect(html).not.toContain("أهلاً وسهلاً بكم");
  });

  it("does NOT greet on a credit note even when the owner configured a header", () => {
    const html = buildCreditNoteHtml({
      lines: [{ name: "برجر", qty: 1, unitPrice: 23 }],
      totals: { subtotal: 23, lineDiscountTotal: 0, discountAmount: 0, vatTotal: 3, total: 23 },
      invoiceNumber: "CN-1",
      originalInvoiceNumber: "INV-1",
      fallbackSellerName: "x",
      vatRate: 15,
      identity: { ...IDENTITY, header: "" },
    });
    expect(html).not.toContain("أهلاً وسهلاً بكم");
  });
});

describe("document type — the receipt finally says what it legally is", () => {
  it("a thermal POS sale is titled a ZATCA simplified tax invoice", () => {
    expect(buildSaleReceiptHtml(saleOpts())).toContain('<div class="doctype">فاتورة ضريبية مبسطة</div>');
    expect(buildSaleReceiptHtml(saleOpts({ paperWidth: "58" }))).toContain("فاتورة ضريبية مبسطة");
  });

  // IDENTITY.header itself reads "…فاتورة ضريبية مبسطة", so the negative
  // assertions below run against an identity with no owner header — otherwise
  // they would be matching the welcome line, not the document-type band.
  const NO_HEADER: DocumentIdentity = { ...IDENTITY, header: "" };

  it("an A4 document is titled just فاتورة ضريبية (it may carry a registered buyer)", () => {
    const html = buildSaleReceiptHtml(saleOpts({ identity: NO_HEADER, paperWidth: "A4" }));
    expect(html).toContain('<div class="doctype">فاتورة ضريبية</div>');
    expect(html).not.toContain("فاتورة ضريبية مبسطة");
  });

  it("an OFFLINE queued sale claims no tax-invoice title it has not earned", () => {
    const html = buildSaleReceiptHtml(saleOpts({ identity: NO_HEADER, offlineRef: true, zatcaQrDataUrl: null }));
    expect(html).toContain("إيصال مبدئي");
    expect(html).not.toContain("فاتورة ضريبية مبسطة");
    // and it still says so honestly in both of the existing places
    expect(html).toContain("مرجع محلي");
    expect(html).toContain("سيُرحَّل عند عودة الاتصال");
    expect(html).toContain("رمز الفاتورة الضريبي يصدر بعد المزامنة");
  });

  it("a caller may override the band", () => {
    expect(buildSaleReceiptHtml(saleOpts({ docTitle: "عرض سعر" }))).toContain('<div class="doctype">عرض سعر</div>');
    expect(buildSaleReceiptHtml(saleOpts({ docTitle: "" }))).not.toContain('class="doctype"');
  });
});

describe("ZATCA — every legally required field still reaches paper after the redesign", () => {
  const html = buildSaleReceiptHtml(saleOpts({ printedAt: new Date("2026-07-15T14:05:00") }));

  it("seller identity", () => {
    expect(html).toContain("<h1>الأصالة</h1>");
    expect(html).toContain('class="legal">مطاعم الأصالة');
  });
  it("VAT registration number", () => expect(html).toContain("الرقم الضريبي:"));
  it("VAT registration number value", () => expect(html).toContain("310122393500003"));
  it("timestamp", () => expect(html).toContain("2026-07-15 14:05"));
  it("VAT total", () => {
    expect(html).toContain('data-row="vat"');
    expect(html).toContain('<span class="tax-name">الضريبة</span>');
    expect(html).toContain('<span class="num">15%</span> ضمن الإجمالي');
  });
  it("total with VAT", () => expect(html).toContain("40.00 ر.س"));
  it("the server-stamped TLV QR at a scannable 120px", () =>
    expect(html).toContain('<img src="data:image/png;base64,iVBORw0KGgoTEST" alt="ZATCA QR" width="120" height="120">'));
});

describe("more detail — the fields that were shipped to the client and never printed", () => {
  it("prints the owner's logo when configured", () => {
    const html = buildSaleReceiptHtml(saleOpts({ identity: { ...IDENTITY, logo: "data:image/png;base64,LOGOPNG" } }));
    expect(html).toContain('<div class="logo"><img src="data:image/png;base64,LOGOPNG" alt=""></div>');
  });

  it("honours the logo toggle that used to be read by nothing", () => {
    const html = buildSaleReceiptHtml(
      saleOpts({
        identity: { ...IDENTITY, logo: "data:image/png;base64,LOGOPNG" },
        showFields: { logo: false, taxNumber: true, crNumber: true, nationalAddress: true, phone: true, email: true, cashier: true, customer: true, qr: true },
      }),
    );
    expect(html).not.toContain("LOGOPNG");
  });

  it("refuses a logo value that is not an image URL", () => {
    const html = buildSaleReceiptHtml(saleOpts({ identity: { ...IDENTITY, logo: "javascript:alert(1)" } }));
    expect(html).not.toContain("javascript:");
  });

  it("prints the e-mail beside the phone (its toggle was read by nothing either)", () => {
    const html = buildSaleReceiptHtml(saleOpts());
    expect(html).toContain("info@example.com");
    const off = buildSaleReceiptHtml(
      saleOpts({
        showFields: { logo: true, taxNumber: true, crNumber: true, nationalAddress: true, phone: true, email: false, cashier: true, customer: true, qr: true },
      }),
    );
    expect(off).not.toContain("info@example.com");
    expect(off).toContain("0112345678");
  });

  it("falls back to the branch street address when there is no national address", () => {
    const html = buildSaleReceiptHtml(saleOpts({ identity: { ...IDENTITY, nationalAddress: "" } }));
    expect(html).toContain("شارع التحلية");
  });

  it("never prints two competing addresses", () => {
    const html = buildSaleReceiptHtml(saleOpts());
    expect(html).toContain("RRRD2929 حي العليا، الرياض");
    expect(html).not.toContain("شارع التحلية");
  });

  it("counts the items", () => {
    const html = buildSaleReceiptHtml(
      saleOpts({ lines: [{ name: "أ", qty: 1, unitPrice: 5 }, { name: "ب", qty: 2, unitPrice: 5 }] }),
    );
    expect(html).toContain("عدد البنود");
    expect(html).toContain('<td class="money"><span class="n">2</span></td>');
  });

  it("tells the customer what they saved — and stays silent when they saved nothing", () => {
    const saved = buildSaleReceiptHtml(
      saleOpts({ totals: { subtotal: 45, lineDiscountTotal: 2, discountAmount: 3, vatTotal: 5.22, total: 40 } }),
    );
    expect(saved).toContain("وفّرت في هذه الفاتورة");
    expect(saved).toContain('<span class="num">5.00 ر.س</span>');
    expect(buildSaleReceiptHtml(saleOpts())).not.toContain("وفّرت");
  });

  it("labels the payment block", () => {
    expect(buildSaleReceiptHtml(saleOpts())).toContain('<div class="sec">تفاصيل الدفع</div>');
  });

  it("captions the QR", () => {
    expect(buildSaleReceiptHtml(saleOpts())).toContain("امسح الرمز للتحقق من الفاتورة");
    // …and never captions a QR that is not there
    expect(buildSaleReceiptHtml(saleOpts({ zatcaQrDataUrl: null }))).not.toContain("امسح الرمز");
  });

  it("quantities print as counts, not as money", () => {
    const html = buildSaleReceiptHtml(saleOpts({ lines: [{ name: "برجر", qty: 2, unitPrice: 20 }] }));
    expect(html).toContain('<td class="money"><span class="n">2</span></td>');
    expect(html).not.toContain('<span class="n">2.00</span>');
  });
});

describe("orphan identity fields that used to print the wrong words", () => {
  it("a non-SAR shop prints its own currency instead of ر.س", () => {
    const html = buildSaleReceiptHtml(saleOpts({ identity: { ...IDENTITY, currency: "AED" } }));
    expect(html).toContain("40.00 AED");
    expect(html).not.toContain("ر.س");
  });

  it("SAR (and an unset currency) keeps the localized glyph", () => {
    expect(buildSaleReceiptHtml(saleOpts())).toContain("40.00 ر.س");
    expect(buildSaleReceiptHtml(saleOpts({ identity: { ...IDENTITY, currency: "" } }))).toContain("40.00 ر.س");
  });

  it("a custom sales-tax name replaces the hardcoded الضريبة", () => {
    const html = buildSaleReceiptHtml(saleOpts({ identity: { ...IDENTITY, salesTaxName: "ضريبة القيمة المضافة" } }));
    expect(html).toContain('<span class="tax-name">ضريبة القيمة المضافة</span>');
    expect(html).toContain('<span class="num">15%</span> ضمن الإجمالي');
  });

  it("prints a configured tax percentage exactly once", () => {
    const html = buildSaleReceiptHtml(saleOpts({ identity: { ...IDENTITY, salesTaxName: "ضريبة القيمة المضافة %15" } }));
    const doc = new DOMParser().parseFromString(html, "text/html");
    const vatRow = doc.querySelector('[data-row="vat"]');
    expect(vatRow).not.toBeNull();
    expect(vatRow?.querySelector(".tax-name")?.textContent).toBe("ضريبة القيمة المضافة");
    expect(vatRow?.textContent?.match(/15%/g)).toHaveLength(1);
  });
});

describe("the money column — one decimal axis, both languages", () => {
  it("every amount is a shrink-to-fit, tabular, trailing-edge cell", () => {
    const html = buildSaleReceiptHtml(saleOpts());
    expect(html).toContain("td.money, th.mh { text-align: right; width: 1%; white-space: nowrap;");
    expect(html).toContain("padding-inline-start: 7px; }");
    expect(html).toContain('<td class="money"><span class="n">40.00</span></td>');
    // no money is rendered through the old ragged `.l num` cell any more
    expect(html).not.toContain('class="l num"');
  });

  it("the LTR isolate is on the inner span, never on the cell", () => {
    // direction:ltr on the CELL resolves padding-inline-start to its left, which
    // in RTL is the paper edge — the money column then collides with the column
    // beside it. Shipped in the first cut of this redesign; caught by rendering.
    const html = buildSaleReceiptHtml(saleOpts());
    expect(html).toContain(".num, .money .n, .line-calc .n { direction: ltr; unicode-bidi: isolate;");
    expect(html).not.toContain("td.money, th.mh { direction: ltr");
  });

  it("a Latin handle inside Arabic owner text keeps its sigil on the right end", () => {
    const html = buildSaleReceiptHtml(saleOpts({ identity: { ...IDENTITY, footer: "تابعنا @mathaq_sa" } }));
    expect(html).toContain('تابعنا <span class="ltr">@mathaq_sa</span>');
    expect(html).toContain(".ltr { direction: ltr; unicode-bidi: isolate; }");
  });

  it("owner text with no Latin token is byte-identical to plain escaping", () => {
    const html = buildSaleReceiptHtml(saleOpts());
    expect(html).toContain('<div class="policy">الاسترجاع خلال ٣ أيام بالفاتورة</div>');
    expect(html).not.toContain('<span class="ltr">الاسترجاع');
  });

  it("the grand total is the only row with a double rule", () => {
    const html = buildSaleReceiptHtml(saleOpts());
    expect(html).toContain('<tr class="total" data-row="grand-total">');
    expect(html).toContain("border-bottom: 3px double currentColor;");
  });

  it("the English document aligns its column headers with its cells (start, not right)", () => {
    const html = buildSaleReceiptHtml(saleOpts({ identity: IDENTITY_EN }));
    expect(html).toContain("th { text-align: start;");
  });

  it("an English document actually LAYS OUT left-to-right", () => {
    // baseCss used to hardcode `body { direction: rtl }`, which overrode the
    // <html dir="ltr"> below it: an English shop printed English text in an RTL
    // frame — ":Invoice" instead of "Invoice:", the money column on the wrong
    // edge. Rendering the document in a browser is what exposed it.
    const en = buildSaleReceiptHtml(saleOpts({ identity: IDENTITY_EN }));
    expect(en).toContain('<html lang="en" dir="ltr">');
    expect(en).not.toContain("direction: rtl");
    // …and the Arabic default still inherits rtl from its own <html>
    const ar = buildSaleReceiptHtml(saleOpts());
    expect(ar).toContain('<html lang="ar" dir="rtl">');
    expect(ar).not.toContain("direction: rtl;");
  });
});

describe("buildCreditNoteHtml — the مرتجع / إشعار دائن document", () => {
  function cnOpts(partial?: Partial<CreditNoteOptions>): CreditNoteOptions {
    return {
      lines: [{ name: "برجر", qty: 1, unitPrice: 23, returnQty: 1, soldQty: 2 }],
      totals: { subtotal: 23, lineDiscountTotal: 0, discountAmount: 0, vatTotal: 3, total: 23 },
      invoiceNumber: "CN-20260715-0007",
      originalInvoiceNumber: "INV-20260715-0001",
      returnReason: "منتج تالف",
      fallbackSellerName: "إشعار دائن ضريبي",
      vatRate: 15,
      identity: IDENTITY,
      zatcaQrDataUrl: "data:image/png;base64,iVBORwCREDITNOTE",
      customerName: "متجر الأمل",
      ...partial,
    };
  }

  it("carries a distinguishing مرتجع marker (not a sale receipt)", () => {
    const html = buildCreditNoteHtml(cnOpts());
    expect(html).toContain("مرتجع");
    expect(html).toContain('class="stamp"');
    expect(html).toContain('data-doc="credit-note"');
    expect(html).toContain("إشعار دائن ضريبي");
  });

  it("shows the original invoice number it reverses", () => {
    const html = buildCreditNoteHtml(cnOpts());
    expect(html).toContain("الفاتورة الأصلية");
    expect(html).toContain("INV-20260715-0001");
  });

  it("shows its own credit-note number", () => {
    const html = buildCreditNoteHtml(cnOpts());
    expect(html).toContain("CN-20260715-0007");
  });

  it("prints the document-level return reason", () => {
    const html = buildCreditNoteHtml(cnOpts());
    expect(html).toContain("سبب المرتجع");
    expect(html).toContain("منتج تالف");
  });

  it("shows the returned/sold quantities on the line", () => {
    const html = buildCreditNoteHtml(cnOpts());
    expect(html).toContain("مُرجَع");
    expect(html).toContain("مباع");
  });

  it("renders the seller identity block like a sale receipt", () => {
    const html = buildCreditNoteHtml(cnOpts());
    expect(html).toContain("مطاعم الأصالة");
    expect(html).toContain("310122393500003");
  });

  it("prints the server-stamped credit-note QR", () => {
    const html = buildCreditNoteHtml(cnOpts());
    expect(html).toContain('src="data:image/png;base64,iVBORwCREDITNOTE"');
  });

  it("omits the reason line when there is no reason", () => {
    const html = buildCreditNoteHtml(cnOpts({ returnReason: null }));
    expect(html).not.toContain("سبب المرتجع");
  });
});

describe("buildSaleReceiptHtml — bilingual (identity.language)", () => {
  it("no language on identity → today's Arabic-only behavior (backward compatible)", () => {
    const html = buildSaleReceiptHtml(saleOpts());
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain("المجموع");
    expect(html).toContain("الإجمالي");
    expect(html).not.toContain("Subtotal");
  });

  it("language: 'en' → English chrome, <html lang dir> flip to ltr", () => {
    const html = buildSaleReceiptHtml(saleOpts({ identity: IDENTITY_EN }));
    expect(html).toContain('<html lang="en" dir="ltr">');
    expect(html).toContain("Item");
    expect(html).toContain("Qty");
    expect(html).toContain("Subtotal");
    expect(html).toContain("VAT");
    expect(html).toContain("Grand Total");
    expect(html).toContain("Cash"); // PAY_LABELS_EN
    expect(html).not.toContain("المجموع");
  });

  it("language: 'en' translates payment methods, the order type and the served-by band", () => {
    const html = buildSaleReceiptHtml(
      saleOpts({
        identity: IDENTITY_EN,
        payments: [{ method: "cash", amount: 46 }, { method: "card", amount: 30 }],
        orderType: "dine_in",
      }),
    );
    expect(html).toContain("Cash");
    expect(html).toContain("Card");
    expect(html).toContain("Dine-in");
    expect(html).toContain("Cashier:");
    expect(html).toContain("Simplified Tax Invoice");
  });

  it("language: 'en' keeps owner-entered free text verbatim (never machine-translated)", () => {
    const html = buildSaleReceiptHtml(saleOpts({ identity: IDENTITY_EN }));
    // header/thankYou/returnPolicy/footer are Arabic strings the owner typed —
    // they print as-is even though the surrounding chrome is English.
    expect(html).toContain("فرع العليا — فاتورة ضريبية مبسطة");
    expect(html).toContain("نشكر لكم زيارتكم ونتشرف بخدمتكم");
  });

  it("language: 'en' offline-ref note and QR-pending note are translated", () => {
    const html = buildSaleReceiptHtml(saleOpts({ identity: IDENTITY_EN, offlineRef: true, zatcaQrDataUrl: null }));
    expect(html).toContain("Local ref:");
    expect(html).toContain("will sync once back online");
    expect(html).toContain("The tax QR code will be issued after sync");
  });

  it("language: 'en' with no identity fields configured → English default thank-you", () => {
    const html = buildSaleReceiptHtml(saleOpts({ identity: { ...IDENTITY_EN, thankYou: "", header: "", footer: "", returnPolicy: "" } }));
    expect(html).toContain("Thank you for visiting us");
  });

  it("language: 'both' renders one financial body with paired Arabic/English labels", () => {
    const html = buildSaleReceiptHtml(saleOpts({ identity: IDENTITY_BOTH }));
    expect(html).toContain('<html lang="ar" dir="rtl">');
    // Arabic block
    expect(html).toContain("المجموع");
    expect(html).toContain("الإجمالي");
    // English block
    expect(html).toContain("Subtotal");
    expect(html).toContain("Grand Total");
    expect(html).toContain('class="bi-en" lang="en" dir="ltr"');
    expect(html).not.toContain('<div dir="ltr" lang="en">');
    expect(html.match(/INV-20260715-0001/g)).toHaveLength(1);
    expect(html.match(/iVBORw0KGgoTEST/g)).toHaveLength(1);
  });
});

describe("buildCreditNoteHtml — bilingual (identity.language)", () => {
  function cnOptsBase(partial?: Partial<CreditNoteOptions>): CreditNoteOptions {
    return {
      lines: [{ name: "برجر", qty: 1, unitPrice: 23, returnQty: 1, soldQty: 2 }],
      totals: { subtotal: 23, lineDiscountTotal: 0, discountAmount: 0, vatTotal: 3, total: 23 },
      invoiceNumber: "CN-20260715-0007",
      originalInvoiceNumber: "INV-20260715-0001",
      returnReason: "منتج تالف",
      fallbackSellerName: "إشعار دائن ضريبي",
      vatRate: 15,
      identity: IDENTITY,
      zatcaQrDataUrl: "data:image/png;base64,iVBORwCREDITNOTE",
      customerName: "متجر الأمل",
      ...partial,
    };
  }

  it("no language on identity → today's Arabic-only behavior (backward compatible)", () => {
    const html = buildCreditNoteHtml(cnOptsBase());
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain("مرتجع");
    expect(html).toContain("إجمالي المرتجع");
    expect(html).not.toContain("Credit Total");
  });

  it("language: 'en' → English chrome, <html lang dir> flip to ltr", () => {
    const html = buildCreditNoteHtml(cnOptsBase({ identity: IDENTITY_EN }));
    expect(html).toContain('<html lang="en" dir="ltr">');
    expect(html).toContain("RETURN · CREDIT NOTE");
    expect(html).toContain("Tax Credit Note");
    expect(html).toContain("Original Invoice:");
    expect(html).toContain("Return Reason:");
    expect(html).toContain("Returned");
    expect(html).toContain("Credit Total");
    expect(html).not.toContain("مرتجع");
  });

  it("language: 'en' — the returned/sold-quantity note translates too", () => {
    const html = buildCreditNoteHtml(cnOptsBase({ identity: IDENTITY_EN }));
    expect(html).toContain("Returned");
    expect(html).toContain("of");
    expect(html).toContain("sold");
  });

  it("language: 'both' renders one bilingual credit-note body", () => {
    const html = buildCreditNoteHtml(cnOptsBase({ identity: IDENTITY_BOTH }));
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain('data-doc="credit-note"');
    expect(html).toContain("مرتجع");
    expect(html).toContain("RETURN · CREDIT NOTE");
    expect(html).toContain('class="bi-en" lang="en" dir="ltr"');
    expect(html).not.toContain('<div dir="ltr" lang="en">');
    expect(html.match(/CN-20260715-0007/g)).toHaveLength(1);
  });
});

describe("professional print hierarchy", () => {
  it.each([
    ["58", 2],
    ["80", 4],
  ] as const)("%smm uses a stable item-table contract", (paperWidth, columns) => {
    const html = buildSaleReceiptHtml(saleOpts({ paperWidth }));
    const doc = new DOMParser().parseFromString(html, "text/html");
    const table = doc.querySelector('[data-section="items"]');
    expect(doc.body.dataset.paper).toBe(paperWidth);
    expect(table?.querySelectorAll("col")).toHaveLength(columns);
    expect(table?.querySelectorAll("thead th")).toHaveLength(columns);
    expect(table?.querySelectorAll("tbody tr:first-child > td")).toHaveLength(columns);
  });

  it("prints structured contact details once and suppresses a legacy contact-only footer", () => {
    const html = buildSaleReceiptHtml(
      saleOpts({ identity: { ...IDENTITY, footer: `${IDENTITY.phone} · ${IDENTITY.email}` } }),
    );
    expect(html.match(/0112345678/g)).toHaveLength(1);
    expect(html.match(/info@example\.com/g)).toHaveLength(1);
    expect(html).toContain('<div class="contact">');
    expect(html).toContain('<span class="ltr">info@example.com</span>');
  });

  it("preserves a real custom footer while keeping contacts out of the header", () => {
    const html = buildSaleReceiptHtml(saleOpts());
    const header = html.slice(html.indexOf('<header class="identity">'), html.indexOf("</header>"));
    expect(header).not.toContain(IDENTITY.phone);
    expect(header).not.toContain(IDENTITY.email);
    expect(html).toContain("سجل معنا في برنامج الولاء");
  });

  it("keeps the A4 settlement, QR and closing blocks indivisible", () => {
    const html = buildSaleReceiptHtml(saleOpts({ paperWidth: "A4" }));
    expect(html).toContain('class="settlement"');
    expect(html).toContain('class="qr-zone"');
    expect(html).toContain('class="closing"');
    expect(html).toContain(".settlement { break-inside: avoid; page-break-inside: avoid; }");
    expect(html).toContain("@page { size: A4; margin: 10mm; }");
  });

  it("uses the local Cairo face with an offline-safe fallback stack", () => {
    const html = buildSaleReceiptHtml(saleOpts());
    expect(html).toContain('src: local("Cairo")');
    expect(html).toContain('font-family: "Cairo Receipt", "Cairo", "Tajawal"');
  });

  it("uses the English branch master-data name on English and bilingual documents", () => {
    const en = buildSaleReceiptHtml(saleOpts({
      identity: { ...IDENTITY_EN, branchName: "فرع العليا", branchNameEn: "Olaya Branch" },
    }));
    expect(en).toContain('<div class="branch">Olaya Branch</div>');
    expect(en).not.toContain('<div class="branch">فرع العليا</div>');

    const both = buildSaleReceiptHtml(saleOpts({
      identity: { ...IDENTITY_BOTH, branchName: "فرع العليا", branchNameEn: "Olaya Branch" },
    }));
    expect(both).toContain("فرع العليا");
    expect(both).toContain("Olaya Branch");
  });
});

describe("printHtml — popup handling", () => {
  it("returns false when the popup is blocked", () => {
    const spy = vi.spyOn(window, "open").mockReturnValue(null);
    expect(printHtml("<html></html>")).toBe(false);
    spy.mockRestore();
  });

  it("writes the HTML and returns true when a window opens", () => {
    const write = vi.fn();
    const fakeWin = {
      document: { open: vi.fn(), write, close: vi.fn() },
      focus: vi.fn(),
      print: vi.fn(),
      setTimeout: vi.fn(),
    } as unknown as Window;
    const spy = vi.spyOn(window, "open").mockReturnValue(fakeWin);
    expect(printHtml("<html>RECEIPT</html>")).toBe(true);
    expect(write).toHaveBeenCalledWith("<html>RECEIPT</html>");
    spy.mockRestore();
  });
});

// ── The A4 tax invoice ──────────────────────────────────────────────────────
// Before, A4 was the thermal receipt stretched to 190mm: one centred column,
// no buyer, a four-column item table with no VAT breakdown — a till receipt on
// big paper, not a document a registered buyer can book. Thermal paper must
// be byte-for-byte unaffected by any of this.
describe("the A4 tax invoice", () => {
  const BUYER = { name: "شركة المشتري", vatNumber: "300000000000003", address: "الرياض — العليا", phone: "0500000000" };

  it("names the seller and the buyer as two parties", () => {
    const html = buildSaleReceiptHtml(saleOpts({ paperWidth: "A4", buyer: BUYER }));
    expect(html).toContain('class="parties"');
    expect(html).toContain("البائع");
    expect(html).toContain('data-section="buyer"');
    expect(html).toContain("شركة المشتري");
    // The buyer's VAT number is what lets them book the invoice.
    expect(html).toContain("300000000000003");
    expect(html).toContain("الرقم الضريبي للمشتري");
  });

  it("omits the buyer block when the owner turned it off", () => {
    const html = buildSaleReceiptHtml(saleOpts({ paperWidth: "A4", buyer: BUYER, a4: { showBuyer: false } }));
    expect(html).not.toContain('data-section="buyer"');
    expect(html).not.toContain("300000000000003");
  });

  it("breaks VAT out per line — taxable and VAT columns exist", () => {
    const html = buildSaleReceiptHtml(saleOpts({ paperWidth: "A4", vatRate: 15 }));
    expect(html).toContain('class="items a4"');
    expect(html).toContain("الخاضع للضريبة");
    expect(html).toContain("سعر الوحدة");
    expect(html).toContain("إجمالي الخاضع للضريبة");
  });

  it("prints terms and bank details only when configured, and signature lines by default", () => {
    const on = buildSaleReceiptHtml(saleOpts({ paperWidth: "A4", a4: { showBank: true, bankDetails: "IBAN SA00 0000", terms: "الدفع خلال 30 يومًا" } }));
    expect(on).toContain('data-section="bank"');
    expect(on).toContain("IBAN SA00 0000");
    expect(on).toContain('data-section="terms"');
    expect(on).toContain("الدفع خلال 30 يومًا");
    expect(on).toContain('data-section="signatures"');

    const off = buildSaleReceiptHtml(saleOpts({ paperWidth: "A4", a4: { showBank: false, bankDetails: "IBAN SA00 0000", showSignature: false } }));
    // Bank details entered but switched OFF must not leak onto the paper.
    expect(off).not.toContain("IBAN SA00 0000");
    expect(off).not.toContain('data-section="signatures"');
  });

  it("shows a due date when the invoice has one", () => {
    const html = buildSaleReceiptHtml(saleOpts({ paperWidth: "A4", dueDate: "2026-10-15T00:00:00.000Z" }));
    expect(html).toContain("تاريخ الاستحقاق");
    expect(html).toContain("2026-10-15");
  });

  it("escapes owner-entered terms and buyer text", () => {
    const html = buildSaleReceiptHtml(saleOpts({
      paperWidth: "A4",
      buyer: { name: "<img src=x onerror=alert(1)>" },
      a4: { terms: "<script>alert(1)</script>" },
    }));
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert");
  });

  it("leaves thermal paper untouched — no parties block, no A4 columns", () => {
    for (const paperWidth of ["58", "80"] as const) {
      const html = buildSaleReceiptHtml(saleOpts({ paperWidth, buyer: BUYER, a4: { terms: "x" } }));
      expect(html).not.toContain('class="parties"');
      expect(html).not.toContain('class="items a4"');
      expect(html).not.toContain('data-section="terms"');
      // The thermal receipt still carries the plain customer line it always had.
      expect(html).not.toContain("الرقم الضريبي للمشتري");
    }
  });

  it("keeps the recorded totals as the money authority on A4", () => {
    // Per-line VAT is derived for display; the totals block must print the
    // caller's recorded figures, never a sum of those derivations.
    const html = buildSaleReceiptHtml(saleOpts({
      paperWidth: "A4",
      totals: { subtotal: 230, lineDiscountTotal: 0, discountAmount: 0, vatTotal: 30, total: 230 },
    }));
    expect(html).toContain("230.00");
    expect(html).toContain("30.00");
    expect(html).toContain("200.00"); // taxable total = 230 − 30, the recorded net
  });
});
