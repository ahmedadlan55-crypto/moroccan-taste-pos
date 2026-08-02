import { describe, it, expect } from "vitest";
import { toProductionDetail } from "@/modules/inventory/lib/adapters/production.adapter";

/**
 * The genealogy rows are the lot-traceability answer: which component lot went
 * into which output lot. When the allocation ledger replaced the old
 * production_output_lots read, the server started serialising camelCase and
 * stopped sending a row `id` — but this adapter still read snake_case, so every
 * field except `qty` came back empty and the screen rendered "— ← (5)".
 *
 * TypeScript could not catch it: the adapter takes `any`. Only a test that
 * feeds the ACTUAL server shape can.
 */
describe("production detail — genealogy adapter", () => {
  // Exactly what lib/productionAllocation.js loadGenealogy() returns.
  const ledgerRow = {
    outputEventId: "PO-1",
    outputLotId: "LOT-OUT-9",
    outputLotNumber: "OUT-0009",
    producedAt: "2026-08-02T00:00:00.000Z",
    componentItemId: "ITM-RICE",
    componentName: "Basmati rice",
    componentLotId: "LOT-IN-4",
    componentLotNumber: "IN-0004",
    issueEventId: "IS-1",
    issueLineId: "ISL-1",
    warehouseId: "WH-1",
    qty: 5,
    unitCost: 2,
    value: 10,
    approximate: false,
  };

  it("reads the camelCase shape the allocation ledger actually sends", () => {
    const [row] = toProductionDetail({ genealogy: [ledgerRow] }).genealogy;
    expect(row.componentLotNumber, "component lot number").toBe("IN-0004");
    expect(row.outputLotNumber, "output lot number").toBe("OUT-0009");
    expect(row.componentLotId).toBe("LOT-IN-4");
    expect(row.outputLotId).toBe("LOT-OUT-9");
    expect(row.componentName).toBe("Basmati rice");
    expect(row.qty).toBe(5);
    expect(row.approximate).toBe(false);
  });

  it("gives every row a non-empty key even though the ledger sends no id", () => {
    const { genealogy } = toProductionDetail({
      genealogy: [ledgerRow, { ...ledgerRow, componentLotId: "LOT-IN-5", componentLotNumber: "IN-0005" }],
    });
    expect(genealogy.map((g) => g.id).every(Boolean), "no blank React keys").toBe(true);
    expect(new Set(genealogy.map((g) => g.id)).size, "keys are distinct").toBe(2);
  });

  it("flags pre-ledger rows so an approximate quantity is not read as exact", () => {
    const [row] = toProductionDetail({
      genealogy: [{ ...ledgerRow, outputEventId: null, unitCost: 0, value: 0, approximate: true }],
    }).genealogy;
    expect(row.approximate).toBe(true);
    // The linkage is still the real, useful part of a pre-ledger row.
    expect(row.componentLotNumber).toBe("IN-0004");
    expect(row.outputLotNumber).toBe("OUT-0009");
  });

  it("still reads the legacy snake_case shape, so a cached bundle keeps working", () => {
    const [row] = toProductionDetail({
      genealogy: [{
        id: "POL-1", output_lot_id: "LOT-OUT-9", output_lot_number: "OUT-0009",
        component_lot_id: "LOT-IN-4", component_lot_number: "IN-0004", qty: 5,
      }],
    }).genealogy;
    expect(row.id).toBe("POL-1");
    expect(row.componentLotNumber).toBe("IN-0004");
    expect(row.outputLotNumber).toBe("OUT-0009");
  });
});
