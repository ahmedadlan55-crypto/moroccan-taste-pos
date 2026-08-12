// DatePicker — one ISO date, a typed field plus the shared calendar primitive.
//
// WHY IT IS NO LONGER <input type="date">
//   The native control drew its visible text and its popup in the ELEMENT's
//   language, which inherits from <html lang="ar">: Arabic month names, and on
//   several platforms Arabic-Indic digits and a HIJRI calendar, inside a filter
//   that feeds a financial report. `lang="en-GB"` pinned it back, but it also
//   meant the picker looked different in every browser and could not carry the
//   product's range/preset behaviour. This renders the calendar itself, so the
//   English-Gregorian-Latin-digits policy is enforced by our own Intl
//   formatters (see shared/ui/calendar.tsx) rather than requested from the
//   platform. Native date inputs are forbidden by the architecture gate: this
//   is the one date field for ERP and POS-facing back-office workflows.
//
// WHAT THE NATIVE CONTROL GAVE FOR FREE AND THIS OWES BACK: typing a known
// date without touching a calendar, full keyboard navigation, an accessible
// name per day, and focus returning to the trigger on close. All four are here.
//
// The value in and out is ISO "YYYY-MM-DD" (or "") — unchanged, so all 15 call
// sites keep working untouched.
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Calendar } from "lucide-react";
import { cn, todayISO } from "@/shared/lib";
import {
  CalendarMonth,
  DatePopover,
  addMonthsISO,
  clampISO,
  formatMonthTitle,
  isValidISODate,
  nextFocusedDay,
  startOfMonthISO,
} from "./calendar";
import { useTx } from "./i18n";

type NativeDateProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange">;

export interface DatePickerProps extends NativeDateProps {
  /** ISO date string "YYYY-MM-DD" (or "" when empty). */
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  min?: string;
  max?: string;
}

/**
 * Call sites historically pass both control and layout utilities through
 * `className`. A width or margin applied only to the input makes the calendar
 * trigger use a different wrapper box. Route layout utilities to that wrapper
 * and leave height/padding/colour utilities on the actual control.
 */
function splitLayoutClasses(className?: string): { wrapper?: string; control?: string } {
  if (!className) return {};
  const layout: string[] = [];
  const control: string[] = [];
  const layoutUtility = /^(?:(?:sm|md|lg|xl|2xl|print):)*(?:block|inline-block|w-.+|min-w-.+|max-w-.+|m[trblxyse]?-.+|flex-1|grow|grow-0|shrink|shrink-0|self-.+)$/;

  for (const token of className.trim().split(/\s+/)) {
    (layoutUtility.test(token) ? layout : control).push(token);
  }
  return {
    wrapper: layout.length ? layout.join(" ") : undefined,
    control: control.length ? control.join(" ") : undefined,
  };
}

export const DatePicker = forwardRef<HTMLInputElement, DatePickerProps>(
  (
    {
      value,
      onChange,
      className,
      invalid,
      min,
      max,
      disabled,
      placeholder,
      onFocus,
      onBlur,
      onKeyDown,
      ...props
    },
    ref,
  ) => {
    const t = useTx();
    const today = todayISO();
    const [open, setOpen] = useState(false);
    const [typing, setTyping] = useState(false);
    // The field mirrors `value` except while it is being typed into, where a
    // half-written date ("2026-08-") must survive the keystroke that made it.
    const [text, setText] = useState(value);
    const [focusedDay, setFocusedDay] = useState(() => clampISO(value || today, min, max));
    const [viewMonth, setViewMonth] = useState(() => startOfMonthISO(value || today));
    const [focusSeq, setFocusSeq] = useState(0);

    const wrapRef = useRef<HTMLSpanElement>(null);
    const toggleRef = useRef<HTMLSpanElement>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const gridId = useId();
    const layoutClasses = splitLayoutClasses(className);

    useEffect(() => {
      if (!typing) setText(value);
    }, [value, typing]);

    function setInputRef(el: HTMLInputElement | null) {
      inputRef.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    }

    function openCalendar() {
      const anchor = clampISO(isValidISODate(value) ? value : today, min, max);
      setFocusedDay(anchor);
      setViewMonth(startOfMonthISO(anchor));
      setOpen(true);
      setFocusSeq((n) => n + 1);
    }

    function toggle() {
      if (disabled) return;
      if (open) setOpen(false);
      else openCalendar();
    }

    function handleType(next: string) {
      setText(next);
      // Emit only a real, in-range calendar day: "2026-02-31" parses to March 3
      // and an out-of-range bound is a filter nobody chose. Anything else waits
      // for blur, which snaps the field back to the committed value.
      if (next === "") {
        onChange("");
        return;
      }
      if (!isValidISODate(next)) return;
      if ((min !== undefined && next < min) || (max !== undefined && next > max)) return;
      onChange(next);
    }

    function pick(iso: string) {
      onChange(iso);
      setText(iso);
      setOpen(false);
    }

    function handleGridKey(e: ReactKeyboardEvent<HTMLDivElement>) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if ((min === undefined || focusedDay >= min) && (max === undefined || focusedDay <= max)) pick(focusedDay);
        return;
      }
      const next = nextFocusedDay(e.key, focusedDay);
      if (next === null) return;
      e.preventDefault();
      const clamped = clampISO(next, min, max);
      setFocusedDay(clamped);
      setViewMonth(startOfMonthISO(clamped));
      setFocusSeq((n) => n + 1);
    }

    return (
      <span
        ref={wrapRef}
        data-date-picker-root
        // ISO/Gregorian values are always LTR. The explicit container direction
        // keeps the calendar trigger on the same physical side as its padding,
        // independently from the Arabic or English document direction.
        dir="ltr"
        className={cn("relative block min-w-0 w-full", layoutClasses.wrapper)}
      >
        <input
          {...props}
          ref={setInputRef}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          dir="ltr"
          lang="en-GB"
          disabled={disabled}
          placeholder={placeholder ?? "YYYY-MM-DD"}
          value={text}
          aria-invalid={invalid || undefined}
          onFocus={(e) => {
            setTyping(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setTyping(false);
            setText(value);
            onBlur?.(e);
          }}
          onChange={(e) => handleType(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && !open) {
              e.preventDefault();
              openCalendar();
            }
            onKeyDown?.(e);
          }}
          className={cn(
            // Logical utilities are physical here because the root is
            // deliberately LTR for ISO dates. This preserves the global RTL
            // token contract while reserving the trigger's right-side space.
            "field py-2 ps-3 pe-11 text-start tabular-nums",
            invalid && "border-rose-400 focus:border-rose-500 focus:ring-rose-100",
            layoutClasses.control,
          )}
        />
        {/* role="button" rather than <button>: this control is routinely
            rendered inside a <label>, where a second labelable element would
            make the field's own accessible name ambiguous. */}
        <span
          ref={toggleRef}
          role="button"
          tabIndex={disabled ? -1 : 0}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? gridId : undefined}
          aria-disabled={disabled || undefined}
          aria-label={t("sharedUi.datePicker.openCalendar")}
          onClick={toggle}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggle();
            }
          }}
          className={cn(
            "absolute end-1.5 top-1/2 grid h-8 w-8 -translate-y-1/2 cursor-pointer place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100",
            disabled && "cursor-not-allowed opacity-60",
          )}
        >
          <Calendar className="h-4 w-4" aria-hidden="true" />
        </span>

        <DatePopover
          open={open}
          anchorRef={wrapRef}
          returnFocusRef={toggleRef}
          onDismiss={() => setOpen(false)}
          ariaLabel={t("sharedUi.datePicker.calendar")}
          testId="date-picker-popover"
          className="p-3"
        >
          <div id={gridId}>
            <CalendarMonth
              month={viewMonth}
              selectedStart={isValidISODate(value) ? value : null}
              today={today}
              min={min}
              max={max}
              focusedDay={focusedDay}
              focusSeq={focusSeq}
              onDayClick={pick}
              onPrevMonth={() => setViewMonth((m) => addMonthsISO(m, -1))}
              onNextMonth={() => setViewMonth((m) => addMonthsISO(m, 1))}
              onKeyDown={handleGridKey}
              ariaLabel={formatMonthTitle(viewMonth)}
              labels={{
                prevMonth: t("sharedUi.datePicker.prevMonth"),
                nextMonth: t("sharedUi.datePicker.nextMonth"),
              }}
            />
          </div>
        </DatePopover>
      </span>
    );
  },
);
DatePicker.displayName = "DatePicker";
