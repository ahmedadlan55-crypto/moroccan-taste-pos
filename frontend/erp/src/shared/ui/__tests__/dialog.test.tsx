import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Dialog, Drawer } from "@/shared/ui";

describe("full-page workflows", () => {
  it("renders a normal Dialog as a full-page work area by default", () => {
    render(
      <Dialog open onClose={() => {}} title="إضافة مورد" description="أدخل بيانات المورد الأساسية">
        <button>حفظ المورد</button>
      </Dialog>,
    );

    const workspace = screen.getByRole("region", { name: "إضافة مورد" });
    expect(workspace).toHaveAttribute("data-presentation", "full-page");
    expect(workspace).toHaveClass("fixed", "inset-0", "h-[100dvh]", "w-full");
    expect(workspace).not.toHaveAttribute("aria-modal");
    expect(screen.getByRole("button", { name: "العودة إلى الصفحة السابقة" })).toBeInTheDocument();
  });

  it("moves focus into the full-page work area", async () => {
    render(
      <Dialog open onClose={() => {}} title="إضافة عميل">
        <button>حفظ العميل</button>
      </Dialog>,
    );
    const workspace = screen.getByRole("region", { name: "إضافة عميل" });
    await waitFor(() => expect(workspace.contains(document.activeElement)).toBe(true));
  });

  it("converts the legacy Drawer API to the same full-page work area", () => {
    render(
      <Drawer open onClose={() => {}} title="تفاصيل الموظف">
        <div>بيانات الموظف</div>
      </Drawer>,
    );
    const workspace = screen.getByRole("region", { name: "تفاصيل الموظف" });
    expect(workspace).toHaveAttribute("data-presentation", "full-page");
    expect(workspace.className).not.toContain("right-0");
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="إضافة صنف">
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
    expect(screen.queryByRole("region", { name: "مخفي" })).not.toBeInTheDocument();
  });
});

describe("compact Dialog", () => {
  it("remains an accessible centered modal for short confirmations", () => {
    render(
      <Dialog open onClose={() => {}} title="تأكيد الحذف" presentation="compact">
        <button>تأكيد</button>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "تأكيد الحذف" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveClass("max-h-[100dvh]", "overflow-hidden", "flex-col");
  });
});
