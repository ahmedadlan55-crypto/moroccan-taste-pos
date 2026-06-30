import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

// shadcn-style button. Variants map to the prototype's button language; every
// variant keeps a 44px min touch target, hover/active/disabled + focus-visible.
const buttonVariants = cva(
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100",
  {
    variants: {
      variant: {
        primary:
          "bg-teal-600 px-4 py-2 text-white shadow-sm hover:-translate-y-0.5 hover:bg-teal-700 hover:shadow-md active:translate-y-0",
        secondary:
          "border border-slate-200 bg-white px-4 py-2 text-slate-700 hover:border-slate-300 hover:bg-slate-50 active:bg-slate-100",
        ghost: "px-3 py-2 text-slate-600 hover:bg-slate-100 hover:text-slate-900 active:bg-slate-200",
        danger:
          "bg-rose-600 px-4 py-2 text-white shadow-sm hover:bg-rose-700 active:translate-y-0",
      },
      size: {
        md: "",
        sm: "min-h-9 px-3 py-1.5 text-xs",
        icon: "h-11 w-11 px-0",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = "button", ...props }, ref) => (
    <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = "Button";

export { buttonVariants };
