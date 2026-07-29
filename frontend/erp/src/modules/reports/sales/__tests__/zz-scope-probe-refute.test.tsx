// TEMPORARY PROBE — delete after running.
import { render, screen, cleanup } from "@testing-library/react";
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
    data: { columns: [], rows: [], subtotals: [], totals: { values: {} }, page: { limit: 50, offset: 0 } },
    meta: { freshness: { watermark: null }, completeness: [], maskedMetrics: [] },
  })),
}));

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: { ...actual.apiClient, get: vi.fn(async () => []), post: postSpy },
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
  postSpy.mockClear();
});
afterEach(cleanup);

describe("PROBE: printed scope vs actual filter narrowing", () => {
  it("logs the basis block text for a heavily-filtered URL", async () => {
    renderAt(
      "/reports/sales/executive?from=2026-07-01&to=2026-07-31&preset=lastMonth&brandId=3&branchId=7&channel=aggregator&orderType=delivery&paymentMethod=cash&hour=13",
    );
    const basis = await screen.findByTestId("basis-of-preparation");
    // eslint-disable-next-line no-console
    console.log("PROBE-SCOPE-TEXT >>>", JSON.stringify(basis.textContent));
    // what actually went on the wire
    const bodies = postSpy.mock.calls.map((c: unknown[]) => c[1]);
    // eslint-disable-next-line no-console
    console.log("PROBE-WIRE-BODY >>>", JSON.stringify(bodies).slice(0, 1500));
    // is the topbar (which carries the chips) inside the print area?
    const topbar = document.querySelector('[data-testid="analytics-topbar"]');
    // eslint-disable-next-line no-console
    console.log(
      "PROBE-TOPBAR >>>",
      topbar ? topbar.className : "MISSING",
      "| inPrintArea:",
      topbar ? !!topbar.closest(".print-document") : "n/a",
    );
    const printDoc = document.querySelector(".print-document");
    // eslint-disable-next-line no-console
    console.log(
      "PROBE-PRINTDOC-TEXT >>>",
      JSON.stringify((printDoc?.textContent ?? "").slice(0, 1200)),
    );
    expect(basis).toBeTruthy();
  });

  it("codec + buildFiltersBody: does the URL actually narrow the wire body?", async () => {
    const { analyticsFilterCodec } = await import("../lib/filters");
    const { buildFiltersBody } = await import("../lib/api");
    const parsed = analyticsFilterCodec.parse(
      new URLSearchParams(
        "from=2026-07-01&to=2026-07-31&preset=lastMonth&brandId=3&branchId=7&channel=aggregator&orderType=delivery&paymentMethod=cash&hour=13",
      ),
    );
    // eslint-disable-next-line no-console
    console.log("PROBE-PARSED >>>", JSON.stringify(parsed));
    // eslint-disable-next-line no-console
    console.log("PROBE-BODY >>>", JSON.stringify(buildFiltersBody(parsed)));
    expect(parsed).toBeTruthy();
  });
});
