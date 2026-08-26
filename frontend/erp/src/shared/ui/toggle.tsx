import { useId, type ReactNode } from "react";
import { cn } from "@/shared/lib";

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
}

/** Accessible on/off switch (role=switch), keyboard + focus ring, 44px hit area. */
export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
  id,
  className,
  "aria-label": ariaLabel,
}: ToggleProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <label
      htmlFor={inputId}
      className={cn(
        "inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-slate-700",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
        className,
      )}
    >
      <button
        id={inputId}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-11 w-14 shrink-0 items-center rounded-full focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "absolute start-1.5 top-2.5 h-6 w-11 rounded-full transition-colors",
            checked ? "bg-teal-600" : "bg-slate-300",
          )}
        />
        <span
          className={cn(
            "absolute start-2 top-3 inline-block h-5 w-5 rounded-full bg-white shadow transition-transform",
            checked && "translate-x-5 rtl:-translate-x-5",
          )}
        />
      </button>
      {label != null && <span>{label}</span>}
    </label>
  );
}
