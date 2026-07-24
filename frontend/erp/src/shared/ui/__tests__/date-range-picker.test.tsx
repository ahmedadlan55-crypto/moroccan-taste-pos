import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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

describe("DateRangePicker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 20, 10, 30));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const value: DateRange = { from: "2026-08-20", to: "2026-08-20", preset: "today" };

  it("emits the computed range when a preset is picked", () => {
    const onChange = vi.fn();
    render(<DateRangePicker value={value} onChange={onChange} labels={LABELS} />);
    fireEvent.change(screen.getByLabelText("Range preset"), { target: { value: "last7" } });
    expect(onChange).toHaveBeenCalledWith({ from: "2026-08-14", to: "2026-08-20", preset: "last7" });
  });

  it("keeps the current range when switching to custom and shows the two date inputs", () => {
    const onChange = vi.fn();
    const { rerender } = render(<DateRangePicker value={value} onChange={onChange} labels={LABELS} />);
    // preset mode → no date inputs
    expect(screen.queryByLabelText("From")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Range preset"), { target: { value: "custom" } });
    expect(onChange).toHaveBeenCalledWith({ from: "2026-08-20", to: "2026-08-20", preset: "custom" });

    rerender(
      <DateRangePicker
        value={{ from: "2026-08-20", to: "2026-08-20", preset: "custom" }}
        onChange={onChange}
        labels={LABELS}
      />,
    );
    const fromInput = screen.getByLabelText("From");
    expect(fromInput).toBeInTheDocument();
    fireEvent.change(fromInput, { target: { value: "2026-08-01" } });
    expect(onChange).toHaveBeenLastCalledWith({ from: "2026-08-01", to: "2026-08-20", preset: "custom" });
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
