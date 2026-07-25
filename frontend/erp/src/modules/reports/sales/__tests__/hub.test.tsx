// Sales Analytics Hub — container behavior through the REAL reports module
// dispatch (/reports/sales/* → lazy hub): the /reports/sales → executive
// redirect, the grouped report picker with capability-hidden sections,
// deep-link denial on cap-gated segments, the analytics.view gate, and the
// unknown-segment state.
import { render, screen, waitFor, cleanup, fireEvent, within } from "@testing-library/react";
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

const PICKER = "أقسام تحليلات المبيعات";

/**
 * The picker is a closed menu — open it and return ITS listbox. Queries must be
 * scoped: the filter bar's native <select>s contribute <option> elements too,
 * so an unscoped getAllByRole("option") counts the period/compare choices.
 */
async function openPicker() {
  const trigger = await screen.findByRole("button", { name: PICKER });
  fireEvent.click(trigger);
  const listbox = await screen.findByRole("listbox", { name: PICKER });
  return within(listbox);
}

describe("SalesAnalyticsHub — routing", () => {
  it("redirects /reports/sales to the executive segment", async () => {
    renderAt("/reports/sales");
    // the picker trigger names the report you are reading
    expect(await screen.findByRole("button", { name: PICKER })).toHaveTextContent(
      "اللوحة التنفيذية",
    );
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
    expect(screen.queryByRole("button", { name: PICKER })).not.toBeInTheDocument();
  });

  it("hides the cashiers + profitability sections without their caps (14 of 16)", async () => {
    renderAt("/reports/sales/executive");
    const picker = await openPicker();
    expect(SALES_HUB_SEGMENTS).toHaveLength(16);
    expect(picker.getAllByRole("option")).toHaveLength(14);
    expect(picker.queryByRole("option", { name: /أداء الكاشير/ })).not.toBeInTheDocument();
    expect(picker.queryByRole("option", { name: /الربحية/ })).not.toBeInTheDocument();
  });

  it("shows all 16 sections when the employee + cost caps are granted", async () => {
    caps["analytics.employees.view"] = true;
    caps["analytics.cost.view"] = true;
    renderAt("/reports/sales/executive");
    const picker = await openPicker();
    expect(picker.getAllByRole("option")).toHaveLength(16);
    expect(picker.getByRole("option", { name: /أداء الكاشير/ })).toBeInTheDocument();
    expect(picker.getByRole("option", { name: /الربحية/ })).toBeInTheDocument();
  });

  it("groups the sections so sixteen reports stay scannable", async () => {
    caps["analytics.employees.view"] = true;
    caps["analytics.cost.view"] = true;
    renderAt("/reports/sales/executive");
    const picker = await openPicker();
    const groups = picker.getAllByRole("group");
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual([
      "نظرة عامة",
      "المنتجات والربحية",
      "المال والتحصيل",
      "التشغيل والموظفون",
      "متقدم",
    ]);
    // the open report is the selected option, so the menu reads "you are here"
    const selected = picker
      .getAllByRole("option")
      .filter((o) => o.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveTextContent("اللوحة التنفيذية");
  });

  it("a deep-link to a cap-gated segment renders PermissionDenied (picker stays)", async () => {
    renderAt("/reports/sales/profitability");
    await waitFor(() =>
      expect(document.querySelector('[data-state="permission-denied"]')).toBeInTheDocument(),
    );
    // the picker is still there so the user can navigate out
    expect(await screen.findByRole("button", { name: PICKER })).toBeInTheDocument();
  });
});
