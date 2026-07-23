import type { ReactNode } from "react";
import { useTx } from "./i18n";

export interface PageHeaderProps {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  action?: ReactNode;
}

/** The one page title block: eyebrow + H1 + subtitle + right-aligned actions. */
export function PageHeader({ eyebrow, title, subtitle, action }: PageHeaderProps) {
  const t = useTx();
  return (
    <div className="mb-7 flex min-w-0 flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1.5 text-xs font-semibold tracking-wide text-teal-700">{eyebrow}</div>}
        <h1 className="text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-2 max-w-4xl text-[15px] font-normal leading-7 text-slate-600">{subtitle}</p>}
      </div>
      {action && (
        <div
          className="grid w-full min-w-0 grid-cols-1 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center sm:justify-end [&>*]:min-w-0 [&>button]:w-full sm:[&>button]:w-auto"
          aria-label={t("sharedUi.pageHeader.actions")}
        >
          {action}
        </div>
      )}
    </div>
  );
}

export function PanelTitle({
  icon: Icon,
  title,
  subtitle,
  action,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
      <div className="flex items-start gap-3">
        {Icon && (
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-600">
            <Icon className="h-5 w-5" />
          </span>
        )}
        <div>
          <h2 className="text-lg font-bold text-slate-900">{title}</h2>
          {subtitle && <p className="mt-1 text-sm font-normal leading-6 text-slate-600">{subtitle}</p>}
        </div>
      </div>
      {action && (
        <div className="grid w-full grid-cols-1 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center [&>button]:w-full sm:[&>button]:w-auto">
          {action}
        </div>
      )}
    </div>
  );
}
