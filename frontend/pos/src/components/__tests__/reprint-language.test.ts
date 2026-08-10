/**
 * REPRINT language — فواتيري must reprint in the shop's configured receipt
 * language.
 *
 * invoiceTemplate derives the whole document language from
 * `opts.identity?.language`, and reprintHtmlFromInvoice rebuilt the identity
 * from the invoice's frozen seller snapshot WITHOUT that field. So a shop set to
 * English (or bilingual) printed bilingual originals and Arabic-only reprints of
 * the very same sale — the reprint silently contradicted the document it copies.
 */
import { describe, expect, it } from "vitest";
import {
  normalizeDocumentLanguage,
  reprintHtmlFromInvoice,
  resolveReprintLanguage,
} from "../dialogs/MyInvoicesDialog";
import { buildReceiptHtml } from "@/lib/receipt";
import type { InvoiceDetail } from "@/lib/api";
import type { LocalOrder, ReceiptIdentity } from "@/lib/types";

function invoice(overrides: Partial<InvoiceDetail> & Record<string, unknown> = {}): InvoiceDetail {
  return {
    orderId: "SH-1752000000000-1752000009999",
    date: "2026-07-10T13:45:00",
    payment: "كاش",
    totalFinal: 46,
    username: "pos_cash1",
    discountName: null,
    discountAmount: 0,
    lineDiscounts: null,
    splitDetails: null,
    cashTendered: 50,
    changeDue: 4,
    items: [{ name: "شاي أتاي", qty: 2, price: 23, total: 46, lineId: null }],
    cashierName: "أحمد الكاشير",
    branchName: "فرع العليا",
    branchAddress: "شارع التحلية",
    branchCompanyName: "",
    companyName: "مطاعم الأصالة",
    taxNumber: "310122393500003",
    currency: "SAR",
    companyPhone: "0112345678",
    companyEmail: "",
    receiptFooter: "",
    crNumber: "1010999999",
    nationalAddress: "RRRD2929 الرياض",
    receiptHeader: "",
    receiptThankYou: "",
    receiptReturnPolicy: "",
    identitySource: "snapshot",
    brandName: "",
    customerId: null,
    customerName: "",
    customerPhone: "",
    paymentNotes: null,
    zatcaType: "simplified",
    zatcaQr: null,
    invoiceNumber: "INV-20260710-0042",
    voidSerial: null,
    returnSerial: null,
    version: null,
    ...overrides,
  } as InvoiceDetail;
}

const catalogWithLang = (language: string) => ({
  vatRate: 15,
  identity: { sellerName: "مطاعم الأصالة", language },
});

describe("normalizeDocumentLanguage — untrusted in, safe out", () => {
  it("accepts exactly ar / en / both, case- and space-tolerant", () => {
    expect(normalizeDocumentLanguage("ar")).toBe("ar");
    expect(normalizeDocumentLanguage(" EN ")).toBe("en");
    expect(normalizeDocumentLanguage("Both")).toBe("both");
  });

  it("rejects anything else so the template keeps its own Arabic default", () => {
    for (const bad of [undefined, null, "", "fr", 7, {}, "arabic"]) {
      expect(normalizeDocumentLanguage(bad)).toBeUndefined();
    }
  });
});

describe("resolveReprintLanguage — invoice first, then the cached catalog", () => {
  it("uses the cached catalog identity when the invoice says nothing", () => {
    expect(resolveReprintLanguage(invoice(), { language: "en" } as never)).toBe("en");
  });

  it("prefers a value the server ships ON the invoice (field is read defensively)", () => {
    expect(resolveReprintLanguage(invoice({ receiptLanguage: "both" }), { language: "en" } as never)).toBe("both");
    expect(resolveReprintLanguage(invoice({ language: "ar" }), { language: "en" } as never)).toBe("ar");
  });

  it("undefined when nothing anywhere declares one", () => {
    expect(resolveReprintLanguage(invoice(), null)).toBeUndefined();
  });
});

describe("the reprinted document actually changes language", () => {
  it("an ENGLISH shop reprints an English document", () => {
    const html = reprintHtmlFromInvoice(invoice(), catalogWithLang("en"), "fallback");
    expect(html).toContain('lang="en"');
    expect(html).toContain('dir="ltr"');
    expect(html).toContain('data-lang="en"');
  });

  it("a BILINGUAL shop reprints the bilingual document, not an Arabic-only one", () => {
    const html = reprintHtmlFromInvoice(invoice(), catalogWithLang("both"), "fallback");
    expect(html).toContain('data-lang="both"');
  });

  it("an ARABIC shop is unchanged — and so is a shop that configured nothing", () => {
    expect(reprintHtmlFromInvoice(invoice(), catalogWithLang("ar"), "fallback")).toContain('lang="ar"');
    const noSetting = reprintHtmlFromInvoice(invoice(), { vatRate: 15, identity: { sellerName: "x" } }, "fallback");
    expect(noSetting).toContain('lang="ar"');
    expect(noSetting).toContain('dir="rtl"');
  });

  it("applies to the CATALOG-identity fallback path too (a pre-snapshot sale)", () => {
    const html = reprintHtmlFromInvoice(invoice({ companyName: "" }), catalogWithLang("en"), "fallback");
    expect(html).toContain('lang="en"');
  });

  it("keeps the issued language, VAT identity and line snapshot when today's catalog changed", () => {
    const historical = invoice({
      receiptLanguage: "en",
      vatRate: 5,
      salesTaxName: "Issue-time VAT",
      receiptLogo: "data:image/png;base64,ISSUED",
      items: [{
        name: "Historical item",
        qty: 2,
        enteredQty: 1,
        price: 10,
        total: 20,
        lineId: null,
        vatCategory: "Z",
        taxInclusive: true,
        notes: "Issue-time note",
        enteredUnitCode: "BOX",
        enteredUnitName: "Box",
        conversionFactorSnapshot: 2,
        baseQty: 2,
      }],
      taxSubtotals: { vat: 0 },
    });
    const currentCatalog = {
      vatRate: 20,
      identity: {
        sellerName: "Current seller",
        language: "ar",
        vatRate: 20,
        salesTaxName: "Current VAT",
        logo: "data:image/png;base64,CURRENT",
      },
    };

    const html = reprintHtmlFromInvoice(historical, currentCatalog, "fallback");
    expect(html).toContain('lang="en"');
    expect(html).toContain('<span class="tax-name">Issue-time VAT</span>');
    expect(html).toContain('<span class="num">5%</span> included in total');
    expect(html).not.toContain("Current VAT");
    expect(html).toContain("data:image/png;base64,ISSUED");
    expect(html).not.toContain("data:image/png;base64,CURRENT");
    expect(html).toContain("Historical item");
    expect(html).toContain("Issue-time note");
  });

  it("first print and later reprint keep the same visible historical contract", () => {
    const identity: ReceiptIdentity = {
      sellerName: "Issued seller", legalName: "Issued legal name",
      taxNumber: "311111111111113", crNumber: "1010000000",
      address: "Issued address", nationalAddress: "Issued national address",
      phone: "0111111111", email: "issued@example.test",
      logo: "data:image/png;base64,ISSUED", currency: "SAR",
      vatRate: 5, salesTaxName: "Issue-time VAT", language: "en",
      header: "Issued header", footer: "Issued footer",
      thankYou: "Issued thanks", returnPolicy: "Issued policy",
      branchName: "Issued branch", branchCompanyName: "Issued operator",
      brandName: "Issued brand",
    };
    const order: LocalOrder = {
      id: "LOCAL-1", status: "completed", orderType: "takeaway", tableNo: null,
      shiftId: "SH-1", deviceId: "DEV-1", discountType: null,
      discountValue: 0, discountName: null, note: null,
      customerId: null, customerName: null, customerPhone: null,
      lines: [{
        menuId: "M-1", name: "Historical item", qty: 1, baseQty: 2,
        unitPrice: 10, lineDiscount: 0, vatCategory: "Z", taxInclusive: true,
        notes: "Issue-time note", enteredUnitCode: "BOX", enteredUnitName: "Box",
        conversionFactorSnapshot: 2,
      }],
      serverVersion: 1, invoiceNumber: "INV-1", saleId: "SALE-1",
      createdAt: new Date("2026-07-10T13:45:00Z").getTime(),
      updatedAt: new Date("2026-07-10T13:45:00Z").getTime(),
    };
    const first = buildReceiptHtml({
      order, payments: [{ method: "cash", amount: 20 }], invoiceNumber: "INV-1",
      cashierName: "Issued cashier", vatRate: 5, identity,
      printedAt: new Date("2026-07-10T13:45:00Z"),
    });
    const reprint = reprintHtmlFromInvoice(invoice({
      orderId: "SALE-1", invoiceNumber: "INV-1", date: "2026-07-10T13:45:00Z",
      companyName: identity.sellerName, legalName: identity.legalName,
      taxNumber: identity.taxNumber, crNumber: identity.crNumber,
      branchAddress: identity.address, nationalAddress: identity.nationalAddress,
      companyPhone: identity.phone, companyEmail: identity.email,
      receiptLogo: identity.logo, currency: identity.currency,
      receiptLanguage: identity.language, vatRate: identity.vatRate,
      salesTaxName: identity.salesTaxName, receiptHeader: identity.header,
      receiptFooter: identity.footer, receiptThankYou: identity.thankYou,
      receiptReturnPolicy: identity.returnPolicy, branchName: identity.branchName,
      branchCompanyName: identity.branchCompanyName, brandName: identity.brandName,
      cashierName: "Issued cashier", totalFinal: 20,
      items: [{
        name: "Historical item", qty: 2, enteredQty: 1, baseQty: 2,
        price: 10, total: 20, lineId: null, vatCategory: "Z", taxInclusive: true,
        notes: "Issue-time note", enteredUnitCode: "BOX", enteredUnitName: "Box",
        conversionFactorSnapshot: 2,
      }],
      taxSubtotals: { net: 20, vat: 0 },
    }), { vatRate: 20, identity: { ...identity, language: "ar", vatRate: 20, salesTaxName: "Current VAT" } }, "fallback");

    for (const token of [
      'lang="en"', "Issued seller", "Issued operator", "311111111111113",
      '<span class="tax-name">Issue-time VAT</span>', '<span class="num">5%</span> included in total',
      "data:image/png;base64,ISSUED", "Historical item", "Issue-time note",
    ]) {
      expect(first, `first print missing ${token}`).toContain(token);
      expect(reprint, `reprint missing ${token}`).toContain(token);
    }
    expect(reprint).not.toContain("Current VAT");
  });
});
