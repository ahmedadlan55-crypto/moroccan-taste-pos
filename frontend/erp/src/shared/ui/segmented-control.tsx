import type { ReactNode } from "react";
import { cn } from "@/shared/lib";

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  size?: "sm" | "md";
  "aria-label"?: string;
}

/**
 * A compact pill switch for a small set of mutually-exclusive choices (e.g. a
 * date range or a view mode). Uses radiogroup semantics.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className,
  size = "md",
  "aria-label": ariaLabel,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn("inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1", className)}
    >
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              "min-h-11 rounded-lg font-bold leading-5 transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100 disabled:cursor-not-allowed disabled:opacity-50",
              size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-1.5 text-sm",
              selected ? "bg-white text-teal-700 shadow-sm" : "text-slate-500 hover:text-slate-800",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
