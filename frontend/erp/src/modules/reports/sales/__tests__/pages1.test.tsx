// Sales Analytics Hub — pages wave 1 (segments 1–8: executive, explorer,
// items, modifiers, payments, cashiers, branches, hours).
//
// lib/api is mocked at the module boundary (runAnalyticsQuery +
// fetchAnalyticsRegistry; everything else — buildFiltersBody, displayMetric,
// stableStringify — stays real). One canned-fixture harness serves every page:
// runAnalyticsQuery dispatches on the requested dimension signature, so each
// page's several bodies each get a shaped result. Per page we assert the five
// contract behaviors: KPI values from the fixture, the chart's accessible
// <details> table alternative, EmptyState on empty rows, ErrorState on
// failure, and the masked-metric "—" contract (masked value NEVER rendered).
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

/** True when any chart's <details> accessible alternative contains the probe. */
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
  /** A label that must appear inside a chart's <details> table alternative. */
  chartProbe: string;
  /**
   * Chart-free pages (the executive report is deliberately one) prove the same
   * thing through their own tables instead of a chart's <details> fallback.
   */
  chartless?: true;
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
    chartProbe: "2026-07-01",
    chartless: true,
    maskMetric: "avg_ticket",
    maskedValue: "25.00 ر.س",
  },
  {
    name: "Explorer",
    Comp: Explorer,
    path: "/reports/sales/explorer",
    kpiProbes: ["1,000.00 ر.س", "40"],
    chartProbe: "Branch A",
    maskMetric: "orders",
    maskedValue: "40",
  },
  {
    name: "Items",
    Comp: Items,
    path: "/reports/sales/items",
    kpiProbes: ["500", "1,500.00 ر.س", "1,000.00 ر.س"],
    chartProbe: "Item A",
    maskMetric: "net_ex_vat",
    maskedValue: "1,000.00 ر.س",
  },
  {
    name: "Modifiers",
    Comp: Modifiers,
    path: "/reports/sales/modifiers",
    kpiProbes: ["210", "1.4", "35%"],
    chartProbe: "Combo Kind",
    maskMetric: "attach_rate",
    maskedValue: "35%",
  },
  {
    name: "Payments",
    Comp: Payments,
    path: "/reports/sales/payments",
    kpiProbes: ["1,200.00 ر.س", "30.00 ر.س", "1,170.00 ر.س"],
    chartProbe: "Cash",
    maskMetric: "refunds_out",
    maskedValue: "30.00 ر.س",
  },
  {
    name: "Cashiers",
    Comp: Cashiers,
    path: "/reports/sales/cashiers",
    kpiProbes: ["40", "1,000.00 ر.س", "25.00 ر.س"],
    chartProbe: "Cashier A",
    maskMetric: "avg_ticket",
    maskedValue: "25.00 ر.س",
  },
  {
    name: "Branches",
    Comp: Branches,
    path: "/reports/sales/branches",
    kpiProbes: ["1,000.00 ر.س", "40"],
    chartProbe: "Branch A",
    maskMetric: "orders",
    maskedValue: "40",
  },
  {
    name: "Hours",
    Comp: Hours,
    path: "/reports/sales/hours",
    kpiProbes: ["1,000.00 ر.س", "40"],
    chartProbe: "Mon",
    maskMetric: "net_ex_vat",
    maskedValue: "1,000.00 ر.س",
  },
];

beforeEach(() => {
  harness.mode = "data";
  harness.masked = [];
});

afterEach(cleanup);

describe.each(PAGES)("$name page", ({ Comp, path, kpiProbes, chartProbe, chartless, maskMetric, maskedValue }) => {
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
    chartless
      ? "renders the dimension label in its own report table"
      : "renders the chart's accessible table alternative",
    async () => {
      renderPage(Comp, path);
      await screen.findByTestId("kpi-row", undefined, { timeout: 5000 });
      if (chartless) {
        // No chart to fall back from — the report's daily table carries it.
        await waitFor(() => expect(screen.getAllByText(chartProbe).length).toBeGreaterThan(0), {
          timeout: 15000,
        });
        expect(document.querySelectorAll("details")).toHaveLength(0);
        return;
      }
      // The chart kit (recharts + ChartCard) loads lazily — allow it to arrive.
      await waitFor(() => expect(probeInDetails(chartProbe)).toBe(true), { timeout: 15000 });
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
