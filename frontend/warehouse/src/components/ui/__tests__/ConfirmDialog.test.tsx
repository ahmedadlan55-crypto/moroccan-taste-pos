import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfirmDialog } from "../ConfirmDialog";

describe("ConfirmDialog", () => {
  it("disables confirm until a mandatory reason (≥3 chars) is entered", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog open title="إرجاع" requireReason confirmLabel="تأكيد" onConfirm={onConfirm} onClose={() => {}} />,
    );
    const confirm = screen.getByRole("button", { name: "تأكيد" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "تالف" } });
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith("تالف");
  });

  it("blocks double-submit while processing and shows a processing label", () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog open title="اعتماد" processing confirmLabel="اعتماد" onConfirm={onConfirm} onClose={() => {}} />);
    expect(screen.getByText(/جارٍ المعالجة/)).toBeInTheDocument();
    // The confirm button is disabled while processing → a second click is a no-op.
    const btn = screen.getByText(/جارٍ المعالجة/).closest("button")!;
    expect(btn).toBeDisabled();
  });

  it("surfaces an inline error (e.g. a 409 message)", () => {
    render(<ConfirmDialog open title="إصدار" error="تغيّرت الحالة — أعد التحميل" onConfirm={() => {}} onClose={() => {}} />);
    expect(screen.getByText("تغيّرت الحالة — أعد التحميل")).toBeInTheDocument();
  });
});
