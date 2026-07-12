import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/shared/lib";

// Square icon-only button. `aria-label` is REQUIRED for an accessible name
// (there is no text content) — enforced via the props type below.
const iconButtonVariants = cva(
  "inline-grid place-items-center rounded-xl transition disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100",
  {
    variants: {
      variant: {
        ghost: "text-slate-500 hover:bg-slate-100 hover:text-slate-900 active:bg-slate-200",
        secondary: "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
        danger: "text-slate-400 hover:bg-rose-50 hover:text-rose-600",
      },
      size: {
        md: "h-11 w-11",
        sm: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "ghost", size: "md" },
  },
);

export interface IconButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof iconButtonVariants> {
  "aria-label": string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, variant, size, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(iconButtonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
IconButton.displayName = "IconButton";

export { iconButtonVariants };
