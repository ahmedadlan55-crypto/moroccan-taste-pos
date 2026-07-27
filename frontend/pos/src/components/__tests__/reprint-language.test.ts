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
import type { InvoiceDetail } from "@/lib/api";

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
});
