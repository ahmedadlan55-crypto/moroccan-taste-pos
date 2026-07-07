import { describe, it, expect } from "vitest";
import { formatCurrency, formatNumber, formatDate, formatDateTime } from "../formatters";

// Numbering policy: every numeral in the O2C UI renders as ENGLISH digits 0-9.
const ARABIC_INDIC = /[٠-٩۰-۹]/;

describe("formatters — English digits everywhere", () => {
  it("currency uses English digits + grouping", () => {
    expect(formatCurrency(1234.5)).toContain("1,234.50");
    expect(ARABIC_INDIC.test(formatCurrency(1234.5))).toBe(false);
    expect(ARABIC_INDIC.test(formatCurrency(9876543.21))).toBe(false);
  });

  it("number formatter never emits Arabic-Indic digits", () => {
    for (const v of [0, 5, 42, 1000, 12345.67, -80]) {
      expect(ARABIC_INDIC.test(formatNumber(v))).toBe(false);
    }
    expect(formatNumber(1000)).toBe("1,000");
  });

  it("dates render with Latin digits (Gregorian)", () => {
    const d = formatDate("2026-07-07");
    expect(ARABIC_INDIC.test(d)).toBe(false);
    expect(d).toMatch(/2026/);
    expect(ARABIC_INDIC.test(formatDateTime("2026-07-07T10:30:00"))).toBe(false);
  });

  it("null/empty are safe", () => {
    expect(formatCurrency(null)).toContain("0.00");
    expect(formatDate(null)).toBe("—");
  });
});
