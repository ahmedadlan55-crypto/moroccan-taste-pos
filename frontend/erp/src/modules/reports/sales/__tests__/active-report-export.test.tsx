import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

import { I18nProvider } from "@/i18n";
import { ToastProvider } from "@/shared/ui";
import type { AnalyticsPlannerRequest } from "../lib/api";
import SalesAnalyticsHub from "../SalesAnalyticsHub";

const { createExportMock } = vi.hoisted(() => ({
  createExportMock: vi.fn(async () => ({ id: "EXP-ACTIVE", status: "queued" as const })),
}));

vi.mock("@/shared/permissions", () => ({
  useCan: () => true,
  usePermissions: () => ({ can: () => true }),
  Can: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: {
      ...actual.apiClient,
      get: vi.fn(async () => []),
    },
  };
});

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    createAnalyticsExport: createExportMock,
    // The assertion stops at job creation. Keeping the poll pending avoids
    // coupling this wiring test to ExportMenu's timer state machine.
    fetchAnalyticsExport: vi.fn(async () => ({ id: "EXP-ACTIVE", status: "running" as const })),
    fetchSavedViews: vi.fn(async () => []),
  };
});

// This test owns the hub -> top bar -> export wiring, not the report bodies.
// Replacing the lazy pages with inert components keeps an accidental page query
// from obscuring which report id the container handed to the export action.
vi.mock("../pages/registry", () => {
  const StubPage = () => <div data-testid="active-report-body" />;
  return {
    VIEW_PAGES: new Proxy<Record<string, typeof StubPage>>({}, {
      get: () => StubPage,
    }),
  };
});

function renderHub(path: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>
            <SalesAnalyticsHub />
          </MemoryRouter>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

async function createCsvExport(path: string): Promise<AnalyticsPlannerRequest> {
  renderHub(path);
  const exportMenu = await screen.findByTestId("export-menu");
  fireEvent.click(within(exportMenu).getByRole("button"));
  const menu = await screen.findByRole("menu");
  fireEvent.click(within(menu).getAllByRole("menuitem")[0]);
  await waitFor(() => expect(createExportMock).toHaveBeenCalledTimes(1));
  const calls = createExportMock.mock.calls as unknown as Array<[AnalyticsPlannerRequest]>;
  const request = calls[0]?.[0];
  if (!request) throw new Error("export request was not captured");
  return request;
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem("erp_lang", "en");
  createExportMock.mockClear();
});

afterEach(cleanup);

describe("sales hub exports the active report, not its containing center", () => {
  it.each([
    {
      report: "taxes",
      path: "/reports/sales/payments?view=taxes",
      metrics: ["vat_amount", "net_ex_vat"],
      dimensions: ["vat_rate"],
    },
    {
      report: "orders",
      path: "/reports/sales/operations?view=orders",
      metrics: ["orders", "invoice_total", "avg_ticket"],
      dimensions: ["business_day"],
    },
    {
      report: "profitability",
      path: "/reports/sales/items?view=profitability",
      metrics: [
        "qty_sold",
        "net_product_sales_ex_vat",
        "cogs",
        "cogs_after_returns",
        "gross_profit_after_returns",
        "margin_pct_after_returns",
        "uncosted_net",
        "uncosted_returns_net",
      ],
      dimensions: ["menu_item"],
    },
  ])("uses the $report registry export contract", async ({ path, metrics, dimensions }) => {
    const request = await createCsvExport(path);
    expect(request.metrics).toEqual(metrics);
    expect(request.dimensions).toEqual(dimensions);
  });

  it("hides an analytics export when it cannot preserve an operational drill filter", async () => {
    renderHub("/reports/sales/operations?view=orders&menuItemId=MENU-1");
    await screen.findByTestId("active-report-body");
    expect(screen.queryByTestId("export-menu")).not.toBeInTheDocument();
  });
});
