import { cn } from "@/shared/lib";

// Status badges never rely on color alone (WCAG 1.4.1): each carries a dot + the
// Arabic label text. The tone map covers the canonical workflow statuses across
// inventory, sales, accounting and workflow domains.
const TONE: Record<string, string> = {
  // healthy / done
  "متوفر": "border-emerald-200 bg-emerald-50 text-emerald-700",
  "جيد": "border-emerald-200 bg-emerald-50 text-emerald-700",
  "مستلم": "border-emerald-200 bg-emerald-50 text-emerald-700",
  "معتمد": "border-emerald-200 bg-emerald-50 text-emerald-700",
  "مدفوع": "border-emerald-200 bg-emerald-50 text-emerald-700",
  "مُرحّل": "border-emerald-200 bg-emerald-50 text-emerald-700",
  "نشط": "border-emerald-200 bg-emerald-50 text-emerald-700",
  "آمن": "border-emerald-200 bg-emerald-50 text-emerald-700",
  // warning / pending
  "منخفض": "border-amber-200 bg-amber-50 text-amber-700",
  "مراقبة": "border-amber-200 bg-amber-50 text-amber-700",
  "بانتظار الاعتماد": "border-amber-200 bg-amber-50 text-amber-700",
  "قيد المراجعة": "border-amber-200 bg-amber-50 text-amber-700",
  "مطابقة مطلوبة": "border-amber-200 bg-amber-50 text-amber-700",
  "مستحق": "border-amber-200 bg-amber-50 text-amber-700",
  "مُرسل": "border-amber-200 bg-amber-50 text-amber-700",
  "محجور": "border-amber-200 bg-amber-50 text-amber-700",
  "تحذير": "border-amber-200 bg-amber-50 text-amber-700",
  // in-flight
  "في الطريق": "border-sky-200 bg-sky-50 text-sky-700",
  "قيد النقل": "border-sky-200 bg-sky-50 text-sky-700",
  "قيد العد": "border-sky-200 bg-sky-50 text-sky-700",
  "قيد التنفيذ": "border-sky-200 bg-sky-50 text-sky-700",
  "استلام جزئي": "border-violet-200 bg-violet-50 text-violet-700",
  // danger / terminal
  "نافد": "border-rose-200 bg-rose-50 text-rose-700",
  "سالب": "border-rose-200 bg-rose-50 text-rose-700",
  "حرج": "border-rose-200 bg-rose-50 text-rose-700",
  "معكوس": "border-rose-200 bg-rose-50 text-rose-700",
  "مُستدعى": "border-rose-200 bg-rose-50 text-rose-700",
  "منتهي": "border-rose-200 bg-rose-50 text-rose-700",
  "متأخر": "border-rose-200 bg-rose-50 text-rose-700",
  "مرفوض": "border-rose-200 bg-rose-50 text-rose-700",
  // neutral / inactive
  "ملغى": "border-slate-200 bg-slate-100 text-slate-500",
  "معطّل": "border-slate-200 bg-slate-100 text-slate-500",
  "مغلق": "border-slate-200 bg-slate-100 text-slate-500",
  "بلا صلاحية": "border-slate-200 bg-slate-50 text-slate-600",
  "مسودة": "border-slate-200 bg-slate-50 text-slate-600",
};

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
  const cls = tone ? EXPLICIT_TONE[tone] : (TONE[children] ?? EXPLICIT_TONE.neutral);
  return (
    <span className={cn("chip", cls)}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />}
      {children}
    </span>
  );
}
