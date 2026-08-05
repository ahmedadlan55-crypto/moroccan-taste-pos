// Sales Analytics Hub — the executive SALES STATEMENT must foot ON SCREEN.
//
// tests/analyticsStatementLadder.test.js pins the arithmetic in the registry
// and the equations. This file pins the other half: that the page puts the
// right metric on the right line. Those are separate failures — the statement
// that shipped was assembled from four metrics that were each individually
// correct, and it still printed a subtraction whose result was not the number
// printed beneath it, because the operands were on three different tax bases:
//   • gross_product_sales — Σ d.gross_amount — is tax-INCLUSIVE and already net
//     of the discount (lineAllocation.js:263 / calculations.js:138),
//   • discounts_total — Σ f.discount_total — is tax-INCLUSIVE and had ALREADY
//     been removed from the line above it,
//   • returns_net — Σ rl.net_amount — is EX-VAT,
//   • fees_total is money that never entered the invoice total, and
//     rounding_total is a column the projection writes as a literal 0.
//
// The fixture is the live e2e seed period (tests/fixtures/salesHubSeed.js
// EXPECTED.TOTAL) so the numbers here and the numbers a reviewer sees in the
// browser against the seeded database are the same numbers.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/i18n";
import type { AnalyticsQueryBody, AnalyticsResult } from "../lib/api";
import Executive from "../pages/Executive";

const { TOTALS, REGISTRY, COST_STATE } = vi.hoisted(() => ({
  /**
   * salesHubSeed EXPECTED.TOTAL, extended with the statement metrics:
   *   sales_before_discount     1071.50 + 15.75          = 1087.25
   *   returns_vat               262.50 − 240.00          =   22.50
   *   net_product_sales         1071.50 − 262.50         =  809.00
   *   net_product_sales_ex_vat   950.00 − 240.00         =  710.00
   *   statement_variance        1071.50 − 1071.50        =    0.00
   * The seed contains a zero-rated line, so VAT is 121.50 on a 950.00 base —
   * 12.8%, not 15% — and a ladder that assumed one rate would not foot here.
   */
  TOTALS: {
    gross_product_sales: 1071.5,
    discounts_total: 15.75,
    sales_before_discount: 1087.25,
    net_ex_vat: 950,
    vat_amount: 121.5,
    returns_net: 240,
    returns_vat: 22.5,
    returns_value: 262.5,
    net_product_sales: 809,
    net_product_sales_ex_vat: 710,
    invoice_total: 1071.5,
    statement_variance: 0,
    orders: 8,
    avg_ticket: 118.75,
    qty_sold: 15,
    avg_items_per_order: 1.88,
    guests: 3,
    // Deliberately NON-ZERO: these two are the figures the old ladder added to
    // reach the invoice total. If either ever reappears as an operand, the
    // footing assertions below break by exactly their value.
    fees_total: 7,
    rounding_total: 0.25,
    returns_count: 3,
    voids_count: 1,
    voids_value: 57.5,
    payments_in: 1071.5,
    refunds_out: 262.5,
    net_collections: 809,
    cogs: 365,
    gross_profit: 585,
    margin_pct: 61.58,
    returns_cogs: 80,
    cogs_after_returns: 285,
    gross_profit_after_returns: 425,
    margin_pct_after_returns: 59.86,
    uncosted_net: 0,
    uncosted_returns_net: 0,
  } as Record<string, number>,
  REGISTRY: { metrics: [], dimensions: [] },
  COST_STATE: { uncostedNet: 0, uncostedReturnsNet: 0 },
}));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    fetchAnalyticsRegistry: vi.fn(async () => REGISTRY as never),
    runAnalyticsQuery: vi.fn(async (body: AnalyticsQueryBody) => {
      // The server contract, enforced here too: lib/analytics/planner.js caps a
      // request at MAX_METRICS = 12 and answers 422 above it.
      if (body.metrics.length > 12) {
        throw new Error(`executive requested ${body.metrics.length} metrics — the planner caps a query at 12`);
      }
      const values: Record<string, number> = {};
      for (const m of body.metrics) if (TOTALS[m] != null) values[m] = TOTALS[m];
      if (body.metrics.includes("uncosted_net")) values.uncosted_net = COST_STATE.uncostedNet;
      if (body.metrics.includes("uncosted_returns_net")) {
        values.uncosted_returns_net = COST_STATE.uncostedReturnsNet;
      }
      const keys = body.dimensions.length > 0 ? ["2032-03-10"] : [];
      return {
        columns: [],
        rows: [{ keys, labels: keys, values }],
        totals: values,
        meta: { freshness: { watermark: null }, maskedMetrics: [], completeness: { complete: true } },
      } as unknown as AnalyticsResult;
    }),
  };
});

vi.mock("@/shared/permissions", () => ({
  useCan: () => true,
  usePermissions: () => ({ can: () => true }),
  Can: ({ children }: { children: import("react").ReactNode }) => <>{children}</>,
}));

afterEach(() => {
  COST_STATE.uncostedNet = 0;
  COST_STATE.uncostedReturnsNet = 0;
  cleanup();
});

/** The money in a named statement line, parsed back out of the rendered cell. */
function lineValue(id: string): number {
  const row = document.querySelector(`[data-testid="statement-sales"] tr[data-line="${id}"]`);
  if (!row) throw new Error(`no statement line "${id}" rendered`);
  const text = row.querySelectorAll("td")[0]?.textContent ?? "";
  // "1,087.25 ر.س" — the currency suffix itself contains a dot, so the number
  // is matched rather than extracted by stripping non-digits.
  const m = text.match(/-?[\d,]+(\.\d+)?/);
  if (!m) throw new Error(`statement line "${id}" rendered "${text}", which carries no figure`);
  return Number(m[0].replace(/,/g, ""));
}

/** True when the line is rendered as a memo (no operator, takes no part). */
function isMemo(id: string): boolean {
  return (
    document
      .querySelector(`[data-testid="statement-sales"] tr[data-line="${id}"]`)
      ?.getAttribute("data-memo") === "true"
  );
}

async function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <MemoryRouter initialEntries={[path]}>
          <Executive />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
  await screen.findByTestId("statement-sales");
}

describe("executive sales statement", () => {
  it("ex-VAT ladder: every '=' line is the exact result of the lines above it", async () => {
    await renderAt("/reports/sales/executive?taxIncl=0");

    expect(lineValue("net")).toBe(950);
    expect(lineValue("returns")).toBe(240);
    expect(lineValue("net_sales")).toBe(710);
    expect(lineValue("net") - lineValue("returns")).toBe(lineValue("net_sales"));
  });

  it("incl-VAT ladder: every '=' line is the exact result of the lines above it", async () => {
    await renderAt("/reports/sales/executive?taxIncl=1");

    // The ladder opens on an INDEPENDENTLY SUMMED figure. It used to open on
    // sales_before_discount — which the registry reconstructs as
    // gross + discount — and then subtract that same discount, so it closed by
    // construction: it would have footed perfectly with a WRONG discount, and
    // proved nothing. The discount is a memo on both bases now.
    expect(isMemo("memo_discounts")).toBe(true);

    expect(lineValue("net")).toBe(1071.5);
    expect(lineValue("returns")).toBe(262.5);
    expect(lineValue("net_sales")).toBe(809);
    expect(lineValue("net") - lineValue("returns")).toBe(lineValue("net_sales"));
  });

  it("the ex-VAT ladder does not subtract the tax-inclusive discount", async () => {
    await renderAt("/reports/sales/executive?taxIncl=0");
    // The discount is present — the owner still has to see it — but as a memo,
    // outside the arithmetic, because it is recorded incl-VAT and is already
    // out of net_ex_vat. Subtracting it here would have produced 934.25.
    expect(isMemo("memo_discounts")).toBe(true);
    expect(lineValue("memo_discounts")).toBe(15.75);
    expect(lineValue("net_sales")).not.toBe(950 - 240 - 15.75);
  });

  it("returns are subtracted on the ladder's own basis, never across bases", async () => {
    await renderAt("/reports/sales/executive?taxIncl=0");
    expect(lineValue("returns")).toBe(240); // ex-VAT beside ex-VAT
    cleanup();
    await renderAt("/reports/sales/executive?taxIncl=1");
    expect(lineValue("returns")).toBe(262.5); // incl-VAT beside incl-VAT
  });

  it("fees and rounding are memo figures, never operands of the invoice total", async () => {
    await renderAt("/reports/sales/executive?taxIncl=1");
    expect(isMemo("memo_fees")).toBe(true);
    expect(isMemo("memo_rounding")).toBe(true);
    expect(lineValue("memo_fees")).toBe(7);
    expect(lineValue("memo_rounding")).toBe(0.25);
    // The old tail was net + VAT + fees + rounding = invoice_total, which
    // overstated the invoice by 7.25 on this fixture.
    expect(lineValue("memo_invoice_total")).toBe(1071.5);
    expect(lineValue("memo_invoice_total")).not.toBe(950 + 121.5 + 7 + 0.25);
  });

  it("the headers-vs-lines control is printed, not absorbed", async () => {
    await renderAt("/reports/sales/executive?taxIncl=1");
    expect(isMemo("memo_variance")).toBe(true);
    expect(lineValue("memo_variance")).toBe(0);
    expect(lineValue("memo_invoice_total") - lineValue("net")).toBe(lineValue("memo_variance"));
  });

  it("names the tax basis on the statement itself, in both modes", async () => {
    await renderAt("/reports/sales/executive?taxIncl=0");
    const excl = screen.getByTestId("statement-sales").textContent ?? "";
    expect(excl).toContain("دون ضريبة القيمة المضافة");
    cleanup();
    await renderAt("/reports/sales/executive?taxIncl=1");
    const incl = screen.getByTestId("statement-sales").textContent ?? "";
    expect(incl).toContain("شامل ضريبة القيمة المضافة");
  });

  it("keeps exactly one named net line for the e2e anchor, on either basis", async () => {
    await renderAt("/reports/sales/executive?taxIncl=0");
    expect(document.querySelectorAll('[data-testid="statement-sales"] tr[data-line="net"]')).toHaveLength(1);
    cleanup();
    await renderAt("/reports/sales/executive?taxIncl=1");
    expect(document.querySelectorAll('[data-testid="statement-sales"] tr[data-line="net"]')).toHaveLength(1);
  });

  it("withholds profit and margin when the period contains revenue without trustworthy cost", async () => {
    COST_STATE.uncostedNet = 125;
    await renderAt("/reports/sales/executive?taxIncl=0");

    expect(await screen.findByTestId("cost-provenance-notice")).toHaveTextContent(
      "حُجبت التكلفة والربح والهامش",
    );

    const kpis = screen.getByTestId("kpi-row");
    const profitLabel = within(kpis).getByText("الربح الإجمالي بعد المرتجعات");
    expect(profitLabel.parentElement?.querySelector("dd")).toHaveTextContent("—");
    const marginLabel = within(kpis).getByText("هامش الربح بعد المرتجعات");
    expect(marginLabel.parentElement?.querySelector("dd")).toHaveTextContent("—");

    expect(document.querySelector('[data-line="profit"] td')?.textContent).toContain("—");
    expect(document.querySelector('[data-line="cogs"] td')?.textContent).toContain("—");
  });
});
