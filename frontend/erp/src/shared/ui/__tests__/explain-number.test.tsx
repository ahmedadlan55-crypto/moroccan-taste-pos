import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ExplainNumber } from "@/shared/ui/explain-number";

const PROPS = {
  title: "Net sales",
  formula: "net = gross - returns - discounts",
  inclusions: ["Posted invoices", "POS receipts"],
  exclusions: ["Draft orders", "Internal transfers"],
  filtersSnapshot: [
    { label: "Period", value: "2026-07-01 → 2026-07-24" },
    { label: "Branch", value: "Riyadh main" },
  ],
  footnote: "Values in SAR, VAT excluded.",
  triggerLabel: "Explain net sales",
  sectionLabels: {
    formula: "Formula",
    inclusions: "Included",
    exclusions: "Excluded",
    filters: "Computed under",
  },
};

describe("ExplainNumber", () => {
  it("is closed by default and opens an accessible dialog from the trigger", () => {
    render(<ExplainNumber {...PROPS} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    const trigger = screen.getByRole("button", { name: "Explain net sales" });
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Net sales" });
    expect(dialog).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("renders every structured section", () => {
    render(<ExplainNumber {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "Explain net sales" }));

    // formula (LTR code block)
    const formula = screen.getByText("net = gross - returns - discounts");
    expect(formula).toHaveAttribute("dir", "ltr");
    expect(screen.getByText("Formula")).toBeInTheDocument();

    // inclusions / exclusions
    expect(screen.getByText("Included")).toBeInTheDocument();
    expect(screen.getByText("Posted invoices")).toBeInTheDocument();
    expect(screen.getByText("POS receipts")).toBeInTheDocument();
    expect(screen.getByText("Excluded")).toBeInTheDocument();
    expect(screen.getByText("Draft orders")).toBeInTheDocument();

    // filters snapshot
    expect(screen.getByText("Computed under")).toBeInTheDocument();
    expect(screen.getByText("Period")).toBeInTheDocument();
    expect(screen.getByText("2026-07-01 → 2026-07-24")).toBeInTheDocument();
    expect(screen.getByText("Branch")).toBeInTheDocument();

    // footnote
    expect(screen.getByText("Values in SAR, VAT excluded.")).toBeInTheDocument();
  });

  it("omits sections whose props are absent", () => {
    render(<ExplainNumber title="Bare" triggerLabel="Explain bare" />);
    fireEvent.click(screen.getByRole("button", { name: "Explain bare" }));
    const dialog = screen.getByRole("dialog", { name: "Bare" });
    expect(dialog).toBeInTheDocument();
    expect(dialog.querySelector("code")).toBeNull();
    expect(dialog.querySelector("ul")).toBeNull();
    expect(dialog.querySelector("dl")).toBeNull();
  });

  it("closes on Escape and returns focus to the trigger", () => {
    render(<ExplainNumber {...PROPS} />);
    const trigger = screen.getByRole("button", { name: "Explain net sales" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Net sales" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("closes on outside click", () => {
    render(
      <div>
        <ExplainNumber {...PROPS} />
        <button type="button">outside</button>
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Explain net sales" }));
    expect(screen.getByRole("dialog", { name: "Net sales" })).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole("button", { name: "outside" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("toggle-closes from its own trigger", () => {
    const onNothing = vi.fn(); // guards against accidental submit-type behavior
    render(
      <form onSubmit={onNothing}>
        <ExplainNumber {...PROPS} />
      </form>,
    );
    const trigger = screen.getByRole("button", { name: "Explain net sales" });
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onNothing).not.toHaveBeenCalled();
  });
});
