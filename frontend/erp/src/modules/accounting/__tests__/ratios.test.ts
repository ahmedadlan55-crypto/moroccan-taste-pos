import { describe, it, expect } from "vitest";
import { computeRatios, extractInputs, sumByPrefix, type RatioInputs } from "../lib/ratios";

const base: RatioInputs = {
  totalAssets: 1000, currentAssets: 600, inventory: 200,
  totalLiabilities: 400, currentLiabilities: 300, equity: 600,
  revenue: 2000, cogs: 800, netIncome: 300,
};
const get = (i: RatioInputs, key: string) => computeRatios(i).find((r) => r.key === key)!;

describe("sumByPrefix", () => {
  it("sums only the matching account codes", () => {
    expect(sumByPrefix([{ code: "1101", balance: 10 }, { code: "1102", balance: 5 }, { code: "2101", balance: 99 }], ["11"])).toBe(15);
  });

  it("returns NULL when nothing matches — the figure does not exist", () => {
    // The legacy code turned this case into `|| totalAssets` / `|| totalExp*0.6`.
    expect(sumByPrefix([{ code: "2101", balance: 99 }], ["11"])).toBeNull();
    expect(sumByPrefix([], ["11"])).toBeNull();
    expect(sumByPrefix(undefined, ["11"])).toBeNull();
  });

  it("distinguishes zero from absent", () => {
    expect(sumByPrefix([{ code: "1101", balance: 0 }], ["11"])).toBe(0);
  });
});

describe("computeRatios — the math", () => {
  it("current ratio = current assets / current liabilities", () => {
    expect(get(base, "current").value).toBeCloseTo(600 / 300);
  });

  it("quick ratio excludes inventory", () => {
    expect(get(base, "quick").value).toBeCloseTo((600 - 200) / 300);
  });

  it("gross margin = (revenue - cogs) / revenue * 100", () => {
    expect(get(base, "gross-margin").value).toBeCloseTo(((2000 - 800) / 2000) * 100);
  });

  it("net margin, ROA, ROE", () => {
    expect(get(base, "net-margin").value).toBeCloseTo((300 / 2000) * 100);
    expect(get(base, "roa").value).toBeCloseTo((300 / 1000) * 100);
    expect(get(base, "roe").value).toBeCloseTo((300 / 600) * 100);
  });

  it("debt ratio and debt/equity", () => {
    expect(get(base, "debt-ratio").value).toBeCloseTo((400 / 1000) * 100);
    expect(get(base, "debt-equity").value).toBeCloseTo(400 / 600);
  });

  it("turnover ratios", () => {
    expect(get(base, "asset-turnover").value).toBeCloseTo(2000 / 1000);
    expect(get(base, "inventory-turnover").value).toBeCloseTo(800 / 200);
  });
});

describe("computeRatios — refuses to fabricate", () => {
  it("gross margin is UNAVAILABLE when there are no COGS accounts (legacy guessed 60% of expenses)", () => {
    const r = get({ ...base, cogs: null }, "gross-margin");
    expect(r.value).toBeNull();
    expect(r.unavailableReason).toContain("تكلفة مبيعات");
  });

  it("inventory turnover is unavailable without COGS", () => {
    expect(get({ ...base, cogs: null }, "inventory-turnover").value).toBeNull();
  });

  it("current ratio is UNAVAILABLE without current-asset accounts (legacy substituted ALL assets)", () => {
    const r = get({ ...base, currentAssets: null }, "current");
    expect(r.value).toBeNull();
    expect(r.unavailableReason).toContain("أصول متداولة");
  });

  it("current ratio is unavailable without current-liability accounts", () => {
    const r = get({ ...base, currentLiabilities: null }, "current");
    expect(r.value).toBeNull();
    expect(r.unavailableReason).toContain("التزامات متداولة");
  });

  it("a zero denominator yields null, not zero or Infinity", () => {
    expect(get({ ...base, equity: 0 }, "roe").value).toBeNull();
    expect(get({ ...base, totalAssets: 0 }, "roa").value).toBeNull();
    expect(get({ ...base, currentLiabilities: 0 }, "current").value).toBeNull();
    expect(get({ ...base, revenue: 0 }, "net-margin").value).toBeNull();
  });

  it("no ratio ever returns NaN or Infinity", () => {
    const hostile: RatioInputs = {
      totalAssets: 0, currentAssets: null, inventory: null, totalLiabilities: 0,
      currentLiabilities: null, equity: 0, revenue: 0, cogs: null, netIncome: 0,
    };
    computeRatios(hostile).forEach((r) => {
      expect(r.value === null || Number.isFinite(r.value)).toBe(true);
    });
  });

  it("every ratio carries a name, formula and explanation", () => {
    computeRatios(base).forEach((r) => {
      expect(r.name).toBeTruthy();
      expect(r.formula).toBeTruthy();
      expect(r.explanation).toBeTruthy();
    });
  });
});

describe("extractInputs", () => {
  it("maps the real API payload shape", () => {
    const i = extractInputs(
      {
        totals: { assets: 1000, liabilities: 400, equity: 600 },
        assets: [{ code: "1101", balance: 400 }, { code: "1121", balance: 200 }],
        liabilities: [{ code: "2101", balance: 300 }],
      },
      {
        summary: { totalRevenue: 2000, totalExpense: 1700, netProfit: 300 },
        expenses: [{ code: "5101", balance: 800 }],
      },
    );
    expect(i.totalAssets).toBe(1000);
    expect(i.currentAssets).toBe(600); // 1101 + 1121 both start with "11"
    expect(i.inventory).toBe(200);     // 1121 starts with "112"
    expect(i.currentLiabilities).toBe(300);
    expect(i.cogs).toBe(800);
    expect(i.netIncome).toBe(300);
  });

  it("uses governed IFRS groups instead of guessing from account prefixes", () => {
    const i = extractInputs(
      {
        totalAssets: 1000, totalLiabilities: 400, totEq: 600,
        totCA: 650, totCL: 280,
        groups: { currentAssets: { inventory: { total: 225 } } },
        // A deliberately unrelated code proves classification wins.
        assets: [{ code: "9999", balance: 999 }],
      },
      { totalRevenue: 2000, totalExpense: 1700, totalCOGS: 800, netIncome: 300 },
    );
    expect(i.currentAssets).toBe(650);
    expect(i.inventory).toBe(225);
    expect(i.currentLiabilities).toBe(280);
    expect(i.cogs).toBe(800);
    expect(i.netIncome).toBe(300);
  });

  it("reports missing figures as null rather than substituting", () => {
    const i = extractInputs({ totals: { assets: 1000, liabilities: 400, equity: 600 }, assets: [], liabilities: [] }, { summary: {}, expenses: [] });
    expect(i.currentAssets).toBeNull();
    expect(i.cogs).toBeNull();
    expect(i.totalAssets).toBe(1000);
  });

  it("falls back to revenue - expense for net income only when netProfit is absent", () => {
    expect(extractInputs(undefined, { summary: { totalRevenue: 100, totalExpense: 40 } }).netIncome).toBe(60);
    expect(extractInputs(undefined, { summary: { totalRevenue: 100, totalExpense: 40, netProfit: 55 } }).netIncome).toBe(55);
  });

  it("survives empty payloads", () => {
    const i = extractInputs(undefined, undefined);
    expect(i.totalAssets).toBe(0);
    expect(i.cogs).toBeNull();
    expect(computeRatios(i).every((r) => r.value === null || Number.isFinite(r.value))).toBe(true);
  });
});
