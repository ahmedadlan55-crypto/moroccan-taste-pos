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
    expect(html).toContain("مطاعم الأصالة");
    expect(html).not.toContain("المذاق المغربي");
  });

  it("prints every owner-configured seller field", () => {
    const html = buildSaleReceiptHtml(saleOpts());
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

  it("a plain invoice with no cashier/orderType renders no cashier line", () => {
    const html = buildSaleReceiptHtml(saleOpts({ cashierName: undefined, orderType: null }));
    expect(html).not.toContain("الكاشير");
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
