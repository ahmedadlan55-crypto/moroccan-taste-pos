import { describe, it, expect, afterEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { DashboardPage } from "../DashboardPage";
import { renderWithProviders, stubFetch } from "@/test/test-utils";

afterEach(() => vi.unstubAllGlobals());

const PAYLOAD = {
  success: true,
  scope: { warehouseId: null },
  kpis: { inventoryValue: 800, itemCount: 2, lowCount: 1, outCount: 0, negativeCount: 0, activeWarehouses: 1 },
  transfers: { pending: 3, inTransit: 2 },
  warehouses: [
    { id: "WH-T1", name: "مستودع المطبخ", code: "WH-T1", type: "branch", isActive: true, itemCount: 2, totalQty: 200, totalValue: 800, lowCount: 1, outCount: 0, negativeCount: 0, lastMovementAt: null },
  ],
  recentMovements: [{ id: "M1", date: "2026-06-29T10:00:00Z", itemId: "RM-1", itemName: "بن", type: "in", qty: 10, reason: "استلام", warehouseId: "WH-T1", warehouseName: "المطبخ" }],
  expiry: { available: true, count: 4, atRiskValue: 120, days: 30 },
};

describe("DashboardPage (real data)", () => {
  it("renders KPIs + warehouse health + recent movements from the API", async () => {
    stubFetch(() => ({ status: 200, body: PAYLOAD }));
    renderWithProviders(<DashboardPage />);
    await waitFor(() => expect(screen.getByText("قيمة المخزون")).toBeInTheDocument());
    expect(screen.getByText("الأصناف المسجلة")).toBeInTheDocument();
    expect(screen.getByText("تحويلات معلّقة")).toBeInTheDocument();
    expect(screen.getByText("مستودع المطبخ")).toBeInTheDocument(); // health table
    expect(screen.getByText("بن")).toBeInTheDocument(); // recent movement
  });

  it("honors the ?wh scope — calls the API with warehouseId", async () => {
    const mock = stubFetch(() => ({ status: 200, body: { ...PAYLOAD, scope: { warehouseId: "WH-T1" } } }));
    renderWithProviders(<DashboardPage />, { route: "/?wh=WH-T1" });
    await waitFor(() => expect(mock).toHaveBeenCalled());
    const url = mock.mock.calls[0][0] as string;
    expect(url).toContain("dashboard-summary");
    expect(url).toContain("warehouseId=WH-T1");
  });

  it("shows an error state (not empty data) when the API fails", async () => {
    stubFetch(() => ({ status: 500, body: { error: "boom" } }));
    renderWithProviders(<DashboardPage />);
    await waitFor(() => expect(screen.getByText(/تعذّر تحميل البيانات/)).toBeInTheDocument());
  });
});
