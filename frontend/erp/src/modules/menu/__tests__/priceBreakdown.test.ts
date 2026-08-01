/**
 * priceBreakdown / netForGross — the net · VAT · gross triple behind the three
 * price columns on the brand menu list and both price dialogs.
 *
 * The owner reads prices as WHAT THE CUSTOMER PAYS. Menu rows are stored NET,
 * so a row at 30.4261 rings up at 34.99 — and until these columns existed
 * nothing on the ERP connected the two numbers. These tests pin:
 *   1. the arithmetic matches the register's (cartMath.displayUnitPrice), and
 *   2. typing a gross figure stores a net that reproduces it EXACTLY —
 *      the round trip that killed the "type 35, get 40" trap.
 */
import { describe, expect, it } from "vitest";
import { priceBreakdown, netForGross } from "../lib";

const round2 = (n: number) => Math.round(n * 100) / 100;

describe("priceBreakdown — the three columns", () => {
  it("splits a tax-exclusive row: the real Thermal Bottle from the till", () => {
    const b = priceBreakdown(30.4261, "S", false, 15);
    expect(b.net).toBe(30.4261);
    expect(b.tax).toBe(4.56);
    expect(b.gross).toBe(34.99);
    expect(b.grossIsWhole).toBe(false);
    expect(b.wholeTarget).toBe(35);
  });

  it("reports a tuned row as whole", () => {
    const b = priceBreakdown(30.4348, "S", false, 15);
    expect(b.gross).toBe(35);
    expect(b.grossIsWhole).toBe(true);
  });

  it("invents no VAT for a zero-rated item", () => {
    const b = priceBreakdown(20, "Z", false, 15);
    expect(b.tax).toBe(0);
    expect(b.gross).toBe(20);
    expect(b.rate).toBe(0);
    expect(b.grossIsWhole).toBe(true);
  });

  it("treats exempt and out-of-scope the same as zero-rated", () => {
    expect(priceBreakdown(20, "E", false, 15).tax).toBe(0);
    expect(priceBreakdown(20, "O", false, 15).tax).toBe(0);
  });

  it("never grosses a tax-INCLUSIVE row twice", () => {
    const b = priceBreakdown(35, "S", true, 15);
    expect(b.gross).toBe(35);
    expect(b.net).toBe(30.4348);
    expect(b.tax).toBe(4.57);
  });

  it("follows the server's rate rather than a hardcoded 15", () => {
    expect(priceBreakdown(100, "S", false, 5).gross).toBe(105);
    expect(priceBreakdown(100, "S", false, 0).gross).toBe(100);
  });

  it("never proposes 0 as a target — that would make a priced item free", () => {
    // 0.40 net → 0.46 gross → naive rounding gives 0.
    expect(priceBreakdown(0.4, "S", false, 15).wholeTarget).toBe(1);
  });

  it("defaults a missing tax category to standard-rated", () => {
    expect(priceBreakdown(100, undefined, false, 15).gross).toBe(115);
  });
});

describe("netForGross — typing what the customer pays", () => {
  it("round-trips: the stored net reproduces the typed gross EXACTLY", () => {
    // The trap this replaces: typing 35 used to store 35 NET, and the till then
    // charged 40.25 → rounded to 40.
    for (const target of [11, 15, 20, 35, 99, 250]) {
      const net = netForGross(target, "S", false, 15);
      expect(round2(priceBreakdown(net, "S", false, 15).gross)).toBe(target);
    }
  });

  it("holds across VAT rates, so a rate change cannot break the round trip", () => {
    for (const rate of [0, 5, 10, 15]) {
      for (let target = 1; target <= 200; target++) {
        const net = netForGross(target, "S", false, rate);
        expect(priceBreakdown(net, "S", false, rate).gross).toBe(target);
      }
    }
  });

  it("leaves a zero-rated row alone — the gross IS the stored price", () => {
    expect(netForGross(20, "Z", false, 15)).toBe(20);
  });

  it("stores the gross unchanged for a tax-inclusive row", () => {
    expect(netForGross(35, "S", true, 15)).toBe(35);
  });
});

describe("agreement with the register", () => {
  // frontend/pos/src/lib/cartMath.ts displayUnitPrice, reimplemented here as
  // the reference. If the ERP column and the cashier card ever disagree, the
  // owner sees two numbers for one product — the original complaint.
  const registerGross = (price: number, cat: string, inclusive: boolean, pct: number) => {
    const taxed = cat === "S";
    const rate = taxed ? pct / 100 : 0;
    return inclusive ? round2(price) : round2(price * (1 + rate));
  };

  it("produces the same gross the cashier card prints", () => {
    const cases: Array<[number, string, boolean, number]> = [
      [30.4261, "S", false, 15],
      [30.4348, "S", false, 15],
      [20, "Z", false, 15],
      [35, "S", true, 15],
      [100, "S", false, 5],
      [16, "S", false, 15],
    ];
    for (const [price, cat, incl, pct] of cases) {
      expect(priceBreakdown(price, cat, incl, pct).gross).toBe(registerGross(price, cat, incl, pct));
    }
  });
});
