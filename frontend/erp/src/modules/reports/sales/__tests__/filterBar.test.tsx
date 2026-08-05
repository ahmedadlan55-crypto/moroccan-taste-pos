// The filter bar, as the analyst experiences it.
//
// Three defects are pinned here, and each of them shipped:
//
//   1. THE SURFACE WAS 1463px TALL. Eleven controls plus the routed report's
//      own settings, all expanded, all the time — the first KPI was below the
//      fold. The bar is now a primary row (period / branch / compare / Apply /
//      more) with everything else in an INLINE expandable area. Not a drawer:
//      shared/ui/drawer.tsx is a retired compatibility shim.
//
//   2. STALE NUMBERS UNDER A NEW LABEL. Every edit patched the URL instantly,
//      so the heading, the print masthead and the basis block flipped to the
//      new period while the table still showed the old one. That is a wrong
//      number, not a slow one. Edits now build a DRAFT; «تطبيق» commits; and
//      the window where the label leads the data is marked aria-busy.
//
//   3. A FAILED LOOKUP READ AS AN EMPTY DOMAIN. `query.data ?? []` turned a
//      500 on /erp/branches-full into a picker that said "no branches".
//
// The three preserved selectors (analytics-topbar, active-filter-chips,
// data-freshness-watermark) are asserted here too — an e2e suite depends on
// them and a rename would be invisible to every other test in this folder.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/i18n";
import ReportsModule from "@/modules/reports";
import { AnalyticsTopBar } from "../components/AnalyticsTopBar";
import { analyticsFilterCodec, type AnalyticsFilters } from "../lib/filters";

/* ── harness ─────────────────────────────────────────────────────────────── */

const { caps } = vi.hoisted(() => ({ caps: {} as Record<string, boolean> }));
vi.mock("@/shared/permissions", () => ({
  useCan: (cap: string) => caps[cap] ?? false,
  usePermissions: () => ({ can: (cap: string) => caps[cap] ?? false }),
  Can: ({ cap, children, fallback = null }: { cap: string; children: React.ReactNode; fallback?: React.ReactNode }) =>
    (caps[cap] ?? false) ? <>{children}</> : <>{fallback}</>,
}));

/** Per-test hooks into the wire, set in beforeEach. */
const wire = {
  get: async (_path: string): Promise<unknown> => [],
  post: async (_path: string, _body?: unknown): Promise<unknown> => EMPTY_RESULT,
};

const EMPTY_RESULT = {
  success: true,
  data: { columns: [], rows: [], subtotals: [], totals: { values: {} }, page: { limit: 50, offset: 0 } },
  meta: { freshness: { watermark: null }, completeness: [], maskedMetrics: [] },
};

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: {
      ...actual.apiClient,
      get: vi.fn((path: string) => wire.get(path)),
      post: vi.fn((path: string, body?: unknown) => wire.post(path, body)),
    },
  };
});

const DEFAULTS: AnalyticsFilters = analyticsFilterCodec.parse(new URLSearchParams());

const AR = {
  period: "الفترة",
  branch: "الفرع",
  compare: "المقارنة",
  apply: "تطبيق",
  more: "المزيد من الفلاتر",
  brand: "العلامة التجارية",
  item: "الصنف",
  channel: "قناة البيع",
  orderType: "نوع الطلب",
  calendarDay: "اليوم التقويمي",
  taxIncl: "شامل الضريبة",
  retry: "إعادة المحاولة",
};

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** The bar on its own — patch/reset are spies, so "committed" never moves. */
function renderBar(overrides: Partial<AnalyticsFilters> = {}) {
  const patch = vi.fn();
  const reset = vi.fn();
  render(
    <QueryClientProvider client={newClient()}>
      <I18nProvider>
        <MemoryRouter initialEntries={["/reports/sales/executive"]}>
          <AnalyticsTopBar filters={{ ...DEFAULTS, ...overrides }} patch={patch} reset={reset} />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { patch, reset };
}

function LocationProbe() {
  const { search } = useLocation();
  return <span data-testid="search">{search}</span>;
}

/** The REAL hub, through the reports module dispatch (lazy → Suspense). */
function renderHub(path = "/reports/sales/executive") {
  render(
    <QueryClientProvider client={newClient()}>
      <I18nProvider>
        <MemoryRouter initialEntries={[path]}>
          <LocationProbe />
          <Routes>
            <Route path="/reports/sales/*" element={<ReportsModule />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const searchString = () => screen.getByTestId("search").textContent ?? "";

beforeEach(() => {
  for (const k of Object.keys(caps)) delete caps[k];
  caps["analytics.view"] = true;
  wire.get = async () => [];
  wire.post = async () => EMPTY_RESULT;
});

afterEach(cleanup);

/* ── 1) the collapsed bar ────────────────────────────────────────────────── */

describe("the collapsed bar", () => {
  it("shows the primary controls and NOTHING else", () => {
    renderBar();
    const bar = screen.getByTestId("analytics-topbar");

    for (const name of [AR.period, AR.branch, AR.compare]) {
      expect(
        within(bar).getByRole(name === AR.branch ? "button" : "combobox", { name }),
        `${name} must be visible without expanding anything`,
      ).toBeInTheDocument();
    }
    expect(within(bar).getByRole("button", { name: AR.apply })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: AR.more })).toBeInTheDocument();

    // …and every secondary control is genuinely absent from the DOM, not
    // merely styled away: a hidden-but-rendered control still takes tab stops
    // and still counts toward the height this defect is about.
    for (const name of [AR.brand, AR.item, AR.channel, AR.orderType]) {
      expect(screen.queryByRole("button", { name }), `${name} must be collapsed`).toBeNull();
    }
    expect(screen.queryByRole("radio", { name: AR.calendarDay })).toBeNull();
    expect(screen.queryByRole("radio", { name: AR.taxIncl })).toBeNull();
    expect(screen.queryByTestId("more-filters")).toBeNull();
  });

  it("renders the topbar exactly once (a duplicate testid is a strict-mode failure)", () => {
    renderBar();
    expect(screen.getAllByTestId("analytics-topbar")).toHaveLength(1);
  });

  it("uses full-width single-column primary fields on a phone", () => {
    renderBar();
    const primary = screen.getByTestId("analytics-primary-filters");
    expect(primary).toHaveClass("grid-cols-1", "sm:grid-cols-2");

    const period = screen.getByRole("combobox", { name: AR.period });
    expect(period.closest("span")?.parentElement).toHaveClass("w-full", "[&>span]:w-full");
    const branch = screen.getByRole("button", { name: AR.branch });
    expect(branch.parentElement).toHaveClass("w-full");
    const compare = screen.getByRole("combobox", { name: AR.compare });
    expect(compare.closest("span")?.parentElement).toHaveClass("w-full", "[&>span]:w-full");
  });

  it("keeps the freshness watermark hook when the query reports one", () => {
    render(
      <QueryClientProvider client={newClient()}>
        <I18nProvider>
          <MemoryRouter initialEntries={["/reports/sales/executive"]}>
            <AnalyticsTopBar
              filters={DEFAULTS}
              patch={vi.fn()}
              reset={vi.fn()}
              meta={{ freshness: { watermark: "2032-03-20T10:00:00Z" }, maskedMetrics: [] }}
            />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
    expect(document.querySelector("[data-freshness-watermark]")).not.toBeNull();
  });
});

/* ── 2) "more filters" — inline, never a panel ───────────────────────────── */

describe("more filters", () => {
  it("reveals the rest INSIDE the bar, with no dialog or drawer", () => {
    renderBar();
    const toggle = screen.getByRole("button", { name: AR.more });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    const more = screen.getByTestId("more-filters");
    // INLINE is the whole point: the revealed area is a descendant of the same
    // card, not a portal, not an overlay.
    expect(more.closest('[data-testid="analytics-topbar"]')).not.toBeNull();
    expect(toggle).toHaveAttribute("aria-controls", more.id);

    for (const name of [AR.brand, AR.item, AR.channel, AR.orderType]) {
      expect(within(more).getByRole("button", { name })).toBeInTheDocument();
    }
    expect(within(more).getByRole("radio", { name: AR.calendarDay })).toBeInTheDocument();
    expect(within(more).getByRole("radio", { name: AR.taxIncl })).toBeInTheDocument();

    // No side panel came back.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[data-testid="drawer"]')).toBeNull();

    fireEvent.click(toggle);
    expect(screen.queryByTestId("more-filters")).toBeNull();
  });

  it("keeps a deep link compact while its committed hidden scope stays visible", () => {
    renderBar({ channel: ["CH1"] });
    expect(screen.queryByTestId("more-filters")).toBeNull();
    // The chip names the committed value, not merely how many values exist.
    // When the lookup has no matching label, the raw persisted id is the
    // honest fallback and keeps a shared link auditable.
    expect(screen.getByTestId("active-filter-chips")).toHaveTextContent(`${AR.channel}: CH1`);
    expect(screen.getByRole("button", { name: AR.more })).toHaveAttribute("aria-expanded", "false");
  });
});

/* ── 3) draft → commit ───────────────────────────────────────────────────── */

describe("editing a filter", () => {
  it("does not touch the committed state until Apply", () => {
    const { patch } = renderBar();
    fireEvent.change(screen.getByRole("combobox", { name: AR.period }), {
      target: { value: "today" },
    });
    expect(patch, "an edit must not commit").not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: AR.apply }));
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0][0]).toMatchObject({ preset: "today" });
  });

  it("enables Apply only while the draft differs from what is committed", () => {
    renderBar();
    const applyBtn = screen.getByRole("button", { name: AR.apply });
    expect(applyBtn, "nothing to apply yet").toBeDisabled();
    expect(screen.queryByText("تغييرات غير مطبَّقة")).toBeNull();

    fireEvent.change(screen.getByRole("combobox", { name: AR.compare }), {
      target: { value: "prevYear" },
    });
    expect(applyBtn).toBeEnabled();
    expect(screen.getByText("تغييرات غير مطبَّقة")).toBeInTheDocument();
  });

  it("commits ONLY the keys that changed", () => {
    const { patch } = renderBar();
    fireEvent.click(screen.getByRole("button", { name: AR.more }));
    fireEvent.click(screen.getByRole("radio", { name: AR.taxIncl }));
    fireEvent.click(screen.getByRole("button", { name: AR.apply }));
    expect(patch).toHaveBeenCalledWith({ taxIncl: true });
  });

  it("fires no query until Apply, then commits to the URL", async () => {
    const posts: unknown[] = [];
    wire.post = async (_path, body) => {
      posts.push(body);
      return EMPTY_RESULT;
    };
    renderHub();
    await waitFor(() => expect(posts.length).toBeGreaterThan(0));
    const before = posts.length;
    const searchBefore = searchString();

    fireEvent.change(screen.getByRole("combobox", { name: AR.period }), {
      target: { value: "today" },
    });
    // Give react-query every chance to fire: the point is that it cannot,
    // because nothing the queries key off has changed.
    await act(async () => {
      await Promise.resolve();
    });
    expect(posts.length, "an edit must not re-query").toBe(before);
    expect(searchString(), "an edit must not touch the URL").toBe(searchBefore);

    fireEvent.click(screen.getByRole("button", { name: AR.apply }));
    await waitFor(() => expect(searchString()).toContain("preset=today"));
    await waitFor(() => expect(posts.length).toBeGreaterThan(before));
  });
});

/* ── 4) the results region while a commit is in flight ───────────────────── */

describe("the results region", () => {
  it("is aria-busy while the committed query refetches, and says the figures are behind", async () => {
    const pending: Array<() => void> = [];
    wire.post = () =>
      new Promise((resolve) => {
        pending.push(() => resolve(EMPTY_RESULT));
      });

    renderHub();
    const results = await screen.findByTestId("analytics-results");
    await waitFor(() => expect(results).toHaveAttribute("aria-busy", "true"));
    expect(screen.getByTestId("analytics-stale-notice")).toBeInTheDocument();

    await act(async () => {
      for (const resolve of pending) resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(results).not.toHaveAttribute("aria-busy"));
    expect(screen.queryByTestId("analytics-stale-notice")).toBeNull();
  });

  it("keeps the chip row describing the COMMITTED period, never the draft", () => {
    renderBar({ from: "2032-03-01", to: "2032-03-31", preset: "custom" });
    const chips = screen.getByTestId("active-filter-chips");
    // Whatever the locale formatter makes of it, the chip names the committed
    // window — asserting on the rendered text keeps this honest without
    // hard-coding a date format the shared formatter owns.
    expect(chips).toHaveTextContent("2032");
    const committedLabel = chips.textContent;

    fireEvent.change(screen.getByRole("combobox", { name: AR.period }), {
      target: { value: "today" },
    });
    expect(
      screen.getByTestId("active-filter-chips").textContent,
      "an uncommitted draft must not rewrite the label on the numbers",
    ).toBe(committedLabel);
  });
});

/* ── 5) a failed lookup ──────────────────────────────────────────────────── */

describe("a lookup that fails", () => {
  it("shows an error with a retry instead of an empty picker", async () => {
    wire.get = async (path: string) => {
      if (path.includes("/erp/branches-full")) throw new Error("boom");
      return [];
    };
    renderBar();

    const alert = await screen.findByTestId("lookup-error");
    expect(alert).toHaveAttribute("data-lookup-error", "branch");
    expect(alert).toHaveTextContent("تعذّر تحميل الفرع");
    expect(within(alert).getByRole("button", { name: AR.retry })).toBeInTheDocument();

    // The picker itself is GONE — "no options" must not be one of the ways a
    // broken request can look.
    expect(screen.queryByRole("button", { name: AR.branch })).toBeNull();
  });

  it("an empty (but successful) lookup still renders the picker", async () => {
    wire.get = async () => [];
    renderBar();
    await waitFor(() => expect(screen.getByRole("button", { name: AR.branch })).toBeInTheDocument());
    expect(screen.queryByTestId("lookup-error")).toBeNull();
  });
});
