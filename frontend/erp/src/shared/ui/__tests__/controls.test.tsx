import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Checkbox, Toggle, ConfirmDialog, NumberInput } from "@/shared/ui";

describe("Checkbox", () => {
  it("fires onChange when toggled", () => {
    const onChange = vi.fn();
    render(<Checkbox label="نشط" checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("نشط"));
    expect(onChange).toHaveBeenCalled();
  });
});

describe("Toggle", () => {
  it("exposes role=switch and toggles", () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} aria-label="تفعيل" />);
    const sw = screen.getByRole("switch");
    expect(sw).toHaveAttribute("aria-checked", "false");
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("NumberInput", () => {
  it("emits a number, or null when cleared", () => {
    const onChange = vi.fn();
    function Harness() {
      const [v, setV] = useState<number | null>(null);
      return (
        <NumberInput
          value={v}
          onChange={(n) => {
            setV(n);
            onChange(n);
          }}
          aria-label="الكمية"
        />
      );
    }
    render(<Harness />);
    const input = screen.getByLabelText("الكمية");
    fireEvent.change(input, { target: { value: "12.5" } });
    expect(onChange).toHaveBeenLastCalledWith(12.5);
    fireEvent.change(input, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});

describe("ConfirmDialog", () => {
  it("requires a reason before confirming when requireReason is set", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        title="عكس المستند"
        requireReason
        onConfirm={onConfirm}
        onClose={() => {}}
      />,
    );
    const confirmBtn = screen.getByRole("button", { name: "تأكيد" });
    expect(confirmBtn).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("اكتب السبب…"), {
      target: { value: "خطأ إدخال" },
    });
    expect(confirmBtn).not.toBeDisabled();
    fireEvent.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalledWith("خطأ إدخال");
  });
});
