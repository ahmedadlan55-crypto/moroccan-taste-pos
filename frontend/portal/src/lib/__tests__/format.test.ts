// Formatting rules that are correctness, not taste.
import { describe, expect, it } from "vitest";
import { formatDate, formatHours, formatMoney, formatNumber, formatSigned, formatTime, toYmd } from "../format";

describe("digits stay Latin in both languages", () => {
  it("never emits Arabic-Indic digits", () => {
    // The product uses Latin digits everywhere; an ar-SA locale would print
    // ٣٤٥ and break every figure a payroll dispute would be argued over.
    const arabicIndic = /[٠-٩۰-۹]/;
    expect(arabicIndic.test(formatNumber(12345))).toBe(false);
    expect(arabicIndic.test(formatMoney(1234.5))).toBe(false);
    expect(arabicIndic.test(formatDate("2026-08-17"))).toBe(false);
  });

  it("renders a date as dd/mm/yyyy", () => {
    expect(formatDate("2026-08-17")).toBe("17/08/2026");
  });
});

describe("formatHours reads like a shift, not a decimal", () => {
  it("converts the fraction to minutes", () => {
    expect(formatHours(7.5)).toBe("7:30");
    expect(formatHours(0)).toBe("0:00");
    expect(formatHours(1.25)).toBe("1:15");
  });

  it("carries instead of printing :60", () => {
    // 7.999 h → 59.94 min, which rounds to 60. Without the carry this prints
    // "7:60", a time that does not exist.
    expect(formatHours(7.999)).toBe("8:00");
  });

  it("keeps the sign on a negative span", () => {
    expect(formatHours(-1.5)).toBe("−1:30");
  });

  it("returns a zero span, not a dash, for zero", () => {
    // A dash reads as "unknown"; the employee worked zero hours, which is known.
    expect(formatHours(0)).toBe("0:00");
  });
});

describe("formatSigned states direction explicitly", () => {
  it("prefixes + and a real minus sign", () => {
    expect(formatSigned(12.5)).toBe("+12.50");
    expect(formatSigned(-12.5)).toBe("−12.50"); // U+2212, not a hyphen
    expect(formatSigned(0)).toBe("0.00");
  });
});

describe("formatTime", () => {
  it("reads a bare HH:MM:SS without inventing a date", () => {
    // Constructing a Date from "07:12:00" would attach today in the browser's
    // zone and could shift the hour.
    expect(formatTime("07:12:00")).toBe("07:12");
  });

  it("returns a dash for an absent clock-out rather than a fabricated time", () => {
    expect(formatTime(null)).toBe("—");
    expect(formatTime(undefined)).toBe("—");
  });
});

describe("toYmd uses the device's calendar day", () => {
  it("does not shift the date through UTC", () => {
    // toISOString() on a local 00:30 in Riyadh (UTC+3) yields the PREVIOUS day.
    // An employee clocking in just after midnight must not be filed to yesterday.
    const justAfterMidnight = new Date(2026, 7, 17, 0, 30, 0);
    expect(toYmd(justAfterMidnight)).toBe("2026-08-17");
  });
});

describe("bad input degrades honestly", () => {
  it("shows a dash rather than NaN", () => {
    expect(formatNumber(Number.NaN)).toBe("—");
    expect(formatMoney(undefined)).toBe("—");
    expect(formatNumber(null)).toBe("—");
  });
});
