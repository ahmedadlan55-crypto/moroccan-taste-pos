import type { LucideIcon } from "lucide-react";
import { TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "@/lib/cn";

export type MetricTone = "teal" | "blue" | "amber" | "rose" | "violet";

const TONES: Record<MetricTone, string> = {
  teal: "bg-teal-50 text-teal-700",
  blue: "bg-sky-50 text-sky-700",
  amber: "bg-amber-50 text-amber-700",
  rose: "bg-rose-50 text-rose-700",
  violet: "bg-violet-50 text-violet-700",
};

export interface MetricCardProps {
  label: string;
  value: string;
  note?: string;
  delta?: string;
  icon: LucideIcon;
  tone?: MetricTone;
  onClick?: () => void;
}

export function MetricCard({ label, value, note, delta, icon: Icon, tone = "teal", onClick }: MetricCardProps) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className={cn("grid h-11 w-11 place-items-center rounded-xl", TONES[tone])}>
          <Icon className="h-5 w-5" />
        </div>
        {delta && (
          <span
            className={cn(
              "flex items-center gap-1 text-xs font-extrabold",
              delta.startsWith("-") ? "text-rose-600" : "text-emerald-600",
            )}
          >
            {delta.startsWith("-") ? <TrendingDown className="h-3.5 w-3.5" /> : <TrendingUp className="h-3.5 w-3.5" />}
            {delta}
          </span>
        )}
      </div>
      <div className="mt-5">
        <div className="text-xs font-bold text-slate-500">{label}</div>
        <div className="mt-1 text-2xl font-extrabold tracking-tight text-slate-950 tabular-nums">{value}</div>
        {note && <div className="mt-1 text-xs font-medium text-slate-400">{note}</div>}
      </div>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="surface w-full p-4 text-right transition hover:-translate-y-1 hover:border-teal-200 hover:shadow-lift"
      >
        {body}
      </button>
    );
  }
  return <article className="surface p-4">{body}</article>;
}
