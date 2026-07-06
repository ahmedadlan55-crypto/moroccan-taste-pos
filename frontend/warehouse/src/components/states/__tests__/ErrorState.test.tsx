import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ErrorState, safeUserMessage } from "@/components/states/States";

const RAW_SQL = "Expression #2 of SELECT list is not in GROUP BY clause and contains nonaggregated column 'railway.supplier_invoices.supplier_name' ... incompatible with sql_mode=only_full_group_by";

describe("safeUserMessage", () => {
  it("replaces raw SQL / DB error text with a generic Arabic message", () => {
    const msg = safeUserMessage(new Error(RAW_SQL));
    expect(msg).not.toMatch(/GROUP BY|SELECT|only_full_group_by|nonaggregated|supplier_invoices/i);
    expect(msg).toMatch(/تواصل مع المسؤول/);
  });
  it("keeps short intentional domain messages", () => {
    expect(safeUserMessage(new Error("اسم المورد مطلوب"))).toBe("اسم المورد مطلوب");
  });
  it("replaces stack-trace-like text", () => {
    expect(safeUserMessage(new Error("boom at handler (app.js:42)"))).toMatch(/تواصل مع المسؤول/);
  });
});

describe("ErrorState — never leaks raw SQL, always offers retry", () => {
  it("renders a friendly message + retry button and NO raw SQL for an internal error", () => {
    const onRetry = vi.fn();
    render(<ErrorState error={new Error(RAW_SQL)} onRetry={onRetry} />);
    expect(document.body.textContent).not.toMatch(/only_full_group_by|SELECT|supplier_invoices|GROUP BY/i);
    const btn = screen.getByRole("button", { name: /إعادة المحاولة/ });
    fireEvent.click(btn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows the report-specific friendly message when title/body are provided", () => {
    render(
      <ErrorState
        error={new Error(RAW_SQL)}
        onRetry={() => {}}
        title="تعذّر تحميل تقرير المشتريات"
        body="أعد المحاولة، وإن استمرت المشكلة تواصل مع المسؤول."
      />,
    );
    expect(screen.getByText("تعذّر تحميل تقرير المشتريات")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/only_full_group_by|supplier_invoices/i);
  });
});
