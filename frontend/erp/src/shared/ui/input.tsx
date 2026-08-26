import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/shared/lib";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Marks the control aria-invalid and applies the error border. */
  invalid?: boolean;
  /** Leading adornment (icon/label), rendered on the inline-start (right in RTL). */
  leading?: ReactNode;
  /** Trailing adornment, rendered on the inline-end (left in RTL). */
  trailing?: ReactNode;
}

/** The one styled text input (built on the `.field` component class). */
export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, invalid, leading, trailing, ...props }, ref) => {
    const control = (
      <input
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          "field py-2",
          invalid && "border-rose-400 focus:border-rose-500 focus:ring-rose-100",
          leading != null && "ps-10",
          trailing != null && "pe-10",
          className,
        )}
        {...props}
        // Native time controls remain intentional; pin their digits/clock to
        // the application's Latin-digit contract without a global DOM observer.
        lang={props.lang ?? (props.type === "time" ? "en-GB" : undefined)}
      />
    );
    if (leading == null && trailing == null) return control;
    return (
      <span className="relative block">
        {leading != null && (
          <span className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-slate-400">
            {leading}
          </span>
        )}
        {control}
        {trailing != null && (
          <span className="absolute end-3 top-1/2 -translate-y-1/2 text-slate-400">{trailing}</span>
        )}
      </span>
    );
  },
);
Input.displayName = "Input";
