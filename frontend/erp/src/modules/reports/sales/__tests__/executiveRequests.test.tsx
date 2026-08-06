// HOW MANY ROUND-TRIPS THE EXECUTIVE REPORT COSTS.
//
// The executive summary is the hub's landing page: it is the first screen every
// analyst opens, on every visit. It used to issue SIX independent
// POST /analytics/query calls — three dimensionless metric groups, the daily
// detail, the tax split and the collections split — which is six planner runs,
// six connection round-trips and six chances for one of them to be the slow one
// while the other five sit rendered beside it.
//
// WHAT CAN AND CANNOT BE MERGED
//   The planner groups by a request's `dimensions`, so two panels can share a
//   request only when they want the SAME grouping. The three dimensionless
//   groups all want none — but they cannot simply be concatenated either:
//   MAX_METRICS is 12, and a voids_* metric drops the void exclusion for every
//   metric on its own fact statement (planner.js:356), so the void group must
//   stay apart from the order-population group whatever else happens.
//
//   That leaves a hard floor of FOUR requests:
//     1. the statement + counts, dimensionless   (≤ 12 metrics, no void metric)
//     2. the void/profit group, dimensionless    (isolated by the void rule)
//     3. the daily detail                        (grouped by day)
//     4. tax + collections                       (grouped by vat_category and
//                                                 payment_method — two DIFFERENT
//                                                 groupings, so still two)
//   …which is five. The count below is the honest measured number, and the
//   comment above is why it is not one.
import { render, waitFor, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/i18n";
import Executive from "../pages/Executive";
import type { AnalyticsQueryBody } from "../lib/api";
import { LIMITS, METRIC_FACTS, VOID_LIFTING_METRICS } from "../lib/contract";

const { calls, REGISTRY } = vi.hoisted(() => ({
  calls: [] as Array<{ metrics: string[]; dimensions: string[] }>,
  REGISTRY: { metrics: [], dimensions: [] },
}));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    fetchAnalyticsRegistry: vi.fn(async () => REGISTRY as never),
    runAnalyticsQuery: vi.fn(async (body: AnalyticsQueryBody) => {
      calls.push({ metrics: [...body.metrics], dimensions: [...body.dimensions] });
      const keys = body.dimensions.length > 0 ? ["fixture"] : [];
      return {
        columns: [],
        rows: [{ keys, labels: keys, values: Object.fromEntries(body.metrics.map((metric) => [metric, 1])) }],
        totals: Object.fromEntries(body.metrics.map((metric) => [metric, 1])),
        meta: { freshness: { watermark: null }, maskedMetrics: [] },
      } as never;
    }),
  };
});

vi.mock("@/shared/permissions", () => ({
  useCan: () => true,
  usePermissions: () => ({ can: () => true }),
  Can: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function renderExecutive() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <MemoryRouter initialEntries={["/reports/sales/executive"]}>
          <Executive />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

/**
 * Wait until the page has stopped issuing requests.
 *
 * Counting after a fixed wait would be a race that reports whatever number the
 * machine happened to reach; counting after the FIRST call would report 1. This
 * polls until the count holds still across three ticks, which is the only
 * honest way to say "this is how many it issues".
 */
async function settle() {
  await waitFor(() => expect(calls.length).toBeGreaterThan(0));
  let stable = 0;
  let last = -1;
  while (stable < 3) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 40));
    if (calls.length === last) stable += 1;
    else {
      stable = 0;
      last = calls.length;
    }
  }
}

afterEach(() => {
  calls.length = 0;
  cleanup();
});

describe("the executive report's round-trip budget", () => {
  it("issues five statement requests plus one active driver request", async () => {
    renderExecutive();
    await settle();
    const unique = new Set(calls.map((c) => `${c.dimensions.join("|")}::${c.metrics.join("|")}`));
    expect(
      unique.size,
      `executive issued ${unique.size} distinct requests: ` +
        [...unique].map((k) => k.split("::")[0] || "(no grouping)").join(" / "),
    ).toBe(6);
  }, 20000);

  it("no request exceeds the planner's metric ceiling", async () => {
    renderExecutive();
    await settle();
    for (const c of calls) {
      expect(c.metrics.length, c.metrics.join(",")).toBeLessThanOrEqual(LIMITS.MAX_METRICS);
    }
  }, 20000);

  it("the merge did not put a void metric back beside the order population", async () => {
    renderExecutive();
    await settle();
    for (const c of calls) {
      const voids = c.metrics.filter((m) => VOID_LIFTING_METRICS.includes(m));
      if (voids.length === 0) continue;
      const orderPopulation = c.metrics.filter(
        (m) => !VOID_LIFTING_METRICS.includes(m) && (METRIC_FACTS[m] ?? []).includes("order"),
      );
      expect(
        orderPopulation,
        `${voids.join("+")} shares a request with ${orderPopulation.join(", ")} — ` +
          "the planner drops the void exclusion for those too",
      ).toEqual([]);
    }
  }, 20000);

  it("every figure the statement renders is still requested somewhere", async () => {
    renderExecutive();
    await settle();
    const asked = new Set(calls.flatMap((c) => c.metrics));
    // A consolidation that dropped a line would also drop a request — this is
    // what stops the count above from being met by deletion.
    for (const m of [
      "sales_before_discount", "discounts_total", "gross_product_sales", "net_ex_vat",
      "vat_amount", "returns_net", "returns_vat", "returns_value", "net_product_sales",
      "net_product_sales_ex_vat", "invoice_total", "statement_variance",
      "orders", "avg_ticket", "qty_sold", "avg_items_per_order", "guests",
      "fees_total", "rounding_total", "returns_count", "payments_in", "refunds_out",
      "voids_count", "voids_value", "net_collections",
      "cogs_after_returns", "gross_profit_after_returns", "margin_pct_after_returns",
      "uncosted_net", "uncosted_returns_net",
    ]) {
      expect(asked, `metric ${m} is no longer requested`).toContain(m);
    }
  }, 20000);
});
