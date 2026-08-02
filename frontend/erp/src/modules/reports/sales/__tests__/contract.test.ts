// lib/contract.ts is a MIRROR of the server analytics registry. This file is
// the proof that it still is one.
//
// The server modules are loaded FOR REAL — node:module createRequire pulls
// lib/analytics/registry/*.js and lib/analytics/planner.js off disk and calls
// them — and every table in the mirror is compared for EXACT set equality in
// both directions. A metric added on the server, a fact that gains a date
// basis, a dimension that loses one: each fails here, at the point where the
// mirror is wrong, instead of reaching a user as ANALYTICS_UNSUPPORTED_COMBINATION.
//
// Two directions matter equally. Missing an entry hides a legal option; keeping
// a stale one OFFERS an option the planner refuses — which is the 422 the whole
// registry exists to make unreachable.
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import {
  DIMENSION_CAPS,
  DIMENSION_FACTS,
  FACT_DATE_BASES,
  FACT_IDS,
  GROUPABLE_DIMENSIONS,
  LIMITS,
  METRIC_CAPS,
  METRIC_FACTS,
  PLANNER_DATE_BASES,
  VOID_LIFTING_METRICS,
} from "../lib/contract";

const req = createRequire(import.meta.url);
/** frontend/erp/src/modules/reports/sales/__tests__ → the repo root. */
const ROOT = path.resolve(__dirname, "../../../../../../..");
const serverPath = (p: string) => path.join(ROOT, p);

const FACTS = req(serverPath("lib/analytics/registry/facts.js")).FACTS;
const METRICS = req(serverPath("lib/analytics/registry/metrics.js"));
const DIMS = req(serverPath("lib/analytics/registry/dimensions.js"));
const GROUPING = req(serverPath("lib/analytics/registry/grouping.js"));
const PLANNER = req(serverPath("lib/analytics/planner.js"));

const sorted = (a: readonly string[]) => [...a].sort();

describe("the server modules really are what is being compared", () => {
  it("loaded the planner and the three registries off disk", () => {
    expect(typeof PLANNER.plan).toBe("function");
    expect(Array.isArray(METRICS.METRICS)).toBe(true);
    expect(Array.isArray(DIMS.DIMENSIONS)).toBe(true);
    expect(Object.keys(FACTS).length).toBeGreaterThan(0);
  });
});

describe("facts", () => {
  it("mirrors the fact ids", () => {
    expect(sorted(FACT_IDS)).toEqual(sorted(Object.keys(FACTS)));
  });

  it("mirrors each fact's date bases, intersected with the planner allow-list", () => {
    for (const id of Object.keys(FACTS)) {
      const expected = PLANNER.DATE_BASES.filter((b: string) => !!FACTS[id].dateBases[b]);
      expect(sorted(FACT_DATE_BASES[id as keyof typeof FACT_DATE_BASES]), `fact ${id}`).toEqual(sorted(expected));
    }
  });

  it("mirrors the planner's date-basis allow-list", () => {
    expect(sorted(PLANNER_DATE_BASES)).toEqual(sorted(PLANNER.DATE_BASES));
  });
});

describe("metrics", () => {
  it("covers EXACTLY the server metric ids", () => {
    expect(sorted(Object.keys(METRIC_FACTS))).toEqual(
      sorted(METRICS.METRICS.map((m: { id: string }) => m.id)),
    );
  });

  it("mirrors each metric's fact set — the server's own metricFacts()", () => {
    for (const m of METRICS.METRICS) {
      expect(sorted(METRIC_FACTS[m.id] ?? []), `metric ${m.id}`).toEqual(
        sorted(GROUPING.metricFacts(m.id)),
      );
    }
  });

  it("mirrors the capability gates", () => {
    const expected: Record<string, string> = {};
    for (const m of METRICS.METRICS) if (m.requiresCap) expected[m.id] = m.requiresCap;
    expect(METRIC_CAPS).toEqual(expected);
  });

  it("mirrors which metrics lift the void exclusion for their whole statement", () => {
    const expected = METRICS.METRICS.filter((m: { id: string }) =>
      GROUPING.liftsVoidExclusion(m.id),
    ).map((m: { id: string }) => m.id);
    expect(sorted(VOID_LIFTING_METRICS)).toEqual(sorted(expected));
  });
});

describe("dimensions", () => {
  it("covers EXACTLY the server dimension ids", () => {
    expect(sorted(Object.keys(DIMENSION_FACTS))).toEqual(
      sorted(DIMS.DIMENSIONS.map((d: { id: string }) => d.id)),
    );
  });

  it("mirrors each dimension's fact set — including the derived-js path", () => {
    for (const d of DIMS.DIMENSIONS) {
      expect(sorted(DIMENSION_FACTS[d.id] ?? []), `dimension ${d.id}`).toEqual(
        sorted(GROUPING.dimensionFacts(d.id)),
      );
    }
  });

  it("mirrors the groupable set", () => {
    const expected = DIMS.DIMENSIONS.filter((d: { groupable: boolean }) => d.groupable).map(
      (d: { id: string }) => d.id,
    );
    expect(sorted(GROUPABLE_DIMENSIONS)).toEqual(sorted(expected));
  });

  it("mirrors the capability gates", () => {
    const expected: Record<string, string> = {};
    for (const d of DIMS.DIMENSIONS) if (d.requiresCap) expected[d.id] = d.requiresCap;
    expect(DIMENSION_CAPS).toEqual(expected);
  });
});

describe("planner limits", () => {
  it("mirrors the caps a report must stay inside", () => {
    expect(LIMITS.MAX_METRICS).toBe(PLANNER.MAX_METRICS);
    expect(LIMITS.MAX_DIMENSIONS).toBe(PLANNER.MAX_DIMENSIONS);
    expect(LIMITS.MAX_LIMIT).toBe(PLANNER.MAX_LIMIT);
    expect(LIMITS.MAX_RANGE_DAYS).toBe(PLANNER.MAX_RANGE_DAYS);
  });
});

/*
 * The mirror is DATA. This last block proves the derived PREDICATE agrees with
 * the planner too — for every metric × dimension pair in the registry, by
 * actually planning it. Without this, the tables could be perfect and the
 * `every(fact => …)` rule above them still wrong.
 */
describe("the derived rule agrees with the planner on every metric × dimension pair", () => {
  const SCOPE = { all: true, branchIds: [], caps: new Set<string>() };
  const OPTS = {
    mealPeriods: [{ period_key: "lunch", start_time: "11:00", end_time: "16:00", sort: 1 }],
    rollupClosedThrough: null,
  };

  it("predicts ANALYTICS_UNSUPPORTED_COMBINATION exactly", async () => {
    const { dimensionUsableOn, factsForMetrics } = await import("../lib/contract");
    // Every capability, so a 403 never masquerades as a legal/illegal answer.
    const caps = new Set<string>([
      "analytics.cost.view",
      "analytics.employees.view",
      "analytics.customers.view",
    ]);
    const scope = { ...SCOPE, caps };
    let checked = 0;
    const disagreements: string[] = [];

    for (const m of METRICS.METRICS) {
      if (m.takesMetricParam) continue; // `growth` — never requestable directly
      for (const d of DIMS.DIMENSIONS) {
        if (!d.groupable) continue;
        checked += 1;
        const predicted = dimensionUsableOn(d.id, factsForMetrics([m.id]));
        let actual = true;
        try {
          PLANNER.plan(
            {
              metrics: [m.id],
              dimensions: [d.id],
              range: { from: "2026-07-01", to: "2026-07-31" },
            },
            scope,
            OPTS,
          );
        } catch (e) {
          actual = false;
          const code = (e as { code?: string }).code;
          if (code !== "ANALYTICS_UNSUPPORTED_COMBINATION") {
            disagreements.push(`${m.id} × ${d.id}: unexpected ${code}`);
          }
        }
        if (predicted !== actual) disagreements.push(`${m.id} × ${d.id}: predicted ${predicted}, server ${actual}`);
      }
    }

    expect(disagreements).toEqual([]);
    // A guard against a loop that silently stopped iterating.
    expect(checked).toBeGreaterThan(1500);
  });
});
