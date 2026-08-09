// The calendar primitive ? the one month grid the whole app's date fields are
// built on. Every assertion here is a PROPERTY (an English month name, an ISO
// value, a real last-day-of-month), never a snapshot: a snapshot of a calendar
// re-records whatever it currently draws, including the wrong thing.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import {
  CALENDAR_WEEKDAYS,
  CalendarMonth,
  addDaysISO,
  addMonthsISO,
  clampISO,
  dateToISO,
  formatDayAriaLabel,
  formatISODisplay,
  formatMonthTitle,
  isValidISODate,
  isoToDate,
  monthGridDays,
  monthKeyISO,
  nextFocusedDay,
  startOfMonthISO,
} from "@/shared/ui/calendar";

const NAV = { prevMonth: "Previous month", nextMonth: "Next month" };

function renderMonth(overrides: Partial<React.ComponentProps<typeof CalendarMonth>> = {}) {
  const onDayClick = vi.fn();
  const utils = render(
    <CalendarMonth month="2026-08-01" today="2026-08-20" onDayClick={onDayClick} labels={NAV} {...overrides} />,
  );
  return { onDayClick, ...utils };
}

/** Every day button in the grid, in DOM order. */
function dayButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("[data-day]"));
}

function day(iso: string): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(`[data-day="${iso}"]`);
  if (!el) throw new Error(`no day cell for ${iso}`);
  return el;
}

/** The role=gridcell wrapper that carries aria-selected and the range band. */
function cell(iso: string): HTMLElement {
  const el = day(iso).closest('[role="gridcell"]');
  if (!el) throw new Error(`day ${iso} is not inside a gridcell`);
  return el as HTMLElement;
}

/* ?? ISO helpers ??????????????????????????????????????????????????????????? */

describe("ISO date helpers", () => {
  it("round-trips a local date without ever touching UTC", () => {
    // 00:30 local ? the window where toISOString() reports the PREVIOUS day for
    // a Riyadh user, which is the whole reason these helpers exist.
    const d = new Date(2026, 0, 1, 0, 30);
    expect(dateToISO(d)).toBe("2026-01-01");
    expect(isoToDate("2026-01-01")?.getDate()).toBe(1);
    expect(isoToDate("2026-01-01")?.getMonth()).toBe(0);
  });

  it("rejects a well-shaped string that is not a real day", () => {
    expect(isValidISODate("2026-02-28")).toBe(true);
    expect(isValidISODate("2028-02-29")).toBe(true); // leap year
    expect(isValidISODate("2026-02-29")).toBe(false); // common year
    expect(isValidISODate("2026-02-31")).toBe(false); // Date would roll to Mar 3
    expect(isValidISODate("2026-13-01")).toBe(false);
    expect(isValidISODate("20260201")).toBe(false);
    expect(isValidISODate("")).toBe(false);
    expect(isValidISODate(null)).toBe(false);
  });

  it("adds months without rolling over a short month", () => {
    // setMonth() alone turns Jan 31 + 1 into Mar 3 ? a PageDown that skips
    // February entirely.
    expect(addMonthsISO("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsISO("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonthsISO("2026-03-31", -1)).toBe("2026-02-28");
    expect(addMonthsISO("2026-01-15", -1)).toBe("2025-12-15");
    expect(addMonthsISO("2026-12-15", 1)).toBe("2027-01-15");
  });

  it("adds days across month and year boundaries", () => {
    expect(addDaysISO("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDaysISO("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDaysISO("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("clamps to the min/max bounds and leaves in-range days alone", () => {
    expect(clampISO("2026-01-01", "2026-02-01", "2026-12-31")).toBe("2026-02-01");
    expect(clampISO("2027-01-01", "2026-02-01", "2026-12-31")).toBe("2026-12-31");
    expect(clampISO("2026-06-06", "2026-02-01", "2026-12-31")).toBe("2026-06-06");
    expect(clampISO("2026-06-06")).toBe("2026-06-06");
  });

  it("starts the month and keys it", () => {
    expect(startOfMonthISO("2026-08-20")).toBe("2026-08-01");
    expect(monthKeyISO("2026-08-20")).toBe("2026-08");
  });
});

/* ?? the grid shape ???????????????????????????????????????????????????????? */

describe("monthGridDays", () => {
  it("always yields 6 Monday-first weeks around the month", () => {
    const days = monthGridDays("2026-08-15");
    expect(days).toHaveLength(42);
    // August 2026 starts on a Saturday, so the grid opens on Mon 27 Jul.
    expect(days[0]).toBe("2026-07-27");
    expect(days[41]).toBe("2026-09-06");
    for (const iso of days) expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Fixed height: a grid that is 5 rows in some months makes the popover
    // jump and moves the footer out from under the cursor.
    expect(monthGridDays("2026-02-01")).toHaveLength(42);
  });
});

describe("nextFocusedDay", () => {
  // 2026-08-20 is a Thursday.
  it("moves by day, week, month and week bounds", () => {
    expect(nextFocusedDay("ArrowRight", "2026-08-20")).toBe("2026-08-21");
    expect(nextFocusedDay("ArrowLeft", "2026-08-20")).toBe("2026-08-19");
    expect(nextFocusedDay("ArrowDown", "2026-08-20")).toBe("2026-08-27");
    expect(nextFocusedDay("ArrowUp", "2026-08-20")).toBe("2026-08-13");
    expect(nextFocusedDay("PageDown", "2026-08-20")).toBe("2026-09-20");
    expect(nextFocusedDay("PageUp", "2026-08-20")).toBe("2026-07-20");
    expect(nextFocusedDay("Home", "2026-08-20")).toBe("2026-08-17"); // Monday
    expect(nextFocusedDay("End", "2026-08-20")).toBe("2026-08-23"); // Sunday
  });

  it("returns null for a key that is not navigation", () => {
    expect(nextFocusedDay("a", "2026-08-20")).toBeNull();
    expect(nextFocusedDay("Enter", "2026-08-20")).toBeNull();
    expect(nextFocusedDay("Tab", "2026-08-20")).toBeNull();
  });
});

/* ?? ENGLISH, on an Arabic document ???????????????????????????????????????? */

describe("English dates on an Arabic document", () => {
  beforeEach(() => {
    document.documentElement.lang = "ar";
    document.documentElement.dir = "rtl";
  });
  afterEach(() => {
    document.documentElement.lang = "en";
    document.documentElement.dir = "ltr";
  });

  it("formats month, weekday and day names in English regardless of the page language", () => {
    expect(formatMonthTitle("2026-08-01")).toBe("2026 AUGUST");
    expect(formatMonthTitle("2026-05-06")).toBe("2026 MAY");
    expect(formatDayAriaLabel("2026-08-20")).toBe("Thursday, 20 August 2026");
    expect(formatISODisplay("2026-08-20")).toBe("20 Aug 2026");
    expect(CALENDAR_WEEKDAYS.map((w) => w.narrow).join("")).toBe("MTWTFSS");
    expect(CALENDAR_WEEKDAYS.map((w) => w.long)).toEqual([
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ]);
  });

  it("renders English month/weekday names and LATIN digits inside the grid", () => {
    renderMonth();
    expect(screen.getByText("2026 AUGUST")).toBeInTheDocument();

    // The narrow initials repeat (T/T, S/S), so the accessible name carries the
    // full weekday. Monday first ? a Gregorian week is read that way in both
    // languages, which is why the grid itself never mirrors.
    const headers = screen.getAllByRole("columnheader");
    expect(headers.map((h) => h.getAttribute("aria-label"))).toEqual([
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ]);
    expect(headers.map((h) => h.textContent).join("")).toBe("MTWTFSS");

    // Arabic-Indic digits (????) would fail \d ? the day number comes from
    // String(Date#getDate()), not from Intl, so they are impossible here.
    for (const b of dayButtons()) expect(b.textContent ?? "").toMatch(/^\d{1,2}$/);
    expect(day("2026-08-20")).toHaveAttribute("aria-label", "Thursday, 20 August 2026");
  });

  it("pins the grid to dir=ltr even while the page is RTL", () => {
    renderMonth();
    const grid = screen.getByRole("grid");
    expect(grid.closest("[dir]")).toHaveAttribute("dir", "ltr");
  });
});

/* ?? selection, today, bounds ?????????????????????????????????????????????? */

describe("CalendarMonth", () => {
  it("emits the ISO day that was clicked, including the muted neighbours", () => {
    const { onDayClick } = renderMonth();
    fireEvent.click(day("2026-08-20"));
    expect(onDayClick).toHaveBeenLastCalledWith("2026-08-20");
    // The leading cells belong to July and are still real, clickable days.
    fireEvent.click(day("2026-07-27"));
    expect(onDayClick).toHaveBeenLastCalledWith("2026-07-27");
  });

  it("marks TODAY, and only today", () => {
    renderMonth();
    const marked = dayButtons().filter((b) => b.getAttribute("aria-current") === "date");
    expect(marked).toHaveLength(1);
    expect(marked[0]).toHaveAttribute("data-day", "2026-08-20");
  });

  it("selects both endpoints and bands every day between them", () => {
    renderMonth({ selectedStart: "2026-08-10", selectedEnd: "2026-08-14" });

    const selected = Array.from(document.querySelectorAll('[role="gridcell"][aria-selected="true"]'));
    expect(selected).toHaveLength(2);
    expect(cell("2026-08-10")).toHaveAttribute("aria-selected", "true");
    expect(cell("2026-08-14")).toHaveAttribute("aria-selected", "true");
    expect(cell("2026-08-12")).toHaveAttribute("aria-selected", "false");

    // The band is continuous across the endpoints and stops at them.
    for (const iso of ["2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14"]) {
      expect(cell(iso), `${iso} must sit on the band`).toHaveClass("bg-teal-50");
    }
    expect(cell("2026-08-09")).not.toHaveClass("bg-teal-50");
    expect(cell("2026-08-15")).not.toHaveClass("bg-teal-50");
  });

  it("previews the band against a hovered day while the range is half-picked", () => {
    renderMonth({ selectedStart: "2026-08-10", selectedEnd: null, previewEnd: "2026-08-13" });
    expect(cell("2026-08-12")).toHaveClass("bg-teal-50");
    expect(cell("2026-08-14")).not.toHaveClass("bg-teal-50");
    // Only the committed endpoint is "selected"; a hover is not a choice.
    expect(document.querySelectorAll('[role="gridcell"][aria-selected="true"]')).toHaveLength(1);
  });

  it("bands correctly when the preview runs BACKWARDS from the anchor", () => {
    renderMonth({ selectedStart: "2026-08-14", selectedEnd: null, previewEnd: "2026-08-10" });
    expect(cell("2026-08-12")).toHaveClass("bg-teal-50");
    expect(cell("2026-08-16")).not.toHaveClass("bg-teal-50");
  });

  it("blocks days outside min/max", () => {
    const { onDayClick } = renderMonth({ min: "2026-08-10", max: "2026-08-20" });
    expect(day("2026-08-09")).toBeDisabled();
    expect(day("2026-08-21")).toBeDisabled();
    expect(day("2026-08-10")).toBeEnabled();
    expect(day("2026-08-20")).toBeEnabled();
    expect(cell("2026-08-09")).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(day("2026-08-09"));
    expect(onDayClick).not.toHaveBeenCalled();
  });

  it("keeps ONE tab stop in the grid (roving tabindex)", () => {
    renderMonth({ focusedDay: "2026-08-20" });
    const tabbable = dayButtons().filter((b) => b.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toHaveAttribute("data-day", "2026-08-20");
  });

  it("moves real DOM focus only when a caller asks for it", () => {
    const { rerender } = renderMonth({ focusedDay: "2026-08-20", focusSeq: 0 });
    expect(document.activeElement).not.toBe(day("2026-08-20"));

    rerender(
      <CalendarMonth
        month="2026-08-01"
        today="2026-08-20"
        onDayClick={vi.fn()}
        labels={NAV}
        focusedDay="2026-08-21"
        focusSeq={1}
      />,
    );
    expect(document.activeElement).toBe(day("2026-08-21"));
  });

  it("renders a month nav only when a caller can act on it", () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const { rerender } = renderMonth();
    expect(screen.queryByRole("button", { name: NAV.prevMonth })).toBeNull();

    rerender(
      <CalendarMonth
        month="2026-08-01"
        today="2026-08-20"
        onDayClick={vi.fn()}
        labels={NAV}
        onPrevMonth={onPrev}
        onNextMonth={onNext}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: NAV.prevMonth }));
    fireEvent.click(screen.getByRole("button", { name: NAV.nextMonth }));
    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("exposes the grid with rows of cells", () => {
    renderMonth();
    const grid = screen.getByRole("grid");
    // 1 weekday header row + 6 week rows.
    expect(within(grid).getAllByRole("row")).toHaveLength(7);
    expect(within(grid).getAllByRole("gridcell")).toHaveLength(42);
  });
});
