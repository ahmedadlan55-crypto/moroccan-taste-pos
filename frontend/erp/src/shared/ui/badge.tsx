import type { HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/shared/lib";

// Small inline label chip (counts, tags, categories). Distinct from StatusBadge,
// which maps workflow-status strings → tones; Badge is a generic colored pill.
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-extrabold leading-none",
  {
    variants: {
      tone: {
        neutral: "border-slate-200 bg-slate-50 text-slate-600",
        teal: "border-teal-200 bg-teal-50 text-teal-700",
        success: "border-emerald-200 bg-emerald-50 text-emerald-700",
        warning: "border-amber-200 bg-amber-50 text-amber-700",
        info: "border-sky-200 bg-sky-50 text-sky-700",
        danger: "border-rose-200 bg-rose-50 text-rose-700",
        purple: "border-violet-200 bg-violet-50 text-violet-700",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export { badgeVariants };
