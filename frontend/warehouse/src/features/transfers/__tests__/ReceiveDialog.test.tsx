import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ReceiveDialog } from "../ReceiveDialog";
import type { TransferLine } from "@/lib/adapters/transfer.adapter";

const lines: TransferLine[] = [
  { id: "L1", item: { id: "I1", name: "سكر", unit: "كجم" }, qtyRequested: 30, qtyIssued: 30, qtyReceived: 10, qtyRemaining: 20, unitCost: 4 },
];

describe("ReceiveDialog (cumulative partial receipt)", () => {
  it("receive-all mode sends no items (undefined)", () => {
    const onConfirm = vi.fn();
    render(<ReceiveDialog open lines={lines} processing={false} error={null} onClose={() => {}} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "تأكيد الاستلام" }));
    expect(onConfirm).toHaveBeenCalledWith(undefined);
  });

  it("partial mode sends per-line deltas", () => {
    const onConfirm = vi.fn();
    render(<ReceiveDialog open lines={lines} processing={false} error={null} onClose={() => {}} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "كميات محددة" }));
    fireEvent.change(screen.getByLabelText("كمية سكر"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "تأكيد الاستلام" }));
    expect(onConfirm).toHaveBeenCalledWith([{ id: "L1", qtyReceived: 5 }]);
  });

  it("flags + blocks an over-receipt (qty > remaining)", () => {
    const onConfirm = vi.fn();
    render(<ReceiveDialog open lines={lines} processing={false} error={null} onClose={() => {}} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "كميات محددة" }));
    fireEvent.change(screen.getByLabelText("كمية سكر"), { target: { value: "25" } });
    expect(screen.getByText("يتجاوز المتبقي")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "تأكيد الاستلام" })).toBeDisabled();
  });
});
