// The report builder must refuse what the planner refuses — BEFORE Run.
//
// The reported failure, from a live screenshot: the metric picker offered all
// 51 registry metrics, the user picked them, and the report came back as a red
// box reading `metrics: at most 12 per request` over an empty page. Nothing
// said a limit existed, which twelve to keep, or that the picker had let them
// build something impossible. The same page also offered any dimension against
// any metric, with the same class of after-the-fact 422 behind it.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/i18n";
import type { AnalyticsQueryBody } from "../lib/api";
import Builder, { MAX_METRICS } from "../pages/Builder";

const { REGISTRY, lastBody, LINE_IDS } = vi.hoisted(() => {
  /** REAL registry ids so t() resolves a real label; the fixture owns the facts. */
  const LINE_IDS = ["gross_product_sales","discounts_total","discounts_line","net_ex_vat","vat_amount","qty_sold","qty_returned","cogs","uncosted_net","returns_net","returns_value","returns_vat","returns_cogs","tips_total","fees_total"];
  const lastBody = { value: null as AnalyticsQueryBody | null };
  /** 20 line-fact metrics + one order-fact + one void metric. */
  const metrics = [
    ...LINE_IDS.map((id) => ({ id, kind: "additive", format: "money", equationKey: "sum", fact: "line", facts: ["line"] })),
    { id: "orders", kind: "additive", format: "count", equationKey: "count", fact: "order", facts: ["order"] },
    { id: "voids_count", kind: "additive", format: "count", equationKey: "count", fact: "order", facts: ["order"], liftsVoidExclusion: true },
  ];
  const REGISTRY = {
    metrics,
    dimensions: [
      { id: "business_day", kind: "time", groupable: true, facts: ["order", "line"] },
      { id: "menu_item", kind: "attribute", groupable: true, facts: ["line"] },
      { id: "vat_rate", kind: "attribute", groupable: true, facts: ["line"] },
    ],
  };
  return { REGISTRY, lastBody, LINE_IDS };
});

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    fetchAnalyticsRegistry: vi.fn(async () => REGISTRY as unknown as import("../lib/api").AnalyticsRegistry),
    runAnalyticsQuery: vi.fn(async (body: AnalyticsQueryBody) => {
      lastBody.value = body;
      return {
        columns: [], rows: [], subtotals: [], totals: {},
        page: { limit: 10, offset: 0, total: 0 },
        meta: { freshness: { watermark: null }, maskedMetrics: [] },
      } as unknown as import("../lib/api").AnalyticsResult;
    }),
  };
});

function renderBuilder(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <MemoryRouter initialEntries={[path]}>
          <Builder />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

/** Open the metric multi-select and return its listbox. */
async function openMetrics(): Promise<HTMLElement> {
  const trigger = await screen.findByRole("button", { name: /المقاييس/ });
  fireEvent.click(trigger);
  return await waitFor(() => screen.getByRole("listbox"));
}

const optionFor = (list: HTMLElement, label: string) =>
  within(list).getAllByRole("option").find((o) => (o.textContent ?? "").startsWith(label));

beforeEach(() => {
  lastBody.value = null;
});
afterEach(cleanup);

const twelve = LINE_IDS.slice(0, MAX_METRICS).join(",");

describe("the metric ceiling", () => {
  it("mirrors the planner's own limit", () => {
    // A number invented here rather than taken from the engine would drift.
    expect(MAX_METRICS).toBe(12);
  });

  it("shows the count against the ceiling, so the limit is visible before it bites", async () => {
    renderBuilder(`/reports/sales/builder?b_m=${LINE_IDS.slice(0,3).join(",")}`);
    expect(await screen.findByText(/المقاييس \(3\/12\)/)).toBeInTheDocument();
  });

  it("stops offering more metrics once the ceiling is reached, and says why", async () => {
    renderBuilder(`/reports/sales/builder?b_m=${twelve}`);
    const list = await openMetrics();
    const unchosen = optionFor(list, "تكلفة المرتجعات")!;
    expect(unchosen).toHaveAttribute("aria-disabled", "true");
    expect(unchosen.textContent).toContain("الحد الأقصى");
  });

  it("never disables an ALREADY-chosen metric — it would be stuck in the report", async () => {
    renderBuilder(`/reports/sales/builder?b_m=${twelve}`);
    const list = await openMetrics();
    expect(optionFor(list, "المُفوتر على العملاء")).not.toHaveAttribute("aria-disabled");
  });

  it("truncates an over-long URL instead of sending a doomed request", async () => {
    // A saved link or a hand-edited URL can carry more than the ceiling.
    const tooMany = LINE_IDS.join(",");
    renderBuilder(`/reports/sales/builder?b_m=${tooMany}`);
    const run = await screen.findByRole("button", { name: /تشغيل/ });
    fireEvent.click(run);
    await waitFor(() => expect(lastBody.value).not.toBeNull());
    expect(lastBody.value!.metrics!.length).toBeLessThanOrEqual(MAX_METRICS);
  });
});

describe("the other two rules the planner enforces", () => {
  it("disables a metric the chosen grouping cannot express", async () => {
    // menu_item is line-only; `orders` lives on the order fact.
    renderBuilder(`/reports/sales/builder?b_m=${LINE_IDS[0]}&b_d1=menu_item`);
    const list = await openMetrics();
    const blocked = optionFor(list, "عدد الطلبات")!;
    expect(blocked).toHaveAttribute("aria-disabled", "true");
    expect(blocked.textContent).toContain("غير متاح مع");
  });

  it("disables a void metric beside an order-population metric", async () => {
    renderBuilder("/reports/sales/builder?b_m=orders&b_d1=business_day");
    const list = await openMetrics();
    expect(optionFor(list, "عدد الطلبات الملغاة")).toHaveAttribute("aria-disabled", "true");
  });
});

/* ── what the adversarial audit of the shipped builder found ───────────────
 * Two defects, both confirmed by three independent refutation passes.
 */
describe("regressions the audit caught", () => {
  it("changing the PRIMARY grouping level actually changes it", async () => {
    // Two back-to-back setSearchParams calls do not compose: react-router
    // resolves each functional update against the location its own closure
    // captured, so the b_d2 write was computed from the PRE-patch params and
    // reinstated the old b_d1. The primary level could never be changed — the
    // combobox snapped back and Run queried the old dimension.
    renderBuilder("/reports/sales/builder?b_m=net_ex_vat&b_d1=business_day");
    const control = await screen.findByTestId("group-by-control");
    const level1 = within(control).getAllByRole("button")[0];
    fireEvent.click(level1);
    const list = await waitFor(() => screen.getByRole("listbox"));
    // The clickable is the BUTTON inside li[role=option]; clicking the li does
    // nothing, which is how this test first "reproduced" a defect of its own.
    const opt = within(list).getAllByRole("option").find((o) => (o.textContent ?? "").includes("الصنف"))!;
    fireEvent.click(opt.querySelector("button") ?? opt);

    const run = await screen.findByRole("button", { name: /تشغيل/ });
    fireEvent.click(run);
    await waitFor(() => expect(lastBody.value?.dimensions?.[0]).toBe("menu_item"));
  });

  it("a THIRD grouping level reaches the query instead of being silently dropped", async () => {
    // The control offers MAX_GROUP_DIMS levels; the page stored only b_d1/b_d2,
    // so picking a third was accepted by the control, dropped on the way to the
    // URL, and reverted on the next render — a no-op the user cannot see.
    renderBuilder(
      "/reports/sales/builder?b_m=net_ex_vat&b_d1=business_day&b_d2=menu_item&b_d3=vat_rate",
    );
    const run = await screen.findByRole("button", { name: /تشغيل/ });
    fireEvent.click(run);
    await waitFor(() => expect(lastBody.value?.dimensions).toHaveLength(3));
    expect(lastBody.value!.dimensions).toEqual(["business_day", "menu_item", "vat_rate"]);
  });

  it("says so when a link's metric list was truncated to the ceiling", async () => {
    // Dropping three columns silently leaves the recipient comparing a
    // 12-column report against the 15-column one they were sent.
    renderBuilder(`/reports/sales/builder?b_m=${LINE_IDS.join(",")}`);
    const notice = await screen.findByTestId("builder-adjusted-notice");
    expect(notice.textContent).toContain(String(LINE_IDS.length));
  });
});
