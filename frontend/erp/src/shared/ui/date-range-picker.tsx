// DateRangePicker + ComparePicker — preset-driven date range selection for the
// analytics surfaces. Controlled components; every visible string arrives via
// the `labels` prop (callers pass t(...)), so no i18n keys live here beyond the
// shared kit's own defaults.
//
// Date math is LOCAL-calendar (shared/lib/dates todayISO + the ISO helpers in
// shared/ui/calendar — never toISOString(), which reads the UTC day).
//
// DRAFT SEMANTICS. The panel edits a DRAFT: clicking days, typing a date and
// picking a preset all change what the panel SHOWS, and nothing reaches
// `onChange` until Apply. Cancel (and Escape, and an outside click) throws the
// draft away and leaves the committed value exactly as it was. This is the same
// contract the analytics filter bar already runs on one level up — an edit that
// commits instantly puts the previous period's numbers under the new period's
// heading, which is a wrong number, not a slow one.
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Calendar as CalendarIcon } from "lucide-react";
import { cn, todayISO } from "@/shared/lib";
import { Button } from "./button";
import {
  CalendarMonth,
  DatePopover,
  addMonthsISO,
  dateToISO,
  formatISODisplay,
  formatMonthTitle,
  isValidISODate,
  isoToDate,
  monthKeyISO,
  nextFocusedDay,
  startOfMonthISO,
} from "./calendar";
import { DatePicker } from "./date-picker";
import { Select } from "./select";
import { useTx } from "./i18n";

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

/** Parse "YYYY-MM-DD" as a LOCAL date (new Date(iso) would read it as UTC). */
function parseISO(iso: string): Date {
  return isoToDate(iso) ?? new Date();
}

function shiftDays(iso: string, days: number): string {
  const d = parseISO(iso);
  d.setDate(d.getDate() + days);
  return dateToISO(d);
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
      return { from: dateToISO(new Date(t.getFullYear(), t.getMonth(), 1)), to: today };
    // The closed periods use day 0 of the FOLLOWING month as the end date —
    // Date normalises it to the last day of the month before, so February and
    // a leap year need no special case and no month-length table.
    case "lastMonth":
      return {
        from: dateToISO(new Date(t.getFullYear(), t.getMonth() - 1, 1)),
        to: dateToISO(new Date(t.getFullYear(), t.getMonth(), 0)),
      };
    case "qtd":
      return { from: dateToISO(new Date(t.getFullYear(), Math.floor(t.getMonth() / 3) * 3, 1)), to: today };
    case "lastQuarter": {
      const firstOfThisQuarter = Math.floor(t.getMonth() / 3) * 3;
      return {
        from: dateToISO(new Date(t.getFullYear(), firstOfThisQuarter - 3, 1)),
        to: dateToISO(new Date(t.getFullYear(), firstOfThisQuarter, 0)),
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
  /** Accessible name for the trigger. */
  presetAriaLabel?: string;
  /** Panel heading. Defaults to the shared kit's copy. */
  title?: string;
  apply?: string;
  cancel?: string;
}

export interface DateRangePickerProps {
  value: DateRange;
  onChange: (value: DateRange) => void;
  labels: DateRangePickerLabels;
  disabled?: boolean;
  className?: string;
}

/** A typed ISO field that mirrors the draft without fighting the keyboard. */
function IsoField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit: (iso: string) => void;
}) {
  const [text, setText] = useState(value);
  const [typing, setTyping] = useState(false);

  useEffect(() => {
    if (!typing) setText(value);
  }, [value, typing]);

  return (
    <input
      type="text"
      inputMode="numeric"
      autoComplete="off"
      spellCheck={false}
      dir="ltr"
      lang="en-GB"
      aria-label={label}
      placeholder="YYYY-MM-DD"
      value={text}
      onFocus={() => setTyping(true)}
      onBlur={() => {
        setTyping(false);
        setText(value);
      }}
      onChange={(e) => {
        setText(e.target.value);
        // A half-typed date is not a range bound; only a real calendar day is.
        if (isValidISODate(e.target.value)) onCommit(e.target.value);
      }}
      className="field h-11 min-h-11 w-full py-1 text-center text-[13px] tabular-nums"
    />
  );
}

/**
 * The period control: a trigger showing the committed period, and a popover
 * with two month grids (From / To), the preset rail, and Cancel / Apply.
 *
 * The two months are CONTIGUOUS and move together — a range picker whose
 * halves can drift onto the same month, or onto months in the wrong order,
 * shows a band that starts nowhere and ends nowhere.
 */
export function DateRangePicker({ value, onChange, labels, disabled, className }: DateRangePickerProps) {
  const t = useTx();
  const today = todayISO();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange>(value);
  /** The first endpoint of an in-progress pick; null when the range is whole. */
  const [anchorDay, setAnchorDay] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [viewMonth, setViewMonth] = useState(() => startOfMonthISO(value.from || today));
  const [focusedDay, setFocusedDay] = useState(() => value.from || today);
  const [focusSeq, setFocusSeq] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const title = labels.title ?? t("sharedUi.dateRangePicker.title");
  const rightMonth = addMonthsISO(viewMonth, 1);

  function openPicker() {
    const anchor = isValidISODate(value.from) ? value.from : today;
    setDraft(value);
    setAnchorDay(null);
    setHovered(null);
    setViewMonth(startOfMonthISO(anchor));
    setFocusedDay(anchor);
    setOpen(true);
    setFocusSeq((n) => n + 1);
  }

  function clickDay(iso: string) {
    setFocusedDay(iso);
    setHovered(null);
    if (anchorDay === null) {
      setAnchorDay(iso);
      setDraft({ from: iso, to: iso, preset: "custom" });
      return;
    }
    // Picking the end BEFORE the start swaps the pair. An inverted range is not
    // "empty results" to the engine — it is a 422 the analyst never asked for.
    const [from, to] = anchorDay <= iso ? [anchorDay, iso] : [iso, anchorDay];
    setAnchorDay(null);
    setDraft({ from, to, preset: "custom" });
  }

  function pickPreset(preset: DateRangePreset) {
    setAnchorDay(null);
    setHovered(null);
    if (preset === "custom") {
      setDraft((d) => ({ ...d, preset: "custom" }));
      return;
    }
    const range = computePresetRange(preset);
    setDraft({ ...range, preset });
    setViewMonth(startOfMonthISO(range.from));
    setFocusedDay(range.from);
  }

  /** Keep `iso` inside the visible pair of months. */
  function ensureVisible(iso: string) {
    setViewMonth((m) => {
      const key = monthKeyISO(iso);
      if (key === monthKeyISO(m) || key === monthKeyISO(addMonthsISO(m, 1))) return m;
      return key < monthKeyISO(m) ? startOfMonthISO(iso) : addMonthsISO(startOfMonthISO(iso), -1);
    });
  }

  function handleGridKey(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      clickDay(focusedDay);
      return;
    }
    const next = nextFocusedDay(e.key, focusedDay);
    if (next === null) return;
    e.preventDefault();
    setFocusedDay(next);
    ensureVisible(next);
    setFocusSeq((n) => n + 1);
  }

  const complete = isValidISODate(draft.from) && isValidISODate(draft.to);

  function apply() {
    if (!complete) return;
    // Last line of defence: a typed pair can still arrive inverted.
    const inverted = draft.from > draft.to;
    onChange({
      from: inverted ? draft.to : draft.from,
      to: inverted ? draft.from : draft.to,
      preset: draft.preset,
    });
    setOpen(false);
  }

  const picking = anchorDay !== null;
  const gridProps = {
    selectedStart: picking ? anchorDay : draft.from || null,
    selectedEnd: picking ? null : draft.to || null,
    previewEnd: picking ? (hovered ?? focusedDay) : null,
    today,
    focusedDay,
    focusSeq,
    onDayClick: clickDay,
    onDayHover: setHovered,
    onKeyDown: handleGridKey,
    onPrevMonth: () => setViewMonth((m) => addMonthsISO(m, -1)),
    onNextMonth: () => setViewMonth((m) => addMonthsISO(m, 1)),
  };

  const summary =
    value.preset !== "custom"
      ? labels.presets[value.preset]
      : `${formatISODisplay(value.from) || "—"} – ${formatISODisplay(value.to) || "—"}`;

  /** One calendar column: header row, rule, month nav, weekday header, grid. */
  const column = (label: string, iso: string, month: string, onCommit: (v: string) => void) => (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 border-b border-slate-200 pb-1.5">
        <span className="text-[11px] font-extrabold uppercase tracking-wide text-slate-500">{label}</span>
        <span dir="ltr" className="text-[13px] font-bold tabular-nums text-slate-800">
          {formatISODisplay(iso) || "—"}
        </span>
      </div>
      <div className="pt-2">
        <CalendarMonth
          {...gridProps}
          month={month}
          ariaLabel={formatMonthTitle(month)}
          // Both columns carry a month nav, so each button's accessible name is
          // qualified by its column — two controls named "previous month" with
          // no way to tell them apart is a screen-reader dead end.
          labels={{
            prevMonth: `${t("sharedUi.datePicker.prevMonth")} (${label})`,
            nextMonth: `${t("sharedUi.datePicker.nextMonth")} (${label})`,
          }}
        />
      </div>
      <div className="pt-2">
        <IsoField label={label} value={iso} onCommit={onCommit} />
      </div>
    </div>
  );

  return (
    <div className={cn("min-w-0", className)}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={labels.presetAriaLabel}
        onClick={() => (open ? setOpen(false) : openPicker())}
        className={cn(
          "field flex w-full items-center justify-between gap-2 py-2 text-start",
          disabled && "cursor-not-allowed opacity-60",
        )}
      >
        <span className="truncate text-sm font-semibold text-slate-800">{summary}</span>
        <CalendarIcon className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
      </button>

      <DatePopover
        open={open}
        anchorRef={triggerRef}
        onDismiss={() => setOpen(false)}
        ariaLabel={title}
        testId="date-range-popover"
      >
        <div className="max-h-[calc(100vh-2rem)] overflow-y-auto p-3 sm:p-4 scrollbar-thin">
          <h2 className="mb-3 text-sm font-extrabold text-slate-700">{title}</h2>

          <div className="flex flex-col gap-4 sm:flex-row sm:gap-5">
            {column(labels.from, draft.from, viewMonth, (iso) =>
              setDraft((d) => ({ ...d, from: iso, preset: "custom" })),
            )}
            {column(labels.to, draft.to, rightMonth, (iso) =>
              setDraft((d) => ({ ...d, to: iso, preset: "custom" })),
            )}

            <div
              role="group"
              aria-label={t("sharedUi.dateRangePicker.presets")}
              className="scrollbar-thin flex max-h-[19rem] shrink-0 flex-col gap-1 overflow-y-auto sm:w-44"
            >
              {DATE_RANGE_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  aria-pressed={draft.preset === preset}
                  onClick={() => pickPreset(preset)}
                  className={cn(
                    "min-h-11 shrink-0 rounded-xl px-3 text-start text-xs font-extrabold transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100",
                    draft.preset === preset
                      ? "bg-teal-600 text-white shadow-sm"
                      : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
                  )}
                >
                  {labels.presets[preset]}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 pt-3">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {labels.cancel ?? t("common.cancel")}
            </Button>
            <Button disabled={!complete} onClick={apply}>
              {labels.apply ?? t("common.apply")}
            </Button>
          </div>
        </div>
      </DatePopover>
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
      return dateToISO(new Date(d.getFullYear() - 1, d.getMonth(), d.getDate()));
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

/** Comparison mode select; "custom" reveals two date fields. */
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
