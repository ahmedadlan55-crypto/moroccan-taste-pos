// TEMPORARY PROBE — delete after run.
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/i18n";
import ReportsModule from "@/modules/reports";

const { caps } = vi.hoisted(() => ({ caps: {} as Record<string, boolean> }));
vi.mock("@/shared/permissions", () => ({
  useCan: (cap: string) => caps[cap] ?? false,
  usePermissions: () => ({ can: (cap: string) => caps[cap] ?? false }),
  Can: ({ cap, children, fallback = null }: { cap: string; children: React.ReactNode; fallback?: React.ReactNode }) =>
    (caps[cap] ?? false) ? <>{children}</> : <>{fallback}</>,
}));

const { postSpy } = vi.hoisted(() => ({
  postSpy: vi.fn(async () => ({
    success: true,
    data: { columns: [], rows: [], subtotals: [], totals: { values: { net_ex_vat: 12345 } }, page: { limit: 50, offset: 0 } },
    meta: { freshness: { watermark: null }, completeness: [], maskedMetrics: [] },
  })),
}));

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: {
      ...actual.apiClient,
      get: vi.fn(async (url: string) => {
        if (String(url).includes("/erp/branches-full")) return [{ id: "7", name: "فرع العليا" }];
        if (String(url).includes("/erp/brands")) return [{ id: "3", name: "علامة تجريبية" }];
        return [];
      }),
      post: postSpy,
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
  postSpy.mockClear();
  for (const k of Object.keys(caps)) delete caps[k];
  caps["analytics.view"] = true;
});
afterEach(cleanup);

describe("probe", () => {
  it("executive with branch+channel+hour filters", async () => {
    renderAt(
      "/reports/sales/executive?from=2026-07-01&to=2026-07-31&preset=lastMonth&brandId=3&branchId=7&channel=aggregator&orderType=delivery&paymentMethod=cash&hour=13",
    );
    const basis = await screen.findByTestId("basis-of-preparation");
    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    // eslint-disable-next-line no-console
    console.log("PROBE-POST-BODY >>>", JSON.stringify(postSpy.mock.calls[0]?.[1]));
    // eslint-disable-next-line no-console
    console.log("PROBE-SCOPE-TEXT >>>", basis.textContent);
    const page = await screen.findByTestId("page-executive");
    // eslint-disable-next-line no-console
    console.log("PROBE-PAGE-HEADER >>>", page.querySelector("header")?.textContent);
    // eslint-disable-next-line no-console
    console.log("PROBE-PRINTABLE >>>", !!basis.closest(".print-document"));
  });

  it("explorer with branch filter", async () => {
    renderAt("/reports/sales/explorer?from=2026-07-01&to=2026-07-31&branchId=7&channel=aggregator");
    const basis = await screen.findByTestId("basis-of-preparation");
    const doc = basis.closest(".print-document") as HTMLElement | null;
    // eslint-disable-next-line no-console
    console.log("PROBE-EXPLORER-BASIS >>>", basis.textContent);
    // eslint-disable-next-line no-console
    console.log("PROBE-EXPLORER-PRINTABLE-TEXT >>>", (doc?.textContent ?? "").slice(0, 800));
  });
});
