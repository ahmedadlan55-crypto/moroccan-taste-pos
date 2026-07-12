// Domain formatting adapters for the O2C screens. These are NOT UI atoms — they
// are thin wrappers that COMPOSE the shared kit (@/shared/lib formatters +
// @/shared/ui <StatusBadge>) into the LTR/tabular numeric + status conventions the
// O2C tables and detail panels use everywhere. All amounts render via the shared
// formatCurrency (English digits + "ر.س"), wrapped LTR tabular for clean alignment
// inside RTL text. No colors/hex live here — status colour comes from StatusBadge.
import type { ReactNode } from "react";
import { formatCurrency, formatNumber, formatDate } from "@/shared/lib";
import { StatusBadge, type StatusTone } from "@/shared/ui";
import { statusMeta, type Tone } from "./status-labels";
import { cn } from "@/shared/lib";

// Map the O2C status tone vocabulary onto the shared StatusBadge semantic tones.
const TONE_TO_STATUS: Record<Tone, StatusTone> = {
  slate: "neutral",
  teal: "info",
  amber: "warning",
  blue: "info",
  green: "success",
  rose: "danger",
  violet: "purple",
};

/** Status pill — resolves the Arabic label + tone from the status string and
 *  renders the shared <StatusBadge> (dot + text, never colour-only). */
export function SalesStatus({ status }: { status: string | null | undefined }) {
  const m = statusMeta(status);
  return <StatusBadge tone={TONE_TO_STATUS[m.tone]}>{m.label}</StatusBadge>;
}

/** Money cell — English digits, LTR, tabular; Arabic currency label. */
export function Money({ value, className }: { value: number | null | undefined; className?: string }) {
  return <span dir="ltr" className={cn("tabular-nums", className)}>{formatCurrency(value)}</span>;
}

/** Plain number — English digits, LTR, tabular. */
export function Num({ value, className }: { value: number | null | undefined; className?: string }) {
  return <span dir="ltr" className={cn("tabular-nums", className)}>{formatNumber(value)}</span>;
}

/** Date cell — Arabic month names, Latin digits, LTR tabular. */
export function DateCell({ value }: { value: string | null | undefined }) {
  return <span dir="ltr" className="tabular-nums">{formatDate(value)}</span>;
}

/** Small labelled fact box used across the O2C detail panels. */
export function Info({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
      <div className="text-[11px] font-bold text-slate-400">{label}</div>
      <div className="mt-0.5 text-sm font-extrabold text-slate-800">{value}</div>
    </div>
  );
}
