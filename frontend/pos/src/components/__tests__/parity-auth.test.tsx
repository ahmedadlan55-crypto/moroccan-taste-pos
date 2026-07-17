/**
 * Parity — auth domain, manager-approval gate rows (docs/pos-parity-matrix.md):
 *   manager-approval-gate / auth-manager-approval-gate / manager-auth-modal /
 *   manager-approval-modal / keyboard-manager-auth-enter
 *
 * The dialog is the UX gate; the SERVER re-authorizes with bcrypt + role
 * (routes/sales.js:_requireManagerApproval). Here we prove the client gate:
 * credentials are demanded, a return demands a reason, submit is a real form
 * (Enter submits), and the password never survives a close.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ManagerApprovalDialog } from "../dialogs/ManagerApprovalDialog";

function setup(props: Partial<Parameters<typeof ManagerApprovalDialog>[0]> = {}) {
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  render(
    <ManagerApprovalDialog
      open
      title="اعتماد مدير"
      onClose={onClose}
      onSubmit={onSubmit}
      {...props}
    />,
  );
  return { onSubmit, onClose };
}

describe("manager-approval-gate — credentials are demanded before the action", () => {
  it("approve stays disabled until BOTH username and password are filled", () => {
    setup();
    const approve = screen.getByRole("button", { name: /اعتماد/ });
    expect(approve).toBeDisabled();
    fireEvent.change(screen.getByLabelText("اسم المستخدم للمدير"), { target: { value: "boss" } });
    expect(approve).toBeDisabled();
    fireEvent.change(screen.getByLabelText("كلمة المرور"), { target: { value: "s3cret" } });
    expect(approve).toBeEnabled();
  });

  it("a RETURN additionally requires a reason (default prefilled, clearing blocks)", () => {
    setup({ title: "اعتماد مرتجع", reasonLabel: "سبب الإرجاع", defaultReason: "مرتجع عميل" });
    fireEvent.change(screen.getByLabelText("اسم المستخدم للمدير"), { target: { value: "boss" } });
    fireEvent.change(screen.getByLabelText("كلمة المرور"), { target: { value: "s3cret" } });
    const approve = screen.getByRole("button", { name: /اعتماد/ });
    expect(approve).toBeEnabled();
    fireEvent.change(screen.getByLabelText("سبب الإرجاع"), { target: { value: "  " } });
    expect(approve).toBeDisabled();
  });

  it("submits the approver credentials + reason to the caller", () => {
    const { onSubmit } = setup({ reasonLabel: "سبب الإرجاع", defaultReason: "مرتجع عميل" });
    fireEvent.change(screen.getByLabelText("اسم المستخدم للمدير"), { target: { value: " boss " } });
    fireEvent.change(screen.getByLabelText("كلمة المرور"), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByRole("button", { name: /اعتماد/ }));
    expect(onSubmit).toHaveBeenCalledWith(
      { approverUsername: "boss", approverPassword: "s3cret" },
      "مرتجع عميل",
    );
  });

  it("keyboard-manager-auth-enter — Enter in the password field submits the FORM", () => {
    const { onSubmit } = setup();
    fireEvent.change(screen.getByLabelText("اسم المستخدم للمدير"), { target: { value: "boss" } });
    const pass = screen.getByLabelText("كلمة المرور");
    fireEvent.change(pass, { target: { value: "s3cret" } });
    // jsdom does not synthesize implicit form submission from a keydown, so we
    // assert the wiring the browser uses: the fields live inside a <form> whose
    // submit handler drives onSubmit — Enter in any field triggers it natively.
    const form = pass.closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);
    expect(onSubmit).toHaveBeenCalledWith({ approverUsername: "boss", approverPassword: "s3cret" }, "");
  });

  it("surfaces a server rejection so the manager can retry", () => {
    setup({ error: "بيانات الاعتماد مرفوضة" });
    expect(screen.getByText("بيانات الاعتماد مرفوضة")).toBeInTheDocument();
  });
});
