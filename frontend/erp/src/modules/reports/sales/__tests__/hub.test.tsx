// Sales Analytics Hub — container behavior through the REAL reports module
// dispatch (/reports/sales/* → lazy hub).
//
// WHAT CHANGED, AND WHY THIS FILE CHANGED WITH IT
//   Seventeen flat report paths became FIVE CENTRES with a `view` param. Every
//   retired path is a bookmark somebody has, so the redirect table is exercised
//   here with a query string on it — a redirect that lands on the right centre
//   and drops the filters is not a working link, it is a link to a different
//   report.
//
// Covered: the /reports/sales → executive redirect, the grouped picker (groups
// ARE the centres) with capability-hidden reports, the per-centre view
// switcher, retired-segment redirects with the query intact, deep-link denial
// on cap-gated reports, the auto-drop of filters a report cannot honour, the
// analytics.view gate, and the unknown-segment state.
import { render, screen, waitFor, cleanup, fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/i18n";
import ReportsModule from "@/modules/reports";
import { CENTERS, LEGACY_SEGMENT_ROUTES, REPORTS } from "../lib/reportRegistry";

// ── controllable capability gate (the pattern every module test uses) ──
const { caps } = vi.hoisted(() => ({ caps: {} as Record<string, boolean> }));
vi.mock("@/shared/permissions", () => ({
  useCan: (cap: string) => caps[cap] ?? false,
  usePermissions: () => ({ can: (cap: string) => caps[cap] ?? false }),
  Can: ({ cap, children, fallback = null }: { cap: string; children: React.ReactNode; fallback?: React.ReactNode }) =>
    (caps[cap] ?? false) ? <>{children}</> : <>{fallback}</>,
}));

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: {
      ...actual.apiClient,
      get: vi.fn(async () => []),
      // POST /analytics/query — the REAL wire envelope with zero rows, so the
      // executive segment settles into its healthy empty state. (The registry
      // GET above yields an empty-but-valid catalog, which now enables the
      // data queries — the adapter in lib/api.ts normalizes this envelope.)
      post: vi.fn(async () => ({
        success: true,
        data: { columns: [], rows: [], subtotals: [], totals: { values: {} }, page: { limit: 50, offset: 0 } },
        meta: { freshness: { watermark: null }, completeness: [], maskedMetrics: [] },
      })),
    },
  };
});

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname + loc.search}</div>;
}

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <MemoryRouter initialEntries={[path]}>
          <LocationProbe />
          <Routes>
            <Route path="/reports/sales" element={<ReportsModule />} />
            <Route path="/reports/sales/*" element={<ReportsModule />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const here = () => screen.getByTestId("location").textContent ?? "";

beforeEach(() => {
  for (const k of Object.keys(caps)) delete caps[k];
  caps["analytics.view"] = true;
});

afterEach(cleanup);

const PICKER = "أقسام تحليلات المبيعات";

/**
 * The picker trigger, with an explicit wait budget.
 *
 * findBy* defaults to 1000ms, which is enough when this file runs alone and is
 * NOT enough when the whole suite runs in parallel: the first render of the hub
 * pulls the lazy report chunk and the i18n dictionaries through the transform.
 * A 1s budget made the first test in the file fail depending on machine load —
 * the worst kind of flake, because it passes when you run it alone.
 */
function findPicker() {
  return screen.findByRole("button", { name: PICKER }, { timeout: 8000 });
}

/**
 * The picker is a closed menu — open it and return ITS listbox. Queries must be
 * scoped: the filter bar's native <select>s contribute <option> elements too,
 * so an unscoped getAllByRole("option") counts the period/compare choices.
 */
async function openPicker() {
  const trigger = await findPicker();
  fireEvent.click(trigger);
  const listbox = await screen.findByRole("listbox", { name: PICKER });
  return within(listbox);
}

describe("SalesAnalyticsHub — routing", () => {
  it("redirects /reports/sales to the executive centre", async () => {
    renderAt("/reports/sales");
    expect(await findPicker()).toHaveTextContent("اللوحة التنفيذية");
    await waitFor(() =>
      expect(document.querySelector('[data-state="empty"]')).toBeInTheDocument(),
    );
  }, 20000);

  it("renders the not-found state for an unknown segment", async () => {
    renderAt("/reports/sales/definitely-not-a-segment");
    await waitFor(() =>
      expect(document.querySelector('[data-state="not-found"]')).toBeInTheDocument(),
    );
  });

  it("a centre with no ?view opens its default report", async () => {
    caps["analytics.employees.view"] = true;
    renderAt("/reports/sales/operations");
    expect(await findPicker()).toHaveTextContent("الفروع");
  });

  it("?view selects a report inside the centre", async () => {
    renderAt("/reports/sales/operations?view=hours");
    expect(await findPicker()).toHaveTextContent("الساعات");
  });

  it("a ?view belonging to ANOTHER centre is sent to its real home, not silently ignored", async () => {
    renderAt("/reports/sales/operations?view=taxes");
    await waitFor(() => expect(here()).toContain("/reports/sales/payments"));
    expect(here()).toContain("view=taxes");
  });
});

/* ── the redirect table — every retired bookmark ─────────────────────────── */

describe("retired report paths keep working", () => {
  /** A real filter state on the old link: period + a scope the target honours. */
  const QUERY = "?from=2032-03-01&to=2032-03-31&preset=custom&branchId=B-1&unknown=keep-me";

  /**
   * THE DESTINATIONS, WRITTEN OUT — deliberately not derived.
   *
   * Every test below drives `LEGACY_SEGMENT_ROUTES`, which is right for
   * coverage (a redirect added to the table is exercised automatically) and
   * useless as a guard: change a destination in the table and the expectation
   * changes with it, so the suite stays green while the bookmark now opens a
   * DIFFERENT report. A mutation run proved exactly that — pointing `hours` at
   * `branches` was caught by nothing.
   *
   * This literal is the contract old bookmarks depend on. It has to be edited
   * by hand, on purpose: a redirect target is a promise to somebody's saved
   * link, and changing one should cost a deliberate keystroke here.
   */
  const EXPECTED_DESTINATIONS: Record<string, string> = {
    "item-sales": "items/items",
    modifiers: "items/modifiers",
    profitability: "items/profitability",
    taxes: "payments/taxes",
    discounts: "payments/discounts",
    reconciliation: "payments/reconciliation",
    branches: "operations/branches",
    cashiers: "operations/cashiers",
    hours: "operations/hours",
    shifts: "operations/shifts",
    voids: "operations/voids",
    orders: "operations/orders",
    builder: "explorer/builder",
  };

  it("each retired path still points where it always did", () => {
    const actual = Object.fromEntries(
      Object.entries(LEGACY_SEGMENT_ROUTES).map(([k, v]) => [k, `${v.center}/${v.view}`]),
    );
    expect(actual).toEqual(EXPECTED_DESTINATIONS);
  });

  for (const [segment, target] of Object.entries(LEGACY_SEGMENT_ROUTES)) {
    it(`/reports/sales/${segment} → ${target.center} (view=${target.view}) with its filters intact`, async () => {
      // Every capability, so a cap-gated target still routes (the denial is a
      // separate concern, asserted below).
      caps["analytics.employees.view"] = true;
      caps["analytics.cost.view"] = true;
      caps["analytics.reconciliation.view"] = true;
      renderAt(`/reports/sales/${segment}${QUERY}`);

      await waitFor(() => expect(here()).toContain(`/reports/sales/${target.center}`));
      const [pathname, search = ""] = here().split("?");
      expect(pathname).toBe(`/reports/sales/${target.center}`);

      const params = new URLSearchParams(search);
      expect(params.get("view")).toBe(target.view);
      // THE FILTER STATE, verbatim — including a param the hub knows nothing
      // about, because a bookmark may carry one (?doc= from a drawer).
      expect(params.get("from")).toBe("2032-03-01");
      expect(params.get("to")).toBe("2032-03-31");
      expect(params.get("preset")).toBe("custom");
      expect(params.get("branchId")).toBe("B-1");
      expect(params.get("unknown")).toBe("keep-me");
    });
  }

  it("a bare retired link redirects cleanly, with no stray filters invented", async () => {
    renderAt("/reports/sales/branches");
    await waitFor(() => expect(here()).toContain("/reports/sales/operations"));
    const params = new URLSearchParams(here().split("?")[1] ?? "");
    expect([...params.keys()]).toEqual(["view"]);
  });

  it("covers every report that moved — the table is not a subset of the reports", () => {
    // A retired segment for each report whose path changed. The four centres
    // named after a report (executive/items/payments/explorer) kept their path,
    // so they are legitimately absent.
    const moved = REPORTS.map((r) => r.id).filter(
      (id) => !CENTERS.some((c) => c.id === id) && id !== "channels",
    );
    expect(Object.keys(LEGACY_SEGMENT_ROUTES).sort()).toEqual(
      [...moved, "item-sales"].sort(),
    );
  });
});

/* ── capabilities ────────────────────────────────────────────────────────── */

describe("SalesAnalyticsHub — capability gates", () => {
  it("denies the whole hub without analytics.view", async () => {
    caps["analytics.view"] = false;
    renderAt("/reports/sales/executive");
    await waitFor(() =>
      expect(document.querySelector('[data-state="permission-denied"]')).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: PICKER })).not.toBeInTheDocument();
  });

  it("hides the three cap-gated reports (14 of 17)", async () => {
    renderAt("/reports/sales/executive");
    const picker = await openPicker();
    expect(REPORTS).toHaveLength(17);
    expect(picker.getAllByRole("option")).toHaveLength(14);
    expect(picker.queryByRole("option", { name: /أداء الكاشير/ })).not.toBeInTheDocument();
    expect(picker.queryByRole("option", { name: /الربحية/ })).not.toBeInTheDocument();
    expect(picker.queryByRole("option", { name: /التسويات/ })).not.toBeInTheDocument();
  });

  it("shows all 17 reports when every capability is granted", async () => {
    caps["analytics.employees.view"] = true;
    caps["analytics.cost.view"] = true;
    caps["analytics.reconciliation.view"] = true;
    renderAt("/reports/sales/executive");
    const picker = await openPicker();
    expect(picker.getAllByRole("option")).toHaveLength(17);
    expect(picker.getByRole("option", { name: /أداء الكاشير/ })).toBeInTheDocument();
    expect(picker.getByRole("option", { name: /الربحية/ })).toBeInTheDocument();
  });

  it("groups the picker by CENTRE, in registry order", async () => {
    caps["analytics.employees.view"] = true;
    caps["analytics.cost.view"] = true;
    caps["analytics.reconciliation.view"] = true;
    renderAt("/reports/sales/executive");
    const picker = await openPicker();
    const groups = picker.getAllByRole("group");
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual([
      "الملخّص التنفيذي",
      "الأصناف والربحية",
      "التحصيل والمطابقة",
      "التشغيل",
      "الاستكشاف الحر",
    ]);
    // the open report is the selected option, so the menu reads "you are here"
    const selected = picker
      .getAllByRole("option")
      .filter((o) => o.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveTextContent("اللوحة التنفيذية");
  });

  it("a deep-link to a cap-gated report renders PermissionDenied (picker stays)", async () => {
    renderAt("/reports/sales/items?view=profitability");
    await waitFor(() =>
      expect(document.querySelector('[data-state="permission-denied"]')).toBeInTheDocument(),
    );
    // the picker is still there so the user can navigate out
    expect(await findPicker()).toBeInTheDocument();
  });

  it("the view switcher hides a cap-gated report too", async () => {
    renderAt("/reports/sales/items");
    const switcher = await screen.findByTestId("view-switcher");
    expect(within(switcher).queryByRole("button", { name: /الربحية/ })).toBeNull();
    caps["analytics.cost.view"] = true;
    cleanup();
    renderAt("/reports/sales/items");
    const withCap = await screen.findByTestId("view-switcher");
    expect(within(withCap).getByRole("button", { name: /الربحية/ })).toBeInTheDocument();
  });
});

/* ── the view switcher ───────────────────────────────────────────────────── */

describe("the centre's view switcher", () => {
  it("moves between the reports of one centre, carrying the filter state", async () => {
    renderAt("/reports/sales/operations?from=2032-03-01&to=2032-03-31&preset=custom");
    const switcher = await screen.findByTestId("view-switcher");
    fireEvent.click(within(switcher).getByRole("button", { name: /الساعات/ }));
    await waitFor(() => expect(here()).toContain("view=hours"));
    expect(here()).toContain("from=2032-03-01");
    expect(here()).toContain("preset=custom");
  });

  it("is absent for a centre with a single report — a control that cannot choose", async () => {
    renderAt("/reports/sales/executive");
    await findPicker();
    expect(screen.queryByTestId("view-switcher")).toBeNull();
  });
});

/* ── the auto-drop ───────────────────────────────────────────────────────── */

describe("filters the routed report cannot honour", () => {
  it("are cleared from the URL, and the reader is told", async () => {
    // `paymentMethod` filters the PAYMENT fact. The shifts report is TILL-fact
    // only, so the planner would answer ANALYTICS_UNSUPPORTED_COMBINATION and
    // the whole screen would go red — while the chip claimed the scope.
    renderAt("/reports/sales/operations?view=shifts&paymentMethod=cash");
    await waitFor(() => expect(screen.getByTestId("dropped-filters-notice")).toBeInTheDocument());
    expect(screen.getByTestId("dropped-filters-notice")).toHaveTextContent("وسيلة الدفع");
    await waitFor(() => expect(here()).not.toContain("paymentMethod"));
  });

  it("leaves a filter the report DOES support completely alone", async () => {
    renderAt("/reports/sales/operations?view=shifts&branchId=B-1");
    await findPicker();
    expect(here()).toContain("branchId=B-1");
    expect(screen.queryByTestId("dropped-filters-notice")).toBeNull();
  });

  it("drops on a report SWITCH too, not only on a deep link", async () => {
    // Branches honours the channel filter (order+line facts); voids does not
    // (the return fact carries no channel).
    renderAt("/reports/sales/operations?channel=CH-1");
    const switcher = await screen.findByTestId("view-switcher");
    expect(here()).toContain("channel=CH-1");
    fireEvent.click(within(switcher).getByRole("button", { name: /الإلغاءات والمرتجعات/ }));
    await waitFor(() => expect(here()).toContain("view=voids"));
    await waitFor(() => expect(here()).not.toContain("channel=CH-1"));
  });

  it("removes a capability-gated filter from a viewer who lacks the capability", async () => {
    // The planner answers 403 for a filter dimension the caller is not entitled
    // to — a bookmarked ?cashierId= would break the whole report, not scope it.
    renderAt("/reports/sales/operations?cashierId=c1");
    await waitFor(() => expect(here()).not.toContain("cashierId"));
    caps["analytics.employees.view"] = true;
    cleanup();
    renderAt("/reports/sales/operations?cashierId=c1");
    await findPicker();
    expect(here()).toContain("cashierId=c1");
  });
});

/* ── the printed sheet ───────────────────────────────────────────────────── */

describe("what a printed report says about itself", () => {
  it("carries the basis of preparation, inside the printable area", async () => {
    renderAt("/reports/sales/executive");
    const basis = await screen.findByTestId("basis-of-preparation");
    expect(basis.closest(".print-document"), "basis block is outside the printable area").not.toBeNull();
    // Control: `closest` must be capable of returning null here, or the
    // assertion above proves nothing.
    const picker = screen.getByRole("button", { name: PICKER });
    expect(picker.closest(".print-document")).toBeNull();
  });

  it("every report carries it — the disclosure is not per-page and cannot be forgotten", async () => {
    caps["analytics.employees.view"] = true;
    caps["analytics.cost.view"] = true;
    caps["analytics.reconciliation.view"] = true;
    for (const report of REPORTS) {
      renderAt(`/reports/sales/${report.center}?view=${report.id}`);
      expect(
        await screen.findByTestId("basis-of-preparation"),
        `${report.id} has no basis of preparation`,
      ).toBeInTheDocument();
      cleanup();
    }
  }, 30000);

  it("carries a masthead, inside the printable area", async () => {
    renderAt("/reports/sales/executive");
    const head = await screen.findByTestId("print-masthead");
    expect(head.closest(".print-document"), "masthead is outside the printable area").not.toBeNull();
  });

  it("names the report and the period it covers", async () => {
    renderAt("/reports/sales/payments?view=taxes&from=2026-07-01&to=2026-07-31&preset=custom");
    const head = await screen.findByTestId("print-masthead");
    expect(head.textContent).toContain("الضرائب");
    expect(head.textContent).toContain("2026-07-01");
    expect(head.textContent).toContain("2026-07-31");
  });

  it("states the two bases the figures depend on", async () => {
    renderAt("/reports/sales/executive?taxIncl=1");
    const head = await screen.findByTestId("print-masthead");
    expect(head.textContent).toContain("يوم العمل");
    expect(head.textContent).toContain("شامل الضريبة");
  });

  it("is print-only — it must not clutter the screen", async () => {
    renderAt("/reports/sales/executive");
    const head = await screen.findByTestId("print-masthead");
    // jsdom applies no stylesheet, so assert the CONTRACT (the class the print
    // stylesheet keys off) rather than a computed style that would be a lie.
    expect(head.className).toContain("print-only");
  });
});
