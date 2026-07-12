import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ToastProvider, useToast } from "@/shared/ui";

function Trigger() {
  const { toast } = useToast();
  return (
    <button onClick={() => toast({ title: "تم الحفظ", tone: "success", duration: 0 })}>أظهر</button>
  );
}

describe("Toast", () => {
  it("shows a toast and dismisses it via the close button", async () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("أظهر"));
    expect(screen.getByText("تم الحفظ")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("إغلاق التنبيه"));
    await waitFor(() => expect(screen.queryByText("تم الحفظ")).not.toBeInTheDocument());
  });

  it("throws when useToast is used without a provider", () => {
    function Orphan() {
      useToast();
      return null;
    }
    // Silence the expected React error boundary console noise.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Orphan />)).toThrow(/ToastProvider/);
    spy.mockRestore();
  });
});
