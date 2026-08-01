// THE 422-FREEDOM PROOF.
//
// "No combination reachable through the UI may return 422" is a claim about the
// SERVER, so it is tested against the server: lib/analytics/planner.js is loaded
// off disk with node:module createRequire and asked to plan every request the
// hub can build. A plan() that throws is the 422 a user would have seen.
//
// THE CROSS PRODUCT
//   every report × every query it issues
//     × every filter it exposes (each alone, none, and ALL AT ONCE)
//     × every tax mode it offers
//     × every date basis it offers
//     × with and without its optional capability
//   … through the REAL request builders (queryBodyToWireRequest for the screen,
//   buildExportRequest for the file) — never a hand-written body, because a
//   hand-written body proves the test author's idea of the request, not the
//   product's.
//
// Plus the two dynamic reports (Explorer / Builder), where the metric set is
// chosen at runtime: every registry metric × every filter, so the per-request
// drop rule in api.ts is proven to protect a selection the registry never saw.
//
// WHY THE FILTERS ARE APPLIED, NOT JUST DECLARED
//   A test that only planned the metrics would pass while every filter silently
//   422'd. Each case sets a real value on the filter key and asserts the built
//   request actually CARRIES it — an over-eager drop rule that answered "no
//   422" by sending no filters at all would fail here.
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import {
  buildExportRequest,
  buildFiltersBody,
  queryBodyToWireRequest,
  registryExportSpec,
  reportQuerySpec,
  type AnalyticsQueryBody,
} from "../lib/api";
import { createAnalyticsFilterCodec, type AnalyticsFilters } from "../lib/filters";
import {
  CENTERS,
  FILTER_DIMENSION,
  LEGACY_SEGMENT_ROUTES,
  REPORTS,
  REPORT_BY_ID,
  reportDateBases,
  reportFilterKeys,
  reportTaxModes,
  resolveDimensions,
  unsupportedFilterKeys,
  type FilterKey,
  type ReportSpec,
} from "../lib/reportRegistry";
import { LIMITS, METRIC_FACTS } from "../lib/contract";

const req = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "../../../../../../..");
const PLANNER = req(path.join(ROOT, "lib/analytics/planner.js"));

/** Every capability, so a 403 can never be mistaken for an expressibility fail. */
const CAPS = new Set<string>([
  "analytics.cost.view",
  "analytics.employees.view",
  "analytics.customers.view",
]);
const SCOPE = { all: true, branchIds: [] as string[], caps: CAPS };
const PLAN_OPTS = {
  mealPeriods: [{ period_key: "lunch", start_time: "11:00", end_time: "16:00", sort: 1 }],
  rollupClosedThrough: "2026-08-31",
};

const CODEC = createAnalyticsFilterCodec("2026-07-29");
const BASE_FILTERS: AnalyticsFilters = CODEC.parse(
  new URLSearchParams("preset=custom&from=2026-07-01&to=2026-07-31"),
);

/** A concrete, non-default value for each filter key (what a real URL carries). */
const FILTER_VALUE: Record<FilterKey, Partial<AnalyticsFilters>> = {
  brandId: { brandId: ["BR-1"] },
  branchId: { branchId: ["B-1"] },
  channel: { channel: ["CH-1"] },
  orderType: { orderType: ["dine_in"] },
  paymentMethod: { paymentMethod: ["cash"] },
  hour: { hour: "13" },
  menuItemId: { menuItemId: ["M-1"] },
  categoryId: { categoryId: ["C-1"] },
  cashierId: { cashierId: ["c1"] },
};

function filtersWith(keys: readonly FilterKey[], over: Partial<AnalyticsFilters>): AnalyticsFilters {
  let out: AnalyticsFilters = { ...BASE_FILTERS, ...over };
  for (const k of keys) out = { ...out, ...FILTER_VALUE[k] };
  return out;
}

/** plan() the request; returns the error code (or null when it planned). */
function planCode(request: unknown): string | null {
  try {
    PLANNER.plan(request, SCOPE, PLAN_OPTS);
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
}

/** Filter-key sets exercised per report: none, each alone, and all together. */
function filterCases(report: ReportSpec): Array<{ label: string; keys: FilterKey[] }> {
  const keys = reportFilterKeys(report);
  return [
    { label: "no filters", keys: [] },
    ...keys.map((k) => ({ label: k, keys: [k] })),
    ...(keys.length > 1 ? [{ label: "all filters at once", keys }] : []),
  ];
}

const ANALYTICS_REPORTS = REPORTS.filter((r) => r.engine === "analytics" && !r.dynamic);

/* ── 1) the declarations themselves ───────────────────────────────────────── */

describe("the registry declares only what the planner accepts", () => {
  it.each(ANALYTICS_REPORTS.map((r) => [r.id, r] as const))(
    "%s stays inside the planner's hard caps",
    (_id, report) => {
      for (const q of report.queries) {
        const all = [...q.metrics, ...(q.capMetrics ?? [])];
        expect(all.length, `${report.id}/${q.id} metrics`).toBeLessThanOrEqual(LIMITS.MAX_METRICS);
        expect(q.dimensions.length, `${report.id}/${q.id} dimensions`).toBeLessThanOrEqual(
          LIMITS.MAX_DIMENSIONS,
        );
        for (const m of all) expect(METRIC_FACTS[m], `unknown metric ${m}`).toBeDefined();
        // `growth` is parameterized — the planner refuses it outright.
        expect(all, `${report.id}/${q.id}`).not.toContain("growth");
      }
    },
  );

  it("every report offers at least the branch filter and a real date basis", () => {
    for (const report of REPORTS) {
      expect(reportFilterKeys(report), report.id).toContain("branchId");
      expect(reportDateBases(report).length, report.id).toBeGreaterThan(0);
      expect(reportTaxModes(report).length, report.id).toBeGreaterThan(0);
    }
  });

  it("every center's views exist, and every report belongs to exactly one center", () => {
    const seen = new Set<string>();
    for (const center of CENTERS) {
      expect(center.views.length, center.id).toBeGreaterThan(0);
      for (const v of center.views) {
        expect(REPORT_BY_ID[v], `view ${v}`).toBeDefined();
        expect(REPORT_BY_ID[v].center).toBe(center.id);
        expect(seen.has(v), `${v} listed twice`).toBe(false);
        seen.add(v);
      }
    }
    expect([...seen].sort()).toEqual(REPORTS.map((r) => r.id).sort());
  });

  it("every retired segment resolves to a real center and view", () => {
    for (const [segment, target] of Object.entries(LEGACY_SEGMENT_ROUTES)) {
      expect(REPORT_BY_ID[target.view], `${segment} → ${target.view}`).toBeDefined();
      expect(REPORT_BY_ID[target.view].center).toBe(target.center);
    }
  });
});

/* ── 2) THE CROSS PRODUCT — the screen path ───────────────────────────────── */

describe("every request the hub can build plans without a 422", () => {
  /** Counted so a loop that quietly stopped iterating cannot pass. */
  const stats = { screen: 0, exportJobs: 0, dynamic: 0 };
  const failures: string[] = [];

  it("report × query × filter × tax mode × date basis × capability", () => {
    for (const report of ANALYTICS_REPORTS) {
      const bases = reportDateBases(report).filter(
        (b) => b === "business_day" || b === "calendar_day",
      );
      for (const businessDay of bases.map((b) => b === "business_day")) {
        for (const taxIncl of reportTaxModes(report).map((m) => m === "incl")) {
          for (const withCap of report.optionalCap ? [false, true] : [false]) {
            for (const kase of filterCases(report)) {
              const filters = filtersWith(kase.keys, { businessDay, taxIncl });
              for (const q of report.queries) {
                const spec = reportQuerySpec(report.id, q.id, filters, { hasOptionalCap: withCap });
                const body: AnalyticsQueryBody = {
                  ...spec,
                  ...buildFiltersBody(filters),
                };
                const wire = queryBodyToWireRequest(body);
                const where = `${report.id}/${q.id} [${kase.label}] basis=${businessDay ? "business_day" : "calendar_day"} tax=${taxIncl ? "incl" : "excl"} cap=${withCap}`;
                const code = planCode(wire);
                if (code) failures.push(`${where}: ${code}`);

                // The filters that SURVIVED must be exactly the ones this
                // report claims to expose (an over-eager drop would silently
                // widen the population back to the whole company).
                const carried = new Set((wire.filters ?? []).map((f) => f.dimension));
                for (const key of kase.keys) {
                  if (!carried.has(FILTER_DIMENSION[key])) {
                    failures.push(`${where}: filter ${key} was dropped although the report exposes it`);
                  }
                }
                // The grouping really is the registry's, with `day` resolved.
                expect(wire.dimensions, where).toEqual(
                  resolveDimensions(q.dimensions, businessDay ? "business_day" : "calendar_day"),
                );
                stats.screen += 1;
              }
            }
          }
        }
      }
    }

    expect(failures).toEqual([]);
    expect(stats.screen).toBeGreaterThan(500);
  });

  it("the EXPORT request plans too, on the same cross product", () => {
    const exportFailures: string[] = [];
    for (const report of ANALYTICS_REPORTS) {
      if (!report.exportQuery) continue;
      for (const businessDay of [true, false]) {
        for (const taxIncl of reportTaxModes(report).map((m) => m === "incl")) {
          for (const kase of filterCases(report)) {
            const filters = filtersWith(kase.keys, { businessDay, taxIncl });
            const request = buildExportRequest(report.id, filters);
            const where = `${report.id} export [${kase.label}] basis=${businessDay} tax=${taxIncl}`;
            const code = planCode(request);
            if (code) exportFailures.push(`${where}: ${code}`);
            stats.exportJobs += 1;
          }
        }
      }
    }
    expect(exportFailures).toEqual([]);
    expect(stats.exportJobs).toBeGreaterThan(80);
  });

  it("a dynamic report cannot 422 either: every metric × every filter", () => {
    const dynFailures: string[] = [];
    const metricIds = Object.keys(METRIC_FACTS).filter((id) => id !== "growth");
    const allKeys = Object.keys(FILTER_DIMENSION) as FilterKey[];
    for (const metric of metricIds) {
      for (const key of allKeys) {
        const filters = filtersWith([key], {});
        const body: AnalyticsQueryBody = {
          metrics: [metric],
          dimensions: [],
          ...buildFiltersBody(filters),
        };
        const code = planCode(queryBodyToWireRequest(body));
        if (code) dynFailures.push(`explorer ${metric} + ${key}: ${code}`);
        stats.dynamic += 1;
      }
    }
    expect(dynFailures).toEqual([]);
    expect(stats.dynamic).toBeGreaterThan(400);
  });
});

/* ── 3) the tax toggle stays a CLIENT-side swap ───────────────────────────── */

describe("the tax basis never reaches the server as a field", () => {
  it("no built request carries a taxMode key (the planner ignores unknown keys)", () => {
    for (const report of ANALYTICS_REPORTS) {
      const filters = filtersWith([], { taxIncl: true });
      if (report.exportQuery) {
        expect(buildExportRequest(report.id, filters)).not.toHaveProperty("taxMode");
      }
      for (const q of report.queries) {
        const wire = queryBodyToWireRequest({
          ...reportQuerySpec(report.id, q.id, filters),
          ...buildFiltersBody(filters),
        });
        expect(wire, `${report.id}/${q.id}`).not.toHaveProperty("taxMode");
      }
    }
  });

  it("a report that offers the incl basis really swaps the metric on BOTH paths", () => {
    // Executive is the canonical net_ex_vat report.
    const inclFilters = filtersWith([], { taxIncl: true });
    const exclFilters = filtersWith([], { taxIncl: false });
    const wireOf = (f: AnalyticsFilters) =>
      queryBodyToWireRequest({ ...reportQuerySpec("executive", "daily", f), ...buildFiltersBody(f) });
    expect(wireOf(inclFilters).metrics).toContain("net_incl_vat");
    expect(wireOf(exclFilters).metrics).toContain("net_ex_vat");
    expect(buildExportRequest("executive", inclFilters).metrics).toContain("net_incl_vat");
  });

  it("a report with no net_ex_vat offers only the ex basis — the toggle would move nothing", () => {
    expect(reportTaxModes(REPORT_BY_ID.shifts)).toEqual(["excl"]);
    expect(reportTaxModes(REPORT_BY_ID.voids)).toEqual(["excl"]);
  });
});

/* ── 4) the auto-drop ─────────────────────────────────────────────────────── */

describe("switching reports drops the filters the new one cannot honour", () => {
  it("names exactly the unsupported keys, and never a supported one", () => {
    const everyKey = Object.keys(FILTER_DIMENSION) as FilterKey[];
    for (const report of REPORTS) {
      const supported = new Set(reportFilterKeys(report));
      const dropped = new Set(unsupportedFilterKeys(report, everyKey));
      for (const key of everyKey) {
        expect(dropped.has(key), `${report.id}/${key}`).toBe(!supported.has(key));
      }
    }
  });

  it("drops nothing when the incoming set is already legal", () => {
    for (const report of REPORTS) {
      expect(unsupportedFilterKeys(report, reportFilterKeys(report)), report.id).toEqual([]);
    }
  });

  it("removes a capability-gated filter from a viewer who lacks the capability", () => {
    const none = () => false;
    // `cashier` is gated on analytics.employees.view; the planner answers 403,
    // not 422, so a bookmarked ?cashierId= would break the report outright.
    expect(reportFilterKeys(REPORT_BY_ID.branches)).toContain("cashierId");
    expect(reportFilterKeys(REPORT_BY_ID.branches, none)).not.toContain("cashierId");
    expect(unsupportedFilterKeys(REPORT_BY_ID.branches, ["cashierId"], none)).toEqual(["cashierId"]);
  });

  it("the merged items report keeps the item filter and drops the payment one", () => {
    const keys = reportFilterKeys(REPORT_BY_ID.items);
    expect(keys).toContain("menuItemId");
    expect(keys).toContain("branchId");
    expect(keys).not.toContain("paymentMethod");
  });
});

/* ── 5) rollup eligibility, proven not asserted ───────────────────────────── */

describe("rollup eligibility is what the planner actually decides", () => {
  it("every report's declaration matches the planner's meta.source", () => {
    const mismatches: string[] = [];
    for (const report of ANALYTICS_REPORTS) {
      if (!report.exportQuery) continue;
      const q = report.queries.find((x) => x.id === report.exportQuery);
      if (!q) continue;
      const filters = filtersWith([], { businessDay: true, taxIncl: false });
      const wire = queryBodyToWireRequest({
        ...reportQuerySpec(report.id, q.id, filters),
        ...buildFiltersBody(filters),
      });
      const plan = PLANNER.plan(wire, SCOPE, PLAN_OPTS);
      const usedRollup = plan.meta.source !== "live";
      if (usedRollup !== report.rollupEligible) {
        mismatches.push(
          `${report.id}: declared rollupEligible=${report.rollupEligible}, planner source=${plan.meta.source} (blockers: ${plan.meta.rollup.blockers.join(", ") || "none"})`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });
});

/* ── 6) the export spec comes from the registry ───────────────────────────── */

describe("export specs", () => {
  it("every report that declares an exportQuery yields one", () => {
    for (const report of ANALYTICS_REPORTS) {
      const spec = registryExportSpec(report.id, BASE_FILTERS);
      if (report.exportQuery) {
        expect(spec, report.id).toBeDefined();
        expect(spec!.metrics.length, report.id).toBeGreaterThan(0);
      } else {
        expect(spec, report.id).toBeUndefined();
      }
    }
  });

  it("the file's day column follows the screen's date basis", () => {
    const business = registryExportSpec("executive", { ...BASE_FILTERS, businessDay: true });
    const calendar = registryExportSpec("executive", { ...BASE_FILTERS, businessDay: false });
    expect(business!.dimensions).toContain("business_day");
    expect(calendar!.dimensions).toContain("calendar_day");
    expect(business!.sort?.[0].by).toBe("business_day");
    expect(calendar!.sort?.[0].by).toBe("calendar_day");
  });
});
