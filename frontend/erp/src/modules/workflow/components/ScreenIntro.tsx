import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { useTx } from "@/shared/ui/i18n";

// Compact context strip for a workflow screen. The screen TITLE already lives
// once in the Topbar (from the manifest), so this never repeats it — it shows
// the group eyebrow + a one-line description + an optional right-side slot.
export function ScreenIntro({
  icon: Icon,
  description,
  action,
}: {
  icon: LucideIcon;
  description: string;
  action?: ReactNode;
}) {
  const t = useTx();
  return (
    <header className="flex items-start gap-3">
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-teal-50 text-teal-700">
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-extrabold tracking-wide text-teal-700">{t("workflow.eyebrow")}</div>
        <p className="mt-0.5 text-sm font-medium text-slate-500">{description}</p>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </header>
  );
}
