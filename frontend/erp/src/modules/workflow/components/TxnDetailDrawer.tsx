import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  Building2,
  CalendarClock,
  CornerUpLeft,
  FileText,
  GitBranch,
  History,
  MessageCircle,
  MoreHorizontal,
  Paperclip,
  ShieldCheck,
  Share2,
  XCircle,
} from "lucide-react";
import {
  AuditTimeline,
  AttachmentViewer,
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  DropdownMenu,
  Drawer,
  DetailStat,
  ErrorState,
  LoadingState,
  Select,
  StatusBadge,
  Tabs,
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
  useMarkTxnRead,
  useRoutableUsers,
  useTxnAction,
  useTxnPermissions,
  type TxnActionKind,
} from "../lib/api";
import { qk } from "../lib/query-keys";
import { actionTypeLabel, importanceMeta, statusMeta } from "../lib/labels";
import type { TxnBundle, TxnLog, WorkflowPathStep } from "../lib/types";

type DetailTab = "summary" | "content" | "attachments" | "conversation" | "path" | "audit";

function htmlToText(html?: string) {
  if (!html) return "";
  if (typeof DOMParser !== "undefined") {
    return new DOMParser().parseFromString(html, "text/html").body.textContent?.trim() ?? "";
  }
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function safeAttachmentUrl(url?: string) {
  if (!url) return undefined;
  if (/^data:(?:application\/pdf|image\/(?:png|jpe?g|webp|gif));base64,/i.test(url)) return url;
  if (/^(?:https:\/\/|\/api\/)/i.test(url)) return url;
  return undefined;
}

function secrecyLabel(value?: string) {
  const labels: Record<string, string> = {
    normal: "عادي",
    confidential: "سري",
    secret: "سري جدًا",
    top_secret: "عالي السرية",
  };
  return labels[String(value || "normal")] || String(value || "عادي");
}

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
  const [tab, setTab] = useState<DetailTab>("summary");
  const query = useQuery({
    queryKey: qk.bundle(txnId ?? "", username),
    queryFn: ({ signal }) => fetchBundle(txnId as string, username, { signal }),
    enabled: open && !!txnId,
  });

  const bundle = query.data;
  const loaded = !!bundle && !bundle.error;
  const markRead = useMarkTxnRead();

  useEffect(() => {
    setTab("summary");
  }, [txnId]);

  useEffect(() => {
    if (!open || !txnId || !loaded || bundle?.isRead !== false || markRead.isPending) return;
    markRead.mutate(txnId);
    // `txnId` and the bundle's read flag make this idempotent; mutation state is
    // deliberately not a dependency so invalidation cannot create a request loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, txnId, loaded, bundle?.isRead]);

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
  const contentText = useMemo(() => htmlToText(bundle?.contentHtml), [bundle?.contentHtml]);
  const detailTabs = useMemo(() => [
    { value: "summary", label: "الملخص" },
    { value: "content", label: "المحتوى" },
    { value: "attachments", label: `المرفقات (${bundle?.attachments?.length ?? 0})` },
    { value: "conversation", label: `المحادثة (${bundle?.replies?.length ?? 0})` },
    { value: "path", label: "المسار" },
    { value: "audit", label: "السجل" },
  ], [bundle?.attachments?.length, bundle?.replies?.length]);

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
    <Drawer open={open} onClose={onClose} title={title} eyebrow="عرض المعاملة" icon={FileText} footer={footer} size="xl">
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
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-3">
            <StatusBadge tone={statusMeta(bundle.status).tone}>{statusMeta(bundle.status).label}</StatusBadge>
            <Badge tone={importanceMeta(bundle.importance).tone}>{importanceMeta(bundle.importance).label}</Badge>
            {bundle.isOverdue && <Badge tone="danger">متأخرة عن SLA</Badge>}
            <span className="me-auto inline-flex items-center gap-1 text-xs font-bold text-slate-500">
              <CalendarClock className="h-4 w-4" aria-hidden="true" />
              {bundle.dueDate ? `الاستحقاق ${formatDate(bundle.dueDate)}` : "لا يوجد موعد استحقاق"}
            </span>
          </div>

          <Tabs
            items={detailTabs}
            value={tab}
            onChange={(value) => setTab(value as DetailTab)}
            aria-label="أقسام تفاصيل المعاملة"
          />

          {tab === "summary" && (
            <div className="space-y-5" role="tabpanel">
              <div className="grid grid-cols-2 gap-3">
                <DetailStat label="رقم المعاملة" value={<span dir="ltr" className="tabular-nums">{bundle.txnNumber || "—"}</span>} />
                <DetailStat label="النوع" value={bundle.typeName || "—"} />
                <DetailStat label="المُرسِل" value={bundle.createdByName || bundle.creatorName || bundle.createdBy || "—"} />
                <DetailStat label="لدى الآن" value={bundle.currentAssigneeName || bundle.assigneeName || bundle.currentAssignee || "—"} />
                <DetailStat label="الخطوة الحالية" value={bundle.currentStepName || "—"} />
                <DetailStat label="الفرع" value={bundle.createdByBranch || bundle.branchName || "—"} />
                <DetailStat label="تاريخ الإنشاء" value={<span dir="ltr" className="tabular-nums">{formatDate(bundle.createdAt)}</span>} />
                {typeof bundle.amount === "number" && bundle.amount > 0 && (
                  <DetailStat label="المبلغ" value={<span dir="ltr" className="tabular-nums">{formatCurrency(bundle.amount)}</span>} />
                )}
              </div>

              {(bundle.issuingEntityName || bundle.createdByPosition) && (
                <section className="rounded-2xl border border-slate-200 p-4">
                  <h3 className="flex items-center gap-2 text-sm font-extrabold text-slate-800">
                    <Building2 className="h-4 w-4 text-teal-600" aria-hidden="true" /> بيانات الإصدار
                  </h3>
                  <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                    <div><dt className="text-xs font-bold text-slate-400">جهة الإصدار</dt><dd className="mt-1 font-semibold text-slate-700">{bundle.issuingEntityName || "—"}</dd></div>
                    <div><dt className="text-xs font-bold text-slate-400">منصب المُرسِل</dt><dd className="mt-1 font-semibold text-slate-700">{bundle.createdByPosition || "—"}</dd></div>
                  </dl>
                </section>
              )}

              {bundle.recipients && bundle.recipients.length > 0 && (
                <section className="space-y-2">
                  <h3 className="text-sm font-extrabold text-slate-800">الجهات والمستلمون</h3>
                  <div className="flex flex-wrap gap-2">
                    {bundle.recipients.map((recipient) => (
                      <Badge key={recipient.id} tone={recipient.responseReceived ? "success" : "neutral"}>
                        {recipient.name || recipient.username || "—"}
                        {recipient.needsResponse ? (recipient.responseReceived ? " · تم الرد" : " · ينتظر الرد") : ""}
                      </Badge>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}

          {tab === "content" && (
            <section className="space-y-4" role="tabpanel">
              <div className="flex flex-wrap items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-teal-600" aria-hidden="true" />
                <span className="text-xs font-bold text-slate-500">سرية المحتوى</span>
                <Badge tone={bundle.contentSecrecy === "normal" ? "neutral" : "warning"}>{secrecyLabel(bundle.contentSecrecy)}</Badge>
              </div>
              {bundle.description && (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <h3 className="text-sm font-extrabold text-slate-800">الملخص التنفيذي</h3>
                  <p className="mt-2 whitespace-pre-wrap text-sm font-medium leading-7 text-slate-700">{bundle.description}</p>
                </div>
              )}
              <div className="rounded-2xl border border-slate-200 bg-white p-4">
                <h3 className="text-sm font-extrabold text-slate-800">نص المعاملة</h3>
                <p className="mt-3 whitespace-pre-wrap text-sm font-medium leading-8 text-slate-700">
                  {contentText || "لا يوجد محتوى نصي مسجل لهذه المعاملة."}
                </p>
              </div>
            </section>
          )}

          {tab === "attachments" && (
            <section className="space-y-4" role="tabpanel">
              <div className="flex flex-wrap items-center gap-2">
                <Paperclip className="h-4 w-4 text-teal-600" aria-hidden="true" />
                <span className="text-xs font-bold text-slate-500">سرية المرفقات</span>
                <Badge tone={bundle.attachmentsSecrecy === "normal" ? "neutral" : "warning"}>{secrecyLabel(bundle.attachmentsSecrecy)}</Badge>
              </div>
              <AttachmentViewer
                attachments={(bundle.attachments ?? []).map((attachment) => ({
                  id: attachment.id,
                  name: attachment.fileName || "مرفق",
                  url: safeAttachmentUrl(attachment.dataUrl),
                  contentType: attachment.mime,
                }))}
                emptyText="لا توجد مرفقات لهذه المعاملة."
              />
              {(bundle.attachments ?? []).map((attachment) => (
                <div key={`meta-${attachment.id}`} className="text-xs font-medium text-slate-400">
                  {attachment.fileName || "مرفق"} · رفعه {attachment.uploadedBy || "—"} · {formatDate(attachment.uploadedAt)}
                </div>
              ))}
            </section>
          )}

          {tab === "conversation" && (
            <section className="space-y-3" role="tabpanel">
              {(bundle.replies ?? []).length === 0 ? (
                <p className="rounded-2xl border border-dashed border-slate-200 p-6 text-center text-sm font-medium text-slate-400">لا توجد ردود أو مناقشات بعد.</p>
              ) : (bundle.replies ?? []).map((reply) => (
                <article key={reply.id} className="rounded-2xl border border-slate-200 p-4">
                  <div className="flex items-start gap-3">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-teal-50 text-teal-700"><MessageCircle className="h-4 w-4" aria-hidden="true" /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-sm font-extrabold text-slate-800">{reply.authorName || reply.authorUsername || "—"}</span>
                        {reply.authorPosition && <span className="text-xs font-medium text-slate-400">{reply.authorPosition}</span>}
                        <span dir="ltr" className="me-auto text-xs tabular-nums text-slate-400">{formatDate(reply.createdAt)}</span>
                      </div>
                      <p className="mt-2 whitespace-pre-wrap text-sm font-medium leading-7 text-slate-700">{reply.replyText || "—"}</p>
                      {safeAttachmentUrl(reply.attachment) && (
                        <a href={safeAttachmentUrl(reply.attachment)} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-teal-700 hover:underline">
                          <Paperclip className="h-3.5 w-3.5" aria-hidden="true" /> {reply.attachmentName || "فتح المرفق"}
                        </a>
                      )}
                    </div>
                  </div>
                </article>
              ))}
            </section>
          )}

          {tab === "path" && (
            <section className="space-y-3" role="tabpanel">
              <h3 className="flex items-center gap-2 text-sm font-extrabold text-slate-800">
                <GitBranch className="h-4 w-4 text-teal-600" aria-hidden="true" /> مسار الاعتماد
              </h3>
              {(bundle.workflowPath ?? []).length > 0
                ? <WorkflowTimeline steps={toWorkflowSteps(bundle)} />
                : <p className="text-sm font-medium text-slate-400">لا يوجد مسار اعتماد مسجل.</p>}
            </section>
          )}

          {tab === "audit" && (
            <section className="space-y-3" role="tabpanel">
              <h3 className="flex items-center gap-2 text-sm font-extrabold text-slate-800">
                <History className="h-4 w-4 text-teal-600" aria-hidden="true" /> سجل الإجراءات
              </h3>
              <AuditTimeline entries={toAuditEntries(bundle.logs ?? [])} />
            </section>
          )}
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
    <div className="flex w-full items-center gap-2">
      {can.approve && (
        <Button className="flex-1 sm:flex-none" variant="primary" size="sm" onClick={() => openDialog("approve")}>
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> اعتماد
        </Button>
      )}
      {can.reject && (
        <Button className="hidden sm:inline-flex" variant="danger" size="sm" onClick={() => openDialog("reject")}>
          <XCircle className="h-4 w-4" aria-hidden="true" /> رفض
        </Button>
      )}
      {can.return && (
        <Button className="hidden sm:inline-flex" variant="secondary" size="sm" onClick={() => openDialog("return")}>
          <CornerUpLeft className="h-4 w-4" aria-hidden="true" /> إرجاع للتعديل
        </Button>
      )}
      {can.forward && (
        <Button className="hidden sm:inline-flex" variant="secondary" size="sm" onClick={() => openDialog("forward")}>
          <Share2 className="h-4 w-4" aria-hidden="true" /> إحالة
        </Button>
      )}
      {(can.reject || can.return || can.forward) && (
        <DropdownMenu
          className="sm:hidden"
          aria-label="إجراءات أخرى"
          trigger={
            <span className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-700">
              <MoreHorizontal className="h-4 w-4" aria-hidden="true" /> المزيد
            </span>
          }
          items={[
            ...(can.return ? [{ key: "return", label: "إرجاع للتعديل", icon: <CornerUpLeft className="h-4 w-4" />, onSelect: () => openDialog("return" as const) }] : []),
            ...(can.forward ? [{ key: "forward", label: "إحالة", icon: <Share2 className="h-4 w-4" />, onSelect: () => openDialog("forward" as const) }] : []),
            ...(can.reject ? [{ key: "reject", label: "رفض", tone: "danger" as const, icon: <XCircle className="h-4 w-4" />, onSelect: () => openDialog("reject" as const) }] : []),
          ]}
        />
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
