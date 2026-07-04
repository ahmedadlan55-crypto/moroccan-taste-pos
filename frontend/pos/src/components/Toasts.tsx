import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { usePos } from "@/state/store";
import { cn } from "./ui";

const STYLES = {
  success: "border-teal-200 bg-teal-50 text-teal-800",
  error: "border-red-200 bg-red-50 text-red-800",
  info: "border-slate-200 bg-white text-slate-700",
} as const;

const ICONS = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
} as const;

export function Toasts() {
  const { toasts, dismissToast } = usePos();
  if (!toasts.length) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[70] flex flex-col items-center gap-2 px-4" aria-live="polite">
      {toasts.map((t) => {
        const Icon = ICONS[t.kind];
        return (
          <div
            key={t.id}
            className={cn(
              "toast-in pointer-events-auto flex w-full max-w-md items-center gap-2.5 rounded-2xl border px-4 py-3 shadow-lift",
              STYLES[t.kind],
            )}
            role="status"
          >
            <Icon className="h-5 w-5 shrink-0" aria-hidden />
            <p className="flex-1 text-sm font-bold leading-snug">{t.message}</p>
            <button
              type="button"
              onClick={() => dismissToast(t.id)}
              aria-label="إغلاق التنبيه"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg opacity-60 hover:bg-black/5 hover:opacity-100"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}
