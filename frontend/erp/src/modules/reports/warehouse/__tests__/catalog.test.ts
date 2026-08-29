import { describe, expect, it } from "vitest";
import {
  INVENTORY_INTELLIGENCE_REPORTS,
  PURCHASING_INTELLIGENCE_REPORTS,
  REPORT_FAMILIES,
} from "../reportCatalog";
import { warehouseIntelligence as ar } from "@/i18n/dictionaries/ar/warehouseIntelligence";
import { warehouseIntelligence as en } from "@/i18n/dictionaries/en/warehouseIntelligence";

describe("warehouse report governance catalog", () => {
  it("classifies every published report with a family, basis and maturity", () => {
    const familyIds = new Set(REPORT_FAMILIES.map((family) => family.id));
    const reports = [...INVENTORY_INTELLIGENCE_REPORTS, ...PURCHASING_INTELLIGENCE_REPORTS];
    // 13 inventory + 9 purchasing. The purchasing list dropped three rows that
    // were not reports: `by-item` duplicated `purchase-detail`'s destination,
    // `by-supplier` pointed at a #supplier-analysis anchor that never existed,
    // and `purchase-detail` was an anchor into the workspace's purchase ledger.
    expect(reports.length).toBeGreaterThanOrEqual(22);
    expect(new Set(reports.map((report) => report.id)).size).toBe(reports.length);
    for (const report of reports) {
      expect(familyIds.has(report.family)).toBe(true);
      expect(report.basis).toBeTruthy();
      expect(["authoritative", "operational", "conditional"]).toContain(report.maturity);
      expect(report.to).toMatch(/^\/reports\//);
    }
  });

  it("does not publish an unbuilt report as a clickable link", () => {
    // ABC/XYZ, turnover and days-on-hand used to sit in a "readiness register"
    // — fifteen paragraphs explaining what the system could not measure. They
    // are now COMPUTED, on the performance dashboard, from the movement ledger.
    // What must never come back is a catalogue ENTRY that navigates to a page
    // that does not exist: a dead link is worse than an absent one.
    const published = [...INVENTORY_INTELLIGENCE_REPORTS, ...PURCHASING_INTELLIGENCE_REPORTS].map((report) => report.id);
    expect(published).not.toContain("asOfValuation");
    expect(published).not.toContain("abcXyzTurnoverDoh");
    expect(published).not.toContain("inventoryRollForward");
  });
  it("marks valuation and lot-based reports as coverage-dependent", () => {
    expect(INVENTORY_INTELLIGENCE_REPORTS.find((report) => report.id === "valuation")).toMatchObject({ maturity: "conditional", standard: "ias2" });
    expect(INVENTORY_INTELLIGENCE_REPORTS.find((report) => report.id === "expiry")).toMatchObject({ maturity: "conditional", basis: "lotLayer" });
    expect(PURCHASING_INTELLIGENCE_REPORTS.find((report) => report.id === "supplier-statement")).toMatchObject({ requiresSupplier: true, basis: "supplierLedger" });
    for (const id of ["purchase-analysis", "receiving-variance", "three-way-match", "price-variance", "tax", "ap-aging", "supplier-statement"]) {
      expect(PURCHASING_INTELLIGENCE_REPORTS.find((report) => report.id === id)?.maturity).toBe("conditional");
    }
  });

  it("does not label capped or incomplete procurement controls as authoritative", () => {
    const conditional = ["purchase-analysis", "receiving-variance", "three-way-match", "price-variance", "tax", "ap-aging", "supplier-statement"];
    for (const id of conditional) {
      expect(PURCHASING_INTELLIGENCE_REPORTS.find((report) => report.id === id)?.maturity).toBe("conditional");
    }
  });

  it("keeps the performance dashboard fully translated in both languages", () => {
    // The dashboard reads ~60 keys. A key present in Arabic and missing in
    // English renders the raw dotted path on screen — which looks like a bug
    // in the metric, not in the copy. Compare the SHAPES, so a key added to
    // one dictionary and forgotten in the other fails here.
    const shape = (value: unknown): unknown => (
      value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, shape(v)]))
        : typeof value
    );
    expect(shape(en.performance)).toEqual(shape(ar.performance));

    // Every ageing bucket the server can emit needs a label, including the one
    // that is NOT a duration: stock never consumed is its own state, and
    // folding it into "over 180 days" hides stock received yesterday.
    for (const bucket of ["0_30", "31_60", "61_90", "91_180", "over_180", "never"] as const) {
      expect(ar.performance.ageing[bucket]).toBeTruthy();
      expect(en.performance.ageing[bucket]).toBeTruthy();
    }
    for (const cls of ["X", "Y", "Z"] as const) {
      expect(ar.performance.xyz[cls]).toBeTruthy();
      expect(en.performance.xyz[cls]).toBeTruthy();
    }
  });

  it("no longer ships a register of metrics the system cannot produce", async () => {
    // The owner's objection, pinned: a control centre states numbers, not
    // paragraphs about missing data. If someone reintroduces the register,
    // this fails before it reaches a screen.
    const catalog = await import("../reportCatalog");
    expect(Object.keys(catalog)).not.toContain("REPORT_READINESS_REQUIREMENTS");
    expect(ar).not.toHaveProperty("readiness");
    expect(en).not.toHaveProperty("readiness");
  });
});
