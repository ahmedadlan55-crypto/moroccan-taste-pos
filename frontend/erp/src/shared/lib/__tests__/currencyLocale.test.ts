// Money must be labelled in the language the reader is reading.
//
// THE DEFECT
//   `formatCurrency` appended the literal `ر.س` unconditionally, so the English
//   UI printed an Arabic currency symbol on every money figure in the product —
//   every report, every KPI, every invoice total. A number whose unit is in a
//   script the reader cannot read is not a cosmetic blemish; it is a figure
//   they cannot safely act on.
//
// WHY THE TEST DRIVES `document.documentElement.lang`
//   That is exactly what the formatter reads, and what I18nProvider stamps on
//   every language switch (I18nProvider.tsx:76). Testing through the same
//   channel the production code uses is the only way this proves anything.
import { afterEach, describe, expect, it } from "vitest";
import { formatCurrency, formatNumber } from "../formatters";

const original = document.documentElement.lang;
afterEach(() => {
  document.documentElement.lang = original;
});

describe("currency follows the active language", () => {
  it("labels in Arabic when the document is Arabic", () => {
    document.documentElement.lang = "ar";
    expect(formatCurrency(1234.5)).toBe("1,234.50 ر.س");
  });

  it("labels in English when the document is English", () => {
    document.documentElement.lang = "en";
    const out = formatCurrency(1234.5);
    expect(out, "an Arabic symbol on an English screen").not.toContain("ر.س");
    expect(out).toBe("SAR 1,234.50");
  });

  it("defaults to Arabic for any other value — the app's primary language", () => {
    // Never fall back to English: this is an Arabic-first product, and an
    // unset lang during first paint must not flash the wrong unit.
    document.documentElement.lang = "";
    expect(formatCurrency(10)).toBe("10.00 ر.س");
  });
});

describe("what must NOT change with language", () => {
  it("keeps English digits in both — the approved numbering policy", () => {
    document.documentElement.lang = "ar";
    expect(formatCurrency(1234.5)).toContain("1,234.50");
    document.documentElement.lang = "en";
    expect(formatCurrency(1234.5)).toContain("1,234.50");
  });

  it("still renders two decimals for whole amounts", () => {
    document.documentElement.lang = "en";
    expect(formatCurrency(10)).toBe("SAR 10.00");
  });

  it("still treats null/undefined/NaN as zero rather than crashing a report", () => {
    document.documentElement.lang = "ar";
    for (const bad of [null, undefined, NaN]) {
      expect(formatCurrency(bad as unknown as number)).toBe("0.00 ر.س");
    }
  });

  it("leaves plain numbers alone — only the currency carries a unit", () => {
    document.documentElement.lang = "en";
    expect(formatNumber(1234.5)).toBe("1,234.5");
  });
});
