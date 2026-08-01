// Sales Analytics Hub — wave 4 (saved views / exports / drill params).
//
//   1) codec roundtrip for the five new drill params
//      (paymentMethod / hour / menuItemId / categoryId / cashierId)
//   2) ExportMenu happy path: create → poll → done → download action shown
//   3) TopBar save-view: save posts the correct module + captured search;
//      selecting a stored view replaces the URL search
//   4) drills: Payments method row click pins paymentMethod; Hours heat cell
//      click lands on orders with the hour param merged into the search.
//
// lib/api is mocked at the module boundary (transport fns only) — codec
// helpers, buildFiltersBody, buildExportRequest and the export registry stay
// REAL, so the asserted request bodies are the production ones.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { I18nProvider } from "@/i18n";
import { ToastProvider } from "@/shared/ui";
import {
  createAnalyticsExport,
  fetchAnalyticsExport,
  fetchSavedViews,
  createSavedView,
  type AnalyticsExportJob,
  type AnalyticsPlannerRequest,
  type AnalyticsQueryBody,
  type AnalyticsResult,
} from "../lib/api";
import { createAnalyticsFilterCodec, type AnalyticsFilters } from "../lib/filters";
import { AnalyticsTopBar } from "../components/AnalyticsTopBar";
import { ExportMenu } from "../components/ExportMenu";
import Payments from "../pages/Payments";
import Hours from "../pages/Hours";

/* ── permission gate (controllable) ── */
const { caps } = vi.hoisted(() => ({ caps: {} as Record<string, boolean> }));
vi.mock("@/shared/permissions", () => ({
  useCan: (cap: string) => caps[cap] ?? false,
  usePermissions: () => ({ can: (cap: string) => caps[cap] ?? false }),
  Can: ({ cap, children, fallback = null }: { cap: string; children?: ReactNode; fallback?: ReactNode }) =>
    (caps[cap] ?? false) ? <>{children}</> : <>{fallback}</>,
}));

/* ── the download helper is a browser fetch — stubbed ── */
vi.mock("@/shared/lib/downloadCsv", () => ({ downloadCsv: vi.fn(async () => undefined) }));

/* ── option lookups in the TopBar go through apiClient ── */
vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: { ...actual.apiClient, get: vi.fn(async () => []) },
  };
});

/* ── analytics fixtures ── */
const { exportState } = vi.hoisted(() => ({
  exportState: { polls: 0, doneAfter: 1 },
}));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();

  const TOTALS: Record<string, number> = {
    payments_in: 1200,
    refunds_out: 30,
    net_collections: 1170,
    net_ex_vat: 1000,
    orders: 40,
  };
  const values = (metrics: string[]) => {
    const out: Record<string, number | null> = {};
    for (const m of metrics) if (TOTALS[m] != null) out[m] = TOTALS[m];
    return out;
  };
  const TUPLES: Record<string, Array<{ keys: Array<string | number | null>; labels: string[] }>> = {
    "": [{ keys: [], labels: [] }],
    payment_method: [
      { keys: ["cash"], labels: ["Cash"] },
      { keys: ["card"], labels: ["Card"] },
    ],
    "business_day,payment_method": [
      { keys: ["2026-07-01", "cash"], labels: ["2026-07-01", "Cash"] },
      { keys: ["2026-07-01", "card"], labels: ["2026-07-01", "Card"] },
    ],
    "weekday,hour": [
      { keys: [0, 10], labels: ["Mon", "10:00"] },
      { keys: [0, 11], labels: ["Mon", "11:00"] },
    ],
    hour: [
      { keys: [10], labels: ["10:00"] },
      { keys: [11], labels: ["11:00"] },
    ],
  };
  const REGISTRY = {
    metrics: [
      "payments_in", "refunds_out", "net_collections", "tips_total",
      "net_ex_vat", "orders",
    ].map((id) => ({ id, kind: "additive", format: "money", equationKey: "sum" })),
    dimensions: [],
  };

  return {
    ...actual,
    fetchAnalyticsRegistry: vi.fn(async () => REGISTRY as unknown as import("../lib/api").AnalyticsRegistry),
    runAnalyticsQuery: vi.fn(async (body: AnalyticsQueryBody): Promise<AnalyticsResult> => {
      const sig = body.dimensions.join(",");
      const tuples = TUPLES[sig] ?? [];
      return {
        columns: [],
        rows: tuples.map((tu) => ({ keys: tu.keys, labels: tu.labels, values: values(body.metrics) })),
        totals: values(body.metrics),
        meta: { freshness: { watermark: null }, maskedMetrics: [] },
      } as unknown as AnalyticsResult;
    }),
    createAnalyticsExport: vi.fn(async (): Promise<AnalyticsExportJob> => ({ id: "EXP-1", status: "queued" })),
    fetchAnalyticsExport: vi.fn(async (id: string): Promise<AnalyticsExportJob> => {
      exportState.polls += 1;
      return { id, status: exportState.polls >= exportState.doneAfter ? "done" : "running" };
    }),
    fetchSavedViews: vi.fn(async (module: string) =>
      module === "analytics:payments"
        ? [{ id: "SV-1", name: "طريقة محفوظة", module, filtersJson: { filters: "channel=online" } }]
        : [],
    ),
    createSavedView: vi.fn(async (input: { module: string; name: string; filtersJson: unknown }) => ({
      id: "SV-NEW",
      name: input.name,
      module: input.module,
      filtersJson: input.filtersJson,
    })),
  };
});

const createExportMock = vi.mocked(createAnalyticsExport);
const fetchExportMock = vi.mocked(fetchAnalyticsExport);
const fetchSavedViewsMock = vi.mocked(fetchSavedViews);
const createSavedViewMock = vi.mocked(createSavedView);

/* ── harness ── */

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname + loc.search}</div>;
}

function renderAt(node: ReactNode, path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>
            {node}
            <LocationProbe />
          </MemoryRouter>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const CODEC = createAnalyticsFilterCodec("2026-07-24");
const DEFAULTS: AnalyticsFilters = CODEC.parse(new URLSearchParams());

beforeEach(() => {
  // Tables now carry a stable `tableId`, so DataTable persists sort/pageSize/
  // hidden columns to localStorage. Without this clear, one test's column or
  // sort choice leaks into the next and the file fails depending on ORDER.
  window.localStorage.clear();
  for (const k of Object.keys(caps)) delete caps[k];
  exportState.polls = 0;
  exportState.doneAfter = 1;
  vi.clearAllMocks();
});

afterEach(cleanup);

/* ── 1) codec roundtrip ── */

describe("wave-4 codec params", () => {
  it("round-trips the five drill params losslessly", () => {
    const state: AnalyticsFilters = {
      ...DEFAULTS,
      paymentMethod: ["cash", "card"],
      hour: "13",
      menuItemId: ["M1", "M2"],
      categoryId: ["C9"],
      cashierId: ["U4"],
    };
    const serialized = CODEC.serialize(state);
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(serialized)) if (v != null) sp.set(k, v);
    expect(sp.get("paymentMethod")).toBe("cash,card");
    expect(sp.get("hour")).toBe("13");
    expect(sp.get("menuItemId")).toBe("M1,M2");
    expect(sp.get("categoryId")).toBe("C9");
    expect(sp.get("cashierId")).toBe("U4");
    expect(CODEC.parse(sp)).toEqual(state);
  });

  it("serializes the drill-param defaults to null (clean URL)", () => {
    const serialized = CODEC.serialize(DEFAULTS);
    for (const key of ["paymentMethod", "hour", "menuItemId", "categoryId", "cashierId"]) {
      expect(serialized[key], key).toBeNull();
    }
  });
});

/* ── 2) ExportMenu happy path ── */

describe("ExportMenu", () => {
  it("creates the job, polls to done, then shows the download action", async () => {
    const { downloadCsv } = await import("@/shared/lib/downloadCsv");
    renderAt(
      <ExportMenu segment="payments" filters={DEFAULTS} pollIntervalMs={5} pollTimeoutMs={2000} />,
      "/reports/sales/payments",
    );

    fireEvent.click(screen.getByRole("button", { name: "تصدير" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "تصدير CSV" }));

    await waitFor(() => expect(createExportMock).toHaveBeenCalledTimes(1));
    // The REAL buildExportRequest ran against the page registry (Payments
    // registered at import) — a planner-shaped request, not a query body.
    const [request, format] = createExportMock.mock.calls[0] as [AnalyticsPlannerRequest, string];
    expect(format).toBe("csv");
    expect(request.metrics).toEqual(["payments_in", "refunds_out", "net_collections"]);
    expect(request.dimensions).toEqual(["payment_method"]);
    expect(request.range).toEqual({ from: DEFAULTS.from, to: DEFAULTS.to });
    expect(request.dateBasis).toBe("business_day");

    // queued toast, then the poll resolves done → ready toast + download action
    expect(await screen.findByText("التصدير في قائمة الانتظار")).toBeInTheDocument();
    const download = await screen.findByRole("button", { name: /تنزيل التصدير/ });
    expect(fetchExportMock).toHaveBeenCalled();

    fireEvent.click(download);
    await waitFor(() =>
      expect(vi.mocked(downloadCsv)).toHaveBeenCalledWith(
        "/analytics/exports/EXP-1/download",
        expect.stringMatching(/^sales-payments-.*\.csv$/),
      ),
    );
  });
});

/* ── 3) TopBar save-view ── */

describe("AnalyticsTopBar save-view", () => {
  function renderBar(path: string, overrides: Partial<AnalyticsFilters> = {}) {
    const patch = vi.fn();
    const reset = vi.fn();
    renderAt(
      <AnalyticsTopBar filters={{ ...DEFAULTS, ...overrides }} patch={patch} reset={reset} />,
      path,
    );
    return { patch, reset };
  }

  it("saves the current URL search under the segment module", async () => {
    renderBar("/reports/sales/payments?channel=pos", { channel: ["pos"] });
    await waitFor(() => expect(fetchSavedViewsMock).toHaveBeenCalledWith("analytics:payments", expect.anything()));

    fireEvent.click(screen.getByRole("button", { name: "حفظ العرض" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "حفظ العرض الحالي" }));

    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "عرضي الجديد" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "حفظ" }));

    await waitFor(() =>
      expect(createSavedViewMock).toHaveBeenCalledWith({
        module: "analytics:payments",
        name: "عرضي الجديد",
        filtersJson: { filters: "channel=pos" },
      }),
    );
  });

  it("selecting a stored view replaces the URL search with the captured one", async () => {
    renderBar("/reports/sales/payments?channel=pos", { channel: ["pos"] });
    fireEvent.click(screen.getByRole("button", { name: "حفظ العرض" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "طريقة محفوظة" }));
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/reports/sales/payments?channel=online"),
    );
  });
});

/* ── 4) drills ── */

describe("wave-4 drills", () => {
  it("Payments: a method row click pins paymentMethod (push)", async () => {
    renderAt(<Payments />, "/reports/sales/payments");
    const cells = await screen.findAllByText("Cash");
    const cell = cells.find((el) => el.closest("td") != null) ?? cells[0];
    fireEvent.click(cell);
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("paymentMethod=cash"),
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/reports/sales/payments");
  });

  it("Hours: a heat cell click lands on orders with the hour param merged", async () => {
    renderAt(<Hours />, "/reports/sales/hours?channel=pos");
    const cell = await screen.findByRole("button", { name: /Mon × 10:00/ });
    fireEvent.click(cell);
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/reports/sales/orders"),
    );
    const probe = screen.getByTestId("location").textContent ?? "";
    expect(probe).toContain("hour=10");
    expect(probe).toContain("channel=pos"); // the current search survived the drill
  });
});
