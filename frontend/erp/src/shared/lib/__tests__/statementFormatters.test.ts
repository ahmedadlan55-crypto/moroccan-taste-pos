// Statement headings and amount scale.
//
// These exist because every report page hand-concatenated
// `${formatDate(from)} — ${formatDate(to)}`, which states a RANGE and says
// nothing about whether the figures under it are a position at an instant or a
// flow over a period — the single most important thing a statement heading has
// to say.
import { afterEach, describe, expect, it } from "vitest";
import {
  amountScaleNote,
  chooseAmountScale,
  formatAsAt,
  formatCurrency,
  formatDate,
  formatForPeriod,
  formatScaled,
} from "../formatters";

function setLang(lang: string) {
  document.documentElement.lang = lang;
}

afterEach(() => {
  setLang("");
});

describe("statement period phrases", () => {
  it("says 'as at' for a position, in Arabic by default", () => {
    setLang("ar");
    expect(formatAsAt("2026-07-31")).toBe("كما في 31 Jul 2026");
  });

  it("says 'as at' in English when the document is English", () => {
    setLang("en");
    expect(formatAsAt("2026-07-31")).toBe("As at 31 Jul 2026");
  });

  it("says 'for the period from … to …' for a flow", () => {
    setLang("ar");
    expect(formatForPeriod("2026-01-01", "2026-07-31")).toBe("للفترة من 1 Jan 2026 إلى 31 Jul 2026");
    setLang("en");
    expect(formatForPeriod("2026-01-01", "2026-07-31")).toBe("For the period from 1 Jan 2026 to 31 Jul 2026");
  });

  it("says 'for the period ENDED' when only an end date is known", () => {
    // The alternative — printing a range with a blank half — is a heading that
    // looks complete and is not.
    setLang("en");
    expect(formatForPeriod(null, "2026-07-31")).toBe("For the period ended 31 Jul 2026");
    setLang("ar");
    expect(formatForPeriod("", "2026-07-31")).toBe("للفترة المنتهية في 31 Jul 2026");
  });

  it("keeps the pinned en-GB Gregorian date inside the phrase", () => {
    // The date policy is load-bearing (a bank or ZATCA may read the sheet), so
    // the phrase must not introduce a second date format of its own.
    setLang("ar");
    expect(formatAsAt("2026-07-31")).toContain(formatDate("2026-07-31"));
  });

  it("does not invent a date it does not have", () => {
    setLang("en");
    expect(formatAsAt(null)).toBe("As at —");
  });
});

describe("amount scale", () => {
  it("does NOT scale ordinary shop-sized figures", () => {
    // Scaling too eagerly turns 1,250 into "1.3" and costs the reader more
    // precision than the narrower column is worth.
    expect(chooseAmountScale([0, 950, 12_500, 999_999]).key).toBe("units");
  });

  it("moves to thousands once the statement carries seven-figure amounts", () => {
    expect(chooseAmountScale([1_500_000, 240]).key).toBe("thousands");
  });

  it("moves to millions for nine-figure amounts", () => {
    expect(chooseAmountScale([250_000_000]).key).toBe("millions");
  });

  it("picks the scale from the LARGEST magnitude, sign included", () => {
    // One big credit balance sets the column width for the whole statement.
    expect(chooseAmountScale([100, -180_000_000, 5]).key).toBe("millions");
  });

  it("ignores missing and non-finite values instead of counting them as zero", () => {
    expect(chooseAmountScale([null, undefined, NaN, Infinity, 2_000_000]).key).toBe("thousands");
    expect(chooseAmountScale([null, undefined]).key).toBe("units");
  });

  it("states the unit ONCE, in the reader's language", () => {
    setLang("ar");
    expect(amountScaleNote(chooseAmountScale([2_000_000]))).toBe("جميع المبالغ بآلاف الريالات السعودية");
    setLang("en");
    expect(amountScaleNote(chooseAmountScale([2_000_000]))).toBe("All amounts in thousands of Saudi Riyals");
    expect(amountScaleNote(chooseAmountScale([10]))).toBe("All amounts in Saudi Riyals");
  });

  it("prints a scaled figure with NO unit suffix — the unit was already stated", () => {
    const scale = chooseAmountScale([2_000_000]);
    expect(formatScaled(1_234_567, scale)).toBe("1,234.6");
    expect(formatScaled(1_234_567, scale)).not.toContain("ر.س");
    expect(formatScaled(1_234_567, scale)).not.toContain("SAR");
  });

  it("keeps the house two decimals when nothing is scaled", () => {
    expect(formatScaled(1_234.5, chooseAmountScale([1_234.5]))).toBe("1,234.50");
  });

  it("shows an invalid figure as a dash rather than as 0.0", () => {
    expect(formatScaled(NaN, chooseAmountScale([2_000_000]))).toBe("—");
    expect(formatScaled(Infinity, chooseAmountScale([10]))).toBe("—");
  });
});

describe("the existing money contract is untouched", () => {
  // formatCurrency reads document.documentElement.lang across 73 call sites.
  // These new formatters sit in the same module and must not have disturbed it.
  it("still suffixes ر.س in Arabic and prefixes SAR in English", () => {
    setLang("ar");
    expect(formatCurrency(1234.5)).toBe("1,234.50 ر.س");
    setLang("en");
    expect(formatCurrency(1234.5)).toBe("SAR 1,234.50");
  });
});
