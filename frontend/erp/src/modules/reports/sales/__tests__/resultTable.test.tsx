// One analytics result → one flat table.
//
// Replaces the deleted pivot.test.ts / PivotTable.test.tsx. What it pins is the
// set of contracts that a naive "just map the rows" conversion silently breaks:
// null is not zero, a masked metric is not a missing one, dimension columns are
// not optional, and two rows with the same key are still two rows.
import { describe, expect, it } from "vitest";
import { buildResultColumns, toResultRows } from "../lib/resultTable";
import type { AnalyticsRegistry, AnalyticsResultRow } from "../lib/api";
import type { TFunction } from "@/i18n";

/** Echoes the key so assertions read as the key, not a translation. */
const t = ((key: string) => key) as unknown as TFunction;

const REGISTRY = {
  metrics: [
    { id: "net_ex_vat", kind: "additive", format: "money", fact: "line" },
    { id: "orders", kind: "additive", format: "count", fact: "order" },
    { id: "margin_pct", kind: "derived", format: "percent", fact: null, requiresCap: "analytics.cost.view" },
  ],
  dimensions: [],
} as unknown as AnalyticsRegistry;

const rows: AnalyticsResultRow[] = [
  { keys: ["b1", "2026-07-01"], labels: ["الفرع الأول", "1 يوليو"], values: { net_ex_vat: 100, orders: 4, margin_pct: 12.5 } },
  { keys: ["b2", "2026-07-01"], labels: ["الفرع الثاني", "1 يوليو"], values: { net_ex_vat: null, orders: 0, margin_pct: null } },
];

const build = (over: Partial<Parameters<typeof buildResultColumns>[0]> = {}) =>
  buildResultColumns({ dimensions: ["branch", "business_day"], metricIds: ["net_ex_vat", "orders"], t, registry: REGISTRY, ...over });

describe("the columns a grouped result produces", () => {
  it("puts one column per dimension FIRST, in request order", () => {
    const cols = build();
    expect(cols.slice(0, 2).map((c) => c.id)).toEqual(["dim:branch", "dim:business_day"]);
    expect(cols.slice(2).map((c) => c.id)).toEqual(["net_ex_vat", "orders"]);
  });

  it("reads each dimension cell from labels[i], not from the raw key", () => {
    const cols = build();
    expect(cols[0].accessor?.(toResultRows(rows)[0])).toBe("الفرع الأول");
    expect(cols[1].accessor?.(toResultRows(rows)[0])).toBe("1 يوليو");
  });

  it("falls back to the raw key when the server sent no label", () => {
    const unlabelled = toResultRows([{ keys: ["b9", null], labels: [], values: {} }]);
    expect(build()[0].accessor?.(unlabelled[0])).toBe("b9");
  });

  it("namespaces dimension ids so a dimension cannot collide with a metric", () => {
    // The column id is the key DataTable persists hidden-state under; an
    // unnamespaced `branch` dimension and a future `branch` metric would share it.
    expect(build().every((c) => !c.id.startsWith("dim:") || c.id.includes(":"))).toBe(true);
  });

  it("makes dimension columns UNHIDEABLE", () => {
    // Hiding `branch` on a brand × branch report leaves rows that look identical
    // carrying different numbers — a table that contradicts itself.
    const cols = build();
    expect(cols[0].hideable).toBe(false);
    expect(cols[1].hideable).toBe(false);
    expect(cols[2].hideable).not.toBe(false); // metrics stay hideable
  });

  it("pins exactly one dimension by default", () => {
    const cols = build();
    expect(cols.filter((c) => c.pinStart)).toHaveLength(1);
    expect(cols[0].pinStart).toBe(true);
  });
});

describe("the null contract", () => {
  it("renders a null metric as an em dash, never as zero", () => {
    const cols = build();
    const net = cols.find((c) => c.id === "net_ex_vat")!;
    const [first, second] = toResultRows(rows);
    expect(net.cell?.(first)).toBe("100.00 ر.س");
    expect(net.cell?.(second)).toBe("—");
  });

  it("keeps a REAL zero as zero — the contract is null≠0, not 'blank the small ones'", () => {
    const orders = build().find((c) => c.id === "orders")!;
    expect(orders.cell?.(toResultRows(rows)[1])).toBe("0");
  });

  it("returns null from the accessor too, so the CSV cell is empty rather than 0", () => {
    const net = build().find((c) => c.id === "net_ex_vat")!;
    expect(net.accessor?.(toResultRows(rows)[1])).toBeNull();
  });
});

describe("masked vs capability-denied", () => {
  it("keeps a MASKED metric as a column of em dashes", () => {
    // "We could not compute this" — the column stays so the reader sees the gap.
    const cols = build({ maskedMetrics: ["net_ex_vat"] });
    const net = cols.find((c) => c.id === "net_ex_vat")!;
    expect(net).toBeDefined();
    expect(net.cell?.(toResultRows(rows)[0])).toBe("—");
  });

  it("marks a capability-gated metric with requireCap so DataTable removes it entirely", () => {
    // "You may not see this" is a different claim, and an em-dash column would
    // read as "there is no cost data", which is false.
    const cols = buildResultColumns({ dimensions: ["branch"], metricIds: ["margin_pct"], t, registry: REGISTRY });
    expect(cols.find((c) => c.id === "margin_pct")!.requireCap).toBe("analytics.cost.view");
  });
});

describe("formatting follows the registry", () => {
  it("money, count and percent each get their own formatter", () => {
    const cols = buildResultColumns({ dimensions: ["branch"], metricIds: ["net_ex_vat", "orders", "margin_pct"], t, registry: REGISTRY });
    const row = toResultRows(rows)[0];
    expect(cols.find((c) => c.id === "net_ex_vat")!.cell?.(row)).toContain("ر.س");
    expect(cols.find((c) => c.id === "orders")!.cell?.(row)).toBe("4");
    expect(cols.find((c) => c.id === "margin_pct")!.cell?.(row)).toBe("12.5%");
  });

  it("marks every metric numeric so it renders LTR and tabular", () => {
    expect(build().filter((c) => !c.id.startsWith("dim:")).every((c) => c.numeric)).toBe(true);
  });
});

describe("row identity", () => {
  it("gives two rows with the SAME dimension tuple distinct ids", () => {
    // QueryService merges two facts on the dimension key and a NULL key on one
    // side can produce a duplicate tuple. React renders one and silently drops
    // the other — a row that disappears with no error anywhere.
    const dupes = toResultRows([
      { keys: [null, null], labels: [], values: { orders: 1 } },
      { keys: [null, null], labels: [], values: { orders: 2 } },
    ]);
    expect(dupes[0].id).not.toBe(dupes[1].id);
  });

  it("keeps keys/labels/values intact so drill handlers still work", () => {
    const [r] = toResultRows(rows);
    expect(r.keys[0]).toBe("b1");
    expect(r.labels[1]).toBe("1 يوليو");
    expect(r.values.orders).toBe(4);
  });
});

describe("a query with no grouping", () => {
  it("still produces an identity column naming the period", () => {
    // Otherwise the single result row is a bare line of numbers describing
    // nothing — which is what the pivot rendered: literally nothing.
    const cols = buildResultColumns({
      dimensions: [],
      metricIds: ["orders"],
      t,
      registry: REGISTRY,
      periodValue: "2026-07-01 — 2026-07-31",
    });
    expect(cols[0].id).toBe("dim:__period");
    expect(cols[0].hideable).toBe(false);
    expect(cols[0].accessor?.(toResultRows(rows)[0])).toBe("2026-07-01 — 2026-07-31");
  });
});
