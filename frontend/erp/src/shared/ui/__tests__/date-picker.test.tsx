// DatePicker — the single-date field, rebuilt on the shared calendar
// primitive. The native <input type="date"> it replaced gave typing, keyboard
// navigation, an accessible name per day and focus restore for free; every one
// of those is pinned here, because "we drew our own calendar" is exactly how a
// product loses them.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { DatePicker } from "@/shared/ui/date-picker";
import { ar } from "@/i18n/dictionaries/ar";

// No I18nProvider here (shared components must render without one), so the kit
// falls back to the Arabic dictionary — read the labels from it rather than
// hardcoding copy that can drift.
const UI = ar.sharedUi.datePicker;

/** A real controlled parent: `value` follows what the picker emits. */
function Controlled({
  initial = "",
  onValue,
  ...props
}: { initial?: string; onValue?: (v: string) => void } & Omit<
  React.ComponentProps<typeof DatePicker>,
  "value" | "onChange"
>) {
  const [v, setV] = useState(initial);
  return (
    <DatePicker
      value={v}
      onChange={(next) => {
        setV(next);
        onValue?.(next);
      }}
      {...props}
    />
  );
}

const field = () => screen.getByRole("textbox") as HTMLInputElement;
const toggle = () => screen.getByRole("button", { name: UI.openCalendar });
const dayCell = (iso: string) => {
  const el = document.querySelector<HTMLButtonElement>(`[data-day="${iso}"]`);
  if (!el) throw new Error(`no day cell for ${iso}`);
  return el;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 7, 20, 10, 30)); // LOCAL Thu 20 Aug 2026
});
afterEach(() => {
  vi.useRealTimers();
});

describe("typing (the native control allowed it, so this must too)", () => {
  it("shows the ISO value and emits ISO for a real day typed in full", () => {
    const onValue = vi.fn();
    render(<Controlled initial="2026-08-20" onValue={onValue} />);
    expect(field().value).toBe("2026-08-20");

    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: "2026-09-05" } });
    expect(onValue).toHaveBeenCalledWith("2026-09-05");
    expect(field().value).toBe("2026-09-05");
  });

  it("does not emit a half-typed or impossible date, and snaps back on blur", () => {
    const onValue = vi.fn();
    render(<Controlled initial="2026-08-20" onValue={onValue} />);
    fireEvent.focus(field());

    for (const attempt of ["2026-0", "2026-09-0", "2026-13-01", "2026-02-31", "hello"]) {
      fireEvent.change(field(), { target: { value: attempt } });
    }
    expect(onValue, "an unfinished or impossible date is not a date").not.toHaveBeenCalled();
    // Whatever was typed stays visible while the caret is in the field — a
    // control that erases your keystrokes mid-word is unusable.
    expect(field().value).toBe("hello");

    fireEvent.blur(field());
    expect(field().value, "the field must never keep text the value does not").toBe("2026-08-20");
  });

  it("emits an empty string when the field is cleared", () => {
    const onValue = vi.fn();
    render(<Controlled initial="2026-08-20" onValue={onValue} />);
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: "" } });
    expect(onValue).toHaveBeenCalledWith("");
  });

  it("refuses a typed date outside min/max", () => {
    const onValue = vi.fn();
    render(<Controlled initial="2026-08-20" onValue={onValue} min="2026-08-01" max="2026-08-31" />);
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: "2026-07-31" } });
    fireEvent.change(field(), { target: { value: "2026-09-01" } });
    expect(onValue).not.toHaveBeenCalled();
    fireEvent.change(field(), { target: { value: "2026-08-05" } });
    expect(onValue).toHaveBeenCalledWith("2026-08-05");
  });
});

describe("the calendar", () => {
  it("opens on the trigger and closes on it again", () => {
    render(<Controlled initial="2026-08-20" />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(toggle()).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle());
    expect(screen.getByRole("dialog", { name: UI.calendar })).toBeInTheDocument();
    expect(toggle()).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(toggle());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders ENGLISH months and Latin digits even on an Arabic document", () => {
    document.documentElement.lang = "ar";
    document.documentElement.dir = "rtl";
    try {
      render(<Controlled initial="2026-08-20" />);
      fireEvent.click(toggle());
      expect(screen.getByText("2026 AUGUST")).toBeInTheDocument();
      expect(dayCell("2026-08-20")).toHaveAttribute("aria-label", "Thursday, 20 August 2026");
      for (const b of document.querySelectorAll("[data-day]")) {
        expect(b.textContent ?? "").toMatch(/^\d{1,2}$/);
      }
    } finally {
      document.documentElement.lang = "en";
      document.documentElement.dir = "ltr";
    }
  });

  it("opens on the selected day, and on TODAY when there is no value", () => {
    const { unmount } = render(<Controlled initial="2026-03-09" />);
    fireEvent.click(toggle());
    expect(screen.getByText("2026 MARCH")).toBeInTheDocument();
    expect(document.activeElement).toBe(dayCell("2026-03-09"));
    unmount();

    render(<Controlled initial="" />);
    fireEvent.click(toggle());
    expect(screen.getByText("2026 AUGUST")).toBeInTheDocument();
    expect(dayCell("2026-08-20")).toHaveAttribute("aria-current", "date");
  });

  it("emits ISO for the clicked day, closes, and returns focus to the trigger", () => {
    const onValue = vi.fn();
    render(<Controlled initial="2026-08-20" onValue={onValue} />);
    const trigger = toggle();
    fireEvent.click(trigger);
    fireEvent.click(dayCell("2026-08-07"));

    expect(onValue).toHaveBeenCalledWith("2026-08-07");
    expect(field().value).toBe("2026-08-07");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement, "focus must come back to what opened the panel").toBe(trigger);
  });

  it("pages months without changing the value", () => {
    const onValue = vi.fn();
    render(<Controlled initial="2026-08-20" onValue={onValue} />);
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole("button", { name: UI.prevMonth }));
    expect(screen.getByText("2026 JULY")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: UI.nextMonth }));
    fireEvent.click(screen.getByRole("button", { name: UI.nextMonth }));
    expect(screen.getByText("2026 SEPTEMBER")).toBeInTheDocument();
    expect(onValue).not.toHaveBeenCalled();
  });

  it("blocks days outside min/max", () => {
    const onValue = vi.fn();
    render(<Controlled initial="2026-08-20" onValue={onValue} min="2026-08-10" max="2026-08-25" />);
    fireEvent.click(toggle());
    expect(dayCell("2026-08-09")).toBeDisabled();
    expect(dayCell("2026-08-26")).toBeDisabled();
    fireEvent.click(dayCell("2026-08-09"));
    expect(onValue).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("keyboard", () => {
  function openWithFocus() {
    render(<Controlled initial="2026-08-20" />);
    fireEvent.click(toggle());
    return document.activeElement as HTMLElement;
  }

  it("moves by day, week, month and week bounds", () => {
    let active = openWithFocus();
    expect(active).toBe(dayCell("2026-08-20"));

    fireEvent.keyDown(active, { key: "ArrowRight" });
    expect(document.activeElement).toBe(dayCell("2026-08-21"));

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(dayCell("2026-08-28"));

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowUp" });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(dayCell("2026-08-20"));

    // Home/End are the WEEK bounds: Monday 17th and Sunday 23rd.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Home" });
    expect(document.activeElement).toBe(dayCell("2026-08-17"));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "End" });
    expect(document.activeElement).toBe(dayCell("2026-08-23"));

    // PageDown/PageUp change the MONTH, and the grid follows the focus.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "PageDown" });
    expect(screen.getByText("2026 SEPTEMBER")).toBeInTheDocument();
    expect(document.activeElement).toBe(dayCell("2026-09-23"));
    active = document.activeElement as HTMLElement;
    fireEvent.keyDown(active, { key: "PageUp" });
    expect(screen.getByText("2026 AUGUST")).toBeInTheDocument();
    expect(document.activeElement).toBe(dayCell("2026-08-23"));
  });

  it("selects the focused day with Enter", () => {
    const onValue = vi.fn();
    render(<Controlled initial="2026-08-20" onValue={onValue} />);
    fireEvent.click(toggle());
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowRight" });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Enter" });
    expect(onValue).toHaveBeenCalledWith("2026-08-21");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("clamps navigation to min/max instead of walking past them", () => {
    render(<Controlled initial="2026-08-20" min="2026-08-19" max="2026-08-21" />);
    fireEvent.click(toggle());
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowLeft" });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(dayCell("2026-08-19"));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "PageDown" });
    expect(document.activeElement).toBe(dayCell("2026-08-21"));
  });

  it("Escape closes, restores focus and commits nothing", () => {
    const onValue = vi.fn();
    render(<Controlled initial="2026-08-20" onValue={onValue} />);
    const trigger = toggle();
    fireEvent.click(trigger);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowRight" });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onValue).not.toHaveBeenCalled();
    expect(field().value).toBe("2026-08-20");
    expect(document.activeElement).toBe(trigger);
  });

  it("opens from the field with ArrowDown", () => {
    render(<Controlled initial="2026-08-20" />);
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("call-site compatibility", () => {
  it("keeps its accessible name when wrapped in a <label> (15 call sites do this)", () => {
    render(
      <label>
        <span>من تاريخ</span>
        <DatePicker value="2026-08-20" onChange={vi.fn()} />
      </label>,
    );
    // The calendar trigger is a role=button SPAN precisely so it cannot become
    // a second labelable control and make this query ambiguous.
    const labelled = screen.getByLabelText("من تاريخ");
    expect(labelled.tagName).toBe("INPUT");
    expect((labelled as HTMLInputElement).value).toBe("2026-08-20");
  });

  it("honours invalid and disabled", () => {
    const { rerender } = render(<DatePicker value="" onChange={vi.fn()} invalid />);
    expect(field()).toHaveAttribute("aria-invalid", "true");

    rerender(<DatePicker value="" onChange={vi.fn()} disabled />);
    expect(field()).toBeDisabled();
    fireEvent.click(toggle());
    expect(screen.queryByRole("dialog"), "a disabled field opens nothing").toBeNull();
  });

  it("forwards the ref to the input, as it always did", () => {
    let node: HTMLInputElement | null = null;
    render(<DatePicker ref={(el) => (node = el)} value="2026-08-20" onChange={vi.fn()} />);
    expect(node).not.toBeNull();
    expect(node!.tagName).toBe("INPUT");
  });
});
