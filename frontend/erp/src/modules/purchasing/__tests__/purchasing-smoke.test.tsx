import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// procurementP2P:true unlocks the ProcurementLayout (otherwise it renders the
// dormant "not enabled" state).
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

import PurchasingModule from "@/modules/purchasing";

describe("purchasing module smoke", () => {
  beforeEach(() => localStorage.clear());

  it("renders the P2P shell + purchase-orders list when the flag is on", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/purchasing/orders"]}>
          <PurchasingModule />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("المشتريات والموردون")).toBeInTheDocument();
  });
});
