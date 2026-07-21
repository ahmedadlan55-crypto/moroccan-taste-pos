import { cn } from "@/shared/lib";
import { status as arStatus } from "@/i18n/dictionaries/ar/status";
import { useTx } from "./i18n";

// Status badges never rely on color alone (WCAG 1.4.1): each carries a dot + a
// label. The label + its tone are keyed by a STABLE status CODE (the English enum
// value) in the "status" i18n namespace; the badge renders t("status."+code) so
// record-status display is localized across every module at once.
//
// ~200 module call-sites still pass the LEGACY Arabic label as children (from
// their own status maps). To translate them WITHOUT touching those call-sites we
// bridge here: AR_LABEL_TO_CODE (derived from the Arabic dictionary, so there is
// ONE source of truth) maps a legacy Arabic label back to its code, then we
// render t("status."+code). Children that aren't a known status (custom text,
// business data like "A4") pass through verbatim with the neutral tone.

// Tailwind classes per status code — the canonical workflow statuses across
// inventory, sales, accounting and workflow domains. (No raw hex → tokens:check.)
const CODE_TONE: Record<string, string> = {
  // healthy / done
  available: "border-emerald-200 bg-emerald-50 text-emerald-700",
  good: "border-emerald-200 bg-emerald-50 text-emerald-700",
  received: "border-emerald-200 bg-emerald-50 text-emerald-700",
  approved: "border-emerald-200 bg-emerald-50 text-emerald-700",
  paid: "border-emerald-200 bg-emerald-50 text-emerald-700",
  posted: "border-emerald-200 bg-emerald-50 text-emerald-700",
  active: "border-emerald-200 bg-emerald-50 text-emerald-700",
  safe: "border-emerald-200 bg-emerald-50 text-emerald-700",
  // warning / pending
  low: "border-amber-200 bg-amber-50 text-amber-700",
  monitor: "border-amber-200 bg-amber-50 text-amber-700",
  pendingApproval: "border-amber-200 bg-amber-50 text-amber-700",
  underReview: "border-amber-200 bg-amber-50 text-amber-700",
  matchRequired: "border-amber-200 bg-amber-50 text-amber-700",
  due: "border-amber-200 bg-amber-50 text-amber-700",
  sent: "border-amber-200 bg-amber-50 text-amber-700",
  quarantined: "border-amber-200 bg-amber-50 text-amber-700",
  warning: "border-amber-200 bg-amber-50 text-amber-700",
  // in-flight
  inTransit: "border-sky-200 bg-sky-50 text-sky-700",
  transferring: "border-sky-200 bg-sky-50 text-sky-700",
  counting: "border-sky-200 bg-sky-50 text-sky-700",
  inProgress: "border-sky-200 bg-sky-50 text-sky-700",
  partiallyReceived: "border-violet-200 bg-violet-50 text-violet-700",
  // danger / terminal
  outOfStock: "border-rose-200 bg-rose-50 text-rose-700",
  negative: "border-rose-200 bg-rose-50 text-rose-700",
  critical: "border-rose-200 bg-rose-50 text-rose-700",
  reversed: "border-rose-200 bg-rose-50 text-rose-700",
  recalled: "border-rose-200 bg-rose-50 text-rose-700",
  expired: "border-rose-200 bg-rose-50 text-rose-700",
  overdue: "border-rose-200 bg-rose-50 text-rose-700",
  rejected: "border-rose-200 bg-rose-50 text-rose-700",
  // neutral / inactive
  cancelled: "border-slate-200 bg-slate-100 text-slate-500",
  disabled: "border-slate-200 bg-slate-100 text-slate-500",
  closed: "border-slate-200 bg-slate-100 text-slate-500",
  noPermission: "border-slate-200 bg-slate-50 text-slate-600",
  draft: "border-slate-200 bg-slate-50 text-slate-600",
};

// Legacy Arabic label → status code, derived from the Arabic dictionary so the
// canonical labels live in exactly one place (i18n/dictionaries/ar/status.ts).
const AR_LABEL_TO_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(arStatus).map(([code, label]) => [label, code]),
);

export type StatusTone = "neutral" | "success" | "warning" | "info" | "danger" | "purple";

const EXPLICIT_TONE: Record<StatusTone, string> = {
  neutral: "border-slate-200 bg-slate-50 text-slate-700",
  success: "border-emerald-200 bg-emerald-50 text-emerald-700",
  warning: "border-amber-200 bg-amber-50 text-amber-700",
  info: "border-sky-200 bg-sky-50 text-sky-700",
  danger: "border-rose-200 bg-rose-50 text-rose-700",
  purple: "border-violet-200 bg-violet-50 text-violet-700",
};

export function StatusBadge({
  children,
  dot = true,
  tone,
}: {
  children: string;
  dot?: boolean;
  /** Override the label→tone lookup with an explicit semantic tone. */
  tone?: StatusTone;
}) {
  const t = useTx();
  // A known status code passed directly, or resolved from a legacy Arabic label.
  const code =
    typeof children === "string"
      ? (children in CODE_TONE ? children : AR_LABEL_TO_CODE[children])
      : undefined;
  const label = code ? t(`status.${code}`) : children;
  const cls = tone ? EXPLICIT_TONE[tone] : (code ? CODE_TONE[code] : undefined) ?? EXPLICIT_TONE.neutral;
  return (
    <span className={cn("chip", cls)}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />}
      {label}
    </span>
  );
}
