/**
 * cartMath must MIRROR lib/posOrderMachine.js (server) exactly —
 * these cases are the shared contract fixture set.
 *
 * The tax convention is PER ITEM (menu.is_tax_inclusive) and every fixture
 * states it. It used to be a global "prices are tax-inclusive" assumption while
 * the database said the opposite for every row — which is how the register came
 * to display a NET price as the total and have the sale refused by the server.
 */
import { describe, expect, it } from "vitest";
import { cartTotals, lineTotals, paymentsError, rateFor, round2 } from "../cartMath";

describe("round2", () => {
  it("rounds to 2dp", () => {
    expect(round2(1.005)).toBeCloseTo(1.0, 10); // JS float: 1.005*100 = 100.49999…
    expect(round2(6.0000001)).toBe(6);
    expect(round2(10.099999)).toBe(10.1);
  });
});

describe("lineTotals", () => {
  it("2×23 S → gross 46, vat 6.00 (tax-inclusive 15%)", () => {
    const t = lineTotals({ qty: 2, unitPrice: 23, lineDiscount: 0, vatCategory: "S", taxInclusive: true });
    expect(t.gross).toBe(46);
    expect(t.vat).toBe(6);
    expect(t.net).toBe(40);
  });

  it("Z/E/O categories carry zero VAT", () => {
    for (const cat of ["Z", "E", "O"] as const) {
      const t = lineTotals({ qty: 1, unitPrice: 115, lineDiscount: 0, vatCategory: cat, taxInclusive: true });
      expect(t.vat).toBe(0);
      expect(t.gross).toBe(115);
    }
  });

  it("line discount reduces gross before VAT and is clamped to qty×price", () => {
    const t = lineTotals({ qty: 1, unitPrice: 100, lineDiscount: 250, vatCategory: "S", taxInclusive: true });
    expect(t.discount).toBe(100); // clamped
    expect(t.gross).toBe(0);
    expect(t.vat).toBe(0);
  });
});

// The state EVERY production menu row is actually in (server.js v7.1 set
// is_tax_inclusive = 0 on all of them) — and the one the whole suite left
// untested while asserting the opposite everywhere.
describe("lineTotals — TAX-EXCLUSIVE items (VAT added on top)", () => {
  // v8.2 — the customer-facing UNIT price snaps to a whole riyal. This case
  // used to assert 18.40, which is the arithmetic the owner rejected: he sells
  // at whole riyals and the till printed halalas on every standard-rated row.
  // net/vat are derived FROM the rounded gross, so the invariant below still
  // holds exactly — the sale journal and ZATCA both depend on it.
  it("the owner's case: 16.00 net rings up as a whole 18", () => {
    const t = lineTotals({ qty: 1, unitPrice: 16, lineDiscount: 0, vatCategory: "S", taxInclusive: false });
    expect(t.gross).toBe(18);
    expect(t.net).toBe(15.65);
    expect(t.vat).toBe(2.35);
    // The property the owner asked for, stated as arithmetic.
    expect(round2(t.net + t.vat)).toBe(t.gross);
  });

  it("2×20 net → 40.00 + 6.00 = 46.00", () => {
    const t = lineTotals({ qty: 2, unitPrice: 20, lineDiscount: 0, vatCategory: "S", taxInclusive: false });
    expect(t.net).toBe(40);
    expect(t.vat).toBe(6);
    expect(t.gross).toBe(46);
  });

  it("a zero-rated exclusive line adds NO VAT", () => {
    const t = lineTotals({ qty: 3, unitPrice: 10, lineDiscount: 0, vatCategory: "Z", taxInclusive: false });
    expect(t.vat).toBe(0);
    expect(t.gross).toBe(30);
  });

  it("a line discount comes off the GROSS, which is the space it is entered in", () => {
    // 50 net → 57.50 → whole unit 58; minus a 10 discount = 48 charged.
    const t = lineTotals({ qty: 1, unitPrice: 50, lineDiscount: 10, vatCategory: "S", taxInclusive: false });
    expect(t.gross).toBe(48);
    expect(round2(t.net + t.vat)).toBe(t.gross);
  });

  it("the whole unit price multiplies cleanly — a quoted 18 each is 36 for two", () => {
    const t = lineTotals({ qty: 2, unitPrice: 16, lineDiscount: 0, vatCategory: "S", taxInclusive: false });
    expect(t.gross).toBe(36);
  });

  it("an ABSENT flag behaves like the database does today (exclusive)", () => {
    const t = lineTotals({ qty: 1, unitPrice: 16, lineDiscount: 0, vatCategory: "S" });
    expect(t.gross).toBe(18);
  });

  it("the flag actually changes the customer-facing amount", () => {
    const inc = lineTotals({ qty: 1, unitPrice: 16, lineDiscount: 0, vatCategory: "S", taxInclusive: true });
    const exc = lineTotals({ qty: 1, unitPrice: 16, lineDiscount: 0, vatCategory: "S", taxInclusive: false });
    expect(inc.gross).toBe(16);
    expect(exc.gross).toBe(18);
  });
});

describe("the VAT rate comes from the server, not a constant", () => {
  it("rateFor honours the shipped percentage and zero-rates non-S categories", () => {
    expect(rateFor("S", 15)).toBeCloseTo(0.15, 10);
    expect(rateFor("S", 5)).toBeCloseTo(0.05, 10);
    expect(rateFor("S", 0)).toBe(0);
    for (const cat of ["Z", "E", "O"] as const) expect(rateFor(cat, 15)).toBe(0);
  });

  it("a 5% rate flows through the line math (100 → 105.00)", () => {
    const t = lineTotals({ qty: 1, unitPrice: 100, lineDiscount: 0, vatCategory: "S", taxInclusive: false }, 5);
    expect(t.vat).toBe(5);
    expect(t.gross).toBe(105);
  });

  it("an invalid rate falls back to 15% instead of producing NaN money", () => {
    const t = lineTotals({ qty: 1, unitPrice: 100, lineDiscount: 0, vatCategory: "S", taxInclusive: false }, NaN);
    expect(Number.isFinite(t.gross)).toBe(true);
    expect(t.gross).toBe(115);
  });

  it("cartTotals threads the rate down to every line", () => {
    const t = cartTotals([{ qty: 1, unitPrice: 100, lineDiscount: 0, vatCategory: "S", taxInclusive: false }], null, 5);
    expect(t.subtotal).toBe(105);
    expect(t.vatTotal).toBe(5);
    expect(t.total).toBe(105);
  });
});

describe("cartTotals", () => {
  it("2×23 S with no order discount → subtotal 46, vat 6.00, total 46", () => {
    const t = cartTotals([{ qty: 2, unitPrice: 23, lineDiscount: 0, vatCategory: "S", taxInclusive: true }], null);
    expect(t.subtotal).toBe(46);
    expect(t.vatTotal).toBe(6);
    expect(t.total).toBe(46);
    expect(t.discountAmount).toBe(0);
  });

  it("order 10% on subtotal 116 (S 86 + Z 30) → total 104.4, vat 10.1", () => {
    const t = cartTotals(
      [
        { qty: 1, unitPrice: 86, lineDiscount: 0, vatCategory: "S", taxInclusive: true },
        { qty: 1, unitPrice: 30, lineDiscount: 0, vatCategory: "Z", taxInclusive: true },
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
    const t = cartTotals([{ qty: 1, unitPrice: 116, lineDiscount: 0, vatCategory: "S", taxInclusive: true }], { type: "PERCENT", value: 10 });
    expect(t.total).toBe(104.4);
    expect(t.vatTotal).toBe(13.62); // 15.13 × 0.9 = 13.617 → 13.62 (server-identical)
  });

  it("FIXED order discount is capped at subtotal", () => {
    const t = cartTotals([{ qty: 1, unitPrice: 50, lineDiscount: 0, vatCategory: "S", taxInclusive: true }], { type: "FIXED", value: 500 });
    expect(t.discountAmount).toBe(50);
    expect(t.total).toBe(0);
    expect(t.vatTotal).toBe(0);
  });

  it("PERCENT is capped at 100", () => {
    const t = cartTotals([{ qty: 1, unitPrice: 80, lineDiscount: 0, vatCategory: "S", taxInclusive: true }], { type: "PERCENT", value: 250 });
    expect(t.discountAmount).toBe(80);
    expect(t.total).toBe(0);
  });

  it("line discounts apply before the order discount", () => {
    const t = cartTotals(
      [{ qty: 2, unitPrice: 25, lineDiscount: 10, vatCategory: "S", taxInclusive: true }], // gross 40
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
