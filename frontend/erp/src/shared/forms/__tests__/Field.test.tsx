import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Field } from "@/shared/forms";
import { z, arabicText } from "@/shared/schemas";
import { Input } from "@/shared/ui";

describe("Field", () => {
  it("associates the label with the control", () => {
    render(
      <Field label="اسم العميل">
        {({ id }) => <Input id={id} defaultValue="" />}
      </Field>,
    );
    expect(screen.getByLabelText("اسم العميل")).toBeInTheDocument();
  });

  it("renders a zod validation error as an alert", () => {
    const schema = z.object({ name: arabicText({ label: "الاسم" }) });
    const parsed = schema.safeParse({ name: "" });
    const message = parsed.success ? undefined : parsed.error.flatten().fieldErrors.name?.[0];

    render(
      <Field label="الاسم" error={message} required>
        <Input defaultValue="" invalid />
      </Field>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("الاسم مطلوب");
  });

  it("shows a hint only when there is no error", () => {
    const { rerender } = render(
      <Field label="المبلغ" hint="بالريال السعودي">
        <Input />
      </Field>,
    );
    expect(screen.getByText("بالريال السعودي")).toBeInTheDocument();

    rerender(
      <Field label="المبلغ" hint="بالريال السعودي" error="مطلوب">
        <Input invalid />
      </Field>,
    );
    expect(screen.queryByText("بالريال السعودي")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("مطلوب");
  });
});
