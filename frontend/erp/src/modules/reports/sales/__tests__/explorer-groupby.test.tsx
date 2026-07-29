// Group By, on the screen.
//
// grouping.test.ts proves the legality comparison; tests/analyticsGrouping.test.js
// proves the fact graph matches the planner. This file proves the WIRING — that
// what the model decides is what the user actually sees and can click, which is
// where the previous version of this feature failed:
//
//   • the Explorer offered 8 dimensions out of 41, so most groupings the engine
//     supports were unreachable;
//   • nothing predicted ANALYTICS_UNSUPPORTED_COMBINATION, so an illegal pair
//     took the whole report to a red error naming a fact id;
//   • the pivot had no total row at all, and the KPI cards above it are the
//     period total — so a reader comparing the two had to take it on faith.
//
// The registry fixture carries `facts` on both metrics and dimensions, exactly
// as the metadata route projects them. Values are the real ones for these five
// metrics and five dimensions.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/i18n";
import type { AnalyticsQueryBody, AnalyticsResult } from "../lib/api";
import Explorer from "../pages/Explorer";

const { lastBody, REGISTRY, resultFor } = vi.hoisted(() => {
  const lastBody = { value: null as AnalyticsQueryBody | null };

  const REGISTRY = {
    metrics: [
      { id: "net_ex_vat", kind: "additive", format: "money", equationKey: "sum", fact: "line", facts: ["line"] },
      { id: "cogs", kind: "additive", format: "money", equationKey: "sum", fact: "line", facts: ["line"] },
      { id: "orders", kind: "additive", format: "count", equationKey: "count", fact: "order", facts: ["order"] },
      { id: "payments_in", kind: "additive", format: "money", equationKey: "sum", fact: "payment", facts: ["payment"] },
      { id: "avg_ticket", kind: "derived", format: "money", equationKey: "avgTicket", fact: null, facts: ["line", "order"] },
    ],
    dimensions: [
      { id: "branch", kind: "scope", groupable: true, facts: ["order", "line", "payment", "till", "modifier", "return", "budget"] },
      { id: "business_day", kind: "time", groupable: true, facts: ["order", "line", "payment", "till", "modifier", "return", "budget"] },
      { id: "menu_item", kind: "attribute", groupable: true, facts: ["line", "modifier", "return"] },
      { id: "payment_method", kind: "attribute", groupable: true, facts: ["payment"] },
      { id: "meal_period", kind: "derived-js", groupable: true, facts: ["order", "line", "modifier", "payment", "till"] },
      { id: "discount_reason", kind: "attribute", groupable: true, facts: [] },
    ],
  };

  /** Rows sum to 300; totals say 1000 — the gap IS the assertion (top-N). */
  const resultFor = (body: AnalyticsQueryBody): AnalyticsResult =>
    ({
      columns: [],
      rows: [
        { keys: ["b1"], labels: ["الفرع الأول"], values: { net_ex_vat: 200, orders: 8 } },
        { keys: ["b2"], labels: ["الفرع الثاني"], values: { net_ex_vat: 100, orders: 4 } },
      ],
      subtotals: [],
      totals: { net_ex_vat: 1000, orders: 40 },
      page: { limit: Number(body.limit) || 10, offset: 0, total: 2 },
      meta: { freshness: { watermark: null }, maskedMetrics: [] },
    }) as unknown as AnalyticsResult;

  return { lastBody, REGISTRY, resultFor };
});

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    fetchAnalyticsRegistry: vi.fn(async () => REGISTRY as unknown as import("../lib/api").AnalyticsRegistry),
    runAnalyticsQuery: vi.fn(async (body: AnalyticsQueryBody) => {
      lastBody.value = body;
      return resultFor(body);
    }),
  };
});

function renderExplorer(path = "/reports/sales/explorer") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <MemoryRouter initialEntries={[path]}>
          <Explorer />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

/** Open the grouping combobox for a slot and return its listbox. */
async function openSlot(slot: number): Promise<HTMLElement> {
  const container = await screen.findByTestId(`group-by-slot-${slot}`);
  // The shared Combobox trigger is a <button aria-haspopup="listbox">, not
  // role="combobox" — target it by its aria-label, which the control sets to
  // "<Group by> <slot+1>".
  fireEvent.click(within(container).getByRole("button", { name: new RegExp(String(slot + 1)) }));
  return await waitFor(() => within(container).getByRole("listbox"));
}

beforeEach(() => {
  lastBody.value = null;
});
afterEach(cleanup);

describe("the grouping menu", () => {
  it("offers every groupable dimension, not a curated handful", async () => {
    renderExplorer();
    const list = await openSlot(0);
    const names = within(list)
      .getAllByRole("option")
      .map((o) => o.textContent ?? "");
    // All six groupable dimensions in the fixture appear. The old control had a
    // hardcoded list of eight ids and could not reach the rest at all.
    for (const label of ["الفرع", "يوم العمل", "الصنف", "طريقة الدفع", "فترة الوجبة", "سبب الخصم"]) {
      expect(names.some((n) => n.includes(label)), `"${label}" missing from the grouping menu`).toBe(true);
    }
  });

  it("disables a dimension the chosen metrics cannot express, and says which metric", async () => {
    renderExplorer();
    // Default metrics are net_ex_vat (line) + orders (order). payment_method
    // exists only on the payment fact, so the planner would 422 the request.
    const list = await openSlot(0);
    const opt = within(list)
      .getAllByRole("option")
      .find((o) => (o.textContent ?? "").includes("طريقة الدفع"))!;
    expect(opt).toHaveAttribute("aria-disabled", "true");
    // The reason names the METRIC, in the user's vocabulary — not a fact id.
    expect(opt.textContent).toContain("غير متاح مع");
    expect(opt.textContent).toContain("صافي المبيعات");
  });

  it("marks a dimension with no data source differently from a metric conflict", async () => {
    renderExplorer();
    const list = await openSlot(0);
    const opt = within(list)
      .getAllByRole("option")
      .find((o) => (o.textContent ?? "").includes("سبب الخصم"))!;
    expect(opt).toHaveAttribute("aria-disabled", "true");
    expect(opt.textContent).toContain("لا يوجد مصدر بيانات");
  });

  it("keeps meal_period available — it has no SQL `facts` map, only sourceColumn", async () => {
    renderExplorer();
    const list = await openSlot(0);
    const opt = within(list)
      .getAllByRole("option")
      .find((o) => (o.textContent ?? "").includes("فترة الوجبة"))!;
    expect(opt).not.toHaveAttribute("aria-disabled");
  });
});

describe("the request the grouping builds", () => {
  it("groups by the chosen dimension", async () => {
    renderExplorer();
    await waitFor(() => expect(lastBody.value?.dimensions).toEqual(["branch"]));
  });

  it("adds a second level without losing the first", async () => {
    renderExplorer();
    await screen.findByTestId("group-by-slot-0");
    const list = await openSlot(1);
    // role="option" is on the <li>; the click handler is on the <button>
    // inside it, so clicking the li does nothing at all.
    const option = within(list)
      .getAllByRole("option")
      .find((o) => (o.textContent ?? "").includes("يوم العمل"))!;
    fireEvent.click(within(option).getByRole("button"));
    await waitFor(() => expect(lastBody.value?.dimensions).toEqual(["branch", "business_day"]));
  });

  it("never asks for more levels than the planner accepts", async () => {
    renderExplorer();
    // MAX_GROUP_DIMS mirrors planner.js MAX_DIMENSIONS = 3. A fourth slot must
    // not exist — a 422 on "dimensions: at most 3" is not a message anyone can
    // act on when the control offered a fourth box.
    await screen.findByTestId("group-by-slot-0");
    expect(screen.queryByTestId("group-by-slot-3")).toBeNull();
  });
});

describe("a grouping that arrives from a link", () => {
  it("honours a legacy by/second URL instead of silently resetting it", async () => {
    renderExplorer();
    // Links, bookmarks and saved views created before Group By carry the old
    // pair. Ignoring them would open a different report than the one shared.
    renderExplorer("/reports/sales/explorer?by=business_day&second=branch");
    await waitFor(() => expect(lastBody.value?.dimensions).toEqual(["business_day", "branch"]));
  });

  it("drops an illegal level rather than 422-ing the whole report, and names it", async () => {
    renderExplorer();
    // menu_item is line-only; the default metrics include `orders` (order fact).
    renderExplorer("/reports/sales/explorer?g=branch,menu_item");
    const notice = await screen.findByTestId("grouping-dropped-notice");
    expect(notice.textContent).toContain("الصنف");
    await waitFor(() => expect(lastBody.value?.dimensions).toEqual(["branch"]));
  });
});

describe("the grand total", () => {
  it("shows the SERVER's period total, not the sum of the rows on screen", async () => {
    renderExplorer();
    // The fixture's rows add to 300 while totals say 1000 — the difference a
    // top-N always creates. A footer that summed the visible rows would print
    // 300 under a report whose own KPI card says 1000.
    const foot = await screen.findByTestId("pivot-grand-total");
    expect(foot.textContent).toContain("1,000");
    expect(foot.textContent).not.toContain("300");
  });

  it("is labelled as a grand total", async () => {
    renderExplorer();
    const foot = await screen.findByTestId("pivot-grand-total");
    expect(foot.textContent).toContain("الإجمالي العام");
  });
});

describe("when reconciliation empties the grouping entirely", () => {
  it("still renders a report instead of crashing on zero dimensions", async () => {
    // ?g=menu_item with the default metrics (net_ex_vat + orders) drops the ONLY
    // level, so `dims` is []. The planner accepts a dimensionless query — it
    // returns the period as one row — but the pivot must survive being handed
    // no row dimensions at all, which is a shape no other page produces.
    renderExplorer("/reports/sales/explorer?g=menu_item");
    await screen.findByTestId("grouping-dropped-notice");
    expect(await screen.findByTestId("page-explorer")).toBeInTheDocument();
    await waitFor(() => expect(lastBody.value?.dimensions).toEqual([]));
  });
});
