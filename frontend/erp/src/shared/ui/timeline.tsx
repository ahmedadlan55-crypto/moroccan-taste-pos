import type { ReactNode } from "react";
import { Check, Circle, Clock, Dot, X } from "lucide-react";
import { cn } from "@/shared/lib";
import { formatDateTime } from "@/shared/lib";
import { useTx } from "./i18n";

export interface AuditEntry {
  id: string | number;
  actor: string;
  action: string;
  at: string; // ISO timestamp
  detail?: ReactNode;
}

/**
 * Vertical audit trail — who did what, when. Numbers/dates render via the shared
 * formatters (Arabic labels, Latin digits). Ordered list for a11y.
 */
export function AuditTimeline({ entries }: { entries: AuditEntry[] }) {
  const t = useTx();
  if (entries.length === 0) {
    return <p className="text-sm font-medium text-slate-400">{t("sharedUi.timeline.empty")}</p>;
  }
  return (
    <ol className="relative space-y-4 border-s border-slate-200 ps-4">
      {entries.map((e) => (
        <li key={e.id} className="relative">
          <span className="absolute -start-[calc(1rem+1px)] top-1 grid h-4 w-4 -translate-x-1/2 place-items-center rounded-full bg-teal-600 text-white rtl:translate-x-1/2">
            <Dot className="h-3 w-3" />
          </span>
          <div className="text-sm font-bold text-slate-800">{e.action}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs font-medium text-slate-500">
            <span>{e.actor}</span>
            <span aria-hidden="true">·</span>
            <span dir="ltr" className="tabular-nums">
              {formatDateTime(e.at)}
            </span>
          </div>
          {e.detail && <div className="mt-1 text-xs text-slate-500">{e.detail}</div>}
        </li>
      ))}
    </ol>
  );
}

export type WorkflowStepStatus = "done" | "current" | "pending" | "rejected";

export interface WorkflowStep {
  id: string | number;
  label: string;
  status: WorkflowStepStatus;
  by?: string;
  at?: string;
}

const STEP_STYLE: Record<WorkflowStepStatus, { ring: string; icon: ReactNode }> = {
  done: { ring: "bg-emerald-600 text-white", icon: <Check className="h-4 w-4" /> },
  current: { ring: "bg-teal-600 text-white", icon: <Clock className="h-4 w-4" /> },
  pending: { ring: "bg-slate-200 text-slate-500", icon: <Circle className="h-3 w-3" /> },
  rejected: { ring: "bg-rose-600 text-white", icon: <X className="h-4 w-4" /> },
};

/**
 * Approval-chain progress: a horizontal-on-wide / vertical-on-mobile stepper
 * showing where a document sits in its workflow (draft → approved → posted …).
 */
export function WorkflowTimeline({ steps }: { steps: WorkflowStep[] }) {
  return (
    <ol className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-0">
      {steps.map((s, i) => {
        const style = STEP_STYLE[s.status];
        const last = i === steps.length - 1;
        return (
          <li key={s.id} className="flex flex-1 items-start gap-3 sm:flex-col sm:items-center sm:text-center">
            <div className="flex items-center sm:w-full sm:flex-col">
              <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-full", style.ring)}>
                {style.icon}
              </span>
            </div>
            <div className="min-w-0 sm:mt-2">
              <div
                className={cn(
                  "text-sm font-bold",
                  s.status === "pending" ? "text-slate-400" : "text-slate-800",
                )}
              >
                {s.label}
              </div>
              {s.by && <div className="mt-0.5 text-[11px] font-medium text-slate-500">{s.by}</div>}
              {s.at && (
                <div dir="ltr" className="text-[11px] font-medium tabular-nums text-slate-400">
                  {formatDateTime(s.at)}
                </div>
              )}
            </div>
            {!last && <span className="hidden h-px flex-1 self-center bg-slate-200 sm:block" aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}
