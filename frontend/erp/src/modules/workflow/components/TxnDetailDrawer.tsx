import { useQuery } from "@tanstack/react-query";
import { FileText, GitBranch, History } from "lucide-react";
import {
  AuditTimeline,
  Badge,
  Drawer,
  DetailStat,
  ErrorState,
  LoadingState,
  StatusBadge,
  WorkflowTimeline,
  type AuditEntry,
  type WorkflowStep,
  type WorkflowStepStatus,
} from "@/shared/ui";
import { formatCurrency, formatDate } from "@/shared/lib";
import { fetchBundle } from "../lib/api";
import { qk } from "../lib/query-keys";
import { actionTypeLabel, importanceMeta, statusMeta } from "../lib/labels";
import type { TxnBundle, TxnLog, WorkflowPathStep } from "../lib/types";
import { LegacyActionNote } from "./LegacyActionNote";

function stepStatus(step: WorkflowPathStep, txnStatus: string): WorkflowStepStatus {
  if (step.isCurrent && String(txnStatus).toLowerCase() === "rejected") return "rejected";
  if (step.state === "current" || step.isCurrent) return "current";
  if (step.state === "done" || step.isPast) return "done";
  return "pending";
}

function toWorkflowSteps(bundle: TxnBundle): WorkflowStep[] {
  return (bundle.workflowPath ?? []).map((s) => ({
    id: s.id,
    label: s.stepName || s.positionName || "خطوة",
    status: stepStatus(s, bundle.status),
    by: s.positionName || undefined,
  }));
}

function toAuditEntries(logs: TxnLog[]): AuditEntry[] {
  return logs.map((l) => ({
    id: l.id,
    actor: l.actorFullName || l.actionBy || "—",
    action: l.stepName ? `${actionTypeLabel(l.actionType)} — ${l.stepName}` : actionTypeLabel(l.actionType),
    at: l.createdAt,
    detail: l.note || undefined,
  }));
}

interface Props {
  txnId: string | null;
  open: boolean;
  onClose: () => void;
  username: string;
  /** Show the "use the legacy system to act" escape hatch (صندوق الوارد only). */
  showLegacyAction?: boolean;
}

export function TxnDetailDrawer({ txnId, open, onClose, username, showLegacyAction = false }: Props) {
  const query = useQuery({
    queryKey: qk.bundle(txnId ?? "", username),
    queryFn: ({ signal }) => fetchBundle(txnId as string, username, { signal }),
    enabled: open && !!txnId,
  });

  const bundle = query.data;
  const title = bundle?.subject || bundle?.title || bundle?.txnNumber || "تفاصيل المعاملة";

  return (
    <Drawer open={open} onClose={onClose} title={title} eyebrow="عرض للقراءة فقط" icon={FileText}
      footer={showLegacyAction && bundle && !bundle.error ? <LegacyActionNote /> : undefined}>
      {query.isLoading ? (
        <LoadingState rows={6} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : !bundle || bundle.error ? (
        <ErrorState
          error={new Error(bundle?.error || "تعذّر تحميل المعاملة")}
          onRetry={() => query.refetch()}
        />
      ) : (
        <div className="space-y-6">
          {/* Summary */}
          <div className="grid grid-cols-2 gap-3">
            <DetailStat
              label="رقم المعاملة"
              value={<span dir="ltr" className="tabular-nums">{bundle.txnNumber || "—"}</span>}
            />
            <DetailStat label="النوع" value={bundle.typeName || "—"} />
            <DetailStat label="الحالة" value={<StatusBadge tone={statusMeta(bundle.status).tone}>{statusMeta(bundle.status).label}</StatusBadge>} />
            <DetailStat label="الأهمية" value={<Badge tone={importanceMeta(bundle.importance).tone}>{importanceMeta(bundle.importance).label}</Badge>} />
            <DetailStat label="المُرسِل" value={bundle.createdByName || bundle.creatorName || bundle.createdBy || "—"} />
            <DetailStat label="لدى" value={bundle.currentAssigneeName || bundle.assigneeName || bundle.currentAssignee || "—"} />
            <DetailStat
              label="التاريخ"
              value={<span dir="ltr" className="tabular-nums">{formatDate(bundle.createdAt)}</span>}
            />
            {typeof bundle.amount === "number" && bundle.amount > 0 && (
              <DetailStat
                label="المبلغ"
                value={<span dir="ltr" className="tabular-nums">{formatCurrency(bundle.amount)}</span>}
              />
            )}
          </div>

          {/* Description */}
          {bundle.description && (
            <section className="space-y-2">
              <h3 className="text-sm font-extrabold text-slate-800">التفاصيل</h3>
              <p className="whitespace-pre-wrap rounded-xl border border-slate-100 bg-slate-50 p-3 text-sm font-medium leading-6 text-slate-600">
                {bundle.description}
              </p>
            </section>
          )}

          {/* Recipients */}
          {bundle.recipients && bundle.recipients.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-sm font-extrabold text-slate-800">الجهات</h3>
              <div className="flex flex-wrap gap-2">
                {bundle.recipients.map((r) => (
                  <Badge key={r.id} tone={r.responseReceived ? "success" : "neutral"}>
                    {r.name || r.username || "—"}
                  </Badge>
                ))}
              </div>
            </section>
          )}

          {/* Approval path */}
          {bundle.workflowPath && bundle.workflowPath.length > 0 && (
            <section className="space-y-3">
              <h3 className="flex items-center gap-2 text-sm font-extrabold text-slate-800">
                <GitBranch className="h-4 w-4 text-teal-600" aria-hidden="true" /> مسار الاعتماد
              </h3>
              <WorkflowTimeline steps={toWorkflowSteps(bundle)} />
            </section>
          )}

          {/* Action log */}
          <section className="space-y-3">
            <h3 className="flex items-center gap-2 text-sm font-extrabold text-slate-800">
              <History className="h-4 w-4 text-teal-600" aria-hidden="true" /> سجل الإجراءات
            </h3>
            <AuditTimeline entries={toAuditEntries(bundle.logs ?? [])} />
          </section>
        </div>
      )}
    </Drawer>
  );
}
