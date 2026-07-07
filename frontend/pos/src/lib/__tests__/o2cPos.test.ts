import { describe, it, expect } from "vitest";
import { upsertPayloadFrom } from "../offline";
import { buildReceiptHtml } from "../receipt";
import type { LocalOrder, Payment } from "../types";

const ARABIC_INDIC = /[٠-٩۰-۹]/;

function doc(over: Partial<LocalOrder> = {}): LocalOrder {
  return {
    id: "01ORDERULID0000000000000000", status: "open", orderType: "takeaway", tableNo: null,
    shiftId: "SH-1", deviceId: "d1", discountType: null, discountValue: 0, discountName: null,
    note: null, customerId: null, customerName: null, customerPhone: null,
    lines: [{ menuId: "M1", name: "شاي مغربي", qty: 1, unitPrice: 23, lineDiscount: 0, vatCategory: "S", notes: null }],
    serverVersion: null, invoiceNumber: null, saleId: null, createdAt: 1, updatedAt: 1,
    ...over,
  };
}

describe("POS ↔ Order-to-Cash: upsert payload carries customerId", () => {
  it("sends a real customerId when the cart is linked to a customer", () => {
    const p = upsertPayloadFrom(doc({ customerId: "CUST-42", customerName: "شركة الأفق", customerPhone: "0551234567" }));
    expect(p.customerId).toBe("CUST-42");
  });

  it("omits customerId for a walk-in (null) — no stale id", () => {
    const p = upsertPayloadFrom(doc({ customerId: null }));
    expect(p.customerId).toBeUndefined();
  });
});

describe("POS receipt shows the customer + payment split (English digits)", () => {
  const payments: Payment[] = [
    { method: "cash", amount: 40 },
    { method: "credit", amount: 60 },
  ];
  const html = buildReceiptHtml({
    order: doc({ customerId: "C1", customerName: "أحمد التاجر", customerPhone: "0509876543", lines: [{ menuId: "M1", name: "شاي", qty: 4, unitPrice: 25, lineDiscount: 0, vatCategory: "S", notes: null }] }),
    payments, invoiceNumber: "INV-100", cashierName: "الكاشير", vatRate: 15,
  });

  it("prints the customer name + phone", () => {
    expect(html).toContain("أحمد التاجر");
    expect(html).toContain("0509876543");
  });

  it("prints each payment method incl. credit as «آجل» (never «كيتا»)", () => {
    expect(html).toContain("آجل");
    expect(html).toContain("كاش");
    expect(html).not.toContain("كيتا");
  });

  it("contains NO Arabic-Indic digits (English 0-9 only)", () => {
    expect(ARABIC_INDIC.test(html)).toBe(false);
  });
});
