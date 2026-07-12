import type { ReactNode } from "react";

export interface PageHeaderProps {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  action?: ReactNode;
}

/** The one page title block: eyebrow + H1 + subtitle + right-aligned actions. */
export function PageHeader({ eyebrow, title, subtitle, action }: PageHeaderProps) {
  return (
    <div className="mb-6 flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 text-xs font-extrabold tracking-wide text-teal-700">{eyebrow}</div>}
        <h1 className="text-2xl font-extrabold tracking-tight text-slate-950 sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-2 max-w-3xl text-sm font-medium leading-6 text-slate-500">{subtitle}</p>}
      </div>
      {action && <div className="flex flex-col gap-2 sm:flex-row sm:items-center">{action}</div>}
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
          <h2 className="text-base font-extrabold text-slate-900">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs font-medium text-slate-500">{subtitle}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}
