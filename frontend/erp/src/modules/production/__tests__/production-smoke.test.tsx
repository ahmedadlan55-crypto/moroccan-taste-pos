import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "@/i18n";

const MOCK = vi.hoisted(() => ({
  data: [], rows: [], items: [], warehouses: [],
  pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1 },
  kpis: {},
  accessibleWarehouses: [], allWarehousesAccess: true, capabilities: {},
}));

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  const fn = () => vi.fn().mockResolvedValue(MOCK);
  return { ...actual, apiClient: { get: fn(), post: fn(), put: fn(), patch: fn(), delete: fn() } };
});

import ProductionModule from "@/modules/production";

describe("production module smoke", () => {
  beforeEach(() => localStorage.clear());

  it("renders the production orders list", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <I18nProvider>
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={["/inventory/production"]}>
            <ProductionModule />
          </MemoryRouter>
        </QueryClientProvider>
      </I18nProvider>,
    );
    expect(await screen.findByText("أوامر الإنتاج")).toBeInTheDocument();
  });
});
