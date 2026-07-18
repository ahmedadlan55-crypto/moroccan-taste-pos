import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PageHeader, Tabs } from "@/shared/ui";
import { FilterBar } from "@/shared/tables";

describe("responsive action surfaces", () => {
  it("keeps named page actions in a dedicated responsive group", () => {
    render(
      <PageHeader
        title="المعاملات"
        action={<button type="button">معاملة جديدة</button>}
      />,
    );
    const actions = screen.getByLabelText("إجراءات الصفحة");
    expect(actions).toHaveClass("grid", "w-full");
    expect(screen.getByRole("button", { name: "معاملة جديدة" })).toBeInTheDocument();
  });

  it("separates filter controls from named table actions", () => {
    render(
      <FilterBar
        search=""
        onSearchChange={() => {}}
        actions={<button type="button">تصدير</button>}
      />,
    );
    expect(screen.getByRole("searchbox")).toBeInTheDocument();
    expect(screen.getByLabelText("إجراءات الجدول")).toHaveClass("grid", "w-full");
    expect(screen.getByRole("button", { name: "تصدير" })).toBeInTheDocument();
  });

  it("keeps tabs keyboard-operable in RTL", () => {
    const onChange = vi.fn();
    render(
      <Tabs
        aria-label="أقسام المنشئ"
        value="one"
        onChange={onChange}
        items={[
          { value: "one", label: "الأول" },
          { value: "two", label: "الثاني" },
        ]}
      />,
    );
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenCalledWith("two");
  });
});
