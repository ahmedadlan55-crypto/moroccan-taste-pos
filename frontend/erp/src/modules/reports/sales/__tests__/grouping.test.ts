/**
 * Group By legality — the client half.
 *
 * SCOPE, deliberately narrow: this file proves the COMPARISON is right, not
 * the fact graph. The client owns no fact knowledge; it compares two arrays
 * the server sent (`metric.facts` vs `dimension.facts`). Whether those arrays
 * describe the planner truthfully is proven server-side, over all 2009 metric
 * × dimension pairs, by running the real planner —
 * tests/analyticsGrouping.test.js. Re-asserting the graph here with a
 * hand-written fixture would only prove the fixture agrees with itself.
 *
 * So the fixture below is small and synthetic on purpose, and each case names
 * the user-visible failure it prevents.
 */
import { describe, expect, it } from "vitest";
import {
  dimensionAvailability,
  groupableDimensions,
  hasFactGraph,
  metricConflicts,
  reconcile,
} from "../lib/grouping";
import type { AnalyticsRegistry } from "../lib/api";

/** Shapes mirror the metadata projection: metrics carry `facts`, dims carry `facts`. */
const REGISTRY: AnalyticsRegistry = {
  metrics: [
    { id: "net_ex_vat", kind: "additive", format: "money", fact: "line", facts: ["line"] },
    { id: "cogs", kind: "additive", format: "money", fact: "line", facts: ["line"] },
    { id: "orders", kind: "additive", format: "count", fact: "order", facts: ["order"] },
    { id: "payments_in", kind: "additive", format: "money", fact: "payment", facts: ["payment"] },
    // derived across TWO facts — the case a single `fact` field cannot express
    { id: "avg_ticket", kind: "derived", format: "money", fact: null, facts: ["line", "order"] },
  ],
  dimensions: [
    { id: "branch", kind: "scope", groupable: true, facts: ["order", "line", "payment"] },
    { id: "menu_item", kind: "attribute", groupable: true, facts: ["line"] },
    { id: "payment_method", kind: "attribute", groupable: true, facts: ["payment"] },
    { id: "meal_period", kind: "derived-js", groupable: true, facts: ["order", "line", "payment"] },
    // groupable in the contract, backed by no projector
    { id: "discount_reason", kind: "attribute", groupable: true, facts: [] },
    // not groupable at all — must never reach a grouping menu
    { id: "vat_rate_filter_only", kind: "attribute", groupable: false, facts: ["line"] },
  ],
};

describe("the groupable menu", () => {
  it("offers every groupable dimension and nothing else", () => {
    const ids = groupableDimensions(REGISTRY).map((d) => d.id);
    expect(ids).toEqual(["branch", "menu_item", "payment_method", "meal_period", "discount_reason"]);
  });
});

describe("a dimension's availability against the chosen metrics", () => {
  it("allows a dimension every metric's fact supports", () => {
    expect(dimensionAvailability(REGISTRY, ["net_ex_vat", "orders"], "branch")).toBeNull();
  });

  it("blocks a dimension one metric's fact cannot express, and NAMES that metric", () => {
    // `orders` lives on the order fact; menu_item exists only on line. The
    // planner would 422 the WHOLE request, listing a fact id the user never
    // typed — so the block has to be explained in the user's own vocabulary.
    const v = dimensionAvailability(REGISTRY, ["net_ex_vat", "orders"], "menu_item");
    expect(v?.reason).toBe("metric-conflict");
    expect(v?.blockedBy).toEqual(["orders"]);
  });

  it("requires EVERY fact of a derived metric, not just one", () => {
    // avg_ticket spans line + order. menu_item covers line only, so it must be
    // blocked — an implementation that checked "any fact matches" would let
    // this through and the report would 422 on submit.
    const v = dimensionAvailability(REGISTRY, ["avg_ticket"], "menu_item");
    expect(v?.reason).toBe("metric-conflict");
    expect(v?.blockedBy).toEqual(["avg_ticket"]);
    // …and allows the dimension that covers both.
    expect(dimensionAvailability(REGISTRY, ["avg_ticket"], "branch")).toBeNull();
  });

  it("reports a dimension with no fact as MISSING A SOURCE, not as a metric conflict", () => {
    // discount_reason is reserved in the contract with no projector behind it.
    // Blaming the user's metric choice would send them changing metrics forever.
    const v = dimensionAvailability(REGISTRY, ["net_ex_vat"], "discount_reason");
    expect(v?.reason).toBe("no-fact");
    expect(v?.blockedBy).toEqual([]);
  });

  it("treats meal_period as available — its facts come from the derived-js path", () => {
    expect(dimensionAvailability(REGISTRY, ["net_ex_vat", "orders"], "meal_period")).toBeNull();
  });
});

describe("the mirror question, for the metric picker", () => {
  it("names the dimensions that block each metric", () => {
    expect(metricConflicts(REGISTRY, ["net_ex_vat", "cogs", "orders"], ["menu_item"])).toEqual({
      orders: ["menu_item"],
    });
  });

  it("is empty when the grouping supports everything", () => {
    expect(metricConflicts(REGISTRY, ["net_ex_vat", "orders"], ["branch"])).toEqual({});
  });

  it("ignores a dimension that has no source — it blocks nothing, it IS blocked", () => {
    expect(metricConflicts(REGISTRY, ["net_ex_vat"], ["discount_reason"])).toEqual({});
  });
});

describe("reconciling a grouping that arrived from somewhere else", () => {
  it("drops the illegal levels and reports them", () => {
    // A saved view grouped by menu_item, reopened with `orders` in the metrics.
    const r = reconcile(REGISTRY, ["net_ex_vat", "orders"], ["branch", "menu_item"]);
    expect(r.dimensions).toEqual(["branch"]);
    expect(r.dropped).toEqual(["menu_item"]);
  });

  it("keeps a fully legal grouping untouched, in order", () => {
    const r = reconcile(REGISTRY, ["net_ex_vat"], ["branch", "menu_item"]);
    expect(r.dimensions).toEqual(["branch", "menu_item"]);
    expect(r.dropped).toEqual([]);
  });
});

describe("degraded mode — an older server that sends no fact graph", () => {
  const OLD: AnalyticsRegistry = {
    metrics: [{ id: "net_ex_vat", kind: "additive", format: "money", fact: "line" }],
    dimensions: [{ id: "menu_item", kind: "attribute", groupable: true }],
  };

  it("is detected", () => {
    expect(hasFactGraph(OLD)).toBe(false);
    expect(hasFactGraph(REGISTRY)).toBe(true);
    expect(hasFactGraph(undefined)).toBe(false);
  });

  it("permits everything rather than greying out legal groupings", () => {
    // Guessing from the old payload (derived metrics reported `fact: null`,
    // meal_period reported no facts at all) would disable real, working
    // groupings and the user would conclude the data is missing. A 422 they can
    // read is strictly better than a control that lies.
    expect(dimensionAvailability(OLD, ["net_ex_vat"], "menu_item")).toBeNull();
    expect(metricConflicts(OLD, ["net_ex_vat"], ["menu_item"])).toEqual({});
    expect(reconcile(OLD, ["net_ex_vat"], ["menu_item"]).dropped).toEqual([]);
  });
});
