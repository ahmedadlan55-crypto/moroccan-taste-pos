// ADLAN calendar primitive — ONE month grid, pure and controlled, plus the
// popover shell and the ISO/English date helpers that DatePicker and
// DateRangePicker are both built on. There is exactly one calendar in this
// codebase and this is it: a second one would be a second set of month-length,
// leap-year, locale and keyboard bugs.
//
// ENGLISH, ALWAYS — the project's standing date policy (see the DATE POLICY
// comment in shared/lib/formatters.ts). Month names, weekday initials and the
// spelled-out day label come from Intl with an EXPLICIT "en-GB" locale and an
// explicit `calendar: "gregory"` + `numberingSystem: "latn"`, so an Arabic
// document (<html lang="ar" dir="rtl">) still draws English months, Latin
// digits and a Gregorian calendar inside a financial filter. Day NUMBERS are
// String(Date#getDate()), not Intl output, which makes Arabic-Indic digits
// impossible by construction rather than by configuration.
//
// LOCAL CALENDAR, ALWAYS — every helper here takes and returns an ISO
// "YYYY-MM-DD" string and builds Dates from local components. Nothing calls
// toISOString(), which reads the UTC day and silently reports yesterday for a
// Riyadh user between 00:00 and 02:59 (the bug shared/lib/dates.ts exists to
// prevent).
//
// RTL — the panel chrome mirrors with the document, but the GRID is pinned
// dir="ltr": a Gregorian week is read Monday→Sunday in both languages, and the
// month-nav chevrons must keep meaning "earlier"/"later", not "left"/"right".
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/shared/lib";

/* ── ISO date helpers (local calendar, string in / string out) ─── */

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local "YYYY-MM-DD" for a Date — never toISOString(). */
export function dateToISO(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Parse "YYYY-MM-DD" as a LOCAL date; null when the shape is wrong. */
export function isoToDate(iso: string): Date | null {
  if (!ISO_RE.test(iso)) return null;
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * A real calendar day, not merely a well-shaped string: "2026-02-31" parses
 * (Date rolls it to March 3) and would otherwise be accepted by a typed field
 * and emitted as a filter bound nobody chose.
 */
export function isValidISODate(iso: string | null | undefined): iso is string {
  if (!iso || !ISO_RE.test(iso)) return false;
  const d = isoToDate(iso);
  return d !== null && dateToISO(d) === iso;
}

function toDate(iso: string, fallback: Date): Date {
  return isoToDate(iso) ?? fallback;
}

export function addDaysISO(iso: string, days: number): string {
  const d = toDate(iso, new Date());
  d.setDate(d.getDate() + days);
  return dateToISO(d);
}

/**
 * Month arithmetic that never rolls over: Jan 31 + 1 month is Feb 28 (or 29),
 * not Mar 3. `Date#setMonth` alone produces the rollover, which turns a
 * PageDown on the 31st into a two-month jump.
 */
export function addMonthsISO(iso: string, months: number): string {
  const d = toDate(iso, new Date());
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  // Day 0 of the FOLLOWING month is the last day of this one — no month-length
  // table, and February/leap years need no special case.
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return dateToISO(d);
}

export function startOfMonthISO(iso: string): string {
  const d = toDate(iso, new Date());
  return dateToISO(new Date(d.getFullYear(), d.getMonth(), 1));
}

/** "YYYY-MM" — the month two ISO days share, for cheap same-month tests. */
export function monthKeyISO(iso: string): string {
  return iso.slice(0, 7);
}

export function clampISO(iso: string, min?: string, max?: string): string {
  if (min && iso < min) return min;
  if (max && iso > max) return max;
  return iso;
}

/* ── English formatting (pinned locale + calendar + numbering) ─── */

const EN_CALENDAR = { calendar: "gregory", numberingSystem: "latn" } as const;

const _monthLong = new Intl.DateTimeFormat("en-GB", { month: "long", ...EN_CALENDAR });
const _weekdayNarrow = new Intl.DateTimeFormat("en-GB", { weekday: "narrow", ...EN_CALENDAR });
const _weekdayLong = new Intl.DateTimeFormat("en-GB", { weekday: "long", ...EN_CALENDAR });
const _dayFull = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  ...EN_CALENDAR,
});
const _dayShort = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  ...EN_CALENDAR,
});

/** "2026 AUGUST" — the month-nav title. */
export function formatMonthTitle(iso: string): string {
  const d = isoToDate(iso);
  if (!d) return "";
  // toUpperCase (not toLocaleUpperCase) — locale-independent by definition, so
  // a Turkish host locale cannot turn "AUGUST" into "AUGUST" with a dotless I.
  return `${d.getFullYear()} ${_monthLong.format(d).toUpperCase()}`;
}

/** "Thursday, 20 August 2026" — a day cell's accessible name. */
export function formatDayAriaLabel(iso: string): string {
  const d = isoToDate(iso);
  return d ? _dayFull.format(d) : iso;
}

/** "20 Aug 2026" — the From/To header and the closed trigger. */
export function formatISODisplay(iso: string): string {
  const d = isoToDate(iso);
  return d ? _dayShort.format(d) : "";
}

/**
 * Monday-first weekday headers. 2024-01-01 was a Monday, so it anchors the
 * week without asking Intl for a first-day-of-week it reports differently per
 * locale — the grid's week order is a product decision, not a locale one.
 */
export const CALENDAR_WEEKDAYS: ReadonlyArray<{ narrow: string; long: string }> = Array.from(
  { length: 7 },
  (_unused, i) => {
    const d = new Date(2024, 0, 1 + i);
    return { narrow: _weekdayNarrow.format(d), long: _weekdayLong.format(d) };
  },
);

/** Monday=0 … Sunday=6. */
function weekdayIndex(d: Date): number {
  return (d.getDay() + 6) % 7;
}

/**
 * The 42 days (6 fixed rows) a month grid shows, including the muted days that
 * belong to the neighbouring months. Fixed at 6 rows on purpose: a grid that
 * grows to 6 rows only in some months makes the popover jump height as you
 * page through it, and moves the footer buttons out from under the cursor.
 */
export function monthGridDays(monthISO: string): string[] {
  const first = toDate(startOfMonthISO(monthISO), new Date());
  const start = addDaysISO(dateToISO(first), -weekdayIndex(first));
  return Array.from({ length: 42 }, (_unused, i) => addDaysISO(start, i));
}

/**
 * Where a navigation key moves the focused day, or null when the key is not a
 * navigation key. Exported because the range picker owns ONE focused day
 * across TWO month grids — the movement cannot live inside a single grid.
 */
export function nextFocusedDay(key: string, from: string): string | null {
  switch (key) {
    case "ArrowLeft":
      return addDaysISO(from, -1);
    case "ArrowRight":
      return addDaysISO(from, 1);
    case "ArrowUp":
      return addDaysISO(from, -7);
    case "ArrowDown":
      return addDaysISO(from, 7);
    case "PageUp":
      return addMonthsISO(from, -1);
    case "PageDown":
      return addMonthsISO(from, 1);
    case "Home": {
      const d = isoToDate(from);
      return d ? addDaysISO(from, -weekdayIndex(d)) : null;
    }
    case "End": {
      const d = isoToDate(from);
      return d ? addDaysISO(from, 6 - weekdayIndex(d)) : null;
    }
    default:
      return null;
  }
}

/* ── CalendarMonth ───────────────────────────────────────────── */

export interface CalendarMonthLabels {
  prevMonth: string;
  nextMonth: string;
}

export interface CalendarMonthProps {
  /** Any ISO day inside the month to render. */
  month: string;
  /** Range start (or the single selected day). */
  selectedStart?: string | null;
  /** Range end. Omit for a single-date calendar. */
  selectedEnd?: string | null;
  /** Provisional end while a range is half-picked (hover / keyboard). */
  previewEnd?: string | null;
  min?: string;
  max?: string;
  /** ISO "today" — injected so the app and the tests share one clock. */
  today: string;
  /** Roving-tabindex target; the only day cell reachable with Tab. */
  focusedDay?: string | null;
  /**
   * Bump to move REAL DOM focus onto `focusedDay`. A plain effect on
   * `focusedDay` would steal focus out of the typed field every time a
   * keystroke there changed the draft, so focus moves only when a caller
   * explicitly asks for it.
   */
  focusSeq?: number;
  onDayClick: (iso: string) => void;
  onDayHover?: (iso: string | null) => void;
  /** Month navigation. Omitting BOTH renders no nav row. */
  onPrevMonth?: () => void;
  onNextMonth?: () => void;
  onKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  labels: CalendarMonthLabels;
  /** Accessible name of the grid itself. */
  ariaLabel?: string;
  className?: string;
}

/**
 * One month, pure and controlled: it owns no selection state, no view state
 * and no clock. Everything it draws comes from props, which is what lets the
 * range picker drive two of them from one selection.
 */
export function CalendarMonth({
  month,
  selectedStart = null,
  selectedEnd = null,
  previewEnd = null,
  min,
  max,
  today,
  focusedDay = null,
  focusSeq = 0,
  onDayClick,
  onDayHover,
  onPrevMonth,
  onNextMonth,
  onKeyDown,
  labels,
  ariaLabel,
  className,
}: CalendarMonthProps) {
  const gridRef = useRef<HTMLDivElement>(null);
  // Read during render so the focus effect below sees the CURRENT day without
  // taking a dependency on it (see the focusSeq doc above).
  const focusedRef = useRef(focusedDay);
  focusedRef.current = focusedDay;

  useEffect(() => {
    if (!focusSeq) return;
    const day = focusedRef.current;
    if (!day) return;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${day}"]`)?.focus();
  }, [focusSeq]);

  const monthStart = startOfMonthISO(month);
  const monthKey = monthKeyISO(monthStart);
  const rows = useMemo(() => {
    const days = monthGridDays(monthStart);
    return Array.from({ length: 6 }, (_unused, r) => days.slice(r * 7, r * 7 + 7));
  }, [monthStart]);

  // The shaded band runs between the two endpoints, whichever order they were
  // picked in — a half-picked range previews against the hovered/focused day.
  const anchor = selectedStart ?? null;
  const other = selectedEnd ?? previewEnd ?? null;
  const bandStart = anchor && other ? (anchor <= other ? anchor : other) : null;
  const bandEnd = anchor && other ? (anchor <= other ? other : anchor) : null;
  const hasBand = bandStart !== null && bandEnd !== null && bandStart !== bandEnd;

  return (
    // dir=ltr: the week reads Monday→Sunday and ‹ means "earlier" in both
    // languages. Only the panel chrome around this mirrors.
    <div dir="ltr" className={cn("min-w-0", className)}>
      {/* The title row is unconditional — a grid that does not say which month
          it is showing is a trap. Only the nav BUTTONS are optional. */}
      <div className="mb-1 flex items-center justify-between gap-1">
        {onPrevMonth ? (
          <button
            type="button"
            aria-label={labels.prevMonth}
            onClick={onPrevMonth}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-slate-200 bg-white text-slate-500 transition hover:border-slate-300 hover:bg-slate-50 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : (
          <span className="h-8 w-8 shrink-0" aria-hidden="true" />
        )}
        <span className="truncate text-xs font-extrabold tracking-wide text-slate-700">
          {formatMonthTitle(monthStart)}
        </span>
        {onNextMonth ? (
          <button
            type="button"
            aria-label={labels.nextMonth}
            onClick={onNextMonth}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-slate-200 bg-white text-slate-500 transition hover:border-slate-300 hover:bg-slate-50 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : (
          <span className="h-8 w-8 shrink-0" aria-hidden="true" />
        )}
      </div>

      <div
        ref={gridRef}
        role="grid"
        aria-label={ariaLabel}
        onKeyDown={onKeyDown}
        onMouseLeave={() => onDayHover?.(null)}
        className="select-none"
      >
        <div role="row" className="grid grid-cols-7">
          {CALENDAR_WEEKDAYS.map((w) => (
            // The narrow initials repeat (T/T, S/S), so the accessible name
            // carries the full English weekday instead of the glyph.
            <span
              key={w.long}
              role="columnheader"
              aria-label={w.long}
              className="grid h-7 place-items-center text-[11px] font-extrabold text-slate-400"
            >
              {w.narrow}
            </span>
          ))}
        </div>

        {rows.map((row) => (
          <div key={row[0]} role="row" className="grid grid-cols-7">
            {row.map((iso) => {
              const outside = monthKeyISO(iso) !== monthKey;
              const blocked = (min !== undefined && iso < min) || (max !== undefined && iso > max);
              const isStart = selectedStart !== null && iso === selectedStart;
              const isEnd = selectedEnd !== null && iso === selectedEnd;
              const isEndpoint = isStart || isEnd;
              const inBand = hasBand && bandStart !== null && bandEnd !== null && iso >= bandStart && iso <= bandEnd;
              const isToday = iso === today;
              return (
                <div
                  key={iso}
                  role="gridcell"
                  aria-selected={isEndpoint}
                  aria-disabled={blocked || undefined}
                  className={cn(
                    "grid place-items-center py-0.5",
                    // The band spans the FULL cell width so it reads as one
                    // continuous row, with only its two ends rounded.
                    inBand && "bg-teal-50",
                    inBand && iso === bandStart && "rounded-s-full",
                    inBand && iso === bandEnd && "rounded-e-full",
                  )}
                >
                  <button
                    type="button"
                    data-day={iso}
                    disabled={blocked}
                    tabIndex={iso === focusedDay ? 0 : -1}
                    aria-label={formatDayAriaLabel(iso)}
                    aria-current={isToday ? "date" : undefined}
                    onClick={() => onDayClick(iso)}
                    onMouseEnter={() => onDayHover?.(iso)}
                    className={cn(
                      "grid h-9 w-9 place-items-center rounded-full text-[13px] font-semibold tabular-nums transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100",
                      isEndpoint
                        ? "bg-teal-600 text-white shadow-sm"
                        : blocked
                          ? "cursor-not-allowed text-slate-200"
                          : outside
                            ? "text-slate-300 hover:bg-slate-100"
                            : "text-slate-700 hover:bg-slate-100",
                      // Today is an OUTLINE, so it stays legible under the
                      // filled endpoint style rather than competing with it.
                      isToday && !isEndpoint && "ring-1 ring-inset ring-teal-500 text-teal-700",
                    )}
                  >
                    {String(Number(iso.slice(8, 10)))}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── DatePopover ─────────────────────────────────────────────── */

// Deliberately NOT shared/ui/overlay.tsx's useFocusTrap: that hook locks body
// scroll and auto-focuses the first focusable element 20ms after open. Both are
// right for a modal and wrong here — a date popover must not lock the page, and
// its opening focus belongs on the selected DAY (the ARIA date-picker pattern),
// which a delayed "focus the first control" would then steal.
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DatePopoverProps {
  open: boolean;
  /** The element the panel is positioned against; clicks inside it never dismiss. */
  anchorRef: RefObject<HTMLElement | null>;
  /** Where focus goes when the panel closes. Defaults to the anchor. */
  returnFocusRef?: RefObject<HTMLElement | null>;
  /** Escape, outside click, or the panel losing its anchor. */
  onDismiss: () => void;
  ariaLabel: string;
  children: ReactNode;
  className?: string;
  testId?: string;
}

/**
 * The popover shell: portalled to <body> (so it is never clipped by a card's
 * overflow, and — because the pickers are routinely rendered inside a <label>
 * — so its buttons never become competing labelled controls), position-fixed
 * against the trigger, Tab-trapped, Escape- and outside-click-dismissed, with
 * focus returned to the trigger on close.
 */
export function DatePopover({
  open,
  anchorRef,
  returnFocusRef,
  onDismiss,
  ariaLabel,
  children,
  className,
  testId,
}: DatePopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      const r = anchor.getBoundingClientRect();
      const pw = panel.offsetWidth;
      const ph = panel.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let top = r.bottom + 6;
      if (ph > 0 && top + ph > vh - 8) top = Math.max(8, r.top - ph - 6);
      // Align to the anchor's INLINE-START edge, which is its right edge in RTL.
      const rtl = typeof document !== "undefined" && document.documentElement.dir === "rtl";
      let left = rtl ? r.right - pw : r.left;
      if (vw > 0 && pw > 0) left = Math.min(Math.max(8, left), Math.max(8, vw - pw - 8));
      setPos((p) => (p.top === top && p.left === left ? p : { top, left }));
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    // The panel's own width is responsive (the columns stack under `sm`), so
    // the first measurement can be taken before the layout settles — which
    // pinned a 375px-wide phone's panel flush against the viewport edge.
    // Re-place whenever the panel's box actually changes. (jsdom has no
    // ResizeObserver; src/test/setup.ts stubs a no-op one, so this is inert
    // in tests rather than a crash.)
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => place());
    if (ro && panelRef.current) ro.observe(panelRef.current);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        dismissRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      // No offsetParent filter here (unlike overlay.getFocusable): jsdom
      // reports offsetParent === null for everything, which would silently
      // turn the trap into a no-op in every test that exercises it.
      const els = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.tabIndex !== -1,
      );
      if (els.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = els[0];
      const last = els[els.length - 1];
      const activeEl = document.activeElement;
      if (e.shiftKey && (activeEl === first || activeEl === panel || !panel.contains(activeEl))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    }
    function onPointerDown(e: MouseEvent) {
      const target = e.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      // The trigger toggles itself; dismissing here too would close and
      // immediately reopen.
      if (anchorRef.current?.contains(target)) return;
      dismissRef.current();
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open, anchorRef]);

  // Focus restore on close — the native <input type=date> gave this for free.
  useEffect(() => {
    if (!open) return;
    return () => (returnFocusRef ?? anchorRef).current?.focus?.();
  }, [open, anchorRef, returnFocusRef]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={ariaLabel}
      data-testid={testId}
      tabIndex={-1}
      style={{ position: "fixed", top: pos.top, left: pos.left }}
      className={cn(
        "z-popover max-w-[calc(100vw-1rem)] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl ring-1 ring-slate-900/5 focus:outline-none",
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  );
}
