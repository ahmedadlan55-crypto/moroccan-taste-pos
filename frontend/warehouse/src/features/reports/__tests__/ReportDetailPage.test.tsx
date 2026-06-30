import { describe, it, expect, afterEach, vi } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
import { ReportDetailPage } from "../ReportDetailPage";
import { renderWithProviders, stubFetch } from "@/test/test-utils";

afterEach(() => vi.unstubAllGlobals());

function envelope() {
  return {
    success: true,
    data: [
      { itemId: "IT-1", name: "سكر ناعم", category: "خام", warehouseName: "المركزي", qty: 100, avgCost: 4, value: 400, reorderPoint: 10, status: "available" },
      { itemId: "IT-2", name: "دقيق", category: "خام", warehouseName: "المركزي", qty: -5, avgCost: 2, value: 0, reorderPoint: 8, status: "negative" },
    ],
    totals: { totalValue: 400, totalQty: 100, rows: 2 },
    pagination: { page: 1, pageSize: 25, total: 2, totalPages: 1 },
    filters: {},
    scope: { allWarehousesAccess: true, warehouseId: null },
    generatedAt: "2026-06-30T10:00:00.000Z",
    dataQualityWarnings: [],
  };
}

function renderDetail(route = "/reports/stock-balance") {
  return renderWithProviders(
    <Routes>
      <Route path="reports/:reportType" element={<ReportDetailPage />} />
    </Routes>,
    { route },
  );
}

describe("ReportDetailPage (generic report table)", () => {
  it("renders rows, totals and the export/print controls", async () => {
    stubFetch((url) => {
      if (url.includes("/inventory/reports/stock-balance")) return { status: 200, body: envelope() };
      return { status: 200, body: { success: true } };
    });
    renderDetail();
    await waitFor(() => expect(screen.getByText("سكر ناعم")).toBeInTheDocument());
    expect(screen.getByText("دقيق")).toBeInTheDocument();
    expect(screen.getByText("إجمالي القيمة")).toBeInTheDocument(); // totals strip
    expect(screen.getByRole("button", { name: /تصدير CSV/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /طباعة/ })).toBeInTheDocument();
  });

  it("sorting a column writes sort+dir into the URL request", async () => {
    const mock = stubFetch((url) => {
      if (url.includes("/inventory/reports/stock-balance")) return { status: 200, body: envelope() };
      return { status: 200, body: { success: true } };
    });
    renderDetail();
    await waitFor(() => expect(screen.getByText("سكر ناعم")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /الكمية/ }));
    await waitFor(() => {
      const calledSort = mock.mock.calls.some((c) => /sort=qty/.test(String(c[0])));
      expect(calledSort).toBe(true);
    });
  });

  it("unknown report type shows a clear empty message", async () => {
    stubFetch(() => ({ status: 200, body: { success: true } }));
    renderDetail("/reports/does-not-exist");
    await waitFor(() => expect(screen.getByText("لا يوجد تقرير بهذا الاسم.")).toBeInTheDocument());
  });
});
