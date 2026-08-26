import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { useTx } from "@/shared/ui/i18n";

// Compact title block for a workflow screen: every routed page owns one visible
// H1, while the shell topbar remains navigation context only.
export function ScreenIntro({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
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
        <h1 className="mt-0.5 break-words text-2xl font-bold leading-tight tracking-tight text-slate-950 sm:text-3xl">
          {title}
        </h1>
        <p className="mt-0.5 text-sm font-medium text-slate-500">{description}</p>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </header>
  );
}
