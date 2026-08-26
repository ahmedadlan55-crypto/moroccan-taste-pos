import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from "react";
import { Check, Minus } from "lucide-react";
import { cn } from "@/shared/lib";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: ReactNode;
  /** Tri-state visual (a header "select all" that is partially selected). */
  indeterminate?: boolean;
}

/**
 * Accessible checkbox: a real (visually-hidden) <input type=checkbox> drives
 * state and keyboard/focus for free; the styled box mirrors checked/indeterminate.
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, label, indeterminate, id, checked, disabled, ...props }, ref) => {
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
        <span className="relative -my-3 -ms-3 inline-grid h-11 w-11 shrink-0 place-items-center">
          <input
            ref={(node) => {
              if (node) node.indeterminate = !!indeterminate;
              if (typeof ref === "function") ref(node);
              else if (ref) ref.current = node;
            }}
            id={inputId}
            type="checkbox"
            checked={checked}
            disabled={disabled}
            className="peer h-5 w-5 cursor-pointer appearance-none rounded-md border border-slate-300 bg-white transition checked:border-teal-600 checked:bg-teal-600 indeterminate:border-teal-600 indeterminate:bg-teal-600 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100 disabled:cursor-not-allowed"
            {...props}
          />
          <span className="pointer-events-none absolute text-white opacity-0 peer-checked:opacity-100 peer-indeterminate:opacity-100">
            {indeterminate ? <Minus className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
          </span>
        </span>
        {label != null && <span>{label}</span>}
      </label>
    );
  },
);
Checkbox.displayName = "Checkbox";
