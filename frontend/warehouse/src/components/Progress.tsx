import { motion } from "framer-motion";
import { cn } from "@/lib/cn";

export type ProgressTone = "teal" | "amber" | "rose" | "blue";

const COLORS: Record<ProgressTone, string> = {
  teal: "bg-teal-500",
  amber: "bg-amber-500",
  rose: "bg-rose-500",
  blue: "bg-sky-500",
};

export function Progress({ value, tone = "teal" }: { value: number; tone?: ProgressTone }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div
      className="h-2 overflow-hidden rounded-full bg-slate-100"
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <motion.div
        initial={{ width: 0 }}
        animate={{ width: `${pct}%` }}
        className={cn("h-full rounded-full", COLORS[tone])}
      />
    </div>
  );
}
