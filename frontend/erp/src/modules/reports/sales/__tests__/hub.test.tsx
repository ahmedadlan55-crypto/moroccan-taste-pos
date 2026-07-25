// Sales Analytics Hub — container behavior through the REAL reports module
// dispatch (/reports/sales/* → lazy hub): the /reports/sales → executive
// redirect, the 16-tab strip with capability-hidden tabs, deep-link denial on
// cap-gated segments, the analytics.view gate, and the unknown-segment state.
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/i18n";
import ReportsModule from "@/modules/reports";
import { SALES_HUB_SEGMENTS } from "../SalesAnalyticsHub";

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

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/reports/sales" element={<ReportsModule />} />
            <Route path="/reports/sales/*" element={<ReportsModule />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  for (const k of Object.keys(caps)) delete caps[k];
  caps["analytics.view"] = true;
});

afterEach(cleanup);

describe("SalesAnalyticsHub — routing", () => {
  it("redirects /reports/sales to the executive segment", async () => {
    renderAt("/reports/sales");
    const tabs = await screen.findAllByRole("tab");
    const selected = tabs.find((t) => t.getAttribute("aria-selected") === "true");
    expect(selected).toHaveTextContent("اللوحة التنفيذية");
    // the placeholder page for the segment renders a healthy empty state
    await waitFor(() =>
      expect(document.querySelector('[data-state="empty"]')).toBeInTheDocument(),
    );
  });

  it("renders the not-found state for an unknown segment", async () => {
    renderAt("/reports/sales/definitely-not-a-segment");
    await waitFor(() =>
      expect(document.querySelector('[data-state="not-found"]')).toBeInTheDocument(),
    );
  });
});

describe("SalesAnalyticsHub — capability gates", () => {
  it("denies the whole hub without analytics.view", async () => {
    caps["analytics.view"] = false;
    renderAt("/reports/sales/executive");
    await waitFor(() =>
      expect(document.querySelector('[data-state="permission-denied"]')).toBeInTheDocument(),
    );
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  it("hides the cashiers + profitability tabs without their caps (14 of 16)", async () => {
    renderAt("/reports/sales/executive");
    const tabs = await screen.findAllByRole("tab");
    expect(SALES_HUB_SEGMENTS).toHaveLength(16);
    expect(tabs).toHaveLength(14);
    expect(screen.queryByRole("tab", { name: "أداء الكاشير" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "الربحية" })).not.toBeInTheDocument();
  });

  it("shows all 16 tabs when the employee + cost caps are granted", async () => {
    caps["analytics.employees.view"] = true;
    caps["analytics.cost.view"] = true;
    renderAt("/reports/sales/executive");
    const tabs = await screen.findAllByRole("tab");
    expect(tabs).toHaveLength(16);
    expect(screen.getByRole("tab", { name: "أداء الكاشير" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "الربحية" })).toBeInTheDocument();
  });

  it("a deep-link to a cap-gated segment renders PermissionDenied (tabs stay)", async () => {
    renderAt("/reports/sales/profitability");
    await waitFor(() =>
      expect(document.querySelector('[data-state="permission-denied"]')).toBeInTheDocument(),
    );
    // the strip is still there so the user can navigate out
    expect((await screen.findAllByRole("tab")).length).toBeGreaterThan(0);
  });
});
