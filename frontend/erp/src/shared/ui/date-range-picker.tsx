// DateRangePicker + ComparePicker — preset-driven date range selection for the
// analytics surfaces. Controlled components; every visible string arrives via
// the `labels` prop (callers pass t(...)), so no i18n keys live here.
//
// Date math is LOCAL-calendar (built on shared/lib/dates todayISO — never
// toISOString(), which reads the UTC day). Custom ranges reuse the native
// DatePicker, so keyboard/calendar/a11y behavior matches every other date field.
import { cn } from "@/shared/lib";
import { todayISO } from "@/shared/lib";
import { DatePicker } from "./date-picker";
import { Select } from "./select";

/* ── preset math ─────────────────────────────────────────────── */

// Every preset before this change was a TO-DATE window ending today. That is
// the wrong shape for accounting: a close, a VAT return and a management review
// all report on a period that has ENDED, and reconstructing "last month" by
// hand — two date fields, both off-by-one-prone — was the most common thing
// anyone did in this bar. The three CLOSED periods sit next to their to-date
// siblings so the pairing is legible: mtd / lastMonth, qtd / lastQuarter,
// ytd / lastYear.
export const DATE_RANGE_PRESETS = [
  "today",
  "yesterday",
  "last7",
  "last30",
  "mtd",
  "lastMonth",
  "qtd",
  "lastQuarter",
  "ytd",
  "lastYear",
  "custom",
] as const;

export type DateRangePreset = (typeof DATE_RANGE_PRESETS)[number];

export interface DateRange {
  /** ISO "YYYY-MM-DD" (or "" when unset in a custom range). */
  from: string;
  to: string;
  preset: DateRangePreset;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function toISO(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Parse "YYYY-MM-DD" as a LOCAL date (new Date(iso) would read it as UTC). */
function parseISO(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function shiftDays(iso: string, days: number): string {
  const d = parseISO(iso);
  d.setDate(d.getDate() + days);
  return toISO(d);
}

/** Inclusive from..to for a non-custom preset, in LOCAL calendar days. */
export function computePresetRange(
  preset: Exclude<DateRangePreset, "custom">,
  today: string = todayISO(),
): { from: string; to: string } {
  const t = parseISO(today);
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = shiftDays(today, -1);
      return { from: y, to: y };
    }
    case "last7":
      return { from: shiftDays(today, -6), to: today };
    case "last30":
      return { from: shiftDays(today, -29), to: today };
    case "mtd":
      return { from: toISO(new Date(t.getFullYear(), t.getMonth(), 1)), to: today };
    // The closed periods use day 0 of the FOLLOWING month as the end date —
    // Date normalises it to the last day of the month before, so February and
    // a leap year need no special case and no month-length table.
    case "lastMonth":
      return {
        from: toISO(new Date(t.getFullYear(), t.getMonth() - 1, 1)),
        to: toISO(new Date(t.getFullYear(), t.getMonth(), 0)),
      };
    case "qtd":
      return { from: toISO(new Date(t.getFullYear(), Math.floor(t.getMonth() / 3) * 3, 1)), to: today };
    case "lastQuarter": {
      const firstOfThisQuarter = Math.floor(t.getMonth() / 3) * 3;
      return {
        from: toISO(new Date(t.getFullYear(), firstOfThisQuarter - 3, 1)),
        to: toISO(new Date(t.getFullYear(), firstOfThisQuarter, 0)),
      };
    }
    case "ytd":
      return { from: `${t.getFullYear()}-01-01`, to: today };
    case "lastYear":
      return { from: `${t.getFullYear() - 1}-01-01`, to: `${t.getFullYear() - 1}-12-31` };
  }
}

/* ── DateRangePicker ─────────────────────────────────────────── */

export interface DateRangePickerLabels {
  /** Display label per preset (callers pass t(...)). */
  presets: Record<DateRangePreset, string>;
  /** Labels for the custom from/to date fields. */
  from: string;
  to: string;
  /** Accessible name for the preset select. */
  presetAriaLabel?: string;
}

export interface DateRangePickerProps {
  value: DateRange;
  onChange: (value: DateRange) => void;
  labels: DateRangePickerLabels;
  disabled?: boolean;
  className?: string;
}

/**
 * Preset select (today … ytd | custom). Picking a preset computes the concrete
 * from/to immediately (so the URL codec always carries real dates); "custom"
 * keeps the current range and reveals two native date inputs.
 */
export function DateRangePicker({ value, onChange, labels, disabled, className }: DateRangePickerProps) {
  function handlePreset(preset: DateRangePreset) {
    if (preset === "custom") {
      onChange({ from: value.from, to: value.to, preset: "custom" });
    } else {
      onChange({ ...computePresetRange(preset), preset });
    }
  }

  return (
    <div className={cn("flex flex-wrap items-end gap-2", className)}>
      <Select
        aria-label={labels.presetAriaLabel}
        value={value.preset}
        disabled={disabled}
        onChange={(e) => handlePreset(e.target.value as DateRangePreset)}
        options={DATE_RANGE_PRESETS.map((p) => ({ value: p, label: labels.presets[p] }))}
        className="min-w-36"
      />
      {value.preset === "custom" && (
        <>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-extrabold text-slate-500">{labels.from}</span>
            <DatePicker
              value={value.from}
              max={value.to || undefined}
              disabled={disabled}
              onChange={(from) => onChange({ from, to: value.to, preset: "custom" })}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-extrabold text-slate-500">{labels.to}</span>
            <DatePicker
              value={value.to}
              min={value.from || undefined}
              disabled={disabled}
              onChange={(to) => onChange({ from: value.from, to, preset: "custom" })}
            />
          </label>
        </>
      )}
    </div>
  );
}

/* ── ComparePicker ───────────────────────────────────────────── */

export const COMPARE_MODES = ["none", "prevPeriod", "prevYear", "custom"] as const;

export type CompareMode = (typeof COMPARE_MODES)[number];

export interface CompareRange {
  from: string;
  to: string;
}

/**
 * The concrete comparison window for a primary range: prevPeriod = the
 * equal-length window ending the day before `from`; prevYear = the same dates
 * one year earlier (Feb 29 rolls forward per Date semantics). "none"/"custom"
 * have no derived window — custom comes from the caller's ComparePicker state.
 */
export function computeCompareRange(
  mode: Exclude<CompareMode, "none" | "custom">,
  range: CompareRange,
): CompareRange {
  if (mode === "prevYear") {
    const shiftYear = (iso: string) => {
      const d = parseISO(iso);
      return toISO(new Date(d.getFullYear() - 1, d.getMonth(), d.getDate()));
    };
    return { from: shiftYear(range.from), to: shiftYear(range.to) };
  }
  // prevPeriod — same length, immediately before.
  const from = parseISO(range.from);
  const to = parseISO(range.to);
  const lengthDays = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
  const compareTo = shiftDays(range.from, -1);
  return { from: shiftDays(compareTo, -(lengthDays - 1)), to: compareTo };
}

export interface ComparePickerLabels {
  modes: Record<CompareMode, string>;
  from: string;
  to: string;
  modeAriaLabel?: string;
}

export interface ComparePickerProps {
  value: CompareMode;
  /** Modes this caller can actually honour. Defaults to the full shared set. */
  modes?: readonly CompareMode[];
  /** The explicit window when `value === "custom"`. */
  customRange?: CompareRange;
  onChange: (mode: CompareMode, customRange?: CompareRange) => void;
  labels: ComparePickerLabels;
  disabled?: boolean;
  className?: string;
}

/** Comparison mode select; "custom" reveals two native date inputs. */
export function ComparePicker({ value, modes = COMPARE_MODES, customRange, onChange, labels, disabled, className }: ComparePickerProps) {
  const range = customRange ?? { from: "", to: "" };

  return (
    <div className={cn("flex flex-wrap items-end gap-2", className)}>
      <Select
        aria-label={labels.modeAriaLabel}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const mode = e.target.value as CompareMode;
          onChange(mode, mode === "custom" ? range : undefined);
        }}
        options={modes.map((m) => ({ value: m, label: labels.modes[m] }))}
        className="min-w-36"
      />
      {value === "custom" && (
        <>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-extrabold text-slate-500">{labels.from}</span>
            <DatePicker
              value={range.from}
              max={range.to || undefined}
              disabled={disabled}
              onChange={(from) => onChange("custom", { from, to: range.to })}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-extrabold text-slate-500">{labels.to}</span>
            <DatePicker
              value={range.to}
              min={range.from || undefined}
              disabled={disabled}
              onChange={(to) => onChange("custom", { from: range.from, to })}
            />
          </label>
        </>
      )}
    </div>
  );
}
