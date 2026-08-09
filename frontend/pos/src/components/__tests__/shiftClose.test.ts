/**
 * Shift close (close/b2-pos-daily) — the pure logic behind the dialog:
 *   • denomTotal — the SAMA denomination grid math (halala-accurate),
 *   • buildShiftWhatsAppText — the wa.me Z-summary,
 *   • buildShiftReportHtml — X vs Z thermal report content.
 */
import { describe, expect, it } from "vitest";
import { CASH_DENOMS, buildShiftWhatsAppText, closeGate, denomTotal } from "../dialogs/ShiftDialog";
import { buildShiftReportHtml, type ShiftReportData } from "@/lib/receipt";
import type { CloseV3Result } from "@/lib/types";

describe("closeGate — blind-count reveal + variance gates (legacy :5530/:5767)", () => {
  it("locked until the reveal, whatever else is true", () => {
    expect(closeGate(false, true, 0, "").locked).toBe(true);
    expect(closeGate(false, true, 0, "").reason).toMatch(/أنهيت العدّ/);
  });

  it("revealed but nothing counted → still locked", () => {
    const g = closeGate(true, false, 0, "");
    expect(g.locked).toBe(true);
    expect(g.reason).toMatch(/أدخل المبالغ/);
  });

  it("non-zero variance demands a ≥10-char explanation", () => {
    expect(closeGate(true, true, -4.5, "").locked).toBe(true);
    expect(closeGate(true, true, -4.5, "قصير").locked).toBe(true);
    expect(closeGate(true, true, -4.5, "         ").locked).toBe(true); // spaces don't count
    expect(closeGate(true, true, -4.5, "عجز بسبب استرجاع نقدي مسائي").locked).toBe(false);
  });

  it("zero variance + revealed + counted → unlocked with no note", () => {
    expect(closeGate(true, true, 0, "")).toEqual({ locked: false });
  });
});

describe("denomTotal — physical cash count", () => {
  it("mirrors the legacy _v3CashDenoms set (app.js:5537) exactly", () => {
    expect([...CASH_DENOMS]).toEqual([500, 200, 100, 50, 20, 10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05]);
  });

  it("sums notes and coins to the halala", () => {
    // 2×500 + 3×0.25 = 1000.75
    expect(denomTotal({ "500": 2, "0.25": 3 })).toBe(1000.75);
    // 1×200 + 4×20 + 10×0.05 = 280.50
    expect(denomTotal({ "200": "1", "20": "4", "0.05": "10" })).toBe(280.5);
  });

  it("float sums stay exact (no 0.1+0.2 drift)", () => {
    // 3×0.1 would be 0.30000000000000004 without rounding
    expect(denomTotal({ "0.1": 3 })).toBe(0.3);
    expect(denomTotal({ "0.05": 3, "0.25": 1 })).toBe(0.4);
  });

  it("ignores blanks, garbage and negatives; truncates fractional counts", () => {
    expect(denomTotal({})).toBe(0);
    expect(denomTotal({ "500": "" })).toBe(0);
    expect(denomTotal({ "500": "abc", "100": -5 })).toBe(0);
    expect(denomTotal({ "50": 2.9 })).toBe(100); // a count is whole notes
    expect(denomTotal({ "999": 4 })).toBe(0); // not a real denomination
  });
});

describe("buildShiftWhatsAppText — Z share", () => {
  const res: CloseV3Result = {
    success: true,
    shiftId: "SH-1752000000000",
    expectedTotal: 1000,
    actualTotal: 995.5,
    variance: -4.5,
    orderCount: 12,
    breakdown: [
      { id: 1, name: "Cash", nameAr: "كاش", groupType: "cash", expected: 600, actual: 595.5, variance: -4.5 },
      { id: 2, name: "Mada", nameAr: "مدى", groupType: "electronic", expected: 400, actual: 400, variance: 0 },
    ],
  };

  it("carries the Z totals + per-method lines with English digits", () => {
    const text = buildShiftWhatsAppText(res, "pos_cash1");
    expect(text).toContain("SH-1752000000000");
    expect(text).toContain("pos_cash1");
    expect(text).toContain("عدد الفواتير: 12");
    expect(text).toContain("المتوقع: 1,000.00");
    expect(text).toContain("المعدود: 995.50");
    expect(text).toContain("الفرق: -4.50");
    expect(text).toContain("• كاش: 595.50 (متوقع 600.00)");
    expect(text).toContain("• مدى: 400.00 (متوقع 400.00)");
    expect(/[٠-٩]/.test(text)).toBe(false);
  });
});

describe("buildShiftReportHtml — X vs Z", () => {
  const rep: ShiftReportData = {
    shiftId: "SH-1752000000000",
    cashier: { username: "pos_cash1", name: "أحمد الكاشير" },
    company: { name: "المذاق المغربي" },
    branch: { name: "فرع العليا" },
    times: { start: "2026-07-17T08:00:00", end: "2026-07-17T16:00:00" },
    financials: { openingFloat: 200, expectedTotal: 1000, actualTotal: 995.5, variance: -4.5, unmatched: 0 },
    methods: [
      { name: "Cash", nameAr: "كاش", expected: 600, actual: 595.5, variance: -4.5 },
      { name: "Mada", nameAr: "مدى", expected: 400, actual: 400, variance: 0 },
    ],
    soldItems: [{ name: "شاي أتاي", qty: 4, price: 23, total: 92 }],
    denominations: [
      { value: 500, kind: "note", count: 1 },
      { value: 0.25, kind: "coin", count: 2 },
      { value: 100, kind: "note", count: 0 },
    ],
    orderCount: 12,
    itemsCount: 4,
    notes: "فرق بسيط في الكاش",
  };

  it("Z: counted vs expected, variance, opening float, denominations, cashier", () => {
    const html = buildShiftReportHtml(rep, { mode: "Z" });
    expect(html).toContain("تقرير إغلاق وردية · Z");
    expect(html).toContain("أحمد الكاشير");
    expect(html).toContain("SH-1752000000000");
    expect(html).toContain("الإجمالي المتوقع");
    expect(html).toContain("الإجمالي المعدود");
    expect(html).toContain("995.50");
    expect(html).toContain("-4.50"); // variance
    expect(html).toContain("200.00"); // opening float
    expect(html).toContain("كاش");
    expect(html).toContain("595.50");
    // denominations: only counted rows print; 25 halala face renders as هللة
    expect(html).toContain("500.00 ر.س");
    expect(html).toContain("25 هللة");
    expect(html).not.toContain("100.00 ر.س</td><td class=\"l num\">× 0");
    // sold items + notes reach paper
    expect(html).toContain("شاي أتاي");
    expect(html).toContain("فرق بسيط في الكاش");
  });

  it("X: expected-only snapshot — no counted/variance, no denominations, open-shift footer", () => {
    const html = buildShiftReportHtml(rep, { mode: "X" });
    expect(html).toContain("تقرير منتصف وردية · X");
    expect(html).not.toContain("الإجمالي المعدود");
    expect(html).not.toContain("معدود</th>");
    expect(html).not.toContain("هللة");
    expect(html).toContain("الوردية ما زالت مفتوحة");
  });

  it("follows the owner paper width", () => {
    expect(buildShiftReportHtml(rep, { mode: "Z", paperWidth: "58" })).toContain("width: 48mm");
    expect(buildShiftReportHtml(rep, { mode: "Z" })).toContain("width: 72mm");
  });

  it("prints an operational hierarchy with KPI, reconciliation and indivisible sections", () => {
    const html = buildShiftReportHtml(rep, { mode: "Z" });
    expect(html).toContain('class="report-head"');
    expect(html).toContain('class="report-kpis"');
    expect(html).toContain('class="report-totals"');
    expect(html).toContain(".report-section { margin-top: 8px; break-inside: avoid;");
    expect(html.match(/class="report-kpi"/g)).toHaveLength(3);
  });
});
