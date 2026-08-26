import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "@/shared/lib";

// ADLAN button — enterprise, calm, dense. Every variant keeps a 44px min touch
// target, hover/active/disabled + a visible focus-visible ring (WCAG 2.4.7).
const buttonVariants = cva(
  "inline-flex min-h-11 min-w-0 max-w-full items-center justify-center gap-2 rounded-xl text-center text-sm font-semibold leading-5 transition-colors duration-150 [&>svg]:shrink-0 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100",
  {
    variants: {
      variant: {
        primary:
          "bg-teal-600 px-4 py-2 text-white shadow-sm hover:bg-teal-700 hover:shadow-md active:bg-teal-800",
        secondary:
          "border border-slate-200 bg-white px-4 py-2 text-slate-700 hover:border-slate-300 hover:bg-slate-50 active:bg-slate-100",
        ghost: "px-3 py-2 text-slate-600 hover:bg-slate-100 hover:text-slate-900 active:bg-slate-200",
        danger: "bg-rose-600 px-4 py-2 text-white shadow-sm hover:bg-rose-700 active:translate-y-0",
        subtle:
          "border border-teal-200 bg-teal-50 px-4 py-2 text-teal-700 hover:bg-teal-100 active:bg-teal-200",
      },
      size: {
        md: "",
        sm: "px-3 py-1.5 text-xs",
        lg: "px-6 py-3 text-base",
        icon: "h-11 w-11 px-0",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Show a spinner and disable the button while an async action runs. */
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = "button", loading = false, disabled, children, ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
      {children}
    </button>
  ),
);
Button.displayName = "Button";

export { buttonVariants };
