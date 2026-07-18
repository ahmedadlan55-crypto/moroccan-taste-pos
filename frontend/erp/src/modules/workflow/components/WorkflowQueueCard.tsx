import { AlertTriangle, Clock3, EyeOff, GitBranch, UserRound } from "lucide-react";
import { Badge, StatusBadge } from "@/shared/ui";
import { importanceMeta, statusMeta } from "../lib/labels";
import type { TxnListItem } from "../lib/types";

function dueLabel(value?: string | null) {
  if (!value) return "بلا موعد استحقاق";
  const due = new Date(value);
  if (Number.isNaN(due.getTime())) return "بلا موعد استحقاق";
  const days = Math.ceil((due.getTime() - Date.now()) / 86_400_000);
  if (days < 0) return `متأخرة ${Math.abs(days)} يوم`;
  if (days === 0) return "تستحق اليوم";
  if (days === 1) return "تستحق غدًا";
  return `متبقي ${days} أيام`;
}

export function WorkflowQueueCard({
  row,
  personLabel,
  person,
  onOpen,
}: {
  row: TxnListItem;
  personLabel: string;
  person: string;
  onOpen: () => void;
}) {
  const status = statusMeta(row.status);
  const importance = importanceMeta(row.importance);

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="w-full rounded-2xl border border-slate-200 bg-white p-4 text-right shadow-sm transition active:bg-slate-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"
      >
        <div className="flex items-start gap-3">
          <span
            className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${row.isRead === false ? "bg-teal-600" : "bg-slate-200"}`}
            aria-label={row.isRead === false ? "غير مقروءة" : "مقروءة"}
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span dir="ltr" className="text-xs font-bold tabular-nums text-slate-500">{row.txnNumber || "—"}</span>
              <span className="text-xs font-semibold text-slate-400">{row.typeName || "معاملة"}</span>
              {row.isRead === false && <EyeOff className="h-3.5 w-3.5 text-teal-600" aria-label="غير مقروءة" />}
            </div>
            <h3 className="mt-1 line-clamp-2 text-sm font-extrabold leading-6 text-slate-900">
              {row.subject || row.title || "بلا موضوع"}
            </h3>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
              <Badge tone={importance.tone}>{importance.label}</Badge>
              {row.isOverdue && (
                <Badge tone="danger"><AlertTriangle className="h-3 w-3" aria-hidden="true" /> متأخرة</Badge>
              )}
            </div>
          </div>
        </div>
        <div className="mt-3 flex min-w-0 items-center gap-3 overflow-hidden border-t border-slate-100 pt-3 text-xs font-semibold text-slate-500">
          <span className="inline-flex min-w-0 items-center gap-1" title={`${personLabel}: ${person || "—"}`}>
            <UserRound className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="max-w-24 truncate">{person || "—"}</span>
          </span>
          <span className="inline-flex min-w-0 items-center gap-1" title={`الخطوة الحالية: ${row.currentStepName || "—"}`}>
            <GitBranch className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="max-w-28 truncate">{row.currentStepName || "—"}</span>
          </span>
          <span className={row.isOverdue ? "me-auto inline-flex shrink-0 items-center gap-1 font-bold text-rose-700" : "me-auto inline-flex shrink-0 items-center gap-1"}>
            <Clock3 className="h-3.5 w-3.5" aria-hidden="true" /> {dueLabel(row.dueDate)}
          </span>
        </div>
      </button>
    </li>
  );
}
