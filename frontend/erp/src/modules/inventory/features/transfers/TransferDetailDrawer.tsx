import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  Truck, ArrowLeftRight, Printer, CheckCircle2, Send, PackageCheck,
  Undo2, XCircle, Trash2, Pencil, Clock, FileText, Layers,
} from "lucide-react";
import { Drawer, DetailStat } from "@/shared/ui";
import { Button } from "@/shared/ui";
import { StatusBadge } from "@/shared/ui";
import { ConfirmDialog } from "@/shared/ui";
import { LoadingState, ErrorState } from "@/shared/ui";
import { useTransferDetail } from "@/modules/inventory/lib/hooks/useTransferDetail";
import {
  useApproveTransfer, useIssueTransfer, useReceiveTransfer,
  useCancelTransfer, useReverseTransfer, useDeleteDraft,
} from "@/modules/inventory/lib/hooks/useTransferMutations";
import { useCan } from "@/modules/inventory/lib/permission-provider";
import { formatCurrency, formatNumber, formatQty, formatDateTime } from "@/shared/lib";
import { useT } from "@/i18n";
import type { TFunction } from "@/i18n";
import { transferStatusToLabel } from "@/modules/inventory/lib/status-labels";
import type { TransferDetail, TransferLine } from "@/modules/inventory/lib/adapters/transfer.adapter";
import { ReceiveDialog } from "./ReceiveDialog";

const KNOWN_ACTIONS = new Set(["create", "approve", "issue", "receive", "reverse", "cancel", "delete"]);
const actionLabel = (t: TFunction, action: string) =>
  KNOWN_ACTIONS.has(action) ? t(`inventoryRest.transfers.detail.action.${action}`) : action;

type DialogKind = "approve" | "issue" | "cancel" | "reverse" | "delete" | null;

export function TransferDetailDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const { data, isLoading, isError, error, refetch } = useTransferDetail(id);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [receiveOpen, setReceiveOpen] = useState(false);

  const approve = useApproveTransfer();
  const issue = useIssueTransfer();
  const receive = useReceiveTransfer();
  const cancel = useCancelTransfer();
  const reverse = useReverseTransfer();
  const del = useDeleteDraft();

  const canApprove = useCan("transfer.approve");
  const canIssue = useCan("transfer.issue");
  const canReceive = useCan("transfer.receive");
  const canReverse = useCan("transfer.reverse");
  const canCreate = useCan("transfer.create");

  // Close any open dialog when the drawer switches to a different document.
  useEffect(() => { setDialog(null); setReceiveOpen(false); }, [id]);

  const title = data ? data.number : t("inventoryRest.transfers.detail.title");

  return (
    <>
      <Drawer
        open={!!id}
        onClose={onClose}
        title={title}
        eyebrow={t("inventoryRest.transfers.detail.eyebrow")}
        icon={Truck}
        footer={data ? <Footer
          d={data}
          can={{ canApprove, canIssue, canReceive, canReverse, canCreate }}
          onAction={setDialog}
          onReceive={() => setReceiveOpen(true)}
          onEdit={() => { onClose(); navigate(`/inventory/transfers?new=1&edit=${data.id}`); }}
        /> : undefined}
      >
        {isLoading ? (
          <LoadingState rows={2} />
        ) : isError ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : data ? (
          <Document d={data} />
        ) : null}
      </Drawer>

      {/* Confirmation dialogs for the simple lifecycle actions */}
      <ConfirmDialog
        open={dialog === "approve"}
        title={t("inventoryRest.transfers.detail.confirmApproveTitle")}
        description={t("inventoryRest.transfers.detail.confirmApproveBody")}
        confirmLabel={t("inventoryRest.transfers.detail.approve")}
        processing={approve.isPending}
        error={approve.error ? approve.error.message : null}
        onClose={() => setDialog(null)}
        onConfirm={() => data && approve.mutate({ id: data.id, expectedVersion: data.version }, { onSuccess: () => setDialog(null) })}
      />
      <ConfirmDialog
        open={dialog === "issue"}
        title={t("inventoryRest.transfers.detail.confirmIssueTitle")}
        description={t("inventoryRest.transfers.detail.confirmIssueBody")}
        confirmLabel={t("inventoryRest.transfers.detail.issue")}
        tone="danger"
        processing={issue.isPending}
        error={issue.error ? issue.error.message : null}
        onClose={() => setDialog(null)}
        onConfirm={() => data && issue.mutate({ id: data.id, expectedVersion: data.version }, { onSuccess: () => setDialog(null) })}
      />
      <ConfirmDialog
        open={dialog === "cancel"}
        title={t("inventoryRest.transfers.detail.confirmCancelTitle")}
        description={t("inventoryRest.transfers.detail.confirmCancelBody")}
        confirmLabel={t("inventoryRest.transfers.detail.confirmCancel")}
        tone="danger"
        requireReason
        reasonLabel={t("inventoryRest.transfers.detail.cancelReason")}
        processing={cancel.isPending}
        error={cancel.error ? cancel.error.message : null}
        onClose={() => setDialog(null)}
        onConfirm={(reason) => data && cancel.mutate({ id: data.id, input: { reason, expectedVersion: data.version } }, { onSuccess: () => setDialog(null) })}
      />
      <ConfirmDialog
        open={dialog === "reverse"}
        title={t("inventoryRest.transfers.detail.confirmReverseTitle")}
        description={t("inventoryRest.transfers.detail.confirmReverseBody")}
        confirmLabel={t("inventoryRest.transfers.detail.confirmReverse")}
        tone="danger"
        requireReason
        reasonLabel={t("inventoryRest.transfers.detail.reverseReasonLabel")}
        processing={reverse.isPending}
        error={reverse.error ? reverse.error.message : null}
        onClose={() => setDialog(null)}
        onConfirm={(reason) => data && reverse.mutate({ id: data.id, input: { reason, expectedVersion: data.version } }, { onSuccess: () => setDialog(null) })}
      />
      <ConfirmDialog
        open={dialog === "delete"}
        title={t("inventoryRest.transfers.detail.confirmDeleteTitle")}
        description={t("inventoryRest.transfers.detail.confirmDeleteBody")}
        confirmLabel={t("inventoryRest.transfers.detail.deleteBtn")}
        tone="danger"
        processing={del.isPending}
        error={del.error ? del.error.message : null}
        onClose={() => setDialog(null)}
        onConfirm={() => data && del.mutate({ id: data.id }, { onSuccess: () => { setDialog(null); onClose(); } })}
      />

      {/* Receive (partial/full) — its own dialog with per-line quantities */}
      {data && (
        <ReceiveDialog
          open={receiveOpen}
          lines={data.lines}
          processing={receive.isPending}
          error={receive.error ? receive.error.message : null}
          onClose={() => setReceiveOpen(false)}
          onConfirm={(items) =>
            receive.mutate(
              { id: data.id, input: { items, expectedVersion: data.version } },
              { onSuccess: () => setReceiveOpen(false) },
            )
          }
        />
      )}
    </>
  );
}

function Document({ d }: { d: TransferDetail }) {
  const t = useT();
  return (
    <div className="print-document space-y-5">
      {/* Status + route */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <StatusBadge>{transferStatusToLabel(d.status)}</StatusBadge>
          <span className="text-xs font-medium text-slate-400">{t("inventoryRest.ui.version")} {formatNumber(d.version)}</span>
        </div>
        <div className="text-sm font-bold text-slate-700">{formatCurrency(d.totalCost)}</div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <DetailStat label={t("inventoryRest.transfers.detail.from")} value={d.fromWarehouse.name} />
        <DetailStat label={t("inventoryRest.transfers.detail.to")} value={<span className="inline-flex items-center gap-1">{d.toWarehouse.name}<ArrowLeftRight className="h-3.5 w-3.5 text-slate-400" /></span>} />
        <DetailStat label={t("inventoryRest.transfers.detail.createdBy")} value={d.actors.createdBy || "—"} />
        <DetailStat label={t("inventoryRest.transfers.detail.approvedBy")} value={d.actors.approvedBy || "—"} />
        <DetailStat label={t("inventoryRest.transfers.detail.issuedBy")} value={d.actors.issuedBy || "—"} />
        <DetailStat label={t("inventoryRest.transfers.detail.receivedBy")} value={d.actors.receivedBy || "—"} />
      </div>

      {d.reverseReason && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
          {t("inventoryRest.transfers.detail.reverseReason", { reason: d.reverseReason })} {d.actors.reversedBy ? `· ${d.actors.reversedBy}` : ""}
        </div>
      )}

      {/* Lines */}
      <Section icon={Layers} title={t("inventoryRest.transfers.detail.linesTitle")}>
        <table className="w-full text-xs">
          <thead className="text-slate-400">
            <tr>
              <th className="py-1.5 text-right">{t("inventoryRest.transfers.detail.colItem")}</th>
              <th className="py-1.5 text-center">{t("inventoryRest.transfers.detail.colRequested")}</th>
              <th className="py-1.5 text-center">{t("inventoryRest.transfers.detail.colIssued")}</th>
              <th className="py-1.5 text-center">{t("inventoryRest.transfers.detail.colReceived")}</th>
              <th className="py-1.5 text-center">{t("inventoryRest.transfers.detail.colRemaining")}</th>
              <th className="py-1.5 text-left">{t("inventoryRest.transfers.detail.colCost")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {d.lines.map((l: TransferLine) => (
              <tr key={l.id}>
                <td className="py-2 font-bold text-slate-800">{l.item.name}</td>
                <td className="py-2 text-center tabular-nums">{formatQty(l.qtyRequested, l.item.unit)}</td>
                <td className="py-2 text-center tabular-nums">{formatQty(l.qtyIssued)}</td>
                <td className="py-2 text-center tabular-nums">{formatQty(l.qtyReceived)}</td>
                <td className="py-2 text-center tabular-nums font-bold text-violet-700">{formatQty(l.qtyRemaining)}</td>
                <td className="py-2 text-left tabular-nums text-slate-500">{formatCurrency(l.unitCost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* Timeline */}
      <Section icon={Clock} title={t("inventoryRest.transfers.detail.timelineTitle")}>
        {d.timeline.length === 0 ? (
          <p className="text-xs text-slate-400">{t("inventoryRest.transfers.detail.timelineEmpty")}</p>
        ) : (
          <ol className="space-y-2.5">
            {d.timeline.map((e, i) => (
              <li key={i} className="flex items-start gap-3">
                <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-teal-50 text-[10px] font-extrabold text-teal-700">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-bold text-slate-800">
                    {actionLabel(t, e.action)}
                    {e.actor ? <span className="font-medium text-slate-500"> · {e.actor}</span> : null}
                  </div>
                  <div className="text-[11px] text-slate-400">{formatDateTime(e.at)}{e.note ? ` — ${e.note}` : ""}</div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Section>

      {/* Movements + GL */}
      {(d.movements.length > 0 || d.gl.issueJournalId || d.gl.reverseJournalId) && (
        <Section icon={FileText} title={t("inventoryRest.transfers.detail.movementsTitle")}>
          {d.movements.length > 0 && (
            <ul className="mb-2 space-y-1 text-[11px] text-slate-500">
              {d.movements.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2">
                  <span>{m.itemName} — {m.reason}</span>
                  <span className={`tabular-nums font-bold ${m.type === "in" ? "text-emerald-600" : "text-rose-600"}`}>
                    {m.type === "in" ? "+" : "−"}{formatQty(m.qty)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2 text-[11px] font-bold text-slate-500">
            {d.gl.issueJournalId && <span className="chip border-slate-200 bg-slate-50">{t("inventoryRest.transfers.detail.issueJournal", { id: d.gl.issueJournalId })}</span>}
            {d.gl.reverseJournalId && <span className="chip border-slate-200 bg-slate-50">{t("inventoryRest.transfers.detail.reverseJournal", { id: d.gl.reverseJournalId })}</span>}
          </div>
        </Section>
      )}
    </div>
  );
}

function Section({ icon: Icon, title, children }: { icon: typeof Layers; title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-xs font-extrabold text-slate-700">
        <Icon className="h-4 w-4 text-slate-400" /> {title}
      </div>
      {children}
    </div>
  );
}

function Footer({
  d, can, onAction, onReceive, onEdit,
}: {
  d: TransferDetail;
  can: { canApprove: boolean; canIssue: boolean; canReceive: boolean; canReverse: boolean; canCreate: boolean };
  onAction: (k: DialogKind) => void;
  onReceive: () => void;
  onEdit: () => void;
}) {
  const t = useT();
  const s = d.status; // UI status: draft|approved|in_transit|partially_received|received|cancelled|reversed
  const actions: React.ReactNode[] = [];

  if (s === "draft") {
    if (can.canCreate) actions.push(<Button key="edit" variant="secondary" onClick={onEdit}><Pencil className="h-4 w-4" /> {t("inventoryRest.transfers.detail.edit")}</Button>);
    if (can.canApprove) actions.push(<Button key="approve" variant="primary" onClick={() => onAction("approve")}><CheckCircle2 className="h-4 w-4" /> {t("inventoryRest.transfers.detail.approve")}</Button>);
    if (can.canCreate) actions.push(<Button key="delete" variant="danger" onClick={() => onAction("delete")}><Trash2 className="h-4 w-4" /> {t("inventoryRest.transfers.detail.deleteBtn")}</Button>);
  } else if (s === "approved") {
    if (can.canIssue) actions.push(<Button key="issue" variant="primary" onClick={() => onAction("issue")}><Send className="h-4 w-4" /> {t("inventoryRest.transfers.detail.issueBtn")}</Button>);
    if (can.canApprove) actions.push(<Button key="cancel" variant="danger" onClick={() => onAction("cancel")}><XCircle className="h-4 w-4" /> {t("inventoryRest.transfers.detail.cancelBtn")}</Button>);
  } else if (s === "in_transit" || s === "partially_received") {
    if (can.canReceive) actions.push(<Button key="receive" variant="primary" onClick={onReceive}><PackageCheck className="h-4 w-4" /> {t("inventoryRest.transfers.detail.receiveBtn")}</Button>);
    if (can.canReverse) actions.push(<Button key="reverse" variant="danger" onClick={() => onAction("reverse")}><Undo2 className="h-4 w-4" /> {t("inventoryRest.transfers.detail.reverseBtn")}</Button>);
  } else if (s === "received") {
    if (can.canReverse) actions.push(<Button key="reverse" variant="secondary" onClick={() => onAction("reverse")}><Undo2 className="h-4 w-4" /> {t("inventoryRest.transfers.detail.reverseBtn")}</Button>);
  }

  return (
    <div className="no-print flex w-full flex-wrap items-center justify-between gap-2">
      <Button variant="ghost" onClick={() => window.print()}><Printer className="h-4 w-4" /> {t("inventoryRest.ui.print")}</Button>
      <div className="flex flex-wrap gap-2">{actions}</div>
    </div>
  );
}
