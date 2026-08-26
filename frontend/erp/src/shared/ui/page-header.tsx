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
    // data-page-header: inside a printed document the masthead already states
    // the title (and the period and basis besides), so this block would print
    // the same name a second time — and LARGER than the masthead. The print
    // stylesheet drops it; on screen nothing changes.
    <div
      data-page-header="true"
      className="mb-6 flex min-w-0 flex-col gap-4 lg:flex-row lg:items-end lg:justify-between"
    >
      <div className="min-w-0">
        {eyebrow && <div className="mb-1.5 text-xs font-semibold tracking-wide text-teal-700">{eyebrow}</div>}
        <h1 className="break-words text-2xl font-bold leading-tight tracking-tight text-slate-950 sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-2 max-w-4xl text-[15px] font-normal leading-7 text-slate-600">{subtitle}</p>}
      </div>
      {action && (
        <div
          className="grid w-full min-w-0 grid-cols-1 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center sm:justify-end [&>*]:min-w-0 [&>a]:w-full [&>button]:w-full sm:[&>a]:w-auto sm:[&>button]:w-auto"
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
    <div className="flex flex-col items-stretch justify-between gap-3 border-b border-slate-100 px-4 py-4 sm:flex-row sm:items-start sm:px-5">
      <div className="flex min-w-0 items-start gap-3">
        {Icon && (
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-600">
            <Icon className="h-5 w-5" />
          </span>
        )}
        <div className="min-w-0">
          <h2 className="break-words text-lg font-bold leading-6 text-slate-900">{title}</h2>
          {subtitle && <p className="mt-1 text-sm font-normal leading-6 text-slate-600">{subtitle}</p>}
        </div>
      </div>
      {action && (
        <div className="grid w-full grid-cols-1 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center [&>a]:w-full [&>button]:w-full sm:[&>a]:w-auto sm:[&>button]:w-auto">
          {action}
        </div>
      )}
    </div>
  );
}
