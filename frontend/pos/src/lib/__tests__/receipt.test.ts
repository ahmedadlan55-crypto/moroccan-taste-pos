/**
 * The receipt prints what the owner configured — pinned at the HTML level.
 *
 * The defect class here is WRITE-ONLY fields: the API returned crNumber,
 * nationalAddress, receiptHeader, receiptThankYou and receiptReturnPolicy for
 * every sale (routes/sales.js /invoice/:orderId), the settings screen edited
 * them — and no renderer ever printed one of them. The seller name came from
 * document.title. There was no ZATCA QR at all.
 *
 * Each assertion is a field reaching PAPER, not a field existing in a payload.
 */
import { describe, expect, it } from "vitest";
import { buildReceiptHtml, type ReceiptOptions } from "../receipt";
import type { LocalOrder, ReceiptIdentity } from "../types";

const IDENTITY: ReceiptIdentity = {
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

function order(partial?: Partial<LocalOrder>): LocalOrder {
  return {
    id: "01JTESTORDER0000000000000",
    status: "completed",
    orderType: "takeaway",
    lines: [
      { menuId: "M1", name: "برجر", qty: 2, unitPrice: 20, vatCategory: "S", lineDiscount: 0, notes: "" } as unknown as LocalOrder["lines"][number],
    ],
    discountType: null,
    discountValue: 0,
    serverVersion: 1,
    invoiceNumber: "INV-20260715-0001",
    saleId: "SALE-1",
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  } as LocalOrder;
}

function opts(partial?: Partial<ReceiptOptions>): ReceiptOptions {
  return {
    order: order(),
    payments: [{ method: "cash", amount: 46 }],
    invoiceNumber: "INV-20260715-0001",
    cashierName: "أحمد",
    vatRate: 15,
    identity: IDENTITY,
    zatcaQrDataUrl: "data:image/png;base64,iVBORw0KGgoTEST",
    ...partial,
  };
}

describe("buildReceiptHtml — identity reaches paper", () => {
  it("prints the CONFIGURED seller, not the browser tab title", () => {
    const html = buildReceiptHtml(opts());
    expect(html).toContain("مطاعم الأصالة");
    // the old source — document.title is empty under jsdom's default,
    // so its fallback brand must NOT appear when an identity exists
    expect(html).not.toContain("المذاق المغربي");
  });

  it("prints every owner-configured field that was write-only", () => {
    const html = buildReceiptHtml(opts());
    expect(html).toContain("310122393500003"); // taxNumber
    expect(html).toContain("1010999999"); // crNumber
    expect(html).toContain("RRRD2929 حي العليا، الرياض"); // nationalAddress
    expect(html).toContain("فرع العليا — فاتورة ضريبية مبسطة"); // receiptHeader
    expect(html).toContain("نشكر لكم زيارتكم ونتشرف بخدمتكم"); // receiptThankYou
    expect(html).toContain("الاسترجاع خلال ٣ أيام بالفاتورة"); // receiptReturnPolicy
    expect(html).toContain("سجل معنا في برنامج الولاء"); // receiptFooter
  });

  it("thankYou REPLACES the hardcoded footer instead of duplicating it", () => {
    const html = buildReceiptHtml(opts());
    expect(html).not.toContain("شكرًا لزيارتكم");
  });

  it("prints the server-stamped QR as an image — never re-derives it", () => {
    const html = buildReceiptHtml(opts());
    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgoTEST"');
  });

  it("an OFFLINE queued sale says the stamp comes after sync — no fake QR", () => {
    const html = buildReceiptHtml(opts({ offlineRef: true, zatcaQrDataUrl: null }));
    expect(html).toContain("رمز الفاتورة الضريبي يصدر بعد المزامنة");
    expect(html).not.toContain("<img");
  });

  it("no identity → tab-title fallback and NO fabricated fields", () => {
    const html = buildReceiptHtml(opts({ identity: null, zatcaQrDataUrl: null }));
    expect(html).not.toContain("الرقم الضريبي");
    expect(html).not.toContain("س.ت:");
    // the default thank-you survives when no identity configured one
    expect(html).toContain("شكرًا لزيارتكم");
  });

  it("owner toggles are honoured: qr=false suppresses even a present stamp", () => {
    const html = buildReceiptHtml(
      opts({ showFields: { logo: true, taxNumber: true, crNumber: true, nationalAddress: true, phone: true, email: true, cashier: true, customer: true, qr: false } }),
    );
    expect(html).not.toContain("<img");
  });

  it("owner toggles: taxNumber=false hides it while the rest print", () => {
    const html = buildReceiptHtml(
      opts({ showFields: { logo: true, taxNumber: false, crNumber: true, nationalAddress: true, phone: true, email: true, cashier: true, customer: true, qr: true } }),
    );
    expect(html).not.toContain("310122393500003");
    expect(html).toContain("1010999999");
  });
});
