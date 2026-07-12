import { forwardRef, type InputHTMLAttributes } from "react";
import { Calendar } from "lucide-react";
import { cn } from "@/shared/lib";

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
 * Date field built on the native <input type=date> — it gives a correct,
 * accessible, localized calendar and keyboard support for free, and stores an
 * unambiguous ISO "YYYY-MM-DD" string (Gregorian) for the financial contracts.
 */
export const DatePicker = forwardRef<HTMLInputElement, DatePickerProps>(
  ({ value, onChange, className, invalid, ...props }, ref) => (
    <span className="relative block">
      <Calendar
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
        aria-hidden="true"
      />
      <input
        ref={ref}
        type="date"
        dir="ltr"
        value={value}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "field py-2 pr-10 text-left tabular-nums",
          invalid && "border-rose-400 focus:border-rose-500 focus:ring-rose-100",
          className,
        )}
        {...props}
      />
    </span>
  ),
);
DatePicker.displayName = "DatePicker";
