import { describe, it, expect } from "vitest";
import { toAccessScope } from "../access-scope.adapter";

describe("toAccessScope", () => {
  it("normalizes a global admin scope", () => {
    const s = toAccessScope({
      success: true,
      enforced: true,
      role: "admin",
      allWarehousesAccess: true,
      accessibleWarehouses: [{ id: "WH-1", name: "A", code: "A1", type: "main", branchId: "", isActive: true }],
      capabilities: { "warehouse.view": true, "transfer.create": false },
    });
    expect(s.enforced).toBe(true);
    expect(s.allWarehousesAccess).toBe(true);
    expect(s.role).toBe("admin");
    expect(s.accessibleWarehouses.map((w) => w.id)).toEqual(["WH-1"]);
    expect(s.capabilities["warehouse.view"]).toBe(true);
    expect(s.capabilities["transfer.create"]).toBe(false);
  });

  it("defaults safely (deny) on a malformed/empty payload", () => {
    const s = toAccessScope(null);
    expect(s.allWarehousesAccess).toBe(false);
    expect(s.enforced).toBe(false);
    expect(s.accessibleWarehouses).toEqual([]);
    expect(s.capabilities).toEqual({});
  });

  it("drops warehouses without an id and coerces fields to strings", () => {
    const s = toAccessScope({ accessibleWarehouses: [{ id: "" }, { id: "WH-2", name: "Beta", code: 7 }] });
    expect(s.accessibleWarehouses.map((w) => w.id)).toEqual(["WH-2"]);
    expect(s.accessibleWarehouses[0].name).toBe("Beta");
    expect(s.accessibleWarehouses[0].code).toBe("7");
  });
});
