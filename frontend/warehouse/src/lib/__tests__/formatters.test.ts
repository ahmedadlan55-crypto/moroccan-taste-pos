import { describe, it, expect } from "vitest";
import { formatCurrency, formatNumber, formatQty, formatPercent } from "../formatters";

describe("formatters", () => {
  it("formats currency without fractional riyals and is null-safe", () => {
    expect(formatCurrency(1000)).toContain("١٬٠٠٠");
    expect(formatCurrency(null)).toContain("٠");
    expect(formatCurrency(undefined)).toContain("٠");
  });

  it("formats numbers with up to one decimal", () => {
    expect(formatNumber(86.5)).toContain("٨٦٫٥");
    expect(formatNumber(0)).toBe("٠");
  });

  it("formats a quantity with an optional unit", () => {
    expect(formatQty(12, "كجم")).toContain("كجم");
    expect(formatQty(12)).not.toContain("كجم");
  });

  it("formats a ratio as a percent", () => {
    expect(formatPercent(0.986)).toContain("٪");
  });
});
