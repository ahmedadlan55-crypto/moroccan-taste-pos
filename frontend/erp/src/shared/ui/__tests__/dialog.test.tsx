import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Dialog } from "@/shared/ui";

describe("Dialog", () => {
  it("renders as an accessible modal with its title", () => {
    render(
      <Dialog open onClose={() => {}} title="تأكيد العملية">
        <button>إجراء</button>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveClass("max-h-[100dvh]", "overflow-hidden", "flex-col");
    expect(screen.getByText("تأكيد العملية")).toBeInTheDocument();
  });

  it("moves focus into the dialog on open (focus trap)", async () => {
    render(
      <Dialog open onClose={() => {}} title="عنوان">
        <button>إجراء داخلي</button>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="عنوان">
        <div>محتوى</div>
      </Dialog>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not render when closed", () => {
    render(
      <Dialog open={false} onClose={() => {}} title="مخفي">
        <div>محتوى</div>
      </Dialog>,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
