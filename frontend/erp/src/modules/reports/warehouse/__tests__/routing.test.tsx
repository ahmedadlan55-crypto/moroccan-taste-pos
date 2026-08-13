import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/i18n";
import ReportsModule from "@/modules/reports";
import { formatSpecializedValue } from "../WarehouseIntelligenceHub";

const { useProcurementReportMock, serverFlags, accountingFailures, permissions, accountingEnabledCalls } = vi.hoisted(() => ({
  useProcurementReportMock: vi.fn(() => ({ isLoading: false, isError: false, data: { data: [] } })),
  serverFlags: { procurementP2P: true },
  accountingFailures: { inventory: false, grni: false },
  permissions: { finance: true },
  accountingEnabledCalls: { inventory: [] as boolean[], grni: [] as boolean[] },
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
vi.mock("@/app/providers", () => ({ useCan: (cap: string) => cap === "finance.reports.view" ? permissions.finance : false }));
vi.mock("@/modules/reports/warehouse/api", () => ({
  useWarehouseIntelligenceOverview: () => ({ isLoading: false, isError: false, data: {
    kpis: { purchaseSpend: 500, receivedQty: 10, openPoValue: 200, openPoQty: 3, supplierCount: 2, wasteValue: null, wasteQty: 3 },
    warnings: [], purchaseBySupplier: [], purchaseTrend: [], stockFlow: [{ type: "sale:out", label: "sale", direction: "out", qty: 8, value: null }],
    costCoverage: { totalStockCount: 0, costedStockCount: 0, estimatedCostStockCount: 0, uncostedStockCount: 0, costedPct: 0, estimatedPct: 0, uncostedPct: 0 },
    salesCostBridge: { state: "unavailable", netSalesExVat: null, cogsSnapshot: null, grossProfit: null, marginPct: null, coveragePct: null, includesReturns: false },
  } }),
  usePurchaseIntelligence: () => ({ isLoading: false, isError: false, data: { rows: [], totals: { qty: 0, netAmount: 0, vatAmount: 0, grossAmount: 0 }, pagination: { page: 1, pageSize: 50, total: 0, totalPages: 1 }, warnings: [] } }),
  useInventoryAccountingReconciliation: (_warehouseId?: string, enabled = true) => { accountingEnabledCalls.inventory.push(enabled); return accountingFailures.inventory ? ({ isLoading: false, isError: true, error: new Error("forbidden"), data: undefined, refetch: vi.fn() }) : ({ isLoading: false, isError: false, refetch: vi.fn(), data: {
    rows: [{ warehouseId: "W-1", warehouseName: "Main", positiveValue: 100, negativeValue: 0, subledgerValue: 100, glBalance: 100, difference: 0, stockPositions: 2, wacPositions: 2, fallbackPositions: 0, missingCostPositions: 0, negativePositions: 0, orphanStockPositions: 0, negativeCostPositions: 0 }],
    summary: { positiveValue: 100, negativeValue: 0, subledgerValue: 100, glBalance: 100, difference: 0, stockPositions: 2, wacPositions: 2, fallbackPositions: 0, missingCostPositions: 0, negativePositions: 0, orphanStockPositions: 0, negativeCostPositions: 0, unallocatedGlValue: 0, warehouseDimensionDifferenceCount: 0, maxWarehouseDimensionDifference: 0, state: "reconciled", blockers: [], tolerance: 0.01 },
    measurement: { inventorySystem: "perpetual", accountingBasisState: "perpetual_current_control", perpetualReconciliationReady: true, costFormula: "weighted_average_by_item_and_warehouse", currentOnly: true, inventoryControlAccount: { role: "INVENTORY", accountId: "A-1", code: "1310" }, includesRecoverableVat: false, includesLandedCost: false },
    ias2Readiness: { carryingAmount: 100, carryingAmountReady: true, byInventoryClass: { state: "unavailable", reason: "missing" }, nrvAndWriteDowns: { state: "unavailable", reason: "missing" }, writeDownReversals: { state: "unavailable", reason: "missing" }, pledgedInventory: { state: "unavailable", reason: "missing" }, fairValueLessCostsToSell: { state: "not_applicable", reason: "none" } }, warnings: [],
  } }); },
  useGrniReconciliation: (_warehouseId?: string, enabled = true) => { accountingEnabledCalls.grni.push(enabled); return accountingFailures.grni ? ({ isLoading: false, isError: true, error: new Error("forbidden"), data: undefined, refetch: vi.fn() }) : ({ isLoading: false, isError: false, refetch: vi.fn(), data: {
    rows: [{ receiptId: "GR-1", receiptNumber: "GRN-1", receiptDate: "2026-08-10", warehouseId: "W-1", warehouseName: "Main", supplierId: "S-1", supplierName: "Supplier One", ageDays: 2, receivedValue: 100, invoicedValue: 60, returnedBeforeInvoiceValue: 0, outstandingValue: 40 }],
    detail: { shown: 1, totalOpenReceipts: 1, truncated: false, limit: 2000 },
    aging: { current: 0, d30: 40, d60: 0, d90: 0, d90plus: 0, negative: 0, total: 40 },
    reconciliation: { operationalOutstanding: 40, glBalance: 40, difference: 0, state: "reconciled", blockers: [], grniAccount: { role: "GRNI", accountId: "A-2", code: "2115" }, currentOnly: true }, warnings: [],
  } }); },
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
  accountingFailures.inventory = false;
  accountingFailures.grni = false;
  permissions.finance = true;
  accountingEnabledCalls.inventory.length = 0;
  accountingEnabledCalls.grni.length = 0;
  useProcurementReportMock.mockClear();
});
afterEach(cleanup);

describe("warehouse intelligence report routing", () => {
  it("formats quantity variance as quantity and price variance as currency", () => {
    expect(formatSpecializedValue("qty_variance", 2)).toBe(formatSpecializedValue("qty", 2));
    expect(formatSpecializedValue("price_variance", 2)).not.toBe(formatSpecializedValue("qty", 2));
  });
  it("mounts inventory as a decision center with real report deep links", async () => {
    renderAt("/reports/inventory?workspace=1");
    await waitFor(() => expect(screen.getByTestId("inventory-decision-view")).toBeInTheDocument(), { timeout: 5_000 });
    expect(screen.getByRole("heading", { name: "Warehouse control center" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Stock flow by business source" })).toBeInTheDocument();
    expect(screen.getByText("Sales consumption")).toBeInTheDocument();
    expect(screen.getByText("Waste control")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "IAS 2 valuation" }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId("inventory-accounting-reconciliation")).toBeInTheDocument();
    expect(screen.getByText("Advanced-report readiness register")).toBeInTheDocument();
    expect(screen.getByText("Historical as-of inventory valuation")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Historical as-of inventory valuation/ })).not.toBeInTheDocument();
  }, 12_000);

  it("mounts purchasing in English without leaking Arabic UI copy", async () => {
    const view = renderAt("/reports/purchasing?report=open-orders");
    await waitFor(() => expect(screen.getByTestId("purchasing-decision-view")).toBeInTheDocument(), { timeout: 5_000 });
    expect(screen.getByRole("heading", { name: "Purchasing and cost control center" })).toBeInTheDocument();
    expect(screen.getByTestId("grni-reconciliation")).toBeInTheDocument();
    expect(screen.getAllByText(/Source of truth/).length).toBeGreaterThan(0);
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

  it("keeps the decision center usable when finance-only reconciliations are forbidden", async () => {
    accountingFailures.inventory = true;
    renderAt("/reports/inventory?workspace=1");
    await waitFor(() => expect(screen.getByTestId("inventory-decision-view")).toBeInTheDocument());
    expect(screen.getByTestId("inventory-accounting-unavailable")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Warehouse control center" })).toBeInTheDocument();
  });

  it("does not enable finance-only reconciliation queries for procurement-only users", async () => {
    permissions.finance = false;
    renderAt("/reports/purchasing?workspace=1");
    await waitFor(() => expect(screen.getByTestId("purchasing-decision-view")).toBeInTheDocument());
    expect(screen.getByTestId("finance-only-reconciliation")).toBeInTheDocument();
    expect(accountingEnabledCalls.grni.length).toBeGreaterThan(0);
    expect(accountingEnabledCalls.grni.every((enabled) => enabled === false)).toBe(true);
    expect(screen.queryByTestId("grni-accounting-unavailable")).not.toBeInTheDocument();
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
    renderAt("/reports/purchasing?workspace=1");
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: "Export CSV" })); });
    const { downloadCsv } = await import("@/shared/lib/downloadCsv");
    await waitFor(() => expect(downloadCsv).toHaveBeenCalledWith(
      "/inventory/intelligence/purchases/export",
      expect.stringMatching(/^purchase-ledger-.*\.csv$/),
      expect.objectContaining({ warehouseId: undefined, q: "", lang: "en" }),
    ));
    await waitFor(() => expect(screen.getByRole("button", { name: "Export CSV" })).toBeEnabled());
  });

  it("keeps the report landing page free from the old stacked decision panels", async () => {
    renderAt("/reports/inventory");
    expect(await screen.findByTestId("warehouse-report-directory")).toBeInTheDocument();
    expect(screen.getByTestId("report-directory-grid")).toHaveClass("lg:grid-cols-2");
    expect(screen.queryByTestId("inventory-decision-view")).not.toBeInTheDocument();
    expect(screen.queryByTestId("inventory-accounting-reconciliation")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Warehouse control center/ })).toHaveAttribute("href", "/reports/inventory?workspace=1");
  });
});
