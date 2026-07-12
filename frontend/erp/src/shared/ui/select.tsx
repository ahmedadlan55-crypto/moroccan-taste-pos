import { forwardRef, type SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/shared/lib";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
  /** Convenience: render options from data. Ignored when children are provided. */
  options?: SelectOption[];
  placeholder?: string;
}

/**
 * Styled NATIVE select — the right choice for short, fixed option lists (best
 * mobile + a11y behavior for free). For long/searchable lists use Combobox or
 * SearchableEntityCombobox.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, invalid, options, placeholder, children, ...props }, ref) => (
    <span className="relative block">
      <select
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          "field appearance-none py-2 pl-9",
          invalid && "border-rose-400 focus:border-rose-500 focus:ring-rose-100",
          className,
        )}
        {...props}
      >
        {placeholder != null && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options
          ? options.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </option>
            ))
          : children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
        aria-hidden="true"
      />
    </span>
  ),
);
Select.displayName = "Select";
