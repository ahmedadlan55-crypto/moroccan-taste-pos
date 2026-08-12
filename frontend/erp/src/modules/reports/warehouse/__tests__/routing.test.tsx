import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/i18n";
import ReportsModule from "@/modules/reports";

const { useProcurementReportMock, serverFlags } = vi.hoisted(() => ({
  useProcurementReportMock: vi.fn(() => ({ isLoading: false, isError: false, data: { data: [] } })),
  serverFlags: { procurementP2P: true },
}));

vi.mock("@/modules/inventory/lib/providers", () => ({ WarehouseModuleProviders: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/modules/inventory/lib/WarehouseScopeSelect", () => ({ WarehouseScopeSelect: () => <span>scope</span> }));
vi.mock("@/modules/inventory/lib/warehouse-scope-provider", () => ({ ALL_WAREHOUSES: "all", useWarehouseScope: () => ({ scope: "all" }) }));
vi.mock("@/modules/inventory/lib/hooks/useAnalytics", () => ({
  useAnalytics: () => ({ isLoading: false, isError: false, data: {
    kpis: { inventoryValueWac: 100, totalQty: 10, itemCount: 2, lowCount: 1, outCount: 0, negativeCount: 0 },
    warnings: [], valueByWarehouse: [], topItemsByValue: [], movementTrend: [],
    dataQualityIndicators: { estimatedCostItems: 0, missingMinStock: 0 }, slowNoMovement: { count: 0 }, transfers: { inTransit: 0 },
  } }),
}));
vi.mock("@/modules/reports/warehouse/api", () => ({
  useWarehouseIntelligenceOverview: () => ({ isLoading: false, isError: false, data: {
    kpis: { purchaseSpend: 500, receivedQty: 10, openPoValue: 200, openPoQty: 3, supplierCount: 2, wasteValue: null, wasteQty: 3 },
    warnings: [], purchaseBySupplier: [], purchaseTrend: [], stockFlow: [{ type: "sale:out", label: "sale", direction: "out", qty: 8, value: null }],
    costCoverage: { totalStockCount: 0, costedStockCount: 0, estimatedCostStockCount: 0, uncostedStockCount: 0, costedPct: 0, estimatedPct: 0, uncostedPct: 0 },
    salesCostBridge: { state: "unavailable", netSalesExVat: null, cogsSnapshot: null, grossProfit: null, marginPct: null, coveragePct: null, includesReturns: false },
  } }),
  usePurchaseIntelligence: () => ({ isLoading: false, isError: false, data: { rows: [], totals: { qty: 0, netAmount: 0, vatAmount: 0, grossAmount: 0 }, pagination: { page: 1, pageSize: 50, total: 0, totalPages: 1 }, warnings: [] } }),
}));
vi.mock("@/modules/inventory/lib/hooks/useProcurement", () => ({ useProcurementReport: useProcurementReportMock }));
vi.mock("@/app/server-flags", () => ({ useServerFlags: () => serverFlags }));
vi.mock("@/modules/inventory/lib/hooks/useEntitySearch", () => ({
  supplierFetcher: async () => ({ items: [{ id: "SUP-1", name: "Supplier One", active: true }], nextPage: null, total: 1 }),
  makeItemFetcher: () => async () => ({ items: [], nextPage: null, total: 0 }),
}));
vi.mock("@/shared/lib/downloadCsv", () => ({ downloadCsv: vi.fn(async () => undefined) }));

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><I18nProvider><MemoryRouter initialEntries={[path]}><Routes><Route path="/reports/inventory/*" element={<ReportsModule />} /><Route path="/reports/purchasing" element={<ReportsModule />} /></Routes></MemoryRouter></I18nProvider></QueryClientProvider>);
}

beforeEach(() => {
  localStorage.setItem("erp_lang", "en");
  serverFlags.procurementP2P = true;
  useProcurementReportMock.mockClear();
});
afterEach(cleanup);

describe("warehouse intelligence report routing", () => {
  it("mounts inventory as a decision center with real report deep links", async () => {
    renderAt("/reports/inventory");
    await waitFor(() => expect(screen.getByTestId("inventory-decision-view")).toBeInTheDocument(), { timeout: 5_000 });
    expect(screen.getByRole("heading", { name: "Warehouse control center" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Stock flow by business source" })).toBeInTheDocument();
    expect(screen.getByText("Sales consumption")).toBeInTheDocument();
    expect(screen.getByText("Waste control")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Stock balance/ })).toHaveAttribute("href", expect.stringContaining("/reports/inventory/stock-balance"));
  });

  it("mounts purchasing in English without leaking Arabic UI copy", async () => {
    const view = renderAt("/reports/purchasing?report=open-orders");
    await waitFor(() => expect(screen.getByTestId("purchasing-decision-view")).toBeInTheDocument(), { timeout: 5_000 });
    expect(screen.getByRole("heading", { name: "Purchasing and cost control center" })).toBeInTheDocument();
    expect(view.container.textContent).not.toMatch(/[\u0600-\u06ff]/);
  });

  it("keeps the purchasing center usable without requesting dormant P2P reports", async () => {
    serverFlags.procurementP2P = false;
    renderAt("/reports/purchasing?report=open-orders");

    await waitFor(() => expect(screen.getByTestId("purchasing-decision-view")).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Purchasing and cost control center" })).toBeInTheDocument();
    expect(screen.getByText("Specialized procurement reports are unavailable")).toBeInTheDocument();
    expect(useProcurementReportMock).toHaveBeenCalledWith(
      "open-orders",
      expect.objectContaining({ warehouseId: undefined }),
      false,
    );
  });

  it("wires supplier statements only after a supplier is selected", async () => {
    renderAt("/reports/purchasing?report=supplier-statement");
    expect(screen.getByRole("option", { name: "Supplier statement" })).toBeDisabled();
    expect(screen.getByText("Select a supplier to open the statement")).toBeInTheDocument();
    expect(useProcurementReportMock).toHaveBeenCalledWith(
      "supplier-statement",
      expect.objectContaining({ supplierId: undefined }),
      false,
    );

    fireEvent.focus(screen.getByRole("combobox", { name: "Supplier filter" }));
    fireEvent.click(await screen.findByRole("option", { name: "Supplier One" }));
    const reportSelect = screen.getByRole("combobox", { name: "Select procurement report" });
    expect(screen.getByRole("option", { name: "Supplier statement" })).toBeEnabled();
    expect(reportSelect).toHaveValue("supplier-statement");

    await waitFor(() => expect(useProcurementReportMock).toHaveBeenCalledWith(
      "supplier-statement",
      expect.objectContaining({ supplierId: "SUP-1", warehouseId: undefined }),
      true,
    ));
  });

  it("exports the complete filtered purchase ledger through the scoped server endpoint", async () => {
    renderAt("/reports/purchasing");
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: "Export CSV" })); });
    const { downloadCsv } = await import("@/shared/lib/downloadCsv");
    await waitFor(() => expect(downloadCsv).toHaveBeenCalledWith(
      "/inventory/intelligence/purchases/export",
      expect.stringMatching(/^purchase-ledger-.*\.csv$/),
      expect.objectContaining({ warehouseId: undefined, q: "", lang: "en" }),
    ));
    await waitFor(() => expect(screen.getByRole("button", { name: "Export CSV" })).toBeEnabled());
  });
});
