import { describe, expect, it } from "vitest";
import {
  INVENTORY_INTELLIGENCE_REPORTS,
  PURCHASING_INTELLIGENCE_REPORTS,
  REPORT_FAMILIES,
  REPORT_READINESS_REQUIREMENTS,
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

  it("does not publish unsupported historical valuation, turnover or inventory roll-forward as report links", () => {
    const published = [...INVENTORY_INTELLIGENCE_REPORTS, ...PURCHASING_INTELLIGENCE_REPORTS].map((report) => report.id);
    expect(published).not.toContain("asOfValuation");
    expect(published).not.toContain("abcXyzTurnoverDoh");
    expect(published).not.toContain("inventoryRollForward");
    expect(REPORT_READINESS_REQUIREMENTS.map((item) => item.id)).toEqual(expect.arrayContaining([
      "asOfValuation", "abcXyzTurnoverDoh", "inventoryRollForward", "landedCost",
    ]));
    expect(REPORT_READINESS_REQUIREMENTS).toHaveLength(15);
    expect(new Set(REPORT_READINESS_REQUIREMENTS.map((item) => item.id)).size).toBe(15);
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

  it("keeps Arabic and English governance copy complete for every readiness requirement", () => {
    for (const requirement of REPORT_READINESS_REQUIREMENTS) {
      for (const dictionary of [ar, en]) {
        const item = dictionary.readiness.items[requirement.id];
        expect(item.label).toBeTruthy();
        expect(item.reason).toBeTruthy();
        expect(item.requirement).toBeTruthy();
      }
    }
  });
});
