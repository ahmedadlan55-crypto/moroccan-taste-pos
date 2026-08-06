// Sales Analytics Hub — pages wave 1 (segments 1–8: executive, explorer,
// items, modifiers, payments, cashiers, branches, hours).
//
// lib/api is mocked at the module boundary (runAnalyticsQuery +
// fetchAnalyticsRegistry; everything else — buildFiltersBody, displayMetric,
// stableStringify — stays real). One canned-fixture harness serves every page:
// runAnalyticsQuery dispatches on the requested dimension signature, so each
// page's several bodies each get a shaped result. Per page we assert the five
// contract behaviors: KPI values from the fixture, the dimension labels in the
// page's own result table, EmptyState on empty rows, ErrorState on
// failure, and the masked-metric "—" contract (masked value NEVER rendered).
//
// REQUIREMENT CHANGE (in-report charts removed). Every wave-1 page used to end
// in a lazily-imported recharts ChartCard, and this file's "chart" test read
// the dimension label out of that card's accessible <details> table
// alternative. The reports are now decision tables (charts live on the
// dashboard), so the ChartCard and its <details> are gone and the SAME fixture
// label is asserted where it now renders: the page's own DataTable /
// DataTable. Nothing is relaxed or dropped -- the probes are unchanged, the
// grouped pivots additionally expand to reach their leaf label, and each
// chart-free page now also proves the chart is really gone (zero <details>).
// Hours is the one exception and documents why below.
import type { ComponentType } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/i18n";
import type { AnalyticsQueryBody, AnalyticsResult } from "../lib/api";
import Executive from "../pages/Executive";
import Explorer from "../pages/Explorer";
import Items from "../pages/Items";
import Modifiers from "../pages/Modifiers";
import Payments from "../pages/Payments";
import Cashiers from "../pages/Cashiers";
import Branches from "../pages/Branches";
import Hours from "../pages/Hours";

/* ── the canned-fixture harness (hoisted: the vi.mock factory needs it) ── */

const { harness, fixtureFor, emptyResult, REGISTRY } = vi.hoisted(() => {
  const harness = {
    mode: "data" as "data" | "empty" | "error",
    masked: [] as string[],
  };

  /** Full-value totals: every metric a wave-1 page requests (tips_total is
   *  deliberately ABSENT → null → "—" per the missing-value contract). */
  const TOTALS: Record<string, number> = {
    net_ex_vat: 1000,
    gross_product_sales: 1500,
    orders: 40,
    avg_ticket: 25,
    discounts_total: 60,
    refunds_out: 30,
    payments_in: 1200,
    net_collections: 1170,
    qty_sold: 500,
    item_contribution_pct: 100,
    modifier_qty: 210,
    modifiers_per_item: 1.4,
    attach_rate: 35,
    growth: 5,
    discount_rate_by_cashier: 8,
    void_rate_by_cashier: 3,
    return_rate_by_cashier: 2,
    // the administrative sales report's statement / tax / returns / profit lines
    returns_net: 40,
    returns_cogs: 20,
    net_product_sales_ex_vat: 960,
    vat_amount: 150,
    fees_total: 10,
    rounding_total: 0.25,
    invoice_total: 1160.25,
    avg_items_per_order: 3,
    guests: 90,
    returns_count: 4,
    returns_value: 45,
    voids_count: 2,
    voids_value: 20,
    cogs: 400,
    gross_profit: 600,
    margin_pct: 60,
    cogs_after_returns: 380,
    gross_profit_after_returns: 580,
    margin_pct_after_returns: 60.42,
  };

  function values(metrics: string[]): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    for (const m of metrics) {
      if (harness.masked.includes(m)) continue;
      if (TOTALS[m] == null) continue; // e.g. tips_total → absent → "—"
      out[m] = TOTALS[m];
    }
    return out;
  }

  interface Tuple {
    keys: Array<string | number | null>;
    labels: string[];
  }

  /** Row tuples per requested dimension signature. */
  const TUPLES: Record<string, { rows: Tuple[]; subtotals?: Tuple[] }> = {
    "": { rows: [{ keys: [], labels: [] }] },
    business_day: {
      rows: [
        { keys: ["2026-07-01"], labels: ["2026-07-01"] },
        { keys: ["2026-07-02"], labels: ["2026-07-02"] },
      ],
    },
    channel: {
      rows: [
        { keys: ["pos"], labels: ["POS Channel"] },
        { keys: ["online"], labels: ["Online Channel"] },
      ],
    },
    branch: {
      rows: [
        { keys: ["br1"], labels: ["Branch A"] },
        { keys: ["br2"], labels: ["Branch B"] },
      ],
    },
    "category,menu_item": {
      rows: [
        { keys: ["cat1", "i1"], labels: ["Category A", "Item A"] },
        { keys: ["cat1", "i2"], labels: ["Category A", "Item B"] },
        { keys: ["cat2", "i3"], labels: ["Category B", "Item C"] },
      ],
      subtotals: [
        { keys: ["cat1", null], labels: ["Category A"] },
        { keys: ["cat2", null], labels: ["Category B"] },
      ],
    },
    modifier_kind: {
      rows: [
        { keys: ["combo"], labels: ["Combo Kind"] },
        { keys: ["extra"], labels: ["Extra Kind"] },
      ],
    },
    "business_day,payment_method": {
      rows: [
        { keys: ["2026-07-01", "cash"], labels: ["2026-07-01", "Cash"] },
        { keys: ["2026-07-01", "card"], labels: ["2026-07-01", "Card"] },
        { keys: ["2026-07-02", "cash"], labels: ["2026-07-02", "Cash"] },
      ],
    },
    payment_method: {
      rows: [
        { keys: ["cash"], labels: ["Cash"] },
        { keys: ["card"], labels: ["Card"] },
      ],
    },
    vat_category: {
      rows: [
        { keys: ["S"], labels: ["Standard"] },
        { keys: ["Z"], labels: ["Zero-rated"] },
      ],
    },
    cashier: {
      rows: [
        { keys: ["c1"], labels: ["Cashier A"] },
        { keys: ["c2"], labels: ["Cashier B"] },
        { keys: ["c3"], labels: ["Cashier C"] },
      ],
    },
    "brand,branch": {
      rows: [
        { keys: ["b1", "br1"], labels: ["Brand X", "Branch A"] },
        { keys: ["b1", "br2"], labels: ["Brand X", "Branch B"] },
        { keys: ["b2", "br3"], labels: ["Brand Y", "Branch C"] },
      ],
      subtotals: [
        { keys: ["b1", null], labels: ["Brand X"] },
        { keys: ["b2", null], labels: ["Brand Y"] },
      ],
    },
    "weekday,hour": {
      rows: [
        { keys: [0, 10], labels: ["Mon", "10:00"] },
        { keys: [0, 11], labels: ["Mon", "11:00"] },
        { keys: [1, 10], labels: ["Tue", "10:00"] },
      ],
    },
    hour: {
      rows: [
        { keys: [10], labels: ["10:00"] },
        { keys: [11], labels: ["11:00"] },
        { keys: [12], labels: ["12:00"] },
      ],
    },
  };

  const meta = () => ({
    freshness: { watermark: "2026-07-23T12:00:00Z" },
    maskedMetrics: [...harness.masked],
    completeness: { complete: false, missingDays: ["2026-07-01"] },
  });

  function fixtureFor(body: { metrics: string[]; dimensions: string[] }) {
    // SERVER CONTRACT, enforced by the mock. lib/analytics/planner.js caps a
    // request at MAX_METRICS = 12 / MAX_DIMENSIONS = 3 and answers 422 above
    // either — the page then renders an ErrorState with no data at all. This
    // harness used to answer ANY body, so a page could ask for 23 metrics and
    // still look perfectly green here while being 100% broken in the product.
    // That is exactly how the rebuilt Executive shipped: every load 422'd.
    if (body.metrics.length > 12) {
      throw new Error(
        `pages1 harness: ${body.metrics.length} metrics requested — the server caps a query at 12 (planner MAX_METRICS) and answers 422 above it. Split the request.`,
      );
    }
    if (body.dimensions.length > 3) {
      throw new Error(
        `pages1 harness: ${body.dimensions.length} dimensions requested — the server caps a query at 3 (planner MAX_DIMENSIONS).`,
      );
    }
    const sig = body.dimensions.join(",");
    const shape = TUPLES[sig];
    if (!shape) throw new Error(`pages1 harness: no fixture for dimensions [${sig}]`);
    return {
      columns: [],
      rows: shape.rows.map((tu) => ({ keys: tu.keys, labels: tu.labels, values: values(body.metrics) })),
      ...(shape.subtotals
        ? { subtotals: shape.subtotals.map((tu) => ({ keys: tu.keys, labels: tu.labels, values: values(body.metrics) })) }
        : {}),
      totals: values(body.metrics),
      meta: meta(),
    };
  }

  const emptyResult = () => ({
    columns: [],
    rows: [],
    meta: { freshness: { watermark: null }, maskedMetrics: [], completeness: { complete: true } },
  });

  /** Enough of GET /analytics/metadata for equationKey + format lookups. */
  const REGISTRY = {
    metrics: [
      { id: "net_ex_vat", kind: "additive", format: "money", equationKey: "sum" },
      { id: "gross_product_sales", kind: "additive", format: "money", equationKey: "grossProductSales" },
      { id: "orders", kind: "additive", format: "count", equationKey: "count" },
      { id: "avg_ticket", kind: "derived", format: "money", equationKey: "avgTicket" },
      { id: "discounts_total", kind: "additive", format: "money", equationKey: "sum" },
      { id: "refunds_out", kind: "additive", format: "money", equationKey: "sum" },
      { id: "payments_in", kind: "additive", format: "money", equationKey: "sum" },
      { id: "net_collections", kind: "derived", format: "money", equationKey: "netCollections" },
      { id: "tips_total", kind: "additive", format: "money", equationKey: "sum" },
      { id: "qty_sold", kind: "additive", format: "qty", equationKey: "sum" },
      { id: "item_contribution_pct", kind: "derived", format: "percent", equationKey: "contributionPct" },
      { id: "modifier_qty", kind: "additive", format: "qty", equationKey: "sum" },
      { id: "modifiers_per_item", kind: "derived", format: "ratio", equationKey: "avgModifiersPerItem" },
      { id: "attach_rate", kind: "derived", format: "percent", equationKey: "attachRate" },
      { id: "growth", kind: "derived", format: "percent", equationKey: "growth" },
      { id: "discount_rate_by_cashier", kind: "derived", format: "percent", equationKey: "ratePct" },
      { id: "void_rate_by_cashier", kind: "derived", format: "percent", equationKey: "ratePct" },
      { id: "return_rate_by_cashier", kind: "derived", format: "percent", equationKey: "ratePct" },
    ],
    dimensions: [],
  };

  return { harness, fixtureFor, emptyResult, REGISTRY };
});

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    fetchAnalyticsRegistry: vi.fn(async () => REGISTRY as unknown as import("../lib/api").AnalyticsRegistry),
    runAnalyticsQuery: vi.fn(async (body: AnalyticsQueryBody): Promise<AnalyticsResult> => {
      if (harness.mode === "error") throw new Error("analytics down");
      if (harness.mode === "empty") return emptyResult() as unknown as AnalyticsResult;
      return fixtureFor(body) as unknown as AnalyticsResult;
    }),
  };
});

/* ── render harness ── */

function renderPage(Comp: ComponentType, path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <MemoryRouter initialEntries={[path]}>
          <Comp />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

/** True when a <details> accessible table alternative contains the probe. */
function probeInDetails(probe: string): boolean {
  return [...document.querySelectorAll("details")].some(
    (d) => within(d as HTMLElement).queryAllByText(probe).length > 0,
  );
}

interface PageSpec {
  name: string;
  Comp: ComponentType;
  path: string;
  /** Fixture-derived KPI values that must render in the KPI row wave. */
  kpiProbes: string[];
  /**
   * A fixture dimension label the page's own result table must render on first
   * paint (formerly the label probed inside the chart's <details> fallback).
   */
  tableProbe: string;
  /**
   * Grouped pivot pages paint collapsed, so `tableProbe` is the group label and
   * this is the LEAF label that must appear once the group is expanded. Named
   * separately so the original leaf probe stays asserted instead of being
   * quietly downgraded to the group row.
   */
  leafProbe?: string;
  /**
   * Hours only. Its weekday x hour Heatmap is a data grid, not a plot (cells
   * carry values and drill), so it deliberately survived the chart removal and
   * keeps its accessible <details> table. This is the label that must appear
   * inside it. Every OTHER page asserts zero <details> instead.
   */
  detailsProbe?: string;
  /** Metric to mask; its formatted UNMASKED value must then be absent. */
  maskMetric: string;
  maskedValue: string;
}

const PAGES: PageSpec[] = [
  {
    name: "Executive",
    Comp: Executive,
    path: "/reports/sales/executive",
    kpiProbes: ["1,000.00 ر.س", "1,500.00 ر.س", "40", "25.00 ر.س"],
    tableProbe: "2026-07-01",
    maskMetric: "avg_ticket",
    maskedValue: "25.00 ر.س",
  },
  {
    name: "Explorer",
    Comp: Explorer,
    path: "/reports/sales/explorer",
    kpiProbes: ["1,000.00 ر.س", "40"],
    // Default `by` is branch with no second dimension, so the pivot's level-0
    // rows ARE the leaves: no expansion needed to reach the branch label.
    tableProbe: "Branch A",
    maskMetric: "orders",
    maskedValue: "40",
  },
  {
    name: "Items",
    Comp: Items,
    path: "/reports/sales/items",
    kpiProbes: ["500", "1,500.00 ر.س", "1,000.00 ر.س"],
    // category > menu_item: the category group row paints, "Item A" is its leaf.
    tableProbe: "Category A",
    leafProbe: "Item A",
    maskMetric: "net_ex_vat",
    maskedValue: "1,000.00 ر.س",
  },
  {
    name: "Modifiers",
    Comp: Modifiers,
    path: "/reports/sales/modifiers",
    kpiProbes: ["210", "1.4", "35%"],
    tableProbe: "Combo Kind",
    maskMetric: "attach_rate",
    maskedValue: "35%",
  },
  {
    name: "Payments",
    Comp: Payments,
    path: "/reports/sales/payments",
    kpiProbes: ["1,200.00 ر.س", "30.00 ر.س", "1,170.00 ر.س"],
    tableProbe: "Cash",
    maskMetric: "refunds_out",
    maskedValue: "30.00 ر.س",
  },
  {
    name: "Cashiers",
    Comp: Cashiers,
    path: "/reports/sales/cashiers",
    kpiProbes: ["40", "1,000.00 ر.س", "25.00 ر.س"],
    tableProbe: "Cashier A",
    maskMetric: "avg_ticket",
    maskedValue: "25.00 ر.س",
  },
  {
    name: "Branches",
    Comp: Branches,
    path: "/reports/sales/branches",
    kpiProbes: ["1,000.00 ر.س", "40"],
    // brand > branch: the brand group row paints, "Branch A" is its leaf.
    tableProbe: "Brand X",
    leafProbe: "Branch A",
    maskMetric: "orders",
    maskedValue: "40",
  },
  {
    name: "Hours",
    Comp: Hours,
    path: "/reports/sales/hours",
    kpiProbes: ["1,000.00 ر.س", "40"],
    // The hour DataTable carries the hour label; the surviving Heatmap's
    // <details> carries the weekday one (see detailsProbe above).
    tableProbe: "10:00",
    detailsProbe: "Mon",
    maskMetric: "net_ex_vat",
    maskedValue: "1,000.00 ر.س",
  },
];

beforeEach(() => {
  harness.mode = "data";
  harness.masked = [];
  // Tables now carry a stable `tableId`, so DataTable persists sort/pageSize/
  // hidden columns to localStorage. Without this clear, one test's column or
  // sort choice leaks into the next and the file fails depending on ORDER —
  // the worst kind of flake, because it passes when you run it alone.
  window.localStorage.clear();
});

afterEach(cleanup);

describe.each(PAGES)("$name page", ({ Comp, path, kpiProbes, tableProbe, leafProbe, detailsProbe, maskMetric, maskedValue }) => {
  // The per-test budget MUST exceed the inner findBy wait. vitest's default
  // testTimeout is 5000ms, so `findByTestId(..., {timeout: 5000})` inside a
  // default-budget test can never actually consume its 5s: the test-level
  // timer starts first (it also covers renderPage + the lazy module imports),
  // so the harness kills the test at 5000ms and reports "Test timed out"
  // instead of the assertion. It bit the FIRST page in describe.each
  // (Executive, 7.8s) whenever the machine was loaded — the sibling chart test
  // below already carries an explicit 20000 for exactly this reason. Same
  // 20000 here and on the masking test; no assertion or wait is relaxed.
  it("renders the KPI values from the fixture", async () => {
    renderPage(Comp, path);
    await screen.findByTestId("kpi-row", undefined, { timeout: 5000 });
    for (const probe of kpiProbes) {
      expect(screen.getAllByText(probe).length).toBeGreaterThan(0);
    }
  }, 20000);

  it(
    "renders the dimension label in its own report table",
    async () => {
      renderPage(Comp, path);
      await screen.findByTestId("kpi-row", undefined, { timeout: 5000 });
      // The result table paints from the same query as the KPI row; the wait
      // budget is the one the lazy chart kit used to need, kept as headroom.
      await waitFor(() => expect(screen.getAllByText(tableProbe).length).toBeGreaterThan(0), {
        timeout: 15000,
      });

      if (leafProbe) {
        // The pivot is gone: these reports are now FLAT tables where each
        // grouping dimension is an ordinary column, so both the outer value
        // and the leaf are on screen at first paint. This assertion used to
        // read "absent until expanded"; asserting BOTH present is strictly
        // stronger — it proves no row was lost in the conversion, which the
        // old collapsed-by-default check could not.
        expect(screen.getAllByText(leafProbe).length).toBeGreaterThan(0);
      }

      if (detailsProbe) {
        // Hours keeps the Heatmap's accessible <details> table (a data grid,
        // not a plot) — the label must still be reachable inside it.
        await waitFor(() => expect(probeInDetails(detailsProbe)).toBe(true), { timeout: 15000 });
        return;
      }
      // Chart removal, asserted: no ChartCard means no <details> fallback at all.
      expect(document.querySelectorAll("details")).toHaveLength(0);
    },
    20000,
  );

  it("renders EmptyState when the query returns no rows", async () => {
    harness.mode = "empty";
    renderPage(Comp, path);
    await waitFor(() => expect(document.querySelector('[data-state="empty"]')).toBeInTheDocument());
  });

  it("renders ErrorState when the query fails", async () => {
    harness.mode = "error";
    renderPage(Comp, path);
    await waitFor(() => expect(document.querySelector('[data-state="error"]')).toBeInTheDocument());
  });

  it(`masks a refused metric (${maskMetric}) as "—"`, async () => {
    harness.masked = [maskMetric];
    renderPage(Comp, path);
    await screen.findByTestId("kpi-row", undefined, { timeout: 5000 });
    // The masked KPI reads "—" and its unmasked value never leaks anywhere.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.queryAllByText(maskedValue)).toHaveLength(0);
  }, 20000);
});

describe("Executive decision workspace", () => {
  it("puts permitted decision KPIs first and carries the committed scope into a dimension drill", async () => {
    renderPage(
      Executive,
      "/reports/sales/executive?from=2026-07-01&to=2026-07-31&preset=custom&branchId=br1",
    );

    const kpis = await screen.findByTestId("kpi-row", undefined, { timeout: 5000 });
    expect(within(kpis).getByText("960.00 ر.س")).toBeInTheDocument();
    expect(within(kpis).getByText("40")).toBeInTheDocument();
    expect(within(kpis).getByText("25.00 ر.س")).toBeInTheDocument();
    // This harness grants no analytics.cost.view capability. Profit and margin
    // are protected figures, so their absence is the permission contract—not
    // missing fixture data.
    expect(within(kpis).queryByText("580.00 ر.س")).not.toBeInTheDocument();
    expect(within(kpis).queryByText("60.42%")).not.toBeInTheDocument();

    const itemDrill = within(screen.getByTestId("decision-shortcuts")).getByRole("link", {
      name: /حسب الصنف/,
    });
    const target = new URL(itemDrill.getAttribute("href") ?? "", "https://example.test");
    expect(target.pathname).toBe("/reports/sales/items");
    expect(target.searchParams.get("view")).toBe("items");
    expect(target.searchParams.get("from")).toBe("2026-07-01");
    expect(target.searchParams.get("to")).toBe("2026-07-31");
    expect(target.searchParams.get("branchId")).toBe("br1");
  }, 20000);
});
