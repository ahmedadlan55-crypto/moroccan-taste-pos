/**
 * A void metric must never share a request with an order-population metric.
 *
 * THE TRAP, in the engine's own words — lib/analytics/planner.js:356:
 *
 *     const hasVoidMetric = factMetrics.some((m) => String(m.sql).includes("'voided'"));
 *     if (!hasStatusFilter && req.includeVoided !== true && !hasVoidMetric) {
 *       whereParts.push("(f.status IS NULL OR f.status <> 'voided')");
 *     }
 *
 * `factMetrics` is every metric on THAT fact statement. So asking for
 * `voids_count` in the same request as `orders` silently drops the
 * void-exclusion for `orders` too: the order count starts including voided
 * orders, and `avg_ticket` — a ratio of a line-fact numerator over that
 * order-fact denominator — becomes void-excluded ÷ void-included. Two
 * populations inside one number, with nothing on screen to say so.
 *
 * It is invisible in every rendering test, because a mocked query layer answers
 * whatever metric ids it is handed and never sees the planner. It is invisible
 * in review, because the grouping is driven by an unrelated constraint
 * (MAX_METRICS = 12 forces the split into groups at all). It was introduced
 * once by a regrouping that was otherwise correct, and caught only by an
 * adversarial reviewer reading the emitted SQL.
 *
 * WHY THIS FILE NO LONGER READS Executive.tsx AS TEXT
 *   The metric groups moved into lib/reportRegistry, which is where every
 *   report's requests are now declared. Reading the declaration is strictly
 *   stronger than scraping a source literal: it holds for EVERY report, not
 *   just the executive one, and it cannot be fooled by a page that computes its
 *   metric list instead of writing it out. The set of void-lifting metrics
 *   likewise comes from lib/contract (mirrored from the server and proven
 *   equal to it in contract.test.ts) rather than from a hardcoded pair.
 */
import { describe, expect, it } from "vitest";
import { LIMITS, METRIC_FACTS, VOID_LIFTING_METRICS } from "../lib/contract";
import { REPORTS, REPORT_BY_ID, type ReportSpec } from "../lib/reportRegistry";

/**
 * Metrics counted over the ORDER population. If the exclusion is lifted, every
 * one of these silently starts counting voided orders. Derived, not listed: any
 * non-void metric whose facts include `order` shares the contaminated
 * statement — which is exactly the planner's own condition.
 */
function orderPopulationMetrics(metrics: readonly string[]): string[] {
  return metrics.filter(
    (m) => !VOID_LIFTING_METRICS.includes(m) && (METRIC_FACTS[m] ?? []).includes("order"),
  );
}

const ANALYTICS_REPORTS = REPORTS.filter((r) => r.engine === "analytics" && !r.dynamic);

describe("every declared request stays inside the planner's ceiling", () => {
  it.each(ANALYTICS_REPORTS.map((r) => [r.id, r] as const))("%s", (_id, report: ReportSpec) => {
    for (const q of report.queries) {
      const all = [...q.metrics, ...(q.capMetrics ?? [])];
      expect(all.length, `${report.id}/${q.id} exceeds MAX_METRICS`).toBeLessThanOrEqual(
        LIMITS.MAX_METRICS,
      );
    }
  });
});

describe("no request mixes a void metric with the order population", () => {
  it("across EVERY report, not just the executive statement", () => {
    const violations: string[] = [];
    for (const report of ANALYTICS_REPORTS) {
      for (const q of report.queries) {
        const all = [...q.metrics, ...(q.capMetrics ?? [])];
        const voids = all.filter((m) => VOID_LIFTING_METRICS.includes(m));
        if (voids.length === 0) continue;
        const contaminated = orderPopulationMetrics(all);
        if (contaminated.length > 0) {
          violations.push(
            `${report.id}/${q.id} asks for ${voids.join("+")} beside ${contaminated.join(", ")} — ` +
              "the planner will drop the void exclusion for those too (planner.js:356)",
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("the guard is not met by simply dropping the figures", () => {
  const executive = REPORT_BY_ID.executive;
  const allExecutive = executive.queries.flatMap((q) => [...q.metrics, ...(q.capMetrics ?? [])]);

  it("the executive statement still asks for the void figures somewhere", () => {
    for (const m of ["voids_count", "voids_value"]) expect(allExecutive).toContain(m);
  });

  it("…and still asks for the order figures somewhere", () => {
    for (const m of ["orders", "avg_ticket"]) expect(allExecutive).toContain(m);
  });

  it("the voids report still carries both counts and values", () => {
    const voids = REPORT_BY_ID.voids.queries.flatMap((q) => q.metrics);
    for (const m of ["voids_count", "voids_value", "returns_count", "returns_value"]) {
      expect(voids).toContain(m);
    }
  });
});
