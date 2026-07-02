import { describe, it, expect, afterEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { AnalyticsPage } from "../AnalyticsPage";
import { renderWithProviders, stubFetch } from "@/test/test-utils";

afterEach(() => vi.unstubAllGlobals());

function analyticsBody() {
  return {
    success: true,
    data: {
      kpis: { inventoryValueWac: 800, estimatedCostValue: 0, itemCount: 2, totalQty: 200, availableCount: 2, lowCount: 0, outCount: 0, negativeCount: 0, activeWarehouses: 1 },
      valueByWarehouse: [{ id: "WH-1", name: "المركزي", code: "C1", value: 800, qty: 200 }],
      warehouseComparison: [{ id: "WH-1", name: "المركزي", code: "C1", type: "main", itemCount: 2, totalQty: 200, totalValue: 800, lowCount: 0, outCount: 0, negativeCount: 0, estimatedValue: 0, availableCount: 2 }],
      valueByCategory: [{ category: "خام", value: 800, qty: 200, items: 2 }],
      topItemsByValue: [{ itemId: "IT-1", name: "سكر", category: "خام", qty: 100, value: 400 }],
      movementTrend: [{ bucket: "2026-06-01", in: 10, out: 5 }],
      slowNoMovement: { window: 90, count: 0 },
      transfers: { pending: 0, inTransit: 0, remainingQty: 0, byStatus: {} },
      dataQualityIndicators: { estimatedCostItems: 0, missingMinStock: 0, expiryCoverage: { lots: 0, covered: 0, reliable: false } },
    },
    totals: {},
    filters: {},
    scope: { allWarehousesAccess: true, warehouseId: null },
    generatedAt: "2026-06-30T10:00:00.000Z",
    dataQualityWarnings: [{ code: "EXPIRY_LOW_COVERAGE", message: "تقديري: لا توجد طبقات استلام كافية.", level: "warning" }],
  };
}

describe("AnalyticsPage (real data)", () => {
  it("renders KPIs + warehouse comparison + the data-quality warning", async () => {
    stubFetch((url) => {
      if (url.includes("/inventory/analytics/summary")) return { status: 200, body: analyticsBody() };
      return { status: 200, body: { success: true } };
    });
    renderWithProviders(<AnalyticsPage />);
    // warehouse comparison table always renders the warehouse name from real data
    await waitFor(() => expect(screen.getAllByText("المركزي").length).toBeGreaterThan(0));
    // the تقديري data-quality warning + estimated-cost framing surface
    expect(screen.getAllByText(/تقديري/).length).toBeGreaterThan(0);
  });
});
