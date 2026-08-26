import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/i18n";

interface ReportQuery { isLoading: boolean; isError: boolean; data: unknown; refetch: () => void }
const EMPTY: ReportQuery = { isLoading: false, isError: false, data: { success: true, data: [] }, refetch: () => {} };

const { useProcurementReportMock, serverFlags, permissions } = vi.hoisted(() => ({
  // Typed on the ARGUMENTS as well as the return: `vi.fn()` with a bare
  // implementation infers `calls: []`, so `calls[0][1]` becomes a type error
  // and the per-report params — the whole point of these tests — go unchecked.
  useProcurementReportMock: vi.fn((..._args: unknown[]): { isLoading: boolean; isError: boolean; data: unknown; refetch: () => void } =>
    ({ isLoading: false, isError: false, data: { success: true, data: [] }, refetch: () => {} })),
  serverFlags: { procurementP2P: true },
  permissions: { granted: true },
}));

vi.mock("@/modules/inventory/lib/providers", () => ({ WarehouseModuleProviders: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/modules/inventory/lib/WarehouseScopeSelect", () => ({ WarehouseScopeSelect: () => <span>scope</span> }));
vi.mock("@/modules/inventory/lib/warehouse-scope-provider", () => ({ ALL_WAREHOUSES: "all", useWarehouseScope: () => ({ scope: "all" }) }));
vi.mock("@/app/providers", () => ({ usePermissions: () => ({ can: () => permissions.granted }) }));
vi.mock("@/app/server-flags", () => ({ useServerFlags: () => serverFlags }));
vi.mock("@/modules/inventory/lib/hooks/useProcurement", () => ({ useProcurementReport: useProcurementReportMock }));
vi.mock("@/modules/inventory/lib/hooks/useEntitySearch", () => ({
  supplierFetcher: async () => ({ items: [{ id: "SUP-1", name: "Supplier One", active: true }], nextPage: null, total: 1 }),
}));

const { PurchasingReportPage } = await import("../PurchasingReportPage");
const { PurchasingReportsDirectory } = await import("../PurchasingReportsDirectory");
const { PURCHASING_REPORT_IDS } = await import("../registry");

function mount(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <MemoryRouter initialEntries={["/reports/purchasing"]}>{node}</MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.setItem("erp_lang", "en");
  serverFlags.procurementP2P = true;
  permissions.granted = true;
  useProcurementReportMock.mockClear();
  useProcurementReportMock.mockReturnValue(EMPTY);
});
afterEach(cleanup);

describe("purchasing reports directory", () => {
  it("opens every report on its own page — never an anchor, never a duplicate", () => {
    mount(<PurchasingReportsDirectory />);
    const hrefs = PURCHASING_REPORT_IDS.map((id) => {
      const row = document.querySelector(`[data-report-item="${id}"] a[data-report-action]`);
      return row?.getAttribute("href");
    });
    expect(hrefs).toEqual(PURCHASING_REPORT_IDS.map((id) => `/reports/purchasing/${id}`));
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("groups the catalogue the way the owner asked, and keeps the workspace out of it", () => {
    mount(<PurchasingReportsDirectory />);
    for (const group of ["orders", "receiving", "payables", "tax", "dataQuality"]) {
      expect(document.querySelector(`[data-report-group="${group}"]`)).toBeInTheDocument();
    }
    // The workspace is reachable, but it is NOT one of the report rows.
    expect(screen.getByTestId("purchasing-workspace-link")).toHaveAttribute("href", "/reports/purchasing?workspace=1");
    expect(document.querySelector('[data-report-item="purchasing-control-center"]')).toBeNull();
  });
});

describe("purchasing report page", () => {
  it("sends ap-aging its own as-at filter and reads grandTotal, not totals", async () => {
    useProcurementReportMock.mockReturnValue({
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
      data: {
        success: true,
        data: [{ supplierId: "S-1", supplierName: "Supplier One", current: 10, d30: 0, d60: 0, d90: 0, d90plus: 0, total: 10 }],
        grandTotal: { current: 10, d30: 0, d60: 0, d90: 0, d90plus: 0, total: 10 },
        snapshot: { complete: true, rowCount: 1, rowLimit: 5000 },
      },
    });
    mount(<PurchasingReportPage reportId="ap-aging" />);

    const [type, params, enabled] = useProcurementReportMock.mock.calls[0] as unknown as [string, Record<string, unknown>, boolean];
    expect(type).toBe("ap-aging");
    expect(enabled).toBe(true);
    expect(params.asOfDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(params.dateFrom).toBeUndefined();
    expect(params.dateTo).toBeUndefined();

    await waitFor(() => expect(screen.getByTestId("purchasing-report-totals")).toBeInTheDocument());
    expect(screen.getAllByText("Total payable").length).toBeGreaterThan(0);
    // Declared, translated headers on BOTH renders — the screen table and the
    // separate print sheet, which is why the count is two and not one.
    expect(screen.getAllByRole("columnheader", { name: "Over 90 days" })).toHaveLength(2);
    // The paper copy carries the server's grandTotal in a real <tfoot>.
    const foot = document.querySelector(".print-document tfoot");
    expect(foot).toBeInTheDocument();
    expect(foot?.textContent).toContain("10.00");
    expect(screen.getByTestId("purchasing-report-snapshot")).toHaveTextContent("Complete snapshot: 1 rows");
    expect(screen.getByTestId("print-masthead")).toHaveTextContent("Warehouse scope: All accessible warehouses");
  });

  it("declares columns that survive an empty result", () => {
    mount(<PurchasingReportPage reportId="open-orders" />);
    // The old derived-column table rendered NO headers when rows were empty.
    expect(screen.getByText("No exceptions in this report")).toBeInTheDocument();
    expect(useProcurementReportMock.mock.calls[0]?.[1]).toMatchObject({ dateFrom: expect.any(String), dateTo: expect.any(String) });
  });

  it("turns the data-quality check object into labelled rows", async () => {
    useProcurementReportMock.mockReturnValue({
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
      data: {
        success: true,
        data: { invoicesWithoutSupplier: 3, duplicateInvoiceNumbers: 0 },
        snapshot: { complete: true, rowCount: 2, rowLimit: 5000 },
      },
    });
    mount(<PurchasingReportPage reportId="data-quality" />);
    await waitFor(() => expect(screen.getAllByText("Invoices with no linked supplier").length).toBeGreaterThan(0));
    expect(screen.getAllByRole("columnheader", { name: "Exceptions" }).length).toBeGreaterThan(0);
  });

  it("does not print or export a report whose complete snapshot is unverified", () => {
    useProcurementReportMock.mockReturnValue({
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
      data: { success: true, data: [{ period: "2026-08", net: 100, inputVat: 15 }] },
    });
    mount(<PurchasingReportPage reportId="tax" />);

    expect(screen.getByRole("alert")).toHaveTextContent("Report completeness cannot be verified");
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Print" })).toBeDisabled();
    expect(document.querySelector(".print-document")).toBeNull();
  });

  it("never calls supplier-statement without a supplier", () => {
    mount(<PurchasingReportPage reportId="supplier-statement" />);
    expect(screen.getByText("Select a supplier to open the statement")).toBeInTheDocument();
    expect(useProcurementReportMock.mock.calls[0]?.[2]).toBe(false);
  });

  it("refuses an unknown report instead of rendering an empty page", () => {
    mount(<PurchasingReportPage reportId="not-a-report" />);
    expect(screen.getAllByText("Unknown purchasing report").length).toBeGreaterThan(0);
    expect(useProcurementReportMock.mock.calls[0]?.[2]).toBe(false);
  });

  it("does not request a dormant P2P report", () => {
    serverFlags.procurementP2P = false;
    mount(<PurchasingReportPage reportId="tax" />);
    expect(useProcurementReportMock.mock.calls[0]?.[2]).toBe(false);
    expect(screen.getByText("Specialized procurement reports are unavailable")).toBeInTheDocument();
  });
});
