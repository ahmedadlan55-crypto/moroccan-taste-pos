import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/shared/lib";

type NativeNumberProps = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type">;

export interface NumberInputProps extends NativeNumberProps {
  value: number | null | undefined;
  /** Fires with a parsed number, or null when the field is cleared. */
  onChange: (value: number | null) => void;
  invalid?: boolean;
  min?: number;
  max?: number;
  step?: number | "any";
  /** A short unit/currency suffix pinned to the inline-end (e.g. "ر.س", "كجم"). */
  suffix?: string;
}

// Numeric field: LTR + tabular-nums for clean alignment inside RTL layouts,
// emits a real number (or null when empty) rather than a string. This is the
// base for CurrencyInput and QuantityInput.
export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(
  ({ value, onChange, className, invalid, suffix, min, max, step = "any", ...props }, ref) => {
    const input = (
      <input
        ref={ref}
        type="number"
        inputMode="decimal"
        dir="ltr"
        min={min}
        max={max}
        step={step}
        value={value ?? ""}
        aria-invalid={invalid || undefined}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") return onChange(null);
          const n = Number(raw);
          onChange(Number.isFinite(n) ? n : null);
        }}
        className={cn(
          "field py-2 text-left tabular-nums",
          invalid && "border-rose-400 focus:border-rose-500 focus:ring-rose-100",
          suffix && "pl-12",
          className,
        )}
        {...props}
      />
    );
    if (!suffix) return input;
    return (
      <span className="relative block">
        {input}
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs font-bold text-slate-400">
          {suffix}
        </span>
      </span>
    );
  },
);
NumberInput.displayName = "NumberInput";
