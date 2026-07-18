/**
 * فواتيري (close/b2-pos-daily) — the pure logic behind the dialog:
 *   • reprintHtmlFromInvoice — the fetched (server-stamped) QR + frozen seller
 *     identity + recorded totals + reversal stamp reach the printed HTML,
 *   • needsApprovalGate — the owner's RequireManagerApprovalForVoid='0'
 *     opt-out (void only; returns never opt out).
 */
import { describe, expect, it } from "vitest";
import { needsApprovalGate, reprintHtmlFromInvoice } from "../dialogs/MyInvoicesDialog";
import type { InvoiceDetail } from "@/lib/api";

const QR = "data:image/png;base64,iVBORw0KGgoREPRINTQR";

function invoice(overrides: Partial<InvoiceDetail> = {}): InvoiceDetail {
  return {
    orderId: "SH-1752000000000-1752000009999",
    date: "2026-07-10T13:45:00",
    payment: "كاش",
    totalFinal: 76,
    username: "pos_cash1",
    discountName: null,
    discountAmount: 0,
    lineDiscounts: null,
    splitDetails: [
      { method: "كاش", amount: 46 },
      { method: "شبكة", amount: 30 },
    ],
    cashTendered: 50,
    changeDue: 4,
    items: [
      { name: "شاي أتاي", qty: 2, price: 23, total: 46, lineId: null },
      { name: "ماء", qty: 3, price: 10, total: 30, lineId: null },
    ],
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
    receiptHeader: "فاتورة ضريبية مبسطة",
    receiptThankYou: "",
    receiptReturnPolicy: "",
    identitySource: "snapshot",
    brandName: "",
    customerId: null,
    customerName: "",
    customerPhone: "",
    paymentNotes: null,
    zatcaType: "simplified",
    zatcaQr: { qrBase64: "AAA", qrDataUrl: QR, stored: true },
    invoiceNumber: "INV-20260710-0042",
    voidSerial: null,
    returnSerial: null,
    version: null,
    ...overrides,
  };
}

describe("reprintHtmlFromInvoice", () => {
  it("embeds the FETCHED server-stamped QR data-URL — never a derivation", () => {
    const html = reprintHtmlFromInvoice(invoice(), null, "fallback");
    expect(html).toContain(`src="${QR}"`);
  });

  it("prints the invoice's FROZEN seller identity, not the cached catalog's", () => {
    const catalog = { identity: { sellerName: "هوية الكتالوج الحية" }, vatRate: 15 };
    const html = reprintHtmlFromInvoice(invoice(), catalog, "fallback");
    expect(html).toContain("مطاعم الأصالة");
    expect(html).toContain("310122393500003");
    expect(html).toContain("1010999999");
    expect(html).not.toContain("هوية الكتالوج الحية");
  });

  it("falls back to the catalog identity only when the invoice carries none", () => {
    const catalog = { identity: { sellerName: "هوية الكتالوج الحية" }, vatRate: 15 };
    const html = reprintHtmlFromInvoice(invoice({ companyName: "" }), catalog, "fallback");
    expect(html).toContain("هوية الكتالوج الحية");
  });

  it("shows the RECORDED totals + split payments + tendered/change + original date", () => {
    const html = reprintHtmlFromInvoice(invoice({ discountAmount: 5, totalFinal: 71 }), null, "fallback");
    expect(html).toContain("71.00"); // recorded total, not a recompute
    expect(html).toContain("-5.00"); // recorded discount
    expect(html).toContain("كاش");
    expect(html).toContain("شبكة");
    expect(html).toContain("المستلَم");
    expect(html).toContain("2026-07-10"); // ORIGINAL sale date on the reprint
    expect(html).toContain("13:45");
    expect(html).toContain("INV-20260710-0042");
  });

  it("stamps a VOIDED reprint with its serial", () => {
    const html = reprintHtmlFromInvoice(invoice({ zatcaType: "cancellation", voidSerial: "V-7" }), null, "x");
    expect(html).toContain("ملغاة · VOIDED #V-7");
  });

  it("stamps a RETURNED reprint; a normal sale gets no stamp", () => {
    const returned = reprintHtmlFromInvoice(invoice({ zatcaType: "credit_note", returnSerial: "R-3" }), null, "x");
    expect(returned).toContain("مرتجع · RETURNED #R-3");
    const normal = reprintHtmlFromInvoice(invoice(), null, "x");
    expect(normal).not.toContain("VOIDED");
    expect(normal).not.toContain("RETURNED");
  });

  it("honors the owner paper width from the catalog", () => {
    const html = reprintHtmlFromInvoice(invoice(), { receiptSettings: { paperWidth: "58" } }, "x");
    expect(html).toContain('data-paper="58"');
  });

  it("VAT uses the PERSISTED taxSubtotals snapshot when present — not a live recompute", () => {
    // total 100 @ 15% would recompute to 13.04; the snapshot says 7.77, and the
    // snapshot must win (an old sale's tax is frozen, not re-derived from today's rate).
    const inv = { ...invoice({ totalFinal: 100 }), taxSubtotals: { vat: 7.77 } } as InvoiceDetail & {
      taxSubtotals: { vat: number };
    };
    const html = reprintHtmlFromInvoice(inv, null, "x");
    expect(html).toContain("7.77");
    expect(html).not.toContain("13.04");
  });

  it("VAT falls back to the recomputed formula for a pre-migration sale with no snapshot", () => {
    // no taxSubtotals → 100 − 100/1.15 = 13.04 (the legacy fallback), not 7.77.
    const html = reprintHtmlFromInvoice(invoice({ totalFinal: 100 }), null, "x");
    expect(html).toContain("13.04");
    expect(html).not.toContain("7.77");
  });
});

describe("needsApprovalGate — RequireManagerApprovalForVoid opt-out", () => {
  it("privileged roles never see the dialog", () => {
    expect(needsApprovalGate("void", true, true)).toBe(false);
    expect(needsApprovalGate("return", true, true)).toBe(false);
  });

  it("cashier void: gated by default, NOT gated when the owner opted out ('0')", () => {
    expect(needsApprovalGate("void", false, true)).toBe(true);
    expect(needsApprovalGate("void", false, false)).toBe(false);
  });

  it("cashier return: ALWAYS gated — the opt-out is void-only", () => {
    expect(needsApprovalGate("return", false, true)).toBe(true);
    expect(needsApprovalGate("return", false, false)).toBe(true);
  });
});
