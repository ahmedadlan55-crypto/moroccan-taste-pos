import { describe, it, expect } from "vitest";
import { formatCurrency, formatNumber, formatQty, formatPercent, formatDate, formatDateTime } from "../formatters";

// The warehouse numbering policy: ENGLISH digits everywhere, Arabic labels.
const ARABIC_DIGITS = /[٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹]/;

describe("formatters — English-digits policy", () => {
  it('formats currency as "1,234.50 ر.س" and is null-safe', () => {
    expect(formatCurrency(1234.5)).toBe("1,234.50 ر.س");
    expect(formatCurrency(1000)).toBe("1,000.00 ر.س");
    expect(formatCurrency(null)).toBe("0.00 ر.س");
    expect(formatCurrency(undefined)).toBe("0.00 ر.س");
  });

  it("formats numbers with en-US grouping, up to two decimals", () => {
    expect(formatNumber(86.5)).toBe("86.5");
    expect(formatNumber(1234.567)).toBe("1,234.57");
    expect(formatNumber(0)).toBe("0");
  });

  it("formats a quantity with an optional unit", () => {
    expect(formatQty(12, "كجم")).toBe("12 كجم");
    expect(formatQty(12)).toBe("12");
    expect(formatQty(1234.5, "حبة")).toBe("1,234.5 حبة");
  });

  it('formats a ratio as "95.25%"', () => {
    expect(formatPercent(0.9525)).toBe("95.25%");
    expect(formatPercent(1)).toBe("100%");
  });

  it("dates keep Arabic month names but LATIN digits", () => {
    const d = formatDate("2026-07-03T10:30:00");
    expect(d).not.toBe("—");
    expect(ARABIC_DIGITS.test(d)).toBe(false);
    const dt = formatDateTime("2026-07-03T10:30:00");
    expect(ARABIC_DIGITS.test(dt)).toBe(false);
  });

  it("HARD GUARD: no formatter ever emits Arabic-Indic digits", () => {
    const samples = [0, 1, 9.99, 1234.56, 1000000, -42.5, 0.001];
    for (const v of samples) {
      expect(ARABIC_DIGITS.test(formatCurrency(v)), `currency(${v})`).toBe(false);
      expect(ARABIC_DIGITS.test(formatNumber(v)), `number(${v})`).toBe(false);
      expect(ARABIC_DIGITS.test(formatQty(v, "كجم")), `qty(${v})`).toBe(false);
      expect(ARABIC_DIGITS.test(formatPercent(v)), `percent(${v})`).toBe(false);
    }
  });
});
