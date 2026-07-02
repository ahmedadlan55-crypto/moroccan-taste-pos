import { describe, it, expect } from "vitest";
import {
  toInventoryRow,
  toInventoryPage,
  toItemDistribution,
  toItemMovements,
} from "../inventory.adapter";

describe("inventory.adapter", () => {
  it("maps a grid row: reserved stays null, status preserved, costEstimated honored", () => {
    const r = toInventoryRow({
      itemId: "RM-1", name: "بن", category: "خام", unit: "كجم",
      warehouseId: "WH-1", warehouseName: "المركزي",
      qty: 10, reserved: null, available: 10,
      avgCost: 54, costEstimated: false, value: 540,
      reorderPoint: 12, status: "low", lastMovementAt: "2026-06-29",
    });
    expect(r.sku).toBe("RM-1");
    expect(r.reserved).toBeNull();
    expect(r.available).toBe(10);
    expect(r.status).toBe("low");
    expect(r.costEstimated).toBe(false);
    expect(r.value).toBe(540);
  });

  it("falls back to 'available' for an unknown status", () => {
    expect(toInventoryRow({ status: "bogus" }).status).toBe("available");
  });

  it("toInventoryPage defaults pagination fields", () => {
    const page = toInventoryPage({ rows: [{ itemId: "X" }], total: 1 });
    expect(page.rows).toHaveLength(1);
    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(25);
    expect(page.totalPages).toBe(1);
  });

  it("toItemDistribution maps the warehouses array", () => {
    const d = toItemDistribution([{ warehouseId: "WH-1", warehouseName: "A", isMain: true, qty: 5, value: 50 }]);
    expect(d[0].isMain).toBe(true);
    expect(d[0].qty).toBe(5);
  });

  it("toItemMovements accepts a bare array OR a paginated { items }", () => {
    const a = toItemMovements([{ id: "M1", type: "in", qty: 3 }]);
    const b = toItemMovements({ items: [{ id: "M2", type: "out", qty: 2 }], total: 1 });
    expect(a[0].qty).toBe(3);
    expect(b[0].qty).toBe(2);
  });
});
