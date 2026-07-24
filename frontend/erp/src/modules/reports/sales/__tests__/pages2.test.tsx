// Sales Analytics Hub — pages wave 9–16 (Orders, Discounts, Voids, Shifts,
// Taxes, Profitability, Reconciliation, Builder).
//
// Mocking style mirrors hub.test.tsx: the analytics transport (lib/api
// runAnalyticsQuery/fetchAnalyticsRegistry) is mocked and dispatched per query
// body; the Orders page's operational invoices fetch (o2cApi.invoices) is
// mocked at its import path. Assertions prefer structural contracts
// (data-state, testids, cellTone classes) over translated copy.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { I18nProvider } from "@/i18n";
import { o2cApi } from "@/modules/sales/lib/api";
import type { Invoice } from "@/modules/sales/lib/types";
import {
  runAnalyticsQuery,
  type AnalyticsQueryBody,
  type AnalyticsResult,
  type AnalyticsResultRow,
  fetchAnalyticsRegistry,
} from "../lib/api";
import OrdersPage from "../pages/Orders";
import DiscountsPage from "../pages/Discounts";
import VoidsPage from "../pages/Voids";
import ShiftsPage from "../pages/Shifts";
import TaxesPage from "../pages/Taxes";
import ProfitabilityPage from "../pages/Profitability";
import ReconciliationPage from "../pages/Reconciliation";
import BuilderPage from "../pages/Builder";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, runAnalyticsQuery: vi.fn(), fetchAnalyticsRegistry: vi.fn() };
});

vi.mock("@/modules/sales/lib/api", () => ({
  o2cApi: { invoices: vi.fn() },
}));

const runMock = vi.mocked(runAnalyticsQuery);
const registryMock = vi.mocked(fetchAnalyticsRegistry);
const invoicesMock = vi.mocked(o2cApi.invoices);

/* ── fixtures ────────────────────────────────────────────────── */

function row(
  keys: Array<string | number | null>,
  labels: string[],
  values: Record<string, number | null>,
): AnalyticsResultRow {
  return { keys, labels, values };
}

function result(
  rows: AnalyticsResultRow[],
  extra?: Partial<Pick<AnalyticsResult, "totals" | "meta">>,
): AnalyticsResult {
  return {
    columns: [],
    rows,
    totals: extra?.totals,
    meta: extra?.meta ?? { freshness: { watermark: null }, maskedMetrics: [] },
  };
}

const EMPTY = result([]);

/** Dispatch mocked analytics responses by "metrics@dimensions" signature. */
function dispatch(map: Record<string, AnalyticsResult>) {
  runMock.mockImplementation(async (body: AnalyticsQueryBody) => {
    const key = `${body.metrics.join(",")}@${body.dimensions.join("|")}`;
    return map[key] ?? EMPTY;
  });
}

function invoice(n: number): Invoice {
  return {
    id: `inv${n}`,
    document_number: `INV-100${n}`,
    document_type: "invoice",
    source_type: "pos",
    customer_name: "عميل",
    issue_date: "2026-07-20T10:00:00Z",
    subtotal: 100,
    vat_amount: 15,
    total_amount: 115,
    paid_amount: 115,
    balance_amount: 0,
    status: "paid",
    zatca_status: "reported",
    version: 1,
  };
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname + loc.search}</div>;
}

function renderPage(node: ReactNode, path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <MemoryRouter initialEntries={[path]}>
          {node}
          <LocationProbe />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

/** Assert at least one <td> containing `text` carries the tone class. */
function expectCellTone(text: string, toneClass: string) {
  const cells = screen.getAllByText(text).map((el) => el.closest("td")).filter(Boolean);
  expect(cells.length).toBeGreaterThan(0);
  expect(cells.some((td) => td && td.className.includes(toneClass))).toBe(true);
}

beforeEach(() => {
  runMock.mockReset();
  registryMock.mockReset();
  invoicesMock.mockReset();
  runMock.mockResolvedValue(EMPTY);
  window.localStorage.clear();
});

afterEach(cleanup);

/* ── 9. Orders ───────────────────────────────────────────────── */

describe("Orders page", () => {
  it("renders the analytics KPI row and the invoice list; row click drills to /sales/invoices?doc=", async () => {
    dispatch({
      "orders,invoice_total,avg_ticket@": result([], {
        totals: { orders: 12, invoice_total: 3450, avg_ticket: 287.5 },
      }),
    });
    invoicesMock.mockResolvedValue({
      success: true,
      data: [invoice(1), invoice(2)],
      pagination: { page: 1, pageSize: 25, total: 2, totalPages: 1 },
    });

    renderPage(<OrdersPage />, "/reports/sales/orders");

    await within(await screen.findByTestId("kpi-orders")).findByText("12");
    within(screen.getByTestId("kpi-invoice_total")).getByText("3,450.00 ر.س");
    const numberCells = await screen.findAllByText("INV-1001");
    expect(numberCells.length).toBeGreaterThan(0);

    fireEvent.click(numberCells[0]);
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/sales/invoices?doc=inv1"),
    );
  });

  it("shows the empty state when the invoice list has no rows", async () => {
    invoicesMock.mockResolvedValue({
      success: true,
      data: [],
      pagination: { page: 1, pageSize: 25, total: 0, totalPages: 0 },
    });
    renderPage(<OrdersPage />, "/reports/sales/orders");
    await waitFor(() => expect(document.querySelector('[data-state="empty"]')).toBeInTheDocument());
  });

  it("shows the error state when the invoice list fails", async () => {
    invoicesMock.mockRejectedValue(new Error("boom"));
    renderPage(<OrdersPage />, "/reports/sales/orders");
    await waitFor(() => expect(document.querySelector('[data-state="error"]')).toBeInTheDocument());
  });
});

/* ── 10. Discounts ───────────────────────────────────────────── */

describe("Discounts page", () => {
  const KPI = "discounts_total,discount_pct,discounted_orders,orders";
  it("renders KPIs, the by-day table with a warning tone on high discount_pct, '—' for a masked cell, and the reason-gap banner", async () => {
    dispatch({
      [`${KPI}@`]: result([], {
        totals: { discounts_total: 500, discount_pct: 5, discounted_orders: 20, orders: 100 },
      }),
      [`${KPI}@business_day`]: result([
        row(["2026-07-01"], ["1 يوليو"], { discounts_total: 300, discount_pct: 12, discounted_orders: 9, orders: 40 }),
        // discount_pct ABSENT → masked → "—" (never 0)
        row(["2026-07-02"], ["2 يوليو"], { discounts_total: 200, discounted_orders: 11, orders: 60 }),
      ]),
      [`${KPI},discount_rate_by_cashier@cashier`]: result([
        row(["u1"], ["أحمد"], { discounts_total: 250, discount_pct: 8, discounted_orders: 5, orders: 50 }),
      ]),
    });

    renderPage(<DiscountsPage />, "/reports/sales/discounts");

    await within(await screen.findByTestId("kpi-discounts_total")).findByText("500.00 ر.س");
    expect(screen.getByTestId("discounts-reason-gap")).toBeInTheDocument();
    expectCellTone("12%", "bg-amber-50");
    // the masked day renders an em-dash cell
    const dashCells = screen.getAllByText("—").map((el) => el.closest("td")).filter(Boolean);
    expect(dashCells.length).toBeGreaterThan(0);
    // cashier section rendered too
    expect(screen.getAllByText("أحمد").length).toBeGreaterThan(0);
  });

  it("shows the empty state when the by-day query returns no rows", async () => {
    renderPage(<DiscountsPage />, "/reports/sales/discounts");
    await waitFor(() => expect(document.querySelector('[data-state="empty"]')).toBeInTheDocument());
  });

  it("shows the error state when the analytics query fails", async () => {
    runMock.mockRejectedValue(new Error("boom"));
    renderPage(<DiscountsPage />, "/reports/sales/discounts");
    await waitFor(() => expect(document.querySelector('[data-state="error"]')).toBeInTheDocument());
  });
});

/* ── 11. Voids ───────────────────────────────────────────────── */

describe("Voids page", () => {
  const KPI = "voids_count,voids_value,returns_count,returns_value,qty_returned";
  const DETAIL = "returns_count,returns_value,qty_returned,return_rate_by_cashier,void_rate_by_cashier";
  it("renders KPIs, the by-reason chart table and the reason→cashier table with a warning tone on a high rate", async () => {
    dispatch({
      [`${KPI}@`]: result([], {
        totals: { voids_count: 4, voids_value: 180, returns_count: 6, returns_value: 240, qty_returned: 9 },
      }),
      "returns_count,returns_value,qty_returned@return_reason": result([
        row(["damaged"], ["تالف"], { returns_count: 4, returns_value: 160, qty_returned: 6 }),
      ]),
      [`${DETAIL}@return_reason|cashier`]: result([
        row(["damaged", "u1"], ["تالف", "سارة"], {
          returns_count: 4,
          returns_value: 160,
          qty_returned: 6,
          return_rate_by_cashier: 8,
          void_rate_by_cashier: null,
        }),
      ]),
    });

    renderPage(<VoidsPage />, "/reports/sales/voids");

    await within(await screen.findByTestId("kpi-voids_count")).findByText("4");
    within(screen.getByTestId("kpi-returns_value")).getByText("240.00 ر.س");
    expect(screen.getAllByText("سارة").length).toBeGreaterThan(0);
    expectCellTone("8%", "bg-amber-50");
    // masked void rate reads "—"
    const dashCells = screen.getAllByText("—").map((el) => el.closest("td")).filter(Boolean);
    expect(dashCells.length).toBeGreaterThan(0);
  });

  it("shows the empty state when nothing is returned", async () => {
    renderPage(<VoidsPage />, "/reports/sales/voids");
    await waitFor(() => expect(document.querySelector('[data-state="empty"]')).toBeInTheDocument());
  });

  it("shows the error state when the reason query fails", async () => {
    runMock.mockRejectedValue(new Error("boom"));
    renderPage(<VoidsPage />, "/reports/sales/voids");
    await waitFor(() => expect(document.querySelector('[data-state="error"]')).toBeInTheDocument());
  });
});

/* ── 12. Shifts ──────────────────────────────────────────────── */

describe("Shifts page", () => {
  const M = "till_expected_cash,till_counted,till_variance";
  function seed() {
    dispatch({
      [`${M}@`]: result([], {
        totals: { till_expected_cash: 180, till_counted: 178.25, till_variance: -1.75 },
      }),
      [`${M}@shift`]: result([
        row(["s1"], ["وردية الصباح"], { till_expected_cash: 100, till_counted: 95, till_variance: -5 }),
        row(["s2"], ["وردية المساء"], { till_expected_cash: 80, till_counted: 83.25, till_variance: 3.25 }),
      ]),
      "till_variance@business_day": result([
        row(["2026-07-01"], ["1 يوليو"], { till_variance: -1.75 }),
      ]),
    });
  }

  it("renders KPI totals and per-shift tones: short → negative, over → warning", async () => {
    seed();
    renderPage(<ShiftsPage />, "/reports/sales/shifts");
    await within(await screen.findByTestId("kpi-till_expected_cash")).findByText("180.00 ر.س");
    expectCellTone("-5.00 ر.س", "bg-rose-50");
    expectCellTone("3.25 ر.س", "bg-amber-50");
  });

  it("row click drills to the operational /pos-admin/shifts screen", async () => {
    seed();
    renderPage(<ShiftsPage />, "/reports/sales/shifts");
    const cells = await screen.findAllByText("وردية الصباح");
    fireEvent.click(cells[0]);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/pos-admin/shifts"));
  });

  it("shows empty and error states", async () => {
    renderPage(<ShiftsPage />, "/reports/sales/shifts");
    await waitFor(() => expect(document.querySelector('[data-state="empty"]')).toBeInTheDocument());
    cleanup();
    runMock.mockRejectedValue(new Error("boom"));
    renderPage(<ShiftsPage />, "/reports/sales/shifts");
    await waitFor(() => expect(document.querySelector('[data-state="error"]')).toBeInTheDocument());
  });
});

/* ── 13. Taxes ───────────────────────────────────────────────── */

describe("Taxes page", () => {
  it("renders VAT KPIs with '—' for null tips, plus the by-rate table", async () => {
    dispatch({
      "vat_amount,fees_total,rounding_total,tips_total@": result([], {
        totals: { vat_amount: 150, fees_total: 20, rounding_total: 0.5, tips_total: null },
      }),
      "vat_amount@business_day|vat_category": result([
        row(["2026-07-01", "S"], ["1 يوليو", "قياسية"], { vat_amount: 150 }),
      ]),
      "vat_amount,net_ex_vat@vat_rate": result([
        row(["15"], ["15%"], { vat_amount: 150, net_ex_vat: 1000 }),
      ]),
    });

    renderPage(<TaxesPage />, "/reports/sales/taxes");

    await within(await screen.findByTestId("kpi-vat_amount")).findByText("150.00 ر.س");
    within(screen.getByTestId("kpi-tips_total")).getByText("—");
    expect(screen.getAllByText("15%").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1,000.00 ر.س").length).toBeGreaterThan(0);
  });

  it("shows empty and error states", async () => {
    renderPage(<TaxesPage />, "/reports/sales/taxes");
    await waitFor(() => expect(document.querySelector('[data-state="empty"]')).toBeInTheDocument());
    cleanup();
    runMock.mockRejectedValue(new Error("boom"));
    renderPage(<TaxesPage />, "/reports/sales/taxes");
    await waitFor(() => expect(document.querySelector('[data-state="error"]')).toBeInTheDocument());
  });
});

/* ── 14. Profitability ───────────────────────────────────────── */

describe("Profitability page", () => {
  const M = "qty_sold,net_ex_vat,cogs,gross_profit,margin_pct";
  it("classifies items into menu-engineering quadrants and tones the margin cells", async () => {
    dispatch({
      "net_ex_vat,cogs,gross_profit,margin_pct@": result([], {
        totals: { net_ex_vat: 4000, cogs: 1600, gross_profit: 2400, margin_pct: 60 },
      }),
      [`${M}@menu_item`]: result([
        row(["a"], ["برجر"], { qty_sold: 100, net_ex_vat: 2000, cogs: 800, gross_profit: 1200, margin_pct: 60 }),
        row(["b"], ["شاورما"], { qty_sold: 100, net_ex_vat: 1000, cogs: 900, gross_profit: 100, margin_pct: 10 }),
        row(["c"], ["كنافة"], { qty_sold: 10, net_ex_vat: 800, cogs: 320, gross_profit: 480, margin_pct: 60 }),
        row(["d"], ["سلطة"], { qty_sold: 10, net_ex_vat: 200, cogs: 180, gross_profit: 20, margin_pct: 10 }),
      ]),
    });

    renderPage(<ProfitabilityPage />, "/reports/sales/profitability");

    await within(await screen.findByTestId("kpi-gross_profit")).findByText("2,400.00 ر.س");
    // one item per quadrant (ar labels — the default language)
    expect(screen.getAllByText("نجوم").length).toBeGreaterThan(0);
    expect(screen.getAllByText("أحصنة عمل").length).toBeGreaterThan(0);
    expect(screen.getAllByText("ألغاز").length).toBeGreaterThan(0);
    expect(screen.getAllByText("خاسرة").length).toBeGreaterThan(0);
    // star margin cell → positive tone; dog margin cell → negative tone
    expectCellTone("60%", "bg-emerald-50");
    expectCellTone("10%", "bg-rose-50");
  });

  it("masks cogs as '—' and shows the cost-provenance notice when cogs is masked", async () => {
    dispatch({
      [`${M}@menu_item`]: result(
        [row(["a"], ["برجر"], { qty_sold: 100, net_ex_vat: 2000 })],
        { meta: { freshness: { watermark: null }, maskedMetrics: ["cogs"] } },
      ),
    });
    renderPage(<ProfitabilityPage />, "/reports/sales/profitability");
    await screen.findByTestId("cost-provenance-notice");
    const dashCells = screen.getAllByText("—").map((el) => el.closest("td")).filter(Boolean);
    expect(dashCells.length).toBeGreaterThan(0);
  });

  it("shows empty and error states", async () => {
    renderPage(<ProfitabilityPage />, "/reports/sales/profitability");
    await waitFor(() => expect(document.querySelector('[data-state="empty"]')).toBeInTheDocument());
    cleanup();
    runMock.mockRejectedValue(new Error("boom"));
    renderPage(<ProfitabilityPage />, "/reports/sales/profitability");
    await waitFor(() => expect(document.querySelector('[data-state="error"]')).toBeInTheDocument());
  });
});

/* ── 15. Reconciliation ──────────────────────────────────────── */

describe("Reconciliation page", () => {
  function seed() {
    dispatch({
      "invoice_total,orders@business_day": result([
        row(["2026-07-01"], ["1 يوليو"], { invoice_total: 100, orders: 5 }),
        row(["2026-07-02"], ["2 يوليو"], { invoice_total: 200, orders: 8 }),
      ]),
      "payments_in,refunds_out@business_day": result([
        row(["2026-07-01"], ["1 يوليو"], { payments_in: 100, refunds_out: 0 }),
        row(["2026-07-02"], ["2 يوليو"], { payments_in: 150, refunds_out: 0 }),
      ]),
      "till_expected_cash,till_counted@business_day": result([
        row(["2026-07-01"], ["1 يوليو"], { till_expected_cash: 50, till_counted: 50 }),
        row(["2026-07-02"], ["2 يوليو"], { till_expected_cash: 80, till_counted: 70 }),
      ]),
    });
  }

  it("merges the three queries, computes the deltas, tones the mismatch day and counts one exception day", async () => {
    seed();
    renderPage(<ReconciliationPage />, "/reports/sales/reconciliation");

    // mismatch day: collections 150 − sales 200 = −50; till 70 − 80 = −10
    await waitFor(() => expect(screen.getAllByText("-50.00 ر.س").length).toBeGreaterThan(0));
    expectCellTone("-50.00 ر.س", "bg-rose-50");
    expectCellTone("-10.00 ر.س", "bg-rose-50");
    // the balanced day's delta is NOT toned
    const zeroCells = screen
      .getAllByText("0.00 ر.س")
      .map((el) => el.closest("td"))
      .filter((td): td is HTMLTableCellElement => !!td);
    expect(zeroCells.some((td) => td.className.includes("bg-rose-50"))).toBe(false);
    // exactly ONE exception day (both deltas live on the same day)
    within(screen.getByTestId("kpi-exception-days")).getByText("1");
  });

  it("fails the whole page when ANY of the three queries fails", async () => {
    runMock.mockImplementation(async (body: AnalyticsQueryBody) => {
      if (body.metrics.includes("till_expected_cash")) throw new Error("boom");
      return EMPTY;
    });
    renderPage(<ReconciliationPage />, "/reports/sales/reconciliation");
    await waitFor(() => expect(document.querySelector('[data-state="error"]')).toBeInTheDocument());
  });

  it("shows the empty state when all three queries return no rows", async () => {
    renderPage(<ReconciliationPage />, "/reports/sales/reconciliation");
    await waitFor(() => expect(document.querySelector('[data-state="empty"]')).toBeInTheDocument());
  });
});

/* ── 16. Builder ─────────────────────────────────────────────── */

describe("Builder page", () => {
  beforeEach(() => {
    registryMock.mockResolvedValue({
      metrics: [
        { id: "orders", kind: "additive", format: "count" },
        { id: "net_ex_vat", kind: "additive", format: "money" },
      ],
      dimensions: [
        { id: "business_day", kind: "time", groupable: true },
        { id: "branch", kind: "scope", groupable: true },
      ],
    });
  });

  it("fires the query ONLY after Run, then renders the pivot result", async () => {
    dispatch({
      "orders@business_day": result([
        row(["2026-07-01"], ["1 يوليو"], { orders: 42 }),
      ]),
    });

    renderPage(<BuilderPage />, "/reports/sales/builder?b_m=orders&b_d1=business_day");

    // run-gated: no analytics query before the Run click
    const runBtn = await screen.findByTestId("builder-run");
    await waitFor(() => expect(runBtn).toBeEnabled());
    expect(runMock).not.toHaveBeenCalled();

    fireEvent.click(runBtn);
    await waitFor(() => expect(runMock).toHaveBeenCalledTimes(1));
    expect(runMock.mock.calls[0][0]).toMatchObject({
      metrics: ["orders"],
      dimensions: ["business_day"],
      limit: 10,
    });
    expect((await screen.findAllByText("1 يوليو")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("42").length).toBeGreaterThan(0);
  });

  it("renders the save-view/schedule buttons disabled (next wave)", async () => {
    renderPage(<BuilderPage />, "/reports/sales/builder");
    expect(await screen.findByTestId("builder-save")).toBeDisabled();
    expect(screen.getByTestId("builder-schedule")).toBeDisabled();
  });

  it("shows the error state when the run fails", async () => {
    runMock.mockRejectedValue(new Error("boom"));
    renderPage(<BuilderPage />, "/reports/sales/builder?b_m=orders&b_d1=business_day");
    fireEvent.click(await screen.findByTestId("builder-run"));
    await waitFor(() => expect(document.querySelector('[data-state="error"]')).toBeInTheDocument());
  });
});
