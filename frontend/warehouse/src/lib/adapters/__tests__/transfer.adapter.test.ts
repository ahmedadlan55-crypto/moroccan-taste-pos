import { describe, it, expect } from "vitest";
import { toTransfer, mapStatus } from "../transfer.adapter";
import { transfer as transferSchema } from "../../schemas/transfer.schema";

describe("transfer.adapter", () => {
  it("renames the legacy 'issued' status to 'in_transit' for the UI", () => {
    expect(mapStatus("issued")).toBe("in_transit");
    expect(mapStatus("partially_received")).toBe("partially_received");
    expect(mapStatus(undefined)).toBe("draft");
  });

  it("maps a legacy stock_issues row + items into the UI Transfer DTO", () => {
    const raw = {
      id: "SI-1",
      issue_number: "ISS-20260629-0014",
      status: "partially_received",
      from_warehouse_id: "WH-MAIN-01",
      from_warehouse_name: "المركزي",
      to_warehouse_id: "WH-BR-YAS",
      to_warehouse_name: "الياسمين",
      total_cost: 4820,
      items: [
        { id: "L1", item_id: "RM-1", item_name: "بن", item_unit: "كجم", qty_requested: 10, qty_issued: 10, qty_received: 4, unit_cost: 54 },
      ],
    };
    const dto = toTransfer(raw);
    expect(dto.number).toBe("ISS-20260629-0014");
    expect(dto.status).toBe("partially_received");
    expect(dto.fromWarehouse.name).toBe("المركزي");
    // cumulative remaining = issued − received
    expect(dto.lines[0].qtyRemaining).toBe(6);
    // and the whole thing satisfies the zod contract
    expect(transferSchema.safeParse(dto).success).toBe(true);
  });

  it("clamps qtyRemaining at zero (never negative)", () => {
    const dto = toTransfer({
      id: "SI-2",
      issue_number: "ISS-x",
      status: "received",
      items: [{ id: "L1", item_id: "i", qty_requested: 5, qty_issued: 5, qty_received: 5, unit_cost: 1 }],
    });
    expect(dto.lines[0].qtyRemaining).toBe(0);
  });
});
