/**
 * cartMath must MIRROR lib/posOrderMachine.js (server) exactly —
 * these cases are the shared contract fixture set.
 */
import { describe, expect, it } from "vitest";
import { cartTotals, lineTotals, paymentsError, round2 } from "../cartMath";

describe("round2", () => {
  it("rounds to 2dp", () => {
    expect(round2(1.005)).toBeCloseTo(1.0, 10); // JS float: 1.005*100 = 100.49999…
    expect(round2(6.0000001)).toBe(6);
    expect(round2(10.099999)).toBe(10.1);
  });
});

describe("lineTotals", () => {
  it("2×23 S → gross 46, vat 6.00 (tax-inclusive 15%)", () => {
    const t = lineTotals({ qty: 2, unitPrice: 23, lineDiscount: 0, vatCategory: "S" });
    expect(t.gross).toBe(46);
    expect(t.vat).toBe(6);
    expect(t.net).toBe(40);
  });

  it("Z/E/O categories carry zero VAT", () => {
    for (const cat of ["Z", "E", "O"] as const) {
      const t = lineTotals({ qty: 1, unitPrice: 115, lineDiscount: 0, vatCategory: cat });
      expect(t.vat).toBe(0);
      expect(t.gross).toBe(115);
    }
  });

  it("line discount reduces gross before VAT and is clamped to qty×price", () => {
    const t = lineTotals({ qty: 1, unitPrice: 100, lineDiscount: 250, vatCategory: "S" });
    expect(t.discount).toBe(100); // clamped
    expect(t.gross).toBe(0);
    expect(t.vat).toBe(0);
  });
});

describe("cartTotals", () => {
  it("2×23 S with no order discount → subtotal 46, vat 6.00, total 46", () => {
    const t = cartTotals([{ qty: 2, unitPrice: 23, lineDiscount: 0, vatCategory: "S" }], null);
    expect(t.subtotal).toBe(46);
    expect(t.vatTotal).toBe(6);
    expect(t.total).toBe(46);
    expect(t.discountAmount).toBe(0);
  });

  it("order 10% on subtotal 116 (S 86 + Z 30) → total 104.4, vat 10.1", () => {
    const t = cartTotals(
      [
        { qty: 1, unitPrice: 86, lineDiscount: 0, vatCategory: "S" },
        { qty: 1, unitPrice: 30, lineDiscount: 0, vatCategory: "Z" },
      ],
      { type: "PERCENT", value: 10 },
    );
    expect(t.subtotal).toBe(116);
    expect(t.discountAmount).toBe(11.6);
    expect(t.total).toBe(104.4);
    // vatBase 11.22 (round2 of 86−86/1.15) × factor 0.9 → 10.098 → 10.1
    expect(t.vatTotal).toBe(10.1);
  });

  it("order 10% on an all-S subtotal scales VAT by total/subtotal", () => {
    const t = cartTotals([{ qty: 1, unitPrice: 116, lineDiscount: 0, vatCategory: "S" }], { type: "PERCENT", value: 10 });
    expect(t.total).toBe(104.4);
    expect(t.vatTotal).toBe(13.62); // 15.13 × 0.9 = 13.617 → 13.62 (server-identical)
  });

  it("FIXED order discount is capped at subtotal", () => {
    const t = cartTotals([{ qty: 1, unitPrice: 50, lineDiscount: 0, vatCategory: "S" }], { type: "FIXED", value: 500 });
    expect(t.discountAmount).toBe(50);
    expect(t.total).toBe(0);
    expect(t.vatTotal).toBe(0);
  });

  it("PERCENT is capped at 100", () => {
    const t = cartTotals([{ qty: 1, unitPrice: 80, lineDiscount: 0, vatCategory: "S" }], { type: "PERCENT", value: 250 });
    expect(t.discountAmount).toBe(80);
    expect(t.total).toBe(0);
  });

  it("line discounts apply before the order discount", () => {
    const t = cartTotals(
      [{ qty: 2, unitPrice: 25, lineDiscount: 10, vatCategory: "S" }], // gross 40
      { type: "PERCENT", value: 50 },
    );
    expect(t.subtotal).toBe(40);
    expect(t.lineDiscountTotal).toBe(10);
    expect(t.discountAmount).toBe(20);
    expect(t.total).toBe(20);
  });

  it("empty cart → all zeros (no division by zero)", () => {
    const t = cartTotals([], { type: "PERCENT", value: 10 });
    expect(t.subtotal).toBe(0);
    expect(t.total).toBe(0);
    expect(t.vatTotal).toBe(0);
  });
});

describe("paymentsError (mirror of M.validatePayments)", () => {
  it("payments must equal the total exactly", () => {
    expect(paymentsError([{ method: "cash", amount: 104.4 }], 104.4)).toBeNull();
    expect(paymentsError([{ method: "cash", amount: 104.39 }], 104.4)).toMatch(/لا يساوي/);
    expect(paymentsError([{ method: "cash", amount: 105 }], 104.4)).toMatch(/لا يساوي/);
  });

  it("split payments sum to the total", () => {
    expect(
      paymentsError(
        [
          { method: "cash", amount: 50 },
          { method: "card", amount: 54.4 },
        ],
        104.4,
      ),
    ).toBeNull();
    expect(
      paymentsError(
        [
          { method: "cash", amount: 50 },
          { method: "card", amount: 50 },
        ],
        104.4,
      ),
    ).toMatch(/لا يساوي/);
  });

  it("rejects empty payments and non-positive amounts", () => {
    expect(paymentsError([], 10)).toMatch(/طريقة دفع/);
    expect(paymentsError([{ method: "cash", amount: 0 }], 0)).toMatch(/غير صالح/);
    expect(paymentsError([{ method: "cash", amount: -5 }], -5)).toMatch(/غير صالح/);
  });

  it("float-sum equality uses round2 (0.1+0.2 style sums pass)", () => {
    expect(
      paymentsError(
        [
          { method: "cash", amount: 0.1 },
          { method: "card", amount: 0.2 },
        ],
        0.3,
      ),
    ).toBeNull();
  });
});
