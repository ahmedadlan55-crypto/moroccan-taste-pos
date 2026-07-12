import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LeaveRequestForm } from "../components/LeaveRequestForm";

describe("LeaveRequestForm", () => {
  it("shows a zod validation error and does not submit when required fields are empty", async () => {
    const onSubmit = vi.fn();
    render(<LeaveRequestForm employees={[]} leaveTypes={[]} onSubmit={onSubmit} onCancel={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "إرسال الطلب" }));

    // requiredId → "الاختيار مطلوب" is surfaced as a Field error (role=alert).
    const errors = await screen.findAllByText("الاختيار مطلوب");
    expect(errors.length).toBeGreaterThan(0);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits the captured values when the form is valid", async () => {
    const onSubmit = vi.fn();
    render(
      <LeaveRequestForm
        employees={[{ id: "e1", employeeNumber: "EMP-001", fullName: "محمد أحمد", status: "active", basicSalary: 0, totalAllowances: 0, grossSalary: 0 }]}
        leaveTypes={[{ id: "lt1", name: "سنوية", defaultDays: 30, isPaid: true, isActive: true }]}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );

    fireEvent.change(screen.getByLabelText(/الموظف/), { target: { value: "e1" } });
    fireEvent.change(screen.getByLabelText(/نوع الإجازة/), { target: { value: "lt1" } });
    fireEvent.change(screen.getByLabelText(/من تاريخ/), { target: { value: "2026-07-01" } });
    fireEvent.change(screen.getByLabelText(/إلى تاريخ/), { target: { value: "2026-07-05" } });
    fireEvent.click(screen.getByRole("button", { name: "إرسال الطلب" }));

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ employeeId: "e1", leaveTypeId: "lt1" });
  });
});
