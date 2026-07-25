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
import { describe, expect, it, vi } from "vitest";
import {
  buildKitchenTicketHtml,
  buildReceiptHtml,
  resolveAutoPrint,
  resolvePaperWidth,
  type ReceiptOptions,
} from "../receipt";
import type { LocalOrder, ReceiptIdentity } from "../types";
import * as invoiceTemplate from "../../../../shared/invoiceTemplate";

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
      { menuId: "M1", name: "برجر", qty: 2, unitPrice: 20, vatCategory: "S", taxInclusive: true, lineDiscount: 0, notes: "" } as unknown as LocalOrder["lines"][number],
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

// ═════════════════════════════════════════════════════════════════════════════
// Paper width (ReceiptPaperWidth '58'|'80'|'A4') + autoprint toggle + reprint
// fidelity — close/b2-pos-daily.
// ═════════════════════════════════════════════════════════════════════════════

describe("paper width — the body actually changes size", () => {
  it("defaults to 80mm → the historical 72mm printable body", () => {
    const html = buildReceiptHtml(opts());
    expect(html).toContain('data-paper="80"');
    expect(html).toContain("width: 72mm");
  });

  it("58 switches to a 48mm body with smaller type", () => {
    const html = buildReceiptHtml(opts({ paperWidth: "58" }));
    expect(html).toContain('data-paper="58"');
    expect(html).toContain("width: 48mm");
    expect(html).toContain("font-size: 10px");
    expect(html).not.toContain("width: 72mm");
  });

  it("A4 switches to the full-width layout and keeps it when printing", () => {
    const html = buildReceiptHtml(opts({ paperWidth: "A4" }));
    expect(html).toContain('data-paper="A4"');
    expect(html).toContain("width: 190mm");
    expect(html).not.toContain("@media print { body { width: auto; } }");
  });

  it("kitchen ticket follows the same switch", () => {
    expect(buildKitchenTicketHtml(order(), "58")).toContain("width: 48mm");
    expect(buildKitchenTicketHtml(order())).toContain("width: 72mm");
  });
});

describe("resolvePaperWidth / resolveAutoPrint — defensive catalog read", () => {
  it("reads catalog.receiptSettings.paperWidth (case-tolerant)", () => {
    expect(resolvePaperWidth({ receiptSettings: { paperWidth: "58" } })).toBe("58");
    expect(resolvePaperWidth({ receiptSettings: { paperWidth: "a4" } })).toBe("A4");
    expect(resolvePaperWidth({ receiptSettings: { paperWidth: "80" } })).toBe("80");
  });

  it("falls back to 80 on every missing/foreign shape", () => {
    expect(resolvePaperWidth(null)).toBe("80");
    expect(resolvePaperWidth(undefined)).toBe("80");
    expect(resolvePaperWidth({})).toBe("80");
    expect(resolvePaperWidth({ receiptSettings: null })).toBe("80");
    expect(resolvePaperWidth({ receiptSettings: { paperWidth: "letter" } })).toBe("80");
    expect(resolvePaperWidth({ receiptSettings: { paperWidth: 42 } })).toBe("80");
  });

  it("autoPrint defaults ON; only an explicit '0' turns it off", () => {
    expect(resolveAutoPrint(null)).toBe(true);
    expect(resolveAutoPrint({})).toBe(true);
    expect(resolveAutoPrint({ receiptSettings: { autoPrint: "1" } })).toBe(true);
    expect(resolveAutoPrint({ receiptSettings: { autoPrint: "0" } })).toBe(false);
    expect(resolveAutoPrint({ receiptSettings: { autoPrint: 0 } })).toBe(false);
  });
});

describe("reprint fidelity", () => {
  it("prints the ORIGINAL sale datetime when printedAt is passed", () => {
    const html = buildReceiptHtml(opts({ printedAt: new Date("2026-01-05T09:30:00") }));
    expect(html).toContain("2026-01-05");
    expect(html).toContain("09:30");
  });

  it("RECORDED totals override the line recomputation", () => {
    const html = buildReceiptHtml(
      opts({ totalsOverride: { subtotal: 76, lineDiscountTotal: 0, discountAmount: 5, vatTotal: 9.26, total: 71 } }),
    );
    expect(html).toContain("71.00");
    expect(html).toContain("9.26");
    expect(html).toContain("-5.00");
  });

  it("stamps a reversed-document reprint", () => {
    const html = buildReceiptHtml(opts({ stamp: "ملغاة · VOIDED" }));
    expect(html).toContain('class="stamp"');
    expect(html).toContain("ملغاة · VOIDED");
  });

  it("split payments + tendered/change rows survive on a reprint", () => {
    const html = buildReceiptHtml(
      opts({ payments: [{ method: "cash", amount: 46 }, { method: "card", amount: 30 }], cashTendered: 50, changeDue: 4 }),
    );
    expect(html).toContain("كاش");
    expect(html).toContain("شبكة");
    expect(html).toContain("المستلَم");
    expect(html).toContain("الباقي");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The wrapper is a thin adapter over the SHARED renderer — it must actually CALL
// buildSaleReceiptHtml (not carry a duplicated, drifting copy of the template).
// ═════════════════════════════════════════════════════════════════════════════
describe("receipt.ts delegates to the shared invoice template", () => {
  it("buildReceiptHtml routes through shared buildSaleReceiptHtml with the adapted shape", () => {
    const spy = vi.spyOn(invoiceTemplate, "buildSaleReceiptHtml");
    const html = buildReceiptHtml(opts());
    expect(spy).toHaveBeenCalledTimes(1);
    // The adaptation flattens the LocalOrder into DocumentLine[] + resolved totals.
    const arg = spy.mock.calls[0][0];
    expect(arg.lines[0]).toMatchObject({ name: "برجر", qty: 2, unitPrice: 20 });
    expect(arg.totals).toMatchObject({ subtotal: 40, total: 40 });
    // And the shared renderer's output is what buildReceiptHtml returns.
    expect(html).toContain("مطاعم الأصالة");
    spy.mockRestore();
  });
});
