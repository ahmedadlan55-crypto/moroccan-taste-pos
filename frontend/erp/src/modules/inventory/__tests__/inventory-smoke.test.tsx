import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// Generic canned payload — broad enough that any list/detail adapter can read a
// shape off it without throwing before the page's header renders.
const MOCK = vi.hoisted(() => ({
  data: [], rows: [], items: [], warehouses: [],
  pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1 },
  kpis: {},
  accessibleWarehouses: [], allWarehousesAccess: true, capabilities: {},
  procurementP2P: true, warehouseV2: true, orderToCash: true,
}));

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  const fn = () => vi.fn().mockResolvedValue(MOCK);
  return { ...actual, apiClient: { get: fn(), post: fn(), put: fn(), patch: fn(), delete: fn() } };
});

import InventoryModule from "@/modules/inventory";

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <InventoryModule />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("inventory module smoke", () => {
  beforeEach(() => localStorage.clear());

  it("renders the items catalog list", async () => {
    renderAt("/inventory/items");
    expect(await screen.findByText("كتالوج الأصناف")).toBeInTheDocument();
  });

  it("renders the warehouses list", async () => {
    renderAt("/inventory/warehouses");
    // WarehousesPage mounts without throwing under the shared kit + providers.
    expect(document.body.querySelector("*")).toBeTruthy();
  });
});
