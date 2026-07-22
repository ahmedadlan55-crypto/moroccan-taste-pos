import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Pencil, CheckCircle2, Send, Ban, Undo2, Trash2, Printer, FileText } from "lucide-react";
import { Drawer, DetailStat } from "@/shared/ui";
import { StatusBadge } from "@/shared/ui";
import { Button } from "@/shared/ui";
import { LoadingState, ErrorState } from "@/shared/ui";
import { ApiError } from "@/shared/api";
import { useCan } from "@/modules/inventory/lib/permission-provider";
import { useAuth } from "@/app/providers";
import { formatCurrency, formatNumber, formatQty, formatDate } from "@/shared/lib";
import { useT } from "@/i18n";
import type { TFunction } from "@/i18n";
import { invTxStatusToLabel } from "@/modules/inventory/lib/status-labels";
import { useInvTxDetail, useInvTxMutations } from "@/modules/inventory/lib/hooks/useInventoryTx";
import type { InvTxConfig } from "./invtxConfig";
import type { InvTxDetail } from "@/modules/inventory/lib/adapters/invtx.adapter";
import { ReasonDialog } from "./ReasonDialog";
import { printInvTx } from "./printInvTx";

const KNOWN_ACTIONS = new Set(["create", "edit", "approve", "post", "cancel", "reverse", "delete"]);
const actionLabel = (t: TFunction, action: string) =>
  KNOWN_ACTIONS.has(action) ? t(`inventoryRest.invtx.detail.action.${action}`) : action;

export function InvTxDetailDrawer({ config, id, onClose }: { config: InvTxConfig; id: string | null; onClose: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const { user } = useAuth();
  const detailQ = useInvTxDetail(config.docType, id);
  const m = useInvTxMutations(config.docType);
  const canApprove = useCan(config.perms.approve);
  const canPost = useCan(config.perms.post);
  const canCreate = useCan(config.perms.create);
  const canReverse = useCan(config.perms.reverse);
  const [dialog, setDialog] = useState<null | "cancel" | "reverse">(null);
  const [actionErr, setActionErr] = useState<string | null>(null);

  const d = detailQ.data;
  const pending = m.approve.isPending || m.post.isPending || m.cancel.isPending || m.reverse.isPending || m.remove.isPending;

  function handleErr(e: unknown) {
    if (e instanceof ApiError) setActionErr(e.isConflict ? t("inventoryRest.invtx.detail.conflict") : e.message);
    else setActionErr(t("inventoryRest.invtx.detail.actionFailed"));
    detailQ.refetch();
  }
  function run(p: Promise<unknown>) { setActionErr(null); p.then(() => setDialog(null)).catch(handleErr); }

  // Maker–Checker UI hint: the creator can't approve their own adjustment.
  const isCreator = !!d && !!user && d.actors.createdBy === user.username;
  const makerChecker = config.docType === "adjustment" && isCreator && user?.role !== "admin" && !user?.isDeveloper;

  return (
    <Drawer open={!!id} onClose={onClose} title={d?.number ?? t("inventoryRest.invtx.detail.fallbackTitle")} eyebrow={t(config.title)} icon={config.icon}>
      {detailQ.isLoading ? (
        <LoadingState rows={3} />
      ) : detailQ.isError ? (
        <ErrorState error={detailQ.error} onRetry={() => detailQ.refetch()} />
      ) : !d ? null : (
        <div className="space-y-5">
          <div className="flex items-center justify-between gap-2">
            <StatusBadge>{invTxStatusToLabel(d.status)}</StatusBadge>
            <span className="text-xs font-bold text-slate-400">{t("inventoryRest.ui.version")} {formatNumber(d.version)}</span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <DetailStat label={t("inventoryRest.invtx.detail.warehouse")} value={d.warehouse.name || d.warehouse.id} />
            <DetailStat label={t("inventoryRest.invtx.detail.date")} value={formatDate(d.date)} />
            <DetailStat label={t("inventoryRest.invtx.detail.value")} value={formatCurrency(d.totalValue)} />
            <DetailStat label={t("inventoryRest.invtx.detail.itemCount")} value={formatNumber(d.lines.length)} />
            {d.reason && <DetailStat label={t("inventoryRest.invtx.detail.reason")} value={d.reason} />}
            {d.sourceRef && <DetailStat label={t("inventoryRest.invtx.detail.ref")} value={d.sourceRef} />}
            {d.recipient && <DetailStat label={t("inventoryRest.invtx.detail.recipient")} value={d.recipient} />}
            {d.referenceEvidence && <DetailStat label={t("inventoryRest.invtx.detail.evidence")} value={d.referenceEvidence} />}
          </div>

          {actionErr && <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{actionErr}</p>}
          {makerChecker && d.status === "draft" && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">{t("inventoryRest.invtx.detail.makerChecker")}</p>
          )}

          {/* Lines */}
          <Section title={t("inventoryRest.invtx.detail.linesTitle")} icon={FileText}>
            <LineTable d={d} mode={config.lineMode} />
          </Section>

          {/* Timeline */}
          <Section title={t("inventoryRest.invtx.detail.auditTitle")}>
            <ol className="space-y-2">
              {d.timeline.length === 0 && <li className="text-xs text-slate-400">{t("inventoryRest.invtx.detail.auditEmpty")}</li>}
              {d.timeline.map((e, i) => (
                <li key={i} className="flex items-start gap-2 text-xs">
                  <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-teal-500" aria-hidden="true" />
                  <div>
                    <span className="font-extrabold text-slate-700">{actionLabel(t, e.action)}</span>
                    <span className="text-slate-400"> · {e.actor || "—"} · {formatDate(e.at)}</span>
                    {e.note && <div className="text-slate-500">{e.note}</div>}
                  </div>
                </li>
              ))}
            </ol>
          </Section>

          {/* Movements + GL */}
          {(d.movements.length > 0 || d.journals.length > 0) && (
            <Section title={t("inventoryRest.invtx.detail.movementsTitle")}>
              {d.movements.length > 0 && (
                <table className="w-full text-xs">
                  <thead className="text-slate-400"><tr><th className="py-1 text-right">{t("inventoryRest.invtx.detail.colType")}</th><th className="text-right">{t("inventoryRest.invtx.detail.colQty")}</th><th className="text-right">{t("inventoryRest.invtx.detail.colReason")}</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {d.movements.map((mv) => (
                      <tr key={mv.id}><td className="py-1 font-bold">{mv.type === "in" ? t("inventoryRest.movementType.in") : t("inventoryRest.movementType.out")}</td><td className="tabular-nums">{formatQty(mv.qty)}</td><td className="text-slate-500">{mv.reason}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
              {d.journals.map((j) => (
                <div key={j.id} className="mt-2 rounded-lg border border-slate-100 p-2">
                  <div className="flex justify-between text-xs font-bold text-slate-600"><span>{j.number}</span><span className="tabular-nums">{formatCurrency(j.totalDebit)}</span></div>
                  <table className="mt-1 w-full text-[11px]">
                    <tbody>
                      {j.entries.map((en, i) => (
                        <tr key={i}><td className="text-slate-500">{en.accountName || en.accountCode}</td><td className="text-left tabular-nums text-emerald-700">{en.debit ? formatCurrency(en.debit) : ""}</td><td className="text-left tabular-nums text-rose-700">{en.credit ? formatCurrency(en.credit) : ""}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </Section>
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-4">
            <Button variant="secondary" onClick={() => printInvTx(config, d, t)}><Printer className="h-4 w-4" /> {t("inventoryRest.invtx.detail.printBtn")}</Button>
            {d.status === "draft" && canCreate && (
              <Button variant="secondary" onClick={() => navigate(`${config.routeBase}?new=1&edit=${d.id}`)}><Pencil className="h-4 w-4" /> {t("inventoryRest.invtx.detail.editBtn")}</Button>
            )}
            {d.status === "draft" && canApprove && !makerChecker && (
              <Button variant="primary" disabled={pending} onClick={() => run(m.approve.mutateAsync({ id: d.id, expectedVersion: d.version }))}><CheckCircle2 className="h-4 w-4" /> {t("inventoryRest.invtx.detail.approveBtn")}</Button>
            )}
            {d.status === "approved" && canPost && (
              <Button variant="primary" disabled={pending} onClick={() => run(m.post.mutateAsync({ id: d.id, expectedVersion: d.version }))}><Send className="h-4 w-4" /> {t("inventoryRest.invtx.detail.postBtn")}</Button>
            )}
            {(d.status === "draft" || d.status === "approved") && canApprove && (
              <Button variant="ghost" disabled={pending} onClick={() => { setActionErr(null); setDialog("cancel"); }}><Ban className="h-4 w-4" /> {t("inventoryRest.invtx.detail.cancelBtn")}</Button>
            )}
            {d.status === "draft" && canApprove && (
              <Button variant="ghost" disabled={pending} onClick={() => { if (confirm(t("inventoryRest.invtx.detail.confirmDeleteDraft"))) run(m.remove.mutateAsync({ id: d.id })); }}><Trash2 className="h-4 w-4" /> {t("inventoryRest.invtx.detail.deleteBtn")}</Button>
            )}
            {d.status === "posted" && canReverse && (
              <Button variant="danger" disabled={pending} onClick={() => { setActionErr(null); setDialog("reverse"); }}><Undo2 className="h-4 w-4" /> {t("inventoryRest.invtx.detail.reverseBtn")}</Button>
            )}
          </div>
        </div>
      )}

      <ReasonDialog
        open={dialog === "cancel"}
        title={t("inventoryRest.invtx.detail.cancelDialogTitle")}
        description={t("inventoryRest.invtx.detail.cancelDialogBody")}
        confirmLabel={t("inventoryRest.invtx.detail.cancelDialogConfirm")}
        pending={m.cancel.isPending}
        error={null}
        onConfirm={(reason) => d && run(m.cancel.mutateAsync({ id: d.id, reason, expectedVersion: d.version }))}
        onClose={() => setDialog(null)}
      />
      <ReasonDialog
        open={dialog === "reverse"}
        title={t("inventoryRest.invtx.detail.reverseDialogTitle")}
        description={t("inventoryRest.invtx.detail.reverseDialogBody")}
        confirmLabel={t("inventoryRest.invtx.detail.reverseDialogConfirm")}
        pending={m.reverse.isPending}
        error={null}
        onConfirm={(reason) => d && run(m.reverse.mutateAsync({ id: d.id, reason, expectedVersion: d.version }))}
        onClose={() => setDialog(null)}
      />
    </Drawer>
  );
}

function Section({ title, icon: Icon, children }: { title: string; icon?: typeof FileText; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-extrabold text-slate-500">{Icon && <Icon className="h-3.5 w-3.5" />}{title}</h3>
      {children}
    </section>
  );
}

function LineTable({ d, mode }: { d: InvTxDetail; mode: InvTxConfig["lineMode"] }) {
  const t = useT();
  if (mode === "adjustment") {
    return (
      <table className="w-full text-xs">
        <thead className="text-slate-400"><tr><th className="py-1 text-right">{t("inventoryRest.invtx.detail.colItem")}</th><th className="text-center">{t("inventoryRest.invtx.detail.colSystem")}</th><th className="text-center">{t("inventoryRest.invtx.detail.colCounted")}</th><th className="text-center">{t("inventoryRest.invtx.detail.colDelta")}</th><th className="text-left">{t("inventoryRest.invtx.detail.colValue")}</th></tr></thead>
        <tbody className="divide-y divide-slate-100">
          {d.lines.map((l) => (
            <tr key={l.id}>
              <td className="py-1.5 font-bold text-slate-700">{l.item.name}</td>
              <td className="text-center tabular-nums text-slate-500">{formatQty(l.systemQtySnapshot)}</td>
              <td className="text-center tabular-nums text-slate-700">{formatQty(l.countedQty)}</td>
              <td className={`text-center font-bold tabular-nums ${l.delta < 0 ? "text-rose-600" : l.delta > 0 ? "text-emerald-600" : "text-slate-400"}`}>{l.delta > 0 ? "+" : ""}{formatQty(l.delta)}</td>
              <td className="text-left tabular-nums text-slate-700">{formatCurrency(l.deltaValue)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <table className="w-full text-xs">
      <thead className="text-slate-400"><tr><th className="py-1 text-right">{t("inventoryRest.invtx.detail.colItem")}</th><th className="text-center">{t("inventoryRest.invtx.detail.colQty")}</th><th className="text-center">{t("inventoryRest.invtx.detail.colUnitCost")}</th><th className="text-left">{t("inventoryRest.invtx.detail.colTotal")}</th></tr></thead>
      <tbody className="divide-y divide-slate-100">
        {d.lines.map((l) => (
          <tr key={l.id}>
            <td className="py-1.5 font-bold text-slate-700">{l.item.name}</td>
            <td className="text-center tabular-nums text-slate-700">{formatQty(l.qty)} {l.item.unit}</td>
            <td className="text-center tabular-nums text-slate-500">{formatCurrency(l.unitCost)}</td>
            <td className="text-left tabular-nums text-slate-700">{formatCurrency(l.lineTotal)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
