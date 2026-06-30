import { describe, it, expect } from "vitest";
import { toDashboardSummary, toWarehousesSummary } from "../dashboard.adapter";

describe("dashboard.adapter", () => {
  it("coerces numbers, defaults arrays, and reads expiry availability", () => {
    const dto = toDashboardSummary({
      scope: { warehouseId: "WH-1" },
      kpis: { inventoryValue: "800", itemCount: 2, lowCount: "1", outCount: 0 },
      transfers: { pending: "3", inTransit: 4 },
      warehouses: [{ id: "WH-1", name: "المركزي", isActive: true, totalValue: "800", itemCount: 2 }],
      recentMovements: [{ id: "M1", type: "in", qty: "10", itemName: "بن" }],
      expiry: { available: true, count: 5, atRiskValue: "120.5", days: 30 },
    });
    expect(dto.kpis.inventoryValue).toBe(800);
    expect(dto.kpis.lowCount).toBe(1);
    expect(dto.transfers.pending).toBe(3);
    expect(dto.warehouses[0].totalValue).toBe(800);
    expect(dto.warehouses[0].isActive).toBe(true);
    expect(dto.recentMovements[0].qty).toBe(10);
    expect(dto.expiry.available).toBe(true);
    expect(dto.expiry.atRiskValue).toBe(120.5);
  });

  it("is defensive against missing/empty fields", () => {
    const dto = toDashboardSummary({});
    expect(dto.kpis.inventoryValue).toBe(0);
    expect(dto.warehouses).toEqual([]);
    expect(dto.recentMovements).toEqual([]);
    expect(dto.expiry.available).toBe(false);
    expect(dto.expiry.days).toBe(30);
  });

  it("toWarehousesSummary maps warehouses + totals", () => {
    const dto = toWarehousesSummary({
      warehouses: [{ id: "WH-1", name: "A", code: "A", isActive: true, totalValue: 800, itemCount: 2, lowCount: 1 }],
      totals: { warehouseCount: 1, activeCount: 1, itemCount: 2, totalValue: 800, lowCount: 1 },
    });
    expect(dto.warehouses).toHaveLength(1);
    expect(dto.totals.activeCount).toBe(1);
    expect(dto.totals.totalValue).toBe(800);
  });
});
