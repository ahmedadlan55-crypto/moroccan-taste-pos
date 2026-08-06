import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/i18n";
import Executive from "../pages/Executive";
import type { AnalyticsQueryBody, AnalyticsResult, AnalyticsResultRow } from "../lib/api";

const CURRENT: Record<string, number> = {
  gross_product_sales: 1_000,
  net_ex_vat: 900,
  returns_net: 100,
  returns_value: 115,
  returns_vat: 15,
  net_product_sales: 885,
  net_product_sales_ex_vat: 800,
  invoice_total: 1_000,
  statement_variance: 5,
  orders: 10,
  avg_ticket: 90,
  discounts_total: 20,
  vat_amount: 100,
  qty_sold: 20,
  avg_items_per_order: 2,
  guests: 10,
  fees_total: 0,
  rounding_total: 0,
  returns_count: 1,
  voids_count: 1,
  voids_value: 25,
  payments_in: 1_000,
  refunds_out: 50,
  net_collections: 950,
  cogs_after_returns: 500,
  gross_profit_after_returns: 300,
  margin_pct_after_returns: 37.5,
  uncosted_net: 20,
  uncosted_returns_net: 0,
};

function select(metrics: string[]): Record<string, number> {
  return Object.fromEntries(metrics.filter((metric) => CURRENT[metric] != null).map((metric) => [metric, CURRENT[metric]]));
}

function compared(values: Record<string, number>, pct = -41.25): Pick<AnalyticsResultRow, "compare" | "delta" | "deltaAbs"> {
  return {
    compare: Object.fromEntries(Object.entries(values).map(([metric, value]) => [metric, value + 100])),
    delta: Object.fromEntries(Object.keys(values).map((metric) => [metric, pct])),
    deltaAbs: Object.fromEntries(Object.keys(values).map((metric) => [metric, -100])),
  };
}

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    fetchAnalyticsRegistry: vi.fn(async () => ({ metrics: [], dimensions: [] })),
    runAnalyticsQuery: vi.fn(async (body: AnalyticsQueryBody): Promise<AnalyticsResult> => {
      const dimension = body.dimensions.join(",");
      if (dimension === "branch") {
        const rows: AnalyticsResultRow[] = [
          { keys: ["B1"], labels: ["Branch A"], values: { net_ex_vat: 300, orders: 3 }, compare: { net_ex_vat: 100, orders: 2 }, delta: { net_ex_vat: 200, orders: 50 }, deltaAbs: { net_ex_vat: 200, orders: 1 } },
          { keys: ["B2"], labels: ["Branch B"], values: { net_ex_vat: 500, orders: 5 }, compare: { net_ex_vat: 600, orders: 6 }, delta: { net_ex_vat: -16.67, orders: -16.67 }, deltaAbs: { net_ex_vat: -100, orders: -1 } },
          { keys: ["B3"], labels: ["Branch C"], values: { net_ex_vat: 400, orders: 2 }, compare: { net_ex_vat: 300, orders: 4 }, delta: { net_ex_vat: 33.33, orders: -50 }, deltaAbs: { net_ex_vat: 100, orders: -2 } },
        ];
        return { columns: [], rows, totals: { net_ex_vat: 1_200, orders: 10 }, meta: { freshness: { watermark: null }, maskedMetrics: [] } };
      }

      const values = select(body.metrics);
      const comparison = body.compare ? compared(values) : {};
      if (dimension === "business_day") {
        const firstValues = { ...values, net_ex_vat: 650, orders: 7, avg_ticket: 92 };
        const secondValues = { ...values, net_ex_vat: 250, orders: 3, avg_ticket: 83 };
        return {
          columns: [],
          rows: [
            { keys: ["2026-08-01"], labels: ["2026-08-01"], values: firstValues, ...comparison },
            { keys: ["2026-08-02"], labels: ["2026-08-02"], values: secondValues, ...comparison },
          ],
          totals: values,
          ...(body.compare ? { totalsCompare: comparison.compare, totalsDelta: comparison.delta, totalsDeltaAbs: comparison.deltaAbs } : {}),
          meta: { freshness: { watermark: "2026-08-06T12:00:00Z", pendingDays: 2 }, maskedMetrics: [] },
        };
      }

      return {
        columns: [],
        rows: [{ keys: dimension ? [dimension] : [], labels: dimension ? [dimension] : [], values, ...comparison }],
        totals: values,
        ...(body.compare ? { totalsCompare: comparison.compare, totalsDelta: comparison.delta, totalsDeltaAbs: comparison.deltaAbs } : {}),
        meta: { freshness: { watermark: "2026-08-06T12:00:00Z", pendingDays: 2 }, maskedMetrics: [] },
      };
    }),
  };
});

vi.mock("@/shared/permissions", () => ({
  useCan: () => true,
  usePermissions: () => ({ can: () => true }),
  Can: ({ children }: { children: import("react").ReactNode }) => <>{children}</>,
}));

function renderCommand() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <MemoryRouter initialEntries={["/reports/sales/executive?compare=prevPeriod&from=2026-08-01&to=2026-08-06&preset=custom"]}>
          <Executive />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem("erp_lang", "en");
});

afterEach(cleanup);

describe("executive decision command center", () => {
  it("renders the server delta rather than deriving a percentage from rounded values", async () => {
    renderCommand();
    const netSales = await screen.findByTestId("kpi-row").then((row) => row.querySelector('[data-kpi-id="net_sales"]'));
    expect(netSales).not.toBeNull();
    expect(netSales?.textContent).toContain("-41.25%");
    expect(netSales?.textContent).not.toContain("-11.11%");
  });

  it("turns control failures and proven declines into direct attention signals", async () => {
    renderCommand();
    await screen.findByTestId("decision-signals");
    for (const id of [
      "statement-variance",
      "settlement-difference",
      "uncosted-sales",
      "pending-days",
      "sales-decline",
      "orders-decline",
    ]) {
      expect(document.querySelector(`[data-signal-id="${id}"]`), id).not.toBeNull();
    }
  });

  it("ranks one active driver dimension and exposes the period pulse without extra dimension fan-out", async () => {
    renderCommand();
    await waitFor(() => expect(document.querySelector('[data-driver-rank="leader"]')).not.toBeNull());
    expect(document.querySelector('[data-driver-rank="leader"]')?.textContent).toContain("Branch B");
    expect(document.querySelector('[data-driver-rank="gain"]')?.textContent).toContain("Branch A");
    expect(document.querySelector('[data-driver-rank="decline"]')?.textContent).toContain("Branch B");
    expect(document.querySelector('[data-insight-id="best-sales-day"]')?.textContent).toContain("2026-08-01");
    expect(document.querySelector('[data-insight-id="weakest-sales-day"]')?.textContent).toContain("2026-08-02");
  });
});
