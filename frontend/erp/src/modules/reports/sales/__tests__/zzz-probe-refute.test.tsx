// TEMPORARY PROBE — delete after run.
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/i18n";
import ReportsModule from "@/modules/reports";

const { caps } = vi.hoisted(() => ({ caps: {} as Record<string, boolean> }));
vi.mock("@/shared/permissions", () => ({
  useCan: (cap: string) => caps[cap] ?? false,
  usePermissions: () => ({ can: (cap: string) => caps[cap] ?? false }),
  Can: ({ cap, children, fallback = null }: any) => ((caps[cap] ?? false) ? <>{children}</> : <>{fallback}</>),
}));

const WM = "2026-07-31T21:00:00.000Z";

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: {
      ...actual.apiClient,
      get: vi.fn(async () => []),
      post: vi.fn(async () => ({
        success: true,
        data: {
          columns: [],
          rows: [{ keys: ["2026-07-01"], labels: ["2026-07-01"], values: { orders: 40, net_ex_vat: 1000 } }],
          subtotals: [],
          totals: { values: { orders: 40, net_ex_vat: 1000, avg_ticket: 25, invoice_total: 1160 } },
          page: { limit: 50, offset: 0 },
        },
        meta: { freshness: { watermark: WM }, completeness: [], maskedMetrics: [] },
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
  caps["analytics.employees.view"] = true;
  caps["analytics.cost.view"] = true;
});
afterEach(cleanup);

describe("PROBE", () => {
  for (const seg of ["executive", "explorer", "taxes", "shifts", "profitability", "payments", "items"]) {
    it(`print area of ${seg}`, async () => {
      renderAt(`/reports/sales/${seg}`);
      await screen.findByTestId("basis-of-preparation");
      await waitFor(() => {
        const doc = document.querySelector(".print-document");
        expect(doc).not.toBeNull();
      });
      // give queries a beat to settle
      await new Promise((r) => setTimeout(r, 60));
      const doc = document.querySelector(".print-document") as HTMLElement;
      const txt = (doc.textContent ?? "").replace(/\s+/g, " ");
      const basis = screen.getByTestId("basis-of-preparation").textContent ?? "";
      // eslint-disable-next-line no-console
      console.log(
        `PROBE[${seg}] basisHasDataAsOf=${basis.includes("البيانات حتى")} ` +
          `printAreaHasRefreshedAt=${txt.includes("آخر تحديث")} ` +
          `printAreaHasAnyJuly31=${/2026|٢٠٢٦/.test(txt) && txt.includes("آخر تحديث")}`,
      );
      const i = txt.indexOf("آخر تحديث");
      // eslint-disable-next-line no-console
      if (i >= 0) console.log(`PROBE[${seg}] SNIPPET >>> ${txt.slice(i, i + 80)}`);
      expect(true).toBe(true);
    });
  }
});
