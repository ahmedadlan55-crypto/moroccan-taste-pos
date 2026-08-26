import { describe, expect, it } from "vitest";
import {
  PURCHASING_REPORTS,
  PURCHASING_REPORT_GROUPS,
  PURCHASING_REPORT_IDS,
  purchasingReportPath,
} from "../registry";
import { PURCHASING_INTELLIGENCE_REPORTS } from "@/modules/reports/warehouse/reportCatalog";
import { warehouseIntelligence as ar } from "@/i18n/dictionaries/ar/warehouseIntelligence";
import { warehouseIntelligence as en } from "@/i18n/dictionaries/en/warehouseIntelligence";

function leaf(dictionary: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (node, key) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined),
    dictionary,
  );
}

/** `warehouseIntelligence.x.y` → `x.y`, the path INSIDE the namespace object. */
function inNamespace(keyPath: string): string {
  return keyPath.replace(/^warehouseIntelligence\./, "");
}

describe("purchasing report registry", () => {
  it("declares every backend report exactly once, with real columns", () => {
    expect(Object.keys(PURCHASING_REPORTS).sort()).toEqual([...PURCHASING_REPORT_IDS].sort());
    for (const id of PURCHASING_REPORT_IDS) {
      const report = PURCHASING_REPORTS[id];
      expect(report.id).toBe(id);
      expect(report.columns.length).toBeGreaterThan(0);
      expect(new Set(report.columns.map((column) => column.key)).size).toBe(report.columns.length);
      expect(report.capsAny.length).toBeGreaterThan(0);
      expect(report.rowIdKeys.length).toBeGreaterThan(0);
    }
  });

  it("groups every report once, and only into declared groups", () => {
    const grouped = PURCHASING_REPORT_GROUPS.flatMap((group) => group.reports);
    expect(grouped.slice().sort()).toEqual([...PURCHASING_REPORT_IDS].sort());
    expect(PURCHASING_REPORT_GROUPS.map((group) => group.id)).toEqual([
      "orders", "receiving", "payables", "tax", "dataQuality",
    ]);
  });

  it("keeps the shapes that differ from the others declared, not special-cased", () => {
    // routes/procurement/reports.js: ap-aging answers with `grandTotal` and
    // filters on asOfDate; data-quality answers with an object of checks;
    // supplier-statement 422s without a supplierId.
    const aging = PURCHASING_REPORTS["ap-aging"];
    expect(aging.filters).toContain("asOfDate");
    expect(aging.filters).not.toContain("period");
    expect(aging.totals?.every((field) => field.from === "grandTotal")).toBe(true);
    expect(PURCHASING_REPORTS["data-quality"].shape).toBe("checks");
    expect(PURCHASING_REPORTS["data-quality"].capsAny).toEqual([
      "finance.reports.view", "procurement.data_quality",
    ]);
    expect(PURCHASING_REPORTS["supplier-statement"].requiresSupplier).toBe(true);
    expect(PURCHASING_REPORTS["supplier-statement"].filters).toContain("supplier");
    // Reports whose endpoint returns no totals must not advertise any.
    for (const id of ["receiving-variance", "three-way-match", "price-variance", "tax", "data-quality"] as const) {
      expect(PURCHASING_REPORTS[id].totals).toBeNull();
    }
  });

  it("routes every row to its own page — never an anchor, never a duplicate", () => {
    const destinations = PURCHASING_INTELLIGENCE_REPORTS.map((report) => report.to);
    expect(new Set(destinations).size).toBe(destinations.length);
    for (const destination of destinations) {
      expect(destination).toMatch(/^\/reports\/purchasing\/[a-z-]+$/);
      expect(destination).not.toContain("#");
      expect(destination).not.toContain("?");
    }
    // The governance catalog and this registry must name the same nine reports.
    const catalogIds = destinations.map((destination) => destination.split("/").pop());
    expect(catalogIds.slice().sort()).toEqual([...PURCHASING_REPORT_IDS].sort());
  });

  it("resolves every declared label in both dictionaries", () => {
    const paths = new Set<string>();
    for (const id of PURCHASING_REPORT_IDS) {
      const report = PURCHASING_REPORTS[id];
      paths.add(report.labelKey);
      paths.add(report.descriptionKey);
      for (const column of report.columns) paths.add(column.labelKey);
      for (const field of report.totals ?? []) paths.add(field.labelKey);
    }
    for (const group of PURCHASING_REPORT_GROUPS) paths.add(group.titleKey);
    for (const path of paths) {
      for (const dictionary of [ar, en]) {
        expect(typeof leaf(dictionary, inNamespace(path))).toBe("string");
      }
    }
  });

  it("builds the report path from the id", () => {
    expect(purchasingReportPath("supplier-statement")).toBe("/reports/purchasing/supplier-statement");
  });
});
