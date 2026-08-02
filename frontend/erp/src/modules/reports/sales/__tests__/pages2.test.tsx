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
  type ReconciliationData,
  type ReconciliationRow,
  fetchAnalyticsRegistry,
  fetchReconciliation,
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
  return {
    ...actual,
    runAnalyticsQuery: vi.fn(),
    fetchAnalyticsRegistry: vi.fn(),
    fetchReconciliation: vi.fn(),
  };
});

vi.mock("@/modules/sales/lib/api", () => ({
  o2cApi: { invoices: vi.fn() },
}));

// Page-level capability gate (Reconciliation caps on analytics.reconciliation.view).
// Mutable map so individual tests can revoke a cap; reset in beforeEach.
const caps: Record<string, boolean> = {};
vi.mock("@/shared/permissions", () => ({
  useCan: (cap: string) => caps[cap] ?? false,
  usePermissions: () => ({ can: (cap: string) => caps[cap] ?? false }),
}));

const runMock = vi.mocked(runAnalyticsQuery);
const registryMock = vi.mocked(fetchAnalyticsRegistry);
const reconciliationMock = vi.mocked(fetchReconciliation);
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
  reconciliationMock.mockReset();
  invoicesMock.mockReset();
  runMock.mockResolvedValue(EMPTY);
  for (const k of Object.keys(caps)) delete caps[k];
  caps["analytics.reconciliation.view"] = true;
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
  const REASON = "discounts_total,discounted_orders,orders";
  it("renders KPIs, the by-day table with a warning tone on high discount_pct, '—' for a masked cell, and the by-reason table", async () => {
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
      // discount_reason is projector-backed now (order fact); the rate is NOT
      // computable at that grain, so the request carries order-fact metrics only.
      [`${REASON}@discount_reason`]: result([
        row(["عرض الافتتاح"], ["عرض الافتتاح"], { discounts_total: 180, discounted_orders: 6, orders: 30 }),
        row([null], [""], { discounts_total: 320, discounted_orders: 14, orders: 70 }),
      ]),
    });

    renderPage(<DiscountsPage />, "/reports/sales/discounts");

    await within(await screen.findByTestId("kpi-discounts_total")).findByText("500.00 ر.س");
    // The named-discount table replaced the "no such dimension" banner.
    expect(screen.getAllByText("عرض الافتتاح").length).toBeGreaterThan(0);
    // …and the NULL bucket is labelled, not dropped: without it the reasons
    // would appear to add up to the period total when they do not.
    expect(screen.getAllByText("بلا خصم مُسمّى").length).toBeGreaterThan(0);
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
  // Plannable per-cashier detail (E2E-wave fix): ORDER-fact void measures by
  // cashier — the old return-fact × [return_reason, cashier] grouping is
  // impossible on the real planner (no fact carries both dimensions).
  const DETAIL = "voids_count,voids_value,void_rate_by_cashier";
  it("renders KPIs, the by-reason chart table and the per-cashier voids table with a warning tone on a high rate", async () => {
    dispatch({
      [`${KPI}@`]: result([], {
        totals: { voids_count: 4, voids_value: 180, returns_count: 6, returns_value: 240, qty_returned: 9 },
      }),
      "returns_count,returns_value,qty_returned@return_reason": result([
        row(["damaged"], ["تالف"], { returns_count: 4, returns_value: 160, qty_returned: 6 }),
      ]),
      [`${DETAIL}@cashier`]: result([
        row(["u1"], ["سارة"], {
          voids_count: 3,
          voids_value: 120,
          void_rate_by_cashier: 8,
        }),
        row(["u2"], ["أحمد"], {
          voids_count: 1,
          voids_value: 40,
          void_rate_by_cashier: null, // masked/incomputable reads "—", never 0
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
    // one item per quadrant (ar labels from salesReports.profitability.quadrants.*)
    expect(screen.getAllByText("النجوم").length).toBeGreaterThan(0);
    expect(screen.getAllByText("الأحصنة العاملة").length).toBeGreaterThan(0);
    expect(screen.getAllByText("الألغاز").length).toBeGreaterThan(0);
    expect(screen.getAllByText("الأصناف الراكدة").length).toBeGreaterThan(0);
    // star margin cell → positive tone; dog margin cell → negative tone
    expectCellTone("60%", "bg-emerald-50");
    expectCellTone("10%", "bg-rose-50");
  });

  // An item with neither a recipe nor a manual cost snapshots cost 0.00, which
  // the server turns into margin_pct = 100. Unguarded, that item lands top-right
  // of the quadrant grid and is labelled a STAR — the page tells the owner to
  // push the one item it understands least. It also drags BOTH medians, which
  // re-classifies every other item around it. This pins both effects.
  it("never crowns an uncosted item a Star, and keeps it out of the medians", async () => {
    dispatch({
      [`${M}@menu_item`]: result([
        row(["a"], ["برجر"], { qty_sold: 100, net_ex_vat: 2000, cogs: 800, gross_profit: 1200, margin_pct: 60 }),
        row(["b"], ["شاورما"], { qty_sold: 80, net_ex_vat: 1000, cogs: 900, gross_profit: 100, margin_pct: 5 }),
        // no recipe, no manual cost → cost_snapshot 0.00 → phantom 100% margin
        row(["c"], ["ماء"], { qty_sold: 90, net_ex_vat: 1000, cogs: 0, gross_profit: 1000, margin_pct: 100 }),
        row(["d"], ["سلطة"], { qty_sold: 10, net_ex_vat: 200, cogs: 180, gross_profit: 20, margin_pct: 15 }),
      ]),
    });

    renderPage(<ProfitabilityPage />, "/reports/sales/profitability");
    await screen.findAllByText("ماء");

    // DataTable renders a desktop <table> AND a mobile card list, so every label
    // matches more than once — scope each assertion to the real table row.
    const tableRow = (label: string): HTMLElement => {
      const tr = screen
        .getAllByText(label)
        .map((el) => el.closest("tr"))
        .find((el): el is HTMLTableRowElement => !!el);
      expect(tr, `no table row for ${label}`).toBeTruthy();
      return tr as HTMLElement;
    };

    // 1. The uncosted item is flagged and left unclassified.
    const uncosted = tableRow("ماء");
    expect(within(uncosted).getByText("تكلفة غير مُعرَّفة")).toBeInTheDocument();
    expect(within(uncosted).queryByText("النجوم")).not.toBeInTheDocument();
    // Cost / profit / margin are blanked — by CELL, not by text: net_ex_vat is
    // still 1,000.00 and legitimately printed, because revenue IS known. It is
    // only the three cost-derived columns that the system cannot stand behind.
    // Columns: item | qty | net | cogs | profit | margin | class.
    const cells = within(uncosted).getAllByRole("cell");
    expect(cells[2]).toHaveTextContent("1,000.00"); // net — known, still shown
    expect(cells[3]).toHaveTextContent("—"); // cogs (+ the badge asserted above)
    expect(cells[4]).toHaveTextContent("—"); // gross_profit, NOT 1,000.00
    expect(cells[5]).toHaveTextContent("—"); // margin_pct, NOT 100%
    expect(cells[5]).not.toHaveTextContent("100%");
    expect(cells[6]).toHaveTextContent("—"); // quadrant class — unclassified

    // 2. Exactly one item is a Star in the table — the phantom would make two.
    const starRows = screen
      .getAllByText("النجوم")
      .map((el) => el.closest("tr"))
      .filter((el): el is HTMLTableRowElement => !!el);
    expect(starRows).toHaveLength(1);
    expect(starRows[0]).toBe(tableRow("برجر"));

    // 3. Medians are computed WITHOUT it: with the phantom in the sample the
    //    margin median rises from 15 to 37.5 and شاورما is demoted to a Dog.
    expect(within(tableRow("شاورما")).getByText("الأحصنة العاملة")).toBeInTheDocument();

    // 4. The KPI cards sum the whole window, so the gap is named explicitly.
    await screen.findByTestId("uncosted-notice");
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
  function recRow(overrides: Partial<ReconciliationRow> & { business_day: string }): ReconciliationRow {
    return {
      branch_id: "b1",
      sales: { orders: 0, invoice_total: 0, documentIds: [], documentIdsTotal: 0 },
      payments: { in: 0, out: 0, net: 0, factIds: [], factIdsTotal: 0 },
      till: { expected_cash: null, counted: null },
      deltas: { salesVsPayments: null, cashExpectedVsCounted: null },
      exceptions: {
        paymentsWithoutOrder: { count: 0, factIds: [] },
        ordersWithoutPayment: { count: 0, documentIds: [] },
      },
      ...overrides,
    };
  }

  /** One balanced day + one mismatch day (both deltas + both exception drills). */
  function seed(): ReconciliationData {
    const data: ReconciliationData = {
      rows: [
        recRow({
          business_day: "2026-07-01",
          sales: { orders: 5, invoice_total: 100, documentIds: ["ok1"], documentIdsTotal: 5 },
          payments: { in: 100, out: 0, net: 100, factIds: [1], factIdsTotal: 1 },
          till: { expected_cash: 50, counted: 50 },
          deltas: { salesVsPayments: 0, cashExpectedVsCounted: 0 },
        }),
        recRow({
          business_day: "2026-07-02",
          sales: { orders: 8, invoice_total: 200, documentIds: ["doc9"], documentIdsTotal: 8 },
          payments: { in: 150, out: 0, net: 150, factIds: [2], factIdsTotal: 1 },
          till: { expected_cash: 80, counted: 70 },
          deltas: { salesVsPayments: 50, cashExpectedVsCounted: 10 },
          exceptions: {
            paymentsWithoutOrder: { count: 1, factIds: [77] },
            ordersWithoutPayment: { count: 1, documentIds: ["doc9"] },
          },
        }),
      ],
      totals: { salesVsPayments: 50, cashExpectedVsCounted: 10, paymentsWithoutOrder: 1, ordersWithoutPayment: 1 },
    };
    reconciliationMock.mockResolvedValue(data);
    return data;
  }

  it("renders the server rows, tones the mismatch deltas, and counts one exception day", async () => {
    seed();
    renderPage(<ReconciliationPage />, "/reports/sales/reconciliation");

    // server-computed deltas: salesVsPayments 50, till 10 — both toned on the mismatch day
    await waitFor(() => expect(screen.getAllByText("50.00 ر.س").length).toBeGreaterThan(0));
    expectCellTone("50.00 ر.س", "bg-rose-50");
    expectCellTone("10.00 ر.س", "bg-rose-50");
    // the balanced day's zero delta is NOT toned
    const zeroCells = screen
      .getAllByText("0.00 ر.س")
      .map((el) => el.closest("td"))
      .filter((td): td is HTMLTableCellElement => !!td);
    expect(zeroCells.length).toBeGreaterThan(0);
    expect(zeroCells.some((td) => td.className.includes("bg-rose-50"))).toBe(false);
    // exactly ONE exception day (deltas + drills all live on 07-02)
    within(screen.getByTestId("kpi-exception-days")).getByText("1");
    // and the fetch carried the URL range through
    expect(reconciliationMock).toHaveBeenCalledWith(
      expect.objectContaining({ from: expect.any(String), to: expect.any(String) }),
      expect.anything(),
    );
  });

  it("renders the exception drill: order ids link to /sales/invoices?doc=, payment fact ids listed", async () => {
    seed();
    renderPage(<ReconciliationPage />, "/reports/sales/reconciliation");

    await screen.findByTestId("reconciliation-exceptions");
    const orders = screen.getByTestId("exception-orders-without-payment");
    const link = within(orders).getByRole("link", { name: "doc9" });
    expect(link).toHaveAttribute("href", expect.stringContaining("/sales/invoices?doc=doc9"));
    const pays = screen.getByTestId("exception-payments-without-order");
    within(pays).getByText("77");
  });

  it("renders PermissionDenied without analytics.reconciliation.view and never fetches", async () => {
    caps["analytics.reconciliation.view"] = false;
    seed();
    renderPage(<ReconciliationPage />, "/reports/sales/reconciliation");
    expect(document.querySelector('[data-state="permission-denied"]')).toBeInTheDocument();
    expect(reconciliationMock).not.toHaveBeenCalled();
  });

  it("shows the error state when the reconciliation call fails", async () => {
    reconciliationMock.mockRejectedValue(new Error("boom"));
    renderPage(<ReconciliationPage />, "/reports/sales/reconciliation");
    await waitFor(() => expect(document.querySelector('[data-state="error"]')).toBeInTheDocument());
  });

  it("shows the empty state when the server returns no rows", async () => {
    reconciliationMock.mockResolvedValue({
      rows: [],
      totals: { salesVsPayments: null, cashExpectedVsCounted: null, paymentsWithoutOrder: 0, ordersWithoutPayment: 0 },
    });
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
