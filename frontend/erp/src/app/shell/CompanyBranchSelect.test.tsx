import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { CompanyBranchSelect } from "./CompanyBranchSelect";

describe("CompanyBranchSelect", () => {
  it("renders complete company and branch labels inside named scope controls", () => {
    render(<CompanyBranchSelect />);

    const group = screen.getByRole("group", { name: "نطاق عرض البيانات" });
    expect(within(group).getByRole("combobox", { name: "اختيار الشركة" })).toHaveValue("all");
    expect(within(group).getByRole("combobox", { name: "اختيار الفرع" })).toHaveValue("all");
    expect(within(group).getAllByText("كل الشركات")).toHaveLength(2);
    expect(within(group).getAllByText("كل الفروع")).toHaveLength(2);
    expect(group).toHaveClass("grid-cols-[13rem_12rem]");
  });

  it("stacks safely on narrow screens and becomes two equal columns from sm", () => {
    render(<CompanyBranchSelect fullWidth />);
    const group = screen.getByRole("group", { name: "نطاق عرض البيانات" });
    expect(group).toHaveClass("w-full", "grid-cols-1", "sm:grid-cols-2");
  });
});
