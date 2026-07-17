import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  CornerUpLeft,
  FileText,
  GitBranch,
  History,
  Share2,
  XCircle,
} from "lucide-react";
import {
  AuditTimeline,
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  Drawer,
  DetailStat,
  ErrorState,
  LoadingState,
  Select,
  StatusBadge,
  WorkflowTimeline,
  safeUserMessage,
  useToast,
  type AuditEntry,
  type WorkflowStep,
  type WorkflowStepStatus,
} from "@/shared/ui";
import { ApiError } from "@/shared/api";
import { useCan } from "@/app/providers";
import { formatCurrency, formatDate } from "@/shared/lib";
import {
  fetchBundle,
  useRoutableUsers,
  useTxnAction,
  useTxnPermissions,
  type TxnActionKind,
} from "../lib/api";
import { qk } from "../lib/query-keys";
import { actionTypeLabel, importanceMeta, statusMeta } from "../lib/labels";
import type { TxnBundle, TxnLog, WorkflowPathStep } from "../lib/types";

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
  /**
   * Enable the real inbox action bar (اعتماد/رفض/إرجاع/إحالة) in the drawer
   * footer — passed only for صندوق الوارد. The buttons themselves are gated by
   * BOTH the `workflow.actions.act` capability AND the server permission flags,
   * so this is just the "this box can act" switch (outbox / طلباتي stay read-only).
   */
  canAct?: boolean;
}

export function TxnDetailDrawer({ txnId, open, onClose, username, canAct = false }: Props) {
  const query = useQuery({
    queryKey: qk.bundle(txnId ?? "", username),
    queryFn: ({ signal }) => fetchBundle(txnId as string, username, { signal }),
    enabled: open && !!txnId,
  });

  const bundle = query.data;
  const loaded = !!bundle && !bundle.error;

  // Server decides — per txn, per user — which actions are allowed. We only fetch
  // it when this box may act AND the drawer is open on a successfully-loaded txn.
  const permQuery = useTxnPermissions(txnId, username, canAct && open && loaded);
  const actAllowed = useCan("workflow.actions.act");
  // Live txn.* capability family (role_permissions) — the same keys the G-wf
  // stream's requireCapability guards enforce on POST /workflow/:id/action.
  // Forward has NO txn.* capability server-side, so it stays on actAllowed only.
  const capApprove = useCan("txn.approve");
  const capReject = useCan("txn.reject");
  const capReturn = useCan("txn.return");

  const perms = permQuery.data?.permissions;
  const version = permQuery.data?.currentVersion ?? 0;
  // A button shows ONLY when the capability AND the server flag both allow it.
  const canApprove = actAllowed && capApprove && !!perms?.canApprove;
  const canReject = actAllowed && capReject && !!perms?.canReject;
  const canReturn = actAllowed && capReturn && !!perms?.canReturn;
  const canForward = actAllowed && !!perms?.canForward;
  const anyAction = canApprove || canReject || canReturn || canForward;

  const title = bundle?.subject || bundle?.title || bundle?.txnNumber || "تفاصيل المعاملة";

  const footer =
    canAct && loaded && anyAction ? (
      <TxnActionBar
        txnId={txnId as string}
        username={username}
        version={version}
        can={{ approve: canApprove, reject: canReject, return: canReturn, forward: canForward }}
        onActed={onClose}
        refetchPerms={() => void permQuery.refetch()}
      />
    ) : undefined;

  return (
    <Drawer open={open} onClose={onClose} title={title} eyebrow="عرض المعاملة" icon={FileText} footer={footer}>
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

// ── Action bar ──────────────────────────────────────────────────────────────
// Rendered in the drawer footer. Approve = optional-note confirm. Reject/Return
// = ConfirmDialog with a MANDATORY reason (server needs ≥ 10 chars; we enforce it
// here too). Forward = pick a routable user + optional note. A stale version 409s
// → we toast + refetch the permissions (which carry the fresh version) and let the
// user retry.
type DialogKind = TxnActionKind | null;

const SUCCESS_MSG: Record<TxnActionKind, string> = {
  approve: "تم اعتماد المعاملة",
  reject: "تم رفض المعاملة",
  return: "تمت إعادة المعاملة للتعديل",
  forward: "تمت إحالة المعاملة",
};

function TxnActionBar({
  txnId,
  username,
  version,
  can,
  onActed,
  refetchPerms,
}: {
  txnId: string;
  username: string;
  version: number;
  can: { approve: boolean; reject: boolean; return: boolean; forward: boolean };
  onActed: () => void;
  refetchPerms: () => void;
}) {
  const { toast } = useToast();
  const action = useTxnAction();

  const [dialog, setDialog] = useState<DialogKind>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState(""); // approve/forward optional note
  const [forwardTo, setForwardTo] = useState("");

  const routable = useRoutableUsers(username, dialog === "forward");

  function close() {
    setDialog(null);
    setError(null);
    setNote("");
    setForwardTo("");
  }

  function openDialog(kind: TxnActionKind) {
    setError(null);
    setNote("");
    setForwardTo("");
    setDialog(kind);
  }

  function run(kind: TxnActionKind, payload: { note?: string; forwardTo?: string }) {
    setError(null);
    action.mutate(
      { id: txnId, action: kind, username, expectedVersion: version, ...payload },
      {
        onSuccess: (res) => {
          if (res && res.success === false) {
            setError(safeUserMessage(new Error(res.error || "تعذّر تنفيذ الإجراء")));
            return;
          }
          toast({ title: SUCCESS_MSG[kind], tone: "success" });
          close();
          onActed();
        },
        onError: (e) => {
          if (e instanceof ApiError && e.isConflict) {
            toast({ title: "تم تحديث المعاملة، أعد المحاولة", tone: "warning" });
            refetchPerms();
            close();
            return;
          }
          setError(safeUserMessage(e));
        },
      },
    );
  }

  // Reject/Return share the mandatory-reason ConfirmDialog. Enforce ≥ 10 here.
  function confirmReason(kind: "reject" | "return", reason: string) {
    if (reason.trim().length < 10) {
      setError("السبب مطلوب ولا يقل عن 10 أحرف.");
      return;
    }
    run(kind, { note: reason.trim() });
  }

  const groups = routable.data?.groups ?? [];

  return (
    <div className="flex w-full flex-wrap items-center gap-2">
      {can.approve && (
        <Button variant="primary" size="sm" onClick={() => openDialog("approve")}>
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> اعتماد
        </Button>
      )}
      {can.reject && (
        <Button variant="danger" size="sm" onClick={() => openDialog("reject")}>
          <XCircle className="h-4 w-4" aria-hidden="true" /> رفض
        </Button>
      )}
      {can.return && (
        <Button variant="secondary" size="sm" onClick={() => openDialog("return")}>
          <CornerUpLeft className="h-4 w-4" aria-hidden="true" /> إرجاع للتعديل
        </Button>
      )}
      {can.forward && (
        <Button variant="secondary" size="sm" onClick={() => openDialog("forward")}>
          <Share2 className="h-4 w-4" aria-hidden="true" /> إحالة
        </Button>
      )}

      {/* Approve — optional note */}
      <Dialog
        open={dialog === "approve"}
        onClose={close}
        title="اعتماد المعاملة"
        description="سيتم تمرير المعاملة للخطوة التالية في المسار."
        dismissable={!action.isPending}
        footer={
          <>
            <Button variant="secondary" onClick={close} disabled={action.isPending}>
              إلغاء
            </Button>
            <Button variant="primary" loading={action.isPending} onClick={() => run("approve", { note: note.trim() || undefined })}>
              اعتماد
            </Button>
          </>
        }
      >
        <label className="block">
          <span className="text-xs font-bold text-slate-600">ملاحظة (اختياري)</span>
          <textarea
            className="field mt-1 min-h-20 w-full resize-y py-2"
            placeholder="أضف ملاحظة على الاعتماد…"
            value={note}
            disabled={action.isPending}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        {error && (
          <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
            {error}
          </div>
        )}
      </Dialog>

      {/* Reject — mandatory reason ≥ 10 */}
      <ConfirmDialog
        open={dialog === "reject"}
        title="رفض المعاملة"
        description="سيتم إنهاء المعاملة كمرفوضة وإشعار المُرسِل. اذكر سبب الرفض."
        tone="danger"
        confirmLabel="تأكيد الرفض"
        requireReason
        reasonLabel="سبب الرفض"
        reasonPlaceholder="اكتب سبب الرفض (10 أحرف على الأقل)…"
        processing={action.isPending}
        error={error}
        onConfirm={(reason) => confirmReason("reject", reason)}
        onClose={close}
      />

      {/* Return — mandatory reason ≥ 10 */}
      <ConfirmDialog
        open={dialog === "return"}
        title="إرجاع المعاملة للتعديل"
        description="ستعود المعاملة إلى المُرسِل لتعديلها. اذكر سبب الإرجاع."
        tone="primary"
        confirmLabel="إرجاع للتعديل"
        requireReason
        reasonLabel="سبب الإرجاع"
        reasonPlaceholder="اكتب سبب الإرجاع (10 أحرف على الأقل)…"
        processing={action.isPending}
        error={error}
        onConfirm={(reason) => confirmReason("return", reason)}
        onClose={close}
      />

      {/* Forward — pick a target user + optional note */}
      <Dialog
        open={dialog === "forward"}
        onClose={close}
        title="إحالة المعاملة"
        description="اختر المستخدم الذي ستُحال إليه المعاملة."
        dismissable={!action.isPending}
        footer={
          <>
            <Button variant="secondary" onClick={close} disabled={action.isPending}>
              إلغاء
            </Button>
            <Button
              variant="primary"
              loading={action.isPending}
              disabled={!forwardTo}
              onClick={() => run("forward", { forwardTo, note: note.trim() || undefined })}
            >
              إحالة
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <label className="block">
            <span className="text-xs font-bold text-slate-600">
              المستخدم <span className="text-rose-600">*</span>
            </span>
            <Select
              className="mt-1"
              value={forwardTo}
              disabled={action.isPending || routable.isLoading}
              invalid={!forwardTo && !!error}
              onChange={(e) => setForwardTo(e.target.value)}
            >
              <option value="">
                {routable.isLoading ? "جارٍ تحميل المستخدمين…" : "— اختر مستخدمًا —"}
              </option>
              {groups.map((g) => (
                <optgroup key={g.key} label={g.label}>
                  {g.users.map((u) => (
                    <option key={u.username} value={u.username}>
                      {u.fullName || u.username}
                      {u.position ? ` — ${u.position}` : ""}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </label>
          <label className="block">
            <span className="text-xs font-bold text-slate-600">ملاحظة (اختياري)</span>
            <textarea
              className="field mt-1 min-h-20 w-full resize-y py-2"
              placeholder="أضف ملاحظة للإحالة…"
              value={note}
              disabled={action.isPending}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          {error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
              {error}
            </div>
          )}
        </div>
      </Dialog>
    </div>
  );
}
