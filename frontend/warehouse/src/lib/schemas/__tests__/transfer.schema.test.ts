import { describe, it, expect } from "vitest";
import {
  createTransferDraftInput,
  receiveTransferInput,
  reverseTransferInput,
} from "../transfer.schema";

describe("transfer input schemas", () => {
  it("accepts a valid draft", () => {
    const r = createTransferDraftInput.safeParse({
      fromWarehouseId: "A", toWarehouseId: "B", items: [{ itemId: "I1", qtyRequested: 5 }],
    });
    expect(r.success).toBe(true);
  });

  it("rejects same source and destination", () => {
    const r = createTransferDraftInput.safeParse({
      fromWarehouseId: "A", toWarehouseId: "A", items: [{ itemId: "I1", qtyRequested: 5 }],
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toMatch(/مختلف/);
  });

  it("rejects empty items", () => {
    const r = createTransferDraftInput.safeParse({ fromWarehouseId: "A", toWarehouseId: "B", items: [] });
    expect(r.success).toBe(false);
  });

  it("rejects zero / negative quantity", () => {
    expect(createTransferDraftInput.safeParse({ fromWarehouseId: "A", toWarehouseId: "B", items: [{ itemId: "I1", qtyRequested: 0 }] }).success).toBe(false);
    expect(createTransferDraftInput.safeParse({ fromWarehouseId: "A", toWarehouseId: "B", items: [{ itemId: "I1", qtyRequested: -2 }] }).success).toBe(false);
  });

  it("receive allows omitted items (receive-all) and carries expectedVersion", () => {
    expect(receiveTransferInput.safeParse({ expectedVersion: 3 }).success).toBe(true);
    expect(receiveTransferInput.safeParse({ items: [{ id: "L1", qtyReceived: 2 }] }).success).toBe(true);
  });

  it("reverse requires a reason of at least 3 chars", () => {
    expect(reverseTransferInput.safeParse({ reason: "ok" }).success).toBe(false);
    expect(reverseTransferInput.safeParse({ reason: "تالف" }).success).toBe(true);
  });
});
