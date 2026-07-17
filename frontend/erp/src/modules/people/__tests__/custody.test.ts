import { describe, it, expect } from "vitest";
import {
  expenseTotals,
  splitTopupAccounts,
  topupAccountOptions,
  topupRequiresAccount,
} from "../lib/custody";
import type { GlAccountLite } from "../lib/types";

const acc = (code: string, nameAr: string, type = "asset"): GlAccountLite => ({
  id: "GL-" + code,
  code,
  nameAr,
  type,
});

describe("splitTopupAccounts (legacy openTopupModal filters)", () => {
  it("classifies cash boxes by 1110 prefix or صندوق/نقد/كاش names", () => {
    const { cash } = splitTopupAccounts([
      acc("11101", "الصندوق الرئيسي"),
      acc("11201", "نقدية الفرع"), // name match, non-1110 code
      acc("2101", "دائنون", "liability"),
    ]);
    expect(cash.map((a) => a.code)).toEqual(["11101", "11201"]);
  });

  it("classifies banks by 11102/1111 prefix or بنك/مصرف names", () => {
    const { bank } = splitTopupAccounts([
      acc("11102", "بنك الراجحي"),
      acc("11111", "حساب جاري"),
      acc("11201", "مصرف الإنماء"),
      acc("11101", "الصندوق الرئيسي"),
    ]);
    expect(bank.map((a) => a.code)).toEqual(["11102", "11111", "11201"]);
  });

  it("falls back to ALL 111x assets for BOTH pickers when nothing matches", () => {
    const rows = [acc("1112", "حساب أصول عام"), acc("2101", "دائنون", "liability")];
    const { cash, bank } = splitTopupAccounts(rows);
    expect(cash.map((a) => a.code)).toEqual(["1112"]);
    expect(bank.map((a) => a.code)).toEqual(["1112"]);
  });

  it("method → options: cash boxes for cash, banks for transfer, both for other", () => {
    const split = {
      cash: [acc("11101", "الصندوق")],
      bank: [acc("11102", "بنك")],
    };
    expect(topupAccountOptions(split, "cash").map((a) => a.code)).toEqual(["11101"]);
    expect(topupAccountOptions(split, "transfer").map((a) => a.code)).toEqual(["11102"]);
    expect(topupAccountOptions(split, "other").map((a) => a.code)).toEqual(["11101", "11102"]);
  });

  it("cash/transfer REQUIRE an account; other does not (legacy submitTopup rule)", () => {
    expect(topupRequiresAccount("cash")).toBe(true);
    expect(topupRequiresAccount("transfer")).toBe(true);
    expect(topupRequiresAccount("other")).toBe(false);
  });
});

describe("expenseTotals (mirrors routes/custody.js VAT math)", () => {
  it("no VAT → total equals amount", () => {
    expect(expenseTotals(200, false, 15)).toEqual({ amount: 200, vatRate: 0, vatAmount: 0, totalWithVat: 200 });
  });

  it("15% VAT → amount * 1.15", () => {
    const t = expenseTotals(200, true, 15);
    expect(t.vatAmount).toBeCloseTo(30);
    expect(t.totalWithVat).toBeCloseTo(230);
  });

  it("a zero/invalid VAT rate with hasVat defaults to 15 (server behavior)", () => {
    const t = expenseTotals(100, true, 0);
    expect(t.vatRate).toBe(15);
    expect(t.totalWithVat).toBeCloseTo(115);
  });
});
