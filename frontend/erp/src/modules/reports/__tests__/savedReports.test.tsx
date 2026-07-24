// /reports/saved — wave 4: server+local merge (server wins on name+module),
// the analytics-view "فتح" deep link, the capability-gated schedules tab, and
// the schedule create dialog's POST body.
//
// The page talks to /api/saved-views and /api/analytics/schedules through the
// envelope-aware wrappers in modules/reports/sales/lib/api — apiClient itself
// is mocked here, so the REAL unwrap/merge logic is what's under test.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { I18nProvider } from "@/i18n";
import SavedReportsPage from "../pages/SavedReports";

/* ── permission gate (controllable) ── */
const { caps } = vi.hoisted(() => ({ caps: {} as Record<string, boolean> }));
vi.mock("@/shared/permissions", () => ({
  useCan: (cap: string) => caps[cap] ?? false,
  usePermissions: () => ({ can: (cap: string) => caps[cap] ?? false }),
  Can: ({ cap, children, fallback = null }: { cap: string; children?: ReactNode; fallback?: ReactNode }) =>
    (caps[cap] ?? false) ? <>{children}</> : <>{fallback}</>,
}));

/* ── transport ── */
const { api } = vi.hoisted(() => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return { ...actual, apiClient: { ...actual.apiClient, ...api } };
});

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname + loc.search}</div>;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <MemoryRouter initialEntries={["/reports/saved"]}>
          <SavedReportsPage />
          <LocationProbe />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  for (const k of Object.keys(caps)) delete caps[k];
  vi.clearAllMocks();
  window.localStorage.clear();

  // localStorage: a DUPLICATE of the server view (server must win) + a plain
  // DataTable view that only exists on this device.
  window.localStorage.setItem(
    "adlan.views.analytics:payments",
    JSON.stringify([{ id: "1", name: "مكرر", state: { filters: "channel=pos" } }]),
  );
  window.localStorage.setItem(
    "adlan.views.admin-users",
    JSON.stringify([{ id: "2", name: "جدول محلي", state: {} }]),
  );

  api.get.mockImplementation(async (path: string, opts?: { params?: { module?: string } }) => {
    if (path === "/saved-views") {
      if (opts?.params?.module === "analytics:payments") {
        return {
          success: true,
          data: [
            {
              id: "SV-9",
              name: "مكرر",
              module: "analytics:payments",
              filtersJson: { filters: "channel=online" },
            },
          ],
        };
      }
      return { success: true, data: [] };
    }
    if (path === "/analytics/schedules") return { success: true, data: [] };
    return { success: true, data: [] };
  });
  api.post.mockImplementation(async () => ({ success: true, data: { id: "SCH-1" } }));
  api.delete.mockImplementation(async () => ({ success: true }));
});

afterEach(cleanup);

describe("SavedReports — views merge", () => {
  it("merges server + local views with the SERVER winning on name+module", async () => {
    renderPage();
    // The local duplicate renders first (localStorage is synchronous); once
    // the server list lands the merge drops it — wait for the server badge.
    await screen.findByText("خادم");
    // exactly ONE «مكرر» row survives and it carries the SERVER badge
    await waitFor(() => expect(screen.getAllByText("مكرر")).toHaveLength(1));
    const row = screen.getAllByText("مكرر")[0].closest("li")!;
    expect(within(row).getByText("خادم")).toBeInTheDocument();
    // the device-only DataTable view is still listed, badged as local
    const localRow = screen.getByText("جدول محلي").closest("li")!;
    expect(within(localRow).getByText("جهاز")).toBeInTheDocument();
    // a non-analytics view gets NO open action
    expect(within(localRow).queryByRole("button", { name: /فتح/ })).not.toBeInTheDocument();
  });

  it("the analytics view's «فتح» opens the hub segment with the SERVER capture", async () => {
    renderPage();
    // wait until the SERVER row replaced the local duplicate before clicking
    await screen.findByText("خادم");
    await waitFor(() => expect(screen.getAllByText("مكرر")).toHaveLength(1));
    const row = screen.getAllByText("مكرر")[0].closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: /فتح/ }));
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/reports/sales/payments?channel=online",
      ),
    );
  });
});

describe("SavedReports — schedules tab", () => {
  it("is hidden without the analytics.schedule capability", async () => {
    renderPage();
    await screen.findAllByText("مكرر");
    expect(screen.queryByRole("tab", { name: "الجداول الزمنية" })).not.toBeInTheDocument();
  });

  it("creates a schedule with the correct POST body (daily → no weekday/month_day)", async () => {
    caps["analytics.schedule"] = true;
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "الجداول الزمنية" }));
    await screen.findByTestId("schedules-panel");

    fireEvent.click(screen.getByRole("button", { name: /جدولة جديدة/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("اسم الجدولة"), {
      target: { value: "تقرير الصباح" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "حفظ" }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    const [path, body] = api.post.mock.calls[0] as [
      string,
      {
        name: string;
        request: { range: { from: string; to: string }; metrics: string[]; dimensions: string[]; dateBasis: string };
        format: string;
        freq: string;
        at_time: string;
        weekday?: number;
        month_day?: number;
        timezone: string;
        is_active: boolean;
      },
    ];
    expect(path).toBe("/analytics/schedules");
    expect(body.name).toBe("تقرير الصباح");
    expect(body.format).toBe("csv");
    expect(body.freq).toBe("daily");
    expect(body.at_time).toBe("08:00");
    expect(body.timezone).toBe("Asia/Riyadh");
    expect(body.is_active).toBe(true);
    expect(body.weekday).toBeUndefined();
    expect(body.month_day).toBeUndefined();
    // the stored request is PLANNER-shaped (range + default metrics/dims)
    expect(body.request.metrics).toEqual(["net_ex_vat", "orders"]);
    expect(body.request.dimensions).toEqual(["business_day"]);
    expect(body.request.dateBasis).toBe("business_day");
    expect(body.request.range.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
