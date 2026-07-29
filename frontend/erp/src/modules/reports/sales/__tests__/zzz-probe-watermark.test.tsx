// TEMPORARY REFUTATION PROBE — delete after running.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/i18n";
import { PrintArea } from "@/modules/accounting/components";
import type { AnalyticsQueryBody, AnalyticsResult } from "../lib/api";
import Executive from "../pages/Executive";
import { BasisOfPreparation } from "../components/BasisOfPreparation";
import type { AnalyticsFilters } from "../lib/filters";

const WATERMARK = "2026-07-31T21:00:00.000Z";

const { REGISTRY, makeResult } = vi.hoisted(() => {
  const TOTALS: Record<string, number> = {
    net_ex_vat: 1000, gross_product_sales: 1500, orders: 40, avg_ticket: 25,
    discounts_total: 60, refunds_out: 30, payments_in: 1200, net_collections: 1170,
    tips_total: 12, qty_sold: 500, avg_items_per_order: 3, guests: 90,
    returns_net: 40, returns_count: 4, returns_value: 45, voids_count: 2, voids_value: 20,
    vat_amount: 150, fees_total: 10, rounding_total: 0.25, invoice_total: 1160.25,
    cogs: 400, gross_profit: 600, margin_pct: 60, growth: 5, item_contribution_pct: 100,
  };
  function values(metrics: string[]) {
    const out: Record<string, number | null> = {};
    for (const m of metrics) if (TOTALS[m] != null) out[m] = TOTALS[m];
    return out;
  }
  function makeResult(body: { metrics: string[]; dimensions: string[] }) {
    const keys = body.dimensions.map((_, i) => `k${i}`);
    const labels = body.dimensions.map((d, i) => `${d}-label-${i}`);
    return {
      columns: [],
      rows: body.dimensions.length ? [{ keys, labels, values: values(body.metrics) }] : [{ keys: [], labels: [], values: values(body.metrics) }],
      totals: values(body.metrics),
      meta: {
        freshness: { watermark: "2026-07-31T21:00:00.000Z" },
        maskedMetrics: [],
        completeness: { complete: true },
      },
    };
  }
  const REGISTRY = {
    metrics: Object.keys(TOTALS).map((id) => ({ id, kind: "additive", format: "money", equationKey: "sum" })),
    dimensions: [],
  };
  return { REGISTRY, makeResult };
});

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    fetchAnalyticsRegistry: vi.fn(async () => REGISTRY as unknown as import("../lib/api").AnalyticsRegistry),
    runAnalyticsQuery: vi.fn(async (body: AnalyticsQueryBody): Promise<AnalyticsResult> =>
      makeResult(body as unknown as { metrics: string[]; dimensions: string[] }) as unknown as AnalyticsResult),
  };
});

afterEach(cleanup);

describe("probe: does the PRINTED executive report carry a data-as-of stamp?", () => {
  it("renders exactly what the hub renders inside PrintArea", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const filters = {
      from: "2026-07-01", to: "2026-07-31", businessDay: true, taxIncl: false,
      brandId: [], branchId: [], channel: [], orderType: [], preset: "lastMonth",
    } as unknown as AnalyticsFilters;
    const { container } = render(
      <QueryClientProvider client={client}>
        <I18nProvider>
          <MemoryRouter initialEntries={["/reports/sales/executive"]}>
            {/* EXACTLY the hub's structure: SalesAnalyticsHub.tsx:151-167 */}
            <PrintArea>
              <Executive />
              <div className="mt-4">
                <BasisOfPreparation filters={filters} />
              </div>
            </PrintArea>
          </M