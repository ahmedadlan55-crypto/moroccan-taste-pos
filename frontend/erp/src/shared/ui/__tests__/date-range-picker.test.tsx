import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ar } from "@/i18n/dictionaries/ar";
import {
  DateRangePicker,
  ComparePicker,
  computePresetRange,
  computeCompareRange,
  DATE_RANGE_PRESETS,
  type DateRange,
  type DateRangePreset,
} from "@/shared/ui/date-range-picker";

const PRESET_LABELS = Object.fromEntries(DATE_RANGE_PRESETS.map((p) => [p, `preset-${p}`])) as Record<
  DateRangePreset,
  string
>;

const LABELS = {
  presets: PRESET_LABELS,
  from: "From",
  to: "To",
  presetAriaLabel: "Range preset",
  title: "Select a time period",
  apply: "Apply",
  cancel: "Cancel",
};

describe("computePresetRange (fixed local date 2026-08-20)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // LOCAL Aug 20 2026 (month index 7) — presets must use local calendar math.
    vi.setSystemTime(new Date(2026, 7, 20, 10, 30));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("computes every preset from local today", () => {
    expect(computePresetRange("today")).toEqual({ from: "2026-08-20", to: "2026-08-20" });
    expect(computePresetRange("yesterday")).toEqual({ from: "2026-08-19", to: "2026-08-19" });
    expect(computePresetRange("last7")).toEqual({ from: "2026-08-14", to: "2026-08-20" });
    expect(computePresetRange("last30")).toEqual({ from: "2026-07-22", to: "2026-08-20" });
    expect(computePresetRange("mtd")).toEqual({ from: "2026-08-01", to: "2026-08-20" });
    expect(computePresetRange("qtd")).toEqual({ from: "2026-07-01", to: "2026-08-20" });
    expect(computePresetRange("ytd")).toEqual({ from: "2026-01-01", to: "2026-08-20" });
  });

  it("crosses month/year boundaries with local math", () => {
    expect(computePresetRange("yesterday", "2026-01-01")).toEqual({ from: "2025-12-31", to: "2025-12-31" });
    expect(computePresetRange("last7", "2026-03-02")).toEqual({ from: "2026-02-24", to: "2026-03-02" });
    expect(computePresetRange("qtd", "2026-02-15")).toEqual({ from: "2026-01-01", to: "2026-02-15" });
  });

  /* ── the CLOSED periods ────────────────────────────────────────────────
   * A close, a VAT return and a management review all report on a period
   * that has ENDED, and every one of these ends on a date the code must
   * derive rather than know: month lengths differ, February moves with the
   * leap year, and both wrap at the year boundary. The implementation asks
   * Date for day 0 of the FOLLOWING month so there is no month-length table
   * to get wrong — these cases are what proves that.
   */
  it("last month ends on the real last day, whatever length that month is", () => {
    expect(computePresetRange("lastMonth", "2026-08-20")).toEqual({ from: "2026-07-01", to: "2026-07-31" });
    // 30-day month
    expect(computePresetRange("lastMonth", "2026-07-14")).toEqual({ from: "2026-06-01", to: "2026-06-30" });
    // February, common year
    expect(computePresetRange("lastMonth", "2026-03-05")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    // February, LEAP year — an off-by-one here silently drops a day of sales
    expect(computePresetRange("lastMonth", "2028-03-05")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    // January → wraps the year
    expect(computePresetRange("lastMonth", "2026-01-09")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });

  it("last quarter is the whole quarter before the current one", () => {
    // Q3 today → Q2
    expect(computePresetRange("lastQuarter", "2026-08-20")).toEqual({ from: "2026-04-01", to: "2026-06-30" });
    // Q1 today → Q4 of the previous year
    expect(computePresetRange("lastQuarter", "2026-02-15")).toEqual({ from: "2025-10-01", to: "2025-12-31" });
    // first day of a quarter still means the PREVIOUS quarter, not an empty one
    expect(computePresetRange("lastQuarter", "2026-07-01")).toEqual({ from: "2026-04-01", to: "2026-06-30" });
  });

  it("last year is the whole previous calendar year", () => {
    expect(computePresetRange("lastYear", "2026-08-20")).toEqual({ from: "2025-01-01", to: "2025-12-31" });
    expect(computePresetRange("lastYear", "2026-01-01")).toEqual({ from: "2025-01-01", to: "2025-12-31" });
  });

  it("stays inside the planner's 400-day ceiling", () => {
    // lib/analytics/planner.js MAX_RANGE_DAYS = 400. A preset the engine
    // refuses is worse than no preset: it 422s on selection with a message
    // about a limit the user never set.
    for (const preset of ["lastMonth", "lastQuarter", "lastYear"] as const) {
      const r = computePresetRange(preset, "2026-08-20");
      const days = (Date.parse(r.to) - Date.parse(r.from)) / 86400000 + 1;
      expect(days, `${preset} spans ${days} days`).toBeLessThanOrEqual(400);
      expect(days).toBeGreaterThan(0);
    }
  });
});

describe("computeCompareRange", () => {
  it("prevPeriod is the equal-length window immediately before", () => {
    expect(computeCompareRange("prevPeriod", { from: "2026-08-01", to: "2026-08-07" })).toEqual({
      from: "2026-07-25",
      to: "2026-07-31",
    });
    // single-day range
    expect(computeCompareRange("prevPeriod", { from: "2026-08-20", to: "2026-08-20" })).toEqual({
      from: "2026-08-19",
      to: "2026-08-19",
    });
  });

  it("prevYear shifts both endpoints one year back", () => {
    expect(computeCompareRange("prevYear", { from: "2026-08-01", to: "2026-08-07" })).toEqual({
      from: "2025-08-01",
      to: "2025-08-07",
    });
  });
});

/* ── the panel ───────────────────────────────────────────────────────────────
 * The control is a trigger plus a popover: two contiguous month grids, the
 * preset rail, and Cancel / Apply. The contract every test below defends is
 * DRAFT → COMMIT: nothing the panel does reaches `onChange` until Apply.
 */

describe("DateRangePicker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 20, 10, 30));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const value: DateRange = { from: "2026-08-20", to: "2026-08-20", preset: "today" };

  const trigger = () => screen.getByRole("button", { name: "Range preset" });
  const panel = () => screen.getByTestId("date-range-popover");
  const openPanel = () => {
    fireEvent.click(trigger());
    return panel();
  };
  const gridOf = (idx: number) => within(panel()).getAllByRole("grid")[idx];
  /** A day cell in the LEFT (0) or RIGHT (1) month — the same ISO day can sit
   *  in both grids at a month boundary, so the column must be explicit. */
  const dayIn = (idx: number, iso: string): HTMLButtonElement => {
    const el = gridOf(idx).querySelector<HTMLButtonElement>(`[data-day="${iso}"]`);
    if (!el) throw new Error(`no day cell for ${iso} in grid ${idx}`);
    return el;
  };
  const presetBtn = (p: DateRangePreset) => within(panel()).getByRole("button", { name: `preset-${p}` });
  const apply = () => within(panel()).getByRole("button", { name: "Apply" });
  const cancel = () => within(panel()).getByRole("button", { name: "Cancel" });

  function renderPicker(v: DateRange = value) {
    const onChange = vi.fn();
    render(<DateRangePicker value={v} onChange={onChange} labels={LABELS} />);
    return onChange;
  }

  it("shows the committed period on the trigger and opens the panel", () => {
    renderPicker();
    expect(trigger()).toHaveTextContent("preset-today");
    expect(screen.queryByTestId("date-range-popover")).toBeNull();

    openPanel();
    expect(screen.getByRole("dialog", { name: "Select a time period" })).toBeInTheDocument();
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
  });

  it("names a custom period by its DATES, not by the word custom", () => {
    renderPicker({ from: "2026-08-01", to: "2026-08-07", preset: "custom" });
    expect(trigger()).toHaveTextContent("01 Aug 2026 – 07 Aug 2026");
  });

  it("shows two CONTIGUOUS months, a From/To header each, and the preset rail", () => {
    renderPicker();
    const p = openPanel();
    expect(within(p).getByText("2026 AUGUST")).toBeInTheDocument();
    expect(within(p).getByText("2026 SEPTEMBER")).toBeInTheDocument();
    expect(within(p).getAllByRole("grid")).toHaveLength(2);
    expect(within(p).getByText("From")).toBeInTheDocument();
    expect(within(p).getByText("To")).toBeInTheDocument();

    // The rail is the complete preset list, rendered from DATE_RANGE_PRESETS —
    // not a second, hand-kept list that can drift from the enum.
    const rail = within(p).getByRole("group", { name: ar.sharedUi.dateRangePicker.presets });
    const buttons = within(rail).getAllByRole("button");
    expect(buttons).toHaveLength(DATE_RANGE_PRESETS.length);
    for (const preset of DATE_RANGE_PRESETS) {
      const btn = presetBtn(preset);
      expect(btn).toBeInTheDocument();
      // A missing label would render the raw id.
      expect(btn.textContent).not.toBe(preset);
    }
    // The active preset is the filled pill.
    expect(presetBtn("today")).toHaveAttribute("aria-pressed", "true");
    expect(presetBtn("last7")).toHaveAttribute("aria-pressed", "false");
  });

  /* ── every preset, asserted as DATES ─────────────────────────────────────
   * "a handler fired" would pass even if the rail were wired to the wrong
   * preset; only the emitted pair proves the rail means what it says. */
  const EXPECTED: Array<[Exclude<DateRangePreset, "custom">, string, string]> = [
    ["today", "2026-08-20", "2026-08-20"],
    ["yesterday", "2026-08-19", "2026-08-19"],
    ["last7", "2026-08-14", "2026-08-20"],
    ["last30", "2026-07-22", "2026-08-20"],
    ["mtd", "2026-08-01", "2026-08-20"],
    ["lastMonth", "2026-07-01", "2026-07-31"],
    ["qtd", "2026-07-01", "2026-08-20"],
    ["lastQuarter", "2026-04-01", "2026-06-30"],
    ["ytd", "2026-01-01", "2026-08-20"],
    ["lastYear", "2025-01-01", "2025-12-31"],
  ];

  it.each(EXPECTED)("preset %s commits exactly %s .. %s", (preset, from, to) => {
    const onChange = renderPicker({ from: "2026-01-01", to: "2026-01-31", preset: "custom" });
    openPanel();
    fireEvent.click(presetBtn(preset));
    expect(onChange, "a preset is a DRAFT edit, not a commit").not.toHaveBeenCalled();
    fireEvent.click(apply());
    expect(onChange).toHaveBeenCalledWith({ from, to, preset });
  });

  it("moves the calendars onto the preset's own months", () => {
    renderPicker();
    const p = openPanel();
    fireEvent.click(presetBtn("lastQuarter")); // 2026-04-01 .. 2026-06-30
    expect(within(p).getByText("2026 APRIL")).toBeInTheDocument();
    expect(within(p).getByText("2026 MAY")).toBeInTheDocument();
  });

  /* ── draft → commit ─────────────────────────────────────────────────────── */

  it("Cancel throws the draft away and leaves the committed value alone", () => {
    const onChange = renderPicker();
    openPanel();
    fireEvent.click(presetBtn("lastMonth"));
    fireEvent.click(cancel());
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId("date-range-popover")).toBeNull();
    expect(trigger()).toHaveTextContent("preset-today");

    // Reopening starts from the COMMITTED value, not the abandoned draft.
    openPanel();
    expect(presetBtn("today")).toHaveAttribute("aria-pressed", "true");
    expect(presetBtn("lastMonth")).toHaveAttribute("aria-pressed", "false");
  });

  it("Escape and an outside click behave like Cancel", () => {
    const onChange = renderPicker();
    openPanel();
    fireEvent.click(presetBtn("ytd"));
    fireEvent.keyDown(document.activeElement ?? document, { key: "Escape" });
    expect(screen.queryByTestId("date-range-popover")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    openPanel();
    fireEvent.click(presetBtn("ytd"));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId("date-range-popover")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  /* ── picking days ───────────────────────────────────────────────────────── */

  it("start then end produces that range, as a custom period", () => {
    const onChange = renderPicker();
    openPanel();
    fireEvent.click(dayIn(0, "2026-08-05"));
    fireEvent.click(dayIn(0, "2026-08-12"));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(apply());
    expect(onChange).toHaveBeenCalledWith({ from: "2026-08-05", to: "2026-08-12", preset: "custom" });
  });

  it("picking the END before the START swaps, it does not invert", () => {
    // An inverted range is not "no rows" to the engine — it is a 422 about a
    // window the analyst never asked for.
    const onChange = renderPicker();
    openPanel();
    fireEvent.click(dayIn(0, "2026-08-12"));
    fireEvent.click(dayIn(0, "2026-08-05"));
    fireEvent.click(apply());
    expect(onChange).toHaveBeenCalledWith({ from: "2026-08-05", to: "2026-08-12", preset: "custom" });
  });

  it("spans the two months when the range crosses the boundary", () => {
    const onChange = renderPicker();
    openPanel();
    fireEvent.click(dayIn(0, "2026-08-25"));
    fireEvent.click(dayIn(1, "2026-09-10"));
    fireEvent.click(apply());
    expect(onChange).toHaveBeenCalledWith({ from: "2026-08-25", to: "2026-09-10", preset: "custom" });
  });

  it("marks both endpoints selected and bands the days between", () => {
    renderPicker();
    openPanel();
    fireEvent.click(dayIn(0, "2026-08-05"));
    fireEvent.click(dayIn(0, "2026-08-08"));
    const cellOf = (iso: string) => dayIn(0, iso).closest('[role="gridcell"]') as HTMLElement;
    expect(cellOf("2026-08-05")).toHaveAttribute("aria-selected", "true");
    expect(cellOf("2026-08-08")).toHaveAttribute("aria-selected", "true");
    expect(cellOf("2026-08-06")).toHaveAttribute("aria-selected", "false");
    expect(cellOf("2026-08-06")).toHaveClass("bg-teal-50");
    expect(cellOf("2026-08-09")).not.toHaveClass("bg-teal-50");
  });

  it("pages both months together, keeping them contiguous", () => {
    renderPicker();
    const p = openPanel();
    fireEvent.click(within(p).getByRole("button", { name: `${ar.sharedUi.datePicker.prevMonth} (From)` }));
    expect(within(p).getByText("2026 JULY")).toBeInTheDocument();
    expect(within(p).getByText("2026 AUGUST")).toBeInTheDocument();
    fireEvent.click(within(p).getByRole("button", { name: `${ar.sharedUi.datePicker.nextMonth} (To)` }));
    expect(within(p).getByText("2026 AUGUST")).toBeInTheDocument();
    expect(within(p).getByText("2026 SEPTEMBER")).toBeInTheDocument();
  });

  /* ── typing ─────────────────────────────────────────────────────────────── */

  it("accepts a typed ISO date in either field", () => {
    const onChange = renderPicker();
    const p = openPanel();
    fireEvent.change(within(p).getByLabelText("From"), { target: { value: "2026-03-04" } });
    fireEvent.click(apply());
    expect(onChange).toHaveBeenCalledWith({ from: "2026-03-04", to: "2026-08-20", preset: "custom" });
  });

  it("orders a typed pair that arrives inverted", () => {
    const onChange = renderPicker();
    const p = openPanel();
    fireEvent.change(within(p).getByLabelText("From"), { target: { value: "2026-12-31" } });
    fireEvent.click(apply());
    expect(onChange).toHaveBeenCalledWith({ from: "2026-08-20", to: "2026-12-31", preset: "custom" });
  });

  it("cannot apply an incomplete range", () => {
    renderPicker({ from: "", to: "", preset: "custom" });
    openPanel();
    expect(apply()).toBeDisabled();
    fireEvent.click(dayIn(0, "2026-08-05"));
    expect(apply()).toBeEnabled();
  });

  /* ── keyboard ───────────────────────────────────────────────────────────── */

  it("opens with focus on the selected day and navigates with the arrows", () => {
    renderPicker();
    openPanel();
    expect(document.activeElement).toBe(dayIn(0, "2026-08-20"));

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(dayIn(0, "2026-08-27"));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Home" });
    expect(document.activeElement).toBe(dayIn(0, "2026-08-24"));
  });

  it("selects a whole range with Enter, without touching the mouse", () => {
    const onChange = renderPicker();
    openPanel();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Enter" }); // start = Aug 20
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowRight" });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowRight" });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Enter" }); // end = Aug 22
    fireEvent.click(apply());
    expect(onChange).toHaveBeenCalledWith({ from: "2026-08-20", to: "2026-08-22", preset: "custom" });
  });

  it("follows the focused day onto a month the panel is not showing", () => {
    renderPicker();
    const p = openPanel();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "PageUp" }); // → 2026-07-20
    expect(within(p).getByText("2026 JULY")).toBeInTheDocument();
    expect(document.activeElement).toBe(dayIn(0, "2026-07-20"));
  });

  /* ── the English date policy ────────────────────────────────────────────── */

  it("renders English months and Latin digits on an Arabic document", () => {
    document.documentElement.lang = "ar";
    document.documentElement.dir = "rtl";
    try {
      renderPicker();
      const p = openPanel();
      expect(within(p).getByText("2026 AUGUST")).toBeInTheDocument();
      expect(within(p).getAllByRole("columnheader").map((h) => h.textContent).join("")).toBe("MTWTFSSMTWTFSS");
      expect(dayIn(0, "2026-08-20")).toHaveAttribute("aria-label", "Thursday, 20 August 2026");
      // The From/To header dates are English too.
      expect(within(p).getAllByText("20 Aug 2026").length).toBeGreaterThan(0);
    } finally {
      document.documentElement.lang = "en";
      document.documentElement.dir = "ltr";
    }
  });

  it("emits ISO, never a formatted date", () => {
    const onChange = renderPicker();
    openPanel();
    fireEvent.click(dayIn(0, "2026-08-03"));
    fireEvent.click(apply());
    const emitted = onChange.mock.calls[0][0] as DateRange;
    expect(emitted.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(emitted.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("does not open when disabled", () => {
    render(<DateRangePicker value={value} onChange={vi.fn()} labels={LABELS} disabled />);
    expect(trigger()).toBeDisabled();
    fireEvent.click(trigger());
    expect(screen.queryByTestId("date-range-popover")).toBeNull();
  });
});

describe("ComparePicker", () => {
  const compareLabels = {
    modes: {
      none: "No compare",
      prevPeriod: "Previous period",
      prevYear: "Previous year",
      custom: "Custom compare",
    },
    from: "Compare from",
    to: "Compare to",
    modeAriaLabel: "Compare mode",
  };

  it("emits the mode and only shows date inputs for custom", () => {
    const onChange = vi.fn();
    const { rerender } = render(<ComparePicker value="none" onChange={onChange} labels={compareLabels} />);
    expect(screen.queryByLabelText("Compare from")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Compare mode"), { target: { value: "prevYear" } });
    expect(onChange).toHaveBeenCalledWith("prevYear", undefined);

    fireEvent.change(screen.getByLabelText("Compare mode"), { target: { value: "custom" } });
    expect(onChange).toHaveBeenLastCalledWith("custom", { from: "", to: "" });

    rerender(
      <ComparePicker
        value="custom"
        customRange={{ from: "", to: "" }}
        onChange={onChange}
        labels={compareLabels}
      />,
    );
    const fromInput = screen.getByLabelText("Compare from");
    fireEvent.change(fromInput, { target: { value: "2025-01-01" } });
    expect(onChange).toHaveBeenLastCalledWith("custom", { from: "2025-01-01", to: "" });
  });
});
