import { cn } from "@/lib/cn";

// Status badges never rely on color alone (WCAG 1.4.1): each carries a dot +
// the Arabic label text. The tone map covers the canonical workflow statuses.
const TONE: Record<string, string> = {
  // healthy / done
  "متوفر": "border-emerald-200 bg-emerald-50 text-emerald-700",
  "جيد": "border-emerald-200 bg-emerald-50 text-emerald-700",
  "مستلم": "border-emerald-200 bg-emerald-50 text-emerald-700",
  "معتمد": "border-emerald-200 bg-emerald-50 text-emerald-700",
  // warning / pending
  "منخفض": "border-amber-200 bg-amber-50 text-amber-700",
  "مراقبة": "border-amber-200 bg-amber-50 text-amber-700",
  "بانتظار الاعتماد": "border-amber-200 bg-amber-50 text-amber-700",
  "مطابقة مطلوبة": "border-amber-200 bg-amber-50 text-amber-700",
  // in-flight
  "في الطريق": "border-sky-200 bg-sky-50 text-sky-700",
  "قيد النقل": "border-sky-200 bg-sky-50 text-sky-700",
  "قيد العد": "border-sky-200 bg-sky-50 text-sky-700",
  "استلام جزئي": "border-violet-200 bg-violet-50 text-violet-700",
  // transfer terminal states
  "ملغى": "border-slate-200 bg-slate-100 text-slate-500",
  "معكوس": "border-rose-200 bg-rose-50 text-rose-700",
  "مُرسل": "border-amber-200 bg-amber-50 text-amber-700",
  // danger
  "نافد": "border-rose-200 bg-rose-50 text-rose-700",
  "سالب": "border-rose-200 bg-rose-50 text-rose-700",
  "حرج": "border-rose-200 bg-rose-50 text-rose-700",
  "معطّل": "border-slate-200 bg-slate-100 text-slate-500",
  "نشط": "border-emerald-200 bg-emerald-50 text-emerald-700",
  // neutral
  "مسودة": "border-slate-200 bg-slate-50 text-slate-600",
};

export function StatusBadge({ children, dot = true }: { children: string; dot?: boolean }) {
  return (
    <span className={cn("chip", TONE[children] ?? "border-slate-200 bg-slate-50 text-slate-700")}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />}
      {children}
    </span>
  );
}
