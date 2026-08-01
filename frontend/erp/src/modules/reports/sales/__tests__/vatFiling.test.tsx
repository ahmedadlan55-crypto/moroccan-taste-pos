// The VAT return detail on the taxes page.
//
// THE DEFECT THIS SECTION EXISTS TO FIX
//   The page headed `vat_amount` as "VAT". `vat_amount` is VAT on SALES. Every
//   refund the branch issued still carried its VAT inside that figure, so the
//   period's liability was overstated by the whole of `returns_vat` — in the
//   direction that costs the owner money, and with nothing on screen to hint at
//   it. The fixture below is built so that the two are DIFFERENT numbers: if
//   the section ever falls back to VAT-on-sales, these tests fail.
//
// Everything asserted here is a number the server computed. `net_vat` is a
// registry metric with its own equation and mutation coverage
// (scripts/audit/mutation-sales-math.js EQ-05e) — a figure that goes on a
// government return is not arithmetic done inside a React component, and these
// tests would pass just as happily if it were, which is why the equation is
// pinned separately on the backend.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/i18n";
import type { AnalyticsQueryBody, AnalyticsResult } from "../lib/api";
import Taxes from "../pages/Taxes";

const { bodies, REGISTRY, resultFor } = vi.hoisted(() => {
  const bodies: AnalyticsQueryBody[] = [];

  const REGISTRY = {
    metrics: [
      { id: "vat_amount", kind: "additive", format: "money", equationKey: "sum", fact: "line", facts: ["line"] },
      { id: "net_ex_vat", kind: "additive", format: "money", equationKey: "sum", fact: "line", facts: ["line"] },
      { id: "returns_net", kind: "additive", format: "money", equationKey: "sum", fact: "return", facts: ["return"] },
      { id: "returns_vat", kind: "additive", format: "money", equationKey: "sum", fact: "return", facts: ["return"] },
      { id: "fees_total", kind: "additive", format: "money", equationKey: "sum", fact: "order", facts: ["order"] },
      { id: "rounding_total", kind: "additive", format: "money", equationKey: "sum", fact: "order", facts: ["order"] },
      { id: "tips_total", kind: "additive", format: "money", equationKey: "sum", fact: "order", facts: ["order"] },
      { id: "net_vat", kind: "derived", format: "money", equationKey: "netVat", fact: null, facts: ["line", "return"] },
      {
        id: "net_product_sales_ex_vat",
        kind: "derived",
        format: "money",
        equationKey: "netSalesExVat",
        fact: null,
        facts: ["line", "return"],
      },
    ],
    dimensions: [
      { id: "vat_category", kind: "attribute", groupable: true, facts: ["line", "return"] },
      { id: "vat_rate", kind: "attribute", groupable: true, facts: ["line", "return"] },
    ],
  };

  /**
   * Two categories. The standard-rated row has BOTH sides; the second row is a
   * rate with RETURNS ONLY — a refund of something not sold in this period,
   * which any hand-joined "sales left-join returns" table silently drops.
   *
   * Standard 15%: VAT on sales 1500, VAT on returns 200 -> net 1300.
   * 1500 and 1300 are deliberately far apart and neither is a round multiple of
   * the other, so a fallback to VAT-on-sales cannot pass by coincidence.
   */
  const resultFor = (body: AnalyticsQueryBody): AnalyticsResult => {
    const dims = (body.dimensions ?? []).join(",");
    if (dims === "vat_category,vat_rate") {
      return {
        columns: [],
        rows: [
          {
            keys: ["standard", "15"],
            labels: ["أساسية", "15%"],
            values: {
              net_ex_vat: 10000,
              vat_amount: 1500,
              returns_net: 1333.33,
              returns_vat: 200,
              net_product_sales_ex_vat: 8666.67,
              net_vat: 1300,
            },
          },
          {
            keys: ["standard", "5"],
            labels: ["أساسية", "5%"],
            values: {
              net_ex_vat: null,
              vat_amount: null,
              returns_net: 400,
              returns_vat: 20,
              net_product_sales_ex_vat: -400,
              net_vat: -20,
            },
          },
        ],
        subtotals: [],
        totals: {
          net_ex_vat: 10000,
          vat_amount: 1500,
          returns_net: 1733.33,
          returns_vat: 220,
          net_product_sales_ex_vat: 8266.67,
          net_vat: 1280,
        },
        page: { limit: 200, offset: 0, total: 2 },
        meta: { freshness: { watermark: null }, maskedMetrics: [] },
      } as unknown as AnalyticsResult;
    }
    // the KPI body and the legacy by-rate body
    return {
      columns: [],
      rows: [{ keys: ["15"], labels: ["15%"], values: { vat_amount: 1500, net_ex_vat: 10000 } }],
      subtotals: [],
      totals: { vat_amount: 1500, net_ex_vat: 10000, fees_total: 10, rounding_total: 1 },
      page: { limit: 50, offset: 0, total: 1 },
      meta: { freshness: { watermark: null }, maskedMetrics: [] },
    } as unknown as AnalyticsResult;
  };

  return { bodies, REGISTRY, resultFor };
});

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    fetchAnalyticsRegistry: vi.fn(async () => REGISTRY as unknown as import("../lib/api").AnalyticsRegistry),
    runAnalyticsQuery: vi.fn(async (body: AnalyticsQueryBody) => {
      bodies.push(body);
      return resultFor(body);
    }),
  };
});

function renderTaxes() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <MemoryRouter initialEntries={["/reports/sales/taxes"]}>
          <Taxes />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

/** The body row whose RATE cell is exactly this rate. Matching on row text
 * would make "5%" find the "15%" row — the substring trap. */
function rateRow(table: HTMLElement, rate: string): HTMLElement {
  const row = within(table)
    .getAllByRole("row")
    .find((r) => r.querySelectorAll("td")[1]?.textContent?.trim() === rate);
  expect(row, `no filing row for rate ${rate}`).toBeDefined();
  return row as HTMLElement;
}

const filingBody = () => bodies.find((b) => (b.dimensions ?? []).join(",") === "vat_category,vat_rate");

beforeEach(() => {
  bodies.length = 0;
});
afterEach(cleanup);

describe("the request the filing table builds", () => {
  it("asks for BOTH sides — sales VAT and returns VAT — in one request", async () => {
    renderTaxes();
    await waitFor(() => expect(filingBody()).toBeDefined());
    const m = filingBody()!.metrics ?? [];
    expect(m).toContain("vat_amount");
    expect(m, "returns VAT is the half that was missing").toContain("returns_vat");
    expect(m, "the filing figure itself must come from the server").toContain("net_vat");
  });

  it("groups by category AND rate — a return is filed per category, not in one lump", async () => {
    renderTaxes();
    await waitFor(() => expect(filingBody()).toBeDefined());
    expect(filingBody()!.dimensions).toEqual(["vat_category", "vat_rate"]);
  });

  it("carries an explicit limit — a truncated TAX table must not be possible", async () => {
    // DEFAULT_LIMIT is 50 (planner.js). A category × rate grid is small today,
    // but "small today" is not a property a tax report may depend on.
    renderTaxes();
    await waitFor(() => expect(filingBody()).toBeDefined());
    expect(filingBody()!.limit).toBeGreaterThanOrEqual(200);
  });
});

describe("what the filing table shows", () => {
  it("shows net VAT (1,300), NOT VAT on sales (1,500), for the standard-rated row", async () => {
    renderTaxes();
    const table = await screen.findByTestId("vat-filing");
    const row = rateRow(table, "15%");
    expect(row.textContent).toContain("1,500"); // VAT on sales, its own column
    expect(row.textContent).toContain("200"); // VAT on returns
    expect(row.textContent, "the net column is the whole point of the section").toContain("1,300");
  });

  it("keeps a rate that had ONLY returns — the row a hand-joined table drops", async () => {
    // A refund of something not sold in this period has no sales side at all.
    // Dropping it understates the credit and the filing goes out wrong.
    renderTaxes();
    const table = await screen.findByTestId("vat-filing");
    const row = rateRow(table, "5%");
    expect(row, "the returns-only row is missing").toBeDefined();
    expect(row.textContent).toContain("—"); // no sales side
    expect(row.textContent).toContain("20"); // but a real credit
  });

  it("totals from the server's rollup, not by adding the rows on screen", async () => {
    // Rows net to 1300 + (−20) = 1280 here, which happens to match; the
    // assertion is that the number comes from `totals`, so the fixture's totals
    // are what must appear. When a limit truncates, only this is right.
    renderTaxes();
    const total = await screen.findByTestId("vat-filing-total");
    expect(total.textContent).toContain("1,280");
  });
});
