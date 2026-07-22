import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { I18nProvider } from "@/i18n";
import { CompanyBranchSelect } from "./CompanyBranchSelect";

// Rendered inside the real I18nProvider (default "ar"), so the labels below are
// the translated Arabic output of the shell.scope.* keys.
describe("CompanyBranchSelect", () => {
  it("renders complete company and branch labels inside named scope controls", () => {
    render(
      <I18nProvider>
        <CompanyBranchSelect />
      </I18nProvider>,
    );

    const group = screen.getByRole("group", { name: "نطاق عرض البيانات" });
    expect(within(group).getByRole("combobox", { name: "اختيار الشركة" })).toHaveValue("all");
    expect(within(group).getByRole("combobox", { name: "اختيار الفرع" })).toHaveValue("all");
    expect(within(group).getAllByText("كل الشركات")).toHaveLength(2);
    expect(within(group).getAllByText("كل الفروع")).toHaveLength(2);
    expect(group).toHaveClass("grid-cols-[13rem_12rem]");
  });

  it("stacks safely on narrow screens and becomes two equal columns from sm", () => {
    render(
      <I18nProvider>
        <CompanyBranchSelect fullWidth />
      </I18nProvider>,
    );
    const group = screen.getByRole("group", { name: "نطاق عرض البيانات" });
    expect(group).toHaveClass("w-full", "grid-cols-1", "sm:grid-cols-2");
  });
});
