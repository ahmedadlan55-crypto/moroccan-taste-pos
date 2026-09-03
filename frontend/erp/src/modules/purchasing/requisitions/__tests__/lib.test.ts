// The rules a branch user relies on, asserted without rendering anything.
import { describe, expect, it } from "vitest";
import { buildConvertPayload, convertNetTotal, requisitionSteps, warehouseForBranch } from "../lib";

describe("warehouseForBranch", () => {
  const branches = [
    { id: "BR-RUH", warehouseId: "WH-RUH" },
    { id: "BR-JED", warehouseId: "" },
  ];
  it("returns the branch's warehouse", () => {
    expect(warehouseForBranch(branches, "BR-RUH")).toBe("WH-RUH");
  });
  it("returns nothing for a branch with no warehouse, an unknown branch, or no branch", () => {
    // The form must not clear or invent a warehouse in any of these cases.
    expect(warehouseForBranch(branches, "BR-JED")).toBe("");
    expect(warehouseForBranch(branches, "BR-NOPE")).toBe("");
    expect(warehouseForBranch(branches, "")).toBe("");
  });
});

describe("requisitionSteps", () => {
  it("walks the happy path", () => {
    const steps = requisitionSteps("approved");
    expect(steps.map((s) => s.key)).toEqual(["draft", "submitted", "approved", "converted"]);
    expect(steps.find((s) => s.current)?.key).toBe("approved");
    expect(steps.filter((s) => s.reached).map((s) => s.key)).toEqual(["draft", "submitted", "approved"]);
  });
  it("shows a rejected request as rejected, not as a draft that never got approved", () => {
    const steps = requisitionSteps("rejected");
    expect(steps.map((s) => s.key)).toEqual(["draft", "submitted", "rejected"]);
    expect(steps.find((s) => s.current)?.key).toBe("rejected");
  });
});

describe("buildConvertPayload", () => {
  const lines = [
    { id: "L1", estimated_price: 10 },
    { id: "L2", estimated_price: 4 },
  ];
  it("sends only the supplier when nothing was changed", () => {
    expect(buildConvertPayload("SUP-1", lines, {})).toEqual({ supplierId: "SUP-1" });
  });
  it("sends only lines whose price DIFFERS from the estimate", () => {
    // An untouched line must fall back server-side to its estimate exactly as
    // before the approver could edit it; sending the same number is noise
    // that would also mask a later change to the estimate.
    const p = buildConvertPayload("SUP-1", lines, { L1: { unitPrice: 10 }, L2: { unitPrice: 4.5 } });
    expect(p).toEqual({ supplierId: "SUP-1", lines: { L2: { unitPrice: 4.5 } } });
  });
  it("treats a null VAT as 'standard' and does not send it", () => {
    const p = buildConvertPayload("SUP-1", lines, { L1: { unitPrice: 11, vatRate: null }, L2: { vatRate: 0 } });
    expect(p.lines).toEqual({ L1: { unitPrice: 11 }, L2: { vatRate: 0 } });
  });
  it("ignores a non-finite price rather than sending NaN", () => {
    const p = buildConvertPayload("SUP-1", lines, { L1: { unitPrice: Number.NaN } });
    expect(p).toEqual({ supplierId: "SUP-1" });
  });
});

describe("convertNetTotal", () => {
  const lines = [
    { id: "L1", quantity: 3, estimated_price: 10 },
    { id: "L2", quantity: 2, estimated_price: 4 },
  ];
  it("uses the estimate until a price is overridden", () => {
    expect(convertNetTotal(lines, {})).toBe(38);
    expect(convertNetTotal(lines, { L1: { unitPrice: 12.5 } })).toBe(3 * 12.5 + 8);
  });
});
