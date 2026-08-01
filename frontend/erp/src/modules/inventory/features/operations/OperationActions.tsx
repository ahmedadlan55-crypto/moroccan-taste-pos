// ═══════════════════════════════════════════════════════════════════════════
// Workflow actions for a document opened in the operations centre.
//
// WHY THIS FILE EXISTS. The transfer and inventory-transaction detail DRAWERS
// were the only UI in the ERP carrying these actions — approve / issue /
// receive / post / cancel / reverse / delete / print. Replacing those drawers
// with a read-only detail page would have silently removed every one of them
// from the product. The unified page owns the READ model; this component owns
// the WRITES, so the move to real routes costs nothing.
//
// The mutation hooks, permission checks, dialogs and state-machine rules are
// the SAME ones the drawers used (useTransferMutations / useInvTxMutations /
// useCan) — deliberately reused rather than reimplemented, so behaviour is
// identical and there is one place where each rule lives.
// ═══════════════════════════════════════════════════════════════════════════
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Printer, CheckCircle2, Send, PackageCheck, Undo2, XCircle, Trash2, Pencil, Ban,
} from "lucide-react";
import { Button, ConfirmDialog } from "@/shared/ui";
import { useT } from "@/i18n";
import { useCan } from "@/modules/inventory/lib/permission-provider";
import { useTransferDetail } from "@/modules/inventory/lib/hooks/useTransferDetail";
import {
  useApproveTransfer, useIssueTransfer, useReceiveTransfer,
  useCancelTransfer, useReverseTransfer, useDeleteDraft,
} from "@/modules/inventory/lib/hooks/useTransferMutations";
import { useInvTxDetail, useInvTxMutations } from "@/modules/inventory/lib/hooks/useInventoryTx";
import { ReceiveDialog } from "@/modules/inventory/features/transfers/ReceiveDialog";
import { ReasonDialog } from "@/modules/inventory/features/_shared/ReasonDialog";
import { INVTX_CONFIG } from "@/modules/inventory/features/_shared/invtxConfig";
import { printInvTx } from "@/modules/inventory/features/_shared/printInvTx";

type DialogKind = "approve" | "issue" | "cancel" | "reverse" | "delete" | null;

/** Which document types have a write surface here. Everything else is read-only. */
export const ACTIONABLE_TYPES = new Set(["transfer", "receipt", "issue", "adjustment"]);

export function OperationActions({ documentType, documentId }: { documentType: string; documentId: string }) {
  if (documentType === "transfer") return <TransferActions id={documentId} />;
  if (documentType === "receipt" || documentType === "issue" || documentType === "adjustment") {
    return <InvTxActions docType={documentType} id={documentId} />;
  }
  return null;
}

// ── Transfers ───────────────────────────────────────────────────────────────
function TransferActions({ id }: { id: string }) {
  const t = useT();
  const navigate = useNavigate();
  const { data } = useTransferDetail(id);
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

  if (!data) return null;
  const s = data.status;
  const actions: React.ReactNode[] = [];

  if (s === "draft") {
    if (canCreate) actions.push(<Button key="edit" variant="secondary" onClick={() => navigate(`/inventory/transfers?new=1&edit=${data.id}`)}><Pencil className="h-4 w-4" /> {t("inventoryRest.transfers.detail.edit")}</Button>);
    if (canApprove) actions.push(<Button key="approve" variant="primary" onClick={() => setDialog("approve")}><CheckCircle2 className="h-4 w-4" /> {t("inventoryRest.transfers.detail.approve")}</Button>);
    if (canCreate) actions.push(<Button key="delete" variant="danger" onClick={() => setDialog("delete")}><Trash2 className="h-4 w-4" /> {t("inventoryRest.transfers.detail.deleteBtn")}</Button>);
  } else if (s === "approved") {
    if (canIssue) actions.push(<Button key="issue" variant="primary" onClick={() => setDialog("issue")}><Send className="h-4 w-4" /> {t("inventoryRest.transfers.detail.issueBtn")}</Button>);
    if (canApprove) actions.push(<Button key="cancel" variant="danger" onClick={() => setDialog("cancel")}><XCircle className="h-4 w-4" /> {t("inventoryRest.transfers.detail.cancelBtn")}</Button>);
  } else if (s === "in_transit" || s === "partially_received") {
    if (canReceive) actions.push(<Button key="receive" variant="primary" onClick={() => setReceiveOpen(true)}><PackageCheck className="h-4 w-4" /> {t("inventoryRest.transfers.detail.receiveBtn")}</Button>);
    if (canReverse) actions.push(<Button key="reverse" variant="danger" onClick={() => setDialog("reverse")}><Undo2 className="h-4 w-4" /> {t("inventoryRest.transfers.detail.reverseBtn")}</Button>);
  } else if (s === "received") {
    if (canReverse) actions.push(<Button key="reverse" variant="secondary" onClick={() => setDialog("reverse")}><Undo2 className="h-4 w-4" /> {t("inventoryRest.transfers.detail.reverseBtn")}</Button>);
  }

  return (
    <>
      <div className="no-print flex w-full flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-4">
        <div className="flex flex-wrap gap-2">{actions}</div>
      </div>

      <ConfirmDialog
        open={dialog === "approve"}
        title={t("inventoryRest.transfers.detail.confirmApproveTitle")}
        description={t("inventoryRest.transfers.detail.confirmApproveBody")}
        confirmLabel={t("inventoryRest.transfers.detail.approve")}
        processing={approve.isPending}
        error={approve.error ? approve.error.message : null}
        onClose={() => setDialog(null)}
        onConfirm={() => approve.mutate({ id: data.id, expectedVersion: data.version }, { onSuccess: () => setDialog(null) })}
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
        onConfirm={() => issue.mutate({ id: data.id, expectedVersion: data.version }, { onSuccess: () => setDialog(null) })}
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
        onConfirm={(reason) => cancel.mutate({ id: data.id, input: { reason, expectedVersion: data.version } }, { onSuccess: () => setDialog(null) })}
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
        onConfirm={(reason) => reverse.mutate({ id: data.id, input: { reason, expectedVersion: data.version } }, { onSuccess: () => setDialog(null) })}
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
        // Deleting the document you are looking at must not leave you on a dead
        // URL — go back to the hub.
        onConfirm={() => del.mutate({ id: data.id }, { onSuccess: () => { setDialog(null); navigate("/inventory/operations"); } })}
      />
      <ReceiveDialog
        open={receiveOpen}
        lines={data.lines}
        processing={receive.isPending}
        error={receive.error ? receive.error.message : null}
        onClose={() => setReceiveOpen(false)}
        onConfirm={(items) => receive.mutate({ id: data.id, input: { items, expectedVersion: data.version } }, { onSuccess: () => setReceiveOpen(false) })}
      />
    </>
  );
}

// ── Receipts / issues / adjustments ─────────────────────────────────────────
function InvTxActions({ docType, id }: { docType: "receipt" | "issue" | "adjustment"; id: string }) {
  const t = useT();
  const navigate = useNavigate();
  const config = INVTX_CONFIG[docType];
  const { data: d } = useInvTxDetail(docType, id);
  const m = useInvTxMutations(docType);
  const canApprove = useCan(config.perms.approve);
  const canPost = useCan(config.perms.post);
  const canCreate = useCan(config.perms.create);
  const canReverse = useCan(config.perms.reverse);
  const [dialog, setDialog] = useState<null | "cancel" | "reverse" | "delete">(null);
  const [actionErr, setActionErr] = useState<string | null>(null);

  if (!d) return null;
  const pending = m.approve.isPending || m.post.isPending || m.cancel.isPending || m.reverse.isPending || m.remove.isPending;

  async function run(p: Promise<unknown>, after?: () => void) {
    setActionErr(null);
    try { await p; setDialog(null); after?.(); }
    catch (e) { setActionErr(e instanceof Error ? e.message : t("inventoryRest.invtx.detail.actionFailed")); }
  }

  return (
    <>
      {actionErr && (
        <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{actionErr}</p>
      )}
      <div className="no-print flex flex-wrap gap-2 border-t border-slate-200 pt-4">
        <Button variant="secondary" onClick={() => printInvTx(config, d, t)}><Printer className="h-4 w-4" /> {t("inventoryRest.invtx.detail.printBtn")}</Button>
        {d.status === "draft" && canCreate && (
          <Button variant="secondary" onClick={() => navigate(`${config.routeBase}?new=1&edit=${d.id}`)}><Pencil className="h-4 w-4" /> {t("inventoryRest.invtx.detail.editBtn")}</Button>
        )}
        {d.status === "draft" && canApprove && (
          <Button variant="primary" disabled={pending} onClick={() => run(m.approve.mutateAsync({ id: d.id, expectedVersion: d.version }))}><CheckCircle2 className="h-4 w-4" /> {t("inventoryRest.invtx.detail.approveBtn")}</Button>
        )}
        {d.status === "approved" && canPost && (
          <Button variant="primary" disabled={pending} onClick={() => run(m.post.mutateAsync({ id: d.id, expectedVersion: d.version }))}><Send className="h-4 w-4" /> {t("inventoryRest.invtx.detail.postBtn")}</Button>
        )}
        {(d.status === "draft" || d.status === "approved") && canApprove && (
          <Button variant="ghost" disabled={pending} onClick={() => { setActionErr(null); setDialog("cancel"); }}><Ban className="h-4 w-4" /> {t("inventoryRest.invtx.detail.cancelBtn")}</Button>
        )}
        {d.status === "draft" && canApprove && (
          // Was a native blocking confirm() — the only one left in the module,
          // and it captured no reason. Now the same ConfirmDialog everything
          // else uses.
          <Button variant="ghost" disabled={pending} onClick={() => { setActionErr(null); setDialog("delete"); }}><Trash2 className="h-4 w-4" /> {t("inventoryRest.invtx.detail.deleteBtn")}</Button>
        )}
        {d.status === "posted" && canReverse && (
          <Button variant="danger" disabled={pending} onClick={() => { setActionErr(null); setDialog("reverse"); }}><Undo2 className="h-4 w-4" /> {t("inventoryRest.invtx.detail.reverseBtn")}</Button>
        )}
      </div>

      <ReasonDialog
        open={dialog === "cancel"}
        title={t("inventoryRest.invtx.detail.cancelDialogTitle")}
        description={t("inventoryRest.invtx.detail.cancelDialogBody")}
        confirmLabel={t("inventoryRest.invtx.detail.cancelDialogConfirm")}
        pending={m.cancel.isPending}
        // The drawer hardcoded error={null} here, so a server-side failure
        // during cancel/reverse never rendered inside the dialog — it landed in
        // a banner BEHIND the still-open modal.
        error={actionErr}
        onConfirm={(reason) => run(m.cancel.mutateAsync({ id: d.id, reason, expectedVersion: d.version }))}
        onClose={() => setDialog(null)}
      />
      <ReasonDialog
        open={dialog === "reverse"}
        title={t("inventoryRest.invtx.detail.reverseDialogTitle")}
        description={t("inventoryRest.invtx.detail.reverseDialogBody")}
        confirmLabel={t("inventoryRest.invtx.detail.reverseDialogConfirm")}
        pending={m.reverse.isPending}
        error={actionErr}
        onConfirm={(reason) => run(m.reverse.mutateAsync({ id: d.id, reason, expectedVersion: d.version }))}
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog === "delete"}
        title={t("inventoryRest.invtx.detail.deleteBtn")}
        description={t("inventoryRest.invtx.detail.confirmDeleteDraft")}
        confirmLabel={t("inventoryRest.invtx.detail.deleteBtn")}
        tone="danger"
        processing={m.remove.isPending}
        error={actionErr}
        onClose={() => setDialog(null)}
        onConfirm={() => run(m.remove.mutateAsync({ id: d.id }), () => navigate("/inventory/operations"))}
      />
    </>
  );
}
