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
 * So the rule is pinned structurally instead of trusted.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const EXECUTIVE = path.resolve(__dirname, "../pages/Executive.tsx");

/** Metrics whose SQL tests `status = 'voided'` — they lift the exclusion. */
const VOID_METRICS = ["voids_count", "voids_value"];

/**
 * Metrics counted over the ORDER population. If the exclusion is lifted, every
 * one of these silently starts counting voided orders.
 * `avg_ticket` / `avg_items_per_order` are derived from `orders`, so they
 * inherit the denominator and are listed too.
 */
const ORDER_POPULATION = [
  "orders",
  "avg_ticket",
  "avg_items_per_order",
  "guests",
  "fees_total",
  "rounding_total",
  "returns_count",
];

/** The string array literal assigned to `const <name> = [ … ]`. */
function metricGroup(src: string, name: string): string[] {
  const start = src.indexOf(`const ${name} = [`);
  expect(start, `${name} not found — was it renamed?`).toBeGreaterThan(-1);
  const open = src.indexOf("[", start);
  const close = src.indexOf("]", open);
  return [...src.slice(open, close).matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
}

describe("the executive statement's request groups", () => {
  const src = fs.readFileSync(EXECUTIVE, "utf8");
  const groups = ["SUMMARY_METRICS_A", "SUMMARY_METRICS_B", "SUMMARY_METRICS_C"].map((name) => ({
    name,
    metrics: metricGroup(src, name),
  }));

  it("each stays within the planner's 12-metric ceiling", () => {
    for (const g of groups) {
      expect(g.metrics.length, `${g.name} exceeds MAX_METRICS`).toBeLessThanOrEqual(12);
    }
  });

  it("never puts a void metric beside an order-population metric", () => {
    for (const g of groups) {
      const voids = g.metrics.filter((m) => VOID_METRICS.includes(m));
      if (voids.length === 0) continue;
      const contaminated = g.metrics.filter((m) => ORDER_POPULATION.includes(m));
      expect(
        contaminated,
        `${g.name} asks for ${voids.join("+")} beside ${contaminated.join(", ")} — ` +
          "the planner will drop the void exclusion for those too (planner.js:356)",
      ).toEqual([]);
    }
  });

  it("still asks for the void figures somewhere — the guard must not be met by dropping them", () => {
    const all = groups.flatMap((g) => g.metrics);
    for (const m of VOID_METRICS) expect(all).toContain(m);
  });

  it("still asks for the order figures somewhere", () => {
    const all = groups.flatMap((g) => g.metrics);
    for (const m of ["orders", "avg_ticket"]) expect(all).toContain(m);
  });
});
