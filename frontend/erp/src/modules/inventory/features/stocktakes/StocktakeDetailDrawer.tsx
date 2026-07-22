import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ClipboardCheck, Printer, Play, Send, CheckCircle2, Undo2, Ban, Trash2, FileText } from "lucide-react";
import { Drawer } from "@/shared/ui";
import { Button } from "@/shared/ui";
import { StatusBadge } from "@/shared/ui";
import { LoadingState, ErrorState } from "@/shared/ui";
import { ReasonDialog } from "@/modules/inventory/features/_shared/ReasonDialog";
import { ApiError } from "@/shared/api";
import { useCan } from "@/modules/inventory/lib/permission-provider";
import { formatCurrency, formatQty, formatDate } from "@/shared/lib";
import { useT } from "@/i18n";
import type { TFunction } from "@/i18n";
import { stocktakeStatusToLabel } from "@/modules/inventory/lib/status-labels";
import { useStocktakeDetail, useStocktakeMutations } from "@/modules/inventory/lib/hooks/useStocktakes";
import { printStocktake } from "./printStocktake";

// Timeline action code → label key. `request-recount` maps to the `recount` key.
const ACTION_KEYS: Record<string, string> = {
  create: "create", edit: "edit", start: "start", submit: "submit", "request-recount": "recount",
  approve: "approve", post: "post", cancel: "cancel", delete: "delete", scope: "scope",
};
const actionLabel = (t: TFunction, action: string) =>
  ACTION_KEYS[action] ? t(`inventoryRest.stocktakes.detail.action.${ACTION_KEYS[action]}`) : action;

export function StocktakeDetailDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const q = useStocktakeDetail(id);
  const m = useStocktakeMutations();
  const canApprove = useCan("stocktake.approve");
  const canPost = useCan("stocktake.post");
  const [err, setErr] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | "recount" | "cancel">(null);
  const d = q.data;
  const busy = m.start.isPending || m.submit.isPending || m.approve.isPending || m.post.isPending || m.cancel.isPending || m.requestRecount.isPending || m.remove.isPending;

  function onError(e: unknown) {
    setErr(e instanceof ApiError ? (e.isConflict ? t("inventoryRest.stocktakes.detail.conflict") : e.message) : t("inventoryRest.stocktakes.detail.actionFailed"));
    if (e instanceof ApiError && e.isConflict) q.refetch();
  }
  const ev = () => (d ? d.version : undefined);

  return (
    <Drawer open={!!id} onClose={onClose} title={d?.number ?? t("inventoryRest.stocktakes.detail.fallbackTitle")} eyebrow={t("inventoryRest.stocktakes.title")} icon={ClipboardCheck}>
      {!d ? (q.isLoading ? <LoadingState rows={3} /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : null) : (
        <div className="space-y-5">
          <div className="flex items-center gap-2">
            <StatusBadge>{stocktakeStatusToLabel(d.status)}</StatusBadge>
            <span className="text-xs font-bold text-slate-400">{t("inventoryRest.ui.version")} {d.version}</span>
            {d.blindCount && <span className="rounded-lg bg-violet-50 px-2 py-0.5 text-[10px] font-extrabold text-violet-700">{t("inventoryRest.stocktakes.detail.blindBadge")}</span>}
          </div>

          {err && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">{err}</p>}

          <div className="grid grid-cols-2 gap-3 text-sm">
            <Field k={t("inventoryRest.stocktakes.detail.warehouse")} v={d.warehouse.name} />
            <Field k={t("inventoryRest.stocktakes.detail.date")} v={formatDate(d.date)} />
            <Field k={t("inventoryRest.stocktakes.detail.scope")} v={d.scopeType === "full" ? t("inventoryRest.stocktakes.detail.scopeFull") : d.scopeType === "category" ? t("inventoryRest.stocktakes.detail.scopeCategory") : t("inventoryRest.stocktakes.detail.scopeItems")} />
            <Field k={t("inventoryRest.stocktakes.detail.countedTotal")} v={`${formatQty(d.countedLines)} / ${formatQty(d.totalLines)}`} />
            <Field k={t("inventoryRest.stocktakes.detail.varianceLines")} v={formatQty(d.varianceLines)} />
            <Field k={t("inventoryRest.stocktakes.detail.totalVariance")} v={formatCurrency(d.totalVarianceValue)} />
            {d.reason && <Field k={t("inventoryRest.stocktakes.detail.reason")} v={d.reason} full />}
            {d.referenceEvidence && <Field k={t("inventoryRest.stocktakes.detail.evidence")} v={d.referenceEvidence} full />}
            {d.adjustmentNumber && <Field k={t("inventoryRest.stocktakes.detail.linkedAdjustment")} v={d.adjustmentNumber} full />}
            {d.recountReason && <Field k={t("inventoryRest.stocktakes.detail.recountReason")} v={d.recountReason} full />}
          </div>

          {/* Variance review */}
          <section>
            <h4 className="mb-2 text-xs font-extrabold text-slate-500">{t("inventoryRest.stocktakes.detail.varianceReviewTitle")}</h4>
            <div className="overflow-x-auto rounded-xl border border-slate-100">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500"><tr>
                  <th className="px-2 py-2 text-right">{t("inventoryRest.stocktakes.detail.colItem")}</th><th>{t("inventoryRest.stocktakes.detail.colSnapshot")}</th><th>{t("inventoryRest.stocktakes.detail.colCountMovements")}</th><th>{t("inventoryRest.stocktakes.detail.colTheoretical")}</th><th>{t("inventoryRest.stocktakes.detail.colCounted")}</th><th>{t("inventoryRest.stocktakes.detail.colVariance")}</th><th>{t("inventoryRest.stocktakes.detail.colValue")}</th>
                </tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {d.lines.map((l) => (
                    <tr key={l.id} className={l.isFlagged ? "bg-amber-50/60" : ""}>
                      <td className="px-2 py-2 text-right font-bold text-slate-700">{l.item.name}</td>
                      <td className="text-center tabular-nums text-slate-500">{formatQty(l.snapshotQty)}</td>
                      <td className="text-center tabular-nums text-slate-500">{l.netMovements > 0 ? "+" : ""}{formatQty(l.netMovements)}</td>
                      <td className="text-center tabular-nums text-slate-600">{formatQty(l.theoreticalQty)}</td>
                      <td className="text-center tabular-nums font-bold">{l.counted ? formatQty(l.countedQty ?? 0) : <span className="text-slate-300">—</span>}</td>
                      <td className={`text-center font-extrabold tabular-nums ${l.variance < 0 ? "text-rose-600" : l.variance > 0 ? "text-emerald-600" : "text-slate-400"}`}>{l.counted ? `${l.variance > 0 ? "+" : ""}${formatQty(l.variance)}` : "—"}</td>
                      <td className="text-center tabular-nums text-slate-600">{l.counted ? formatCurrency(l.varianceValue) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Movements + GL (from the linked adjustment) */}
          {d.movements.length > 0 && (
            <section>
              <h4 className="mb-2 text-xs font-extrabold text-slate-500">{t("inventoryRest.stocktakes.detail.movementsTitle")}</h4>
              <div className="space-y-1">
                {d.movements.map((mv) => (
                  <div key={mv.id} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-1.5 text-xs">
                    <span className={`font-bold ${mv.type === "in" ? "text-emerald-700" : "text-rose-700"}`}>{mv.type === "in" ? t("inventoryRest.movementType.in") : t("inventoryRest.movementType.out")} {formatQty(mv.qty)}</span>
                    <span className="text-slate-400">{mv.referenceType}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
          {d.journals.length > 0 && (
            <section>
              <h4 className="mb-2 text-xs font-extrabold text-slate-500">{t("inventoryRest.stocktakes.detail.journalTitle")}</h4>
              {d.journals.map((j) => (
                <div key={j.id} className="rounded-xl border border-slate-100 p-3 text-xs">
                  <div className="mb-1 flex justify-between font-bold text-slate-600"><span>{j.number}</span><span>{t("inventoryRest.stocktakes.detail.debitCredit", { debit: formatCurrency(j.totalDebit), credit: formatCurrency(j.totalCredit) })}</span></div>
                  {j.entries.map((e, i) => (
                    <div key={i} className="flex justify-between text-slate-500"><span>{e.accountCode} {e.accountName}</span><span className="tabular-nums">{e.debit > 0 ? t("inventoryRest.stocktakes.detail.debit", { value: formatCurrency(e.debit) }) : t("inventoryRest.stocktakes.detail.credit", { value: formatCurrency(e.credit) })}</span></div>
                  ))}
                </div>
              ))}
            </section>
          )}

          {/* Timeline */}
          <section>
            <h4 className="mb-2 text-xs font-extrabold text-slate-500">{t("inventoryRest.stocktakes.detail.timelineTitle")}</h4>
            <ol className="space-y-2">
              {d.timeline.map((e, i) => (
                <li key={i} className="flex items-start gap-2 text-xs">
                  <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-teal-500" />
                  <div><span className="font-bold text-slate-700">{actionLabel(t, e.action)}</span><span className="text-slate-400"> · {e.actor} · {formatDate(e.at)}</span>{e.note && <div className="text-slate-500">{e.note}</div>}</div>
                </li>
              ))}
            </ol>
          </section>

          {/* Actions (status + permission driven) */}
          <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-4">
            <Button variant="secondary" size="sm" onClick={() => printStocktake(d, "count", t)}><Printer className="h-4 w-4" /> {t("inventoryRest.stocktakes.detail.countSheet")}</Button>
            {d.countedLines > 0 && <Button variant="secondary" size="sm" onClick={() => printStocktake(d, "variance", t)}><FileText className="h-4 w-4" /> {t("inventoryRest.stocktakes.detail.varianceReport")}</Button>}

            {d.status === "draft" && (
              <Button variant="primary" size="sm" disabled={busy} onClick={() => m.start.mutate({ id: d.id, expectedVersion: ev() }, { onSuccess: () => navigate(`/inventory/stocktakes?count=${d.id}`), onError })}><Play className="h-4 w-4" /> {t("inventoryRest.stocktakes.detail.startCount")}</Button>
            )}
            {d.status === "counting" && (
              <>
                <Button variant="primary" size="sm" onClick={() => navigate(`/inventory/stocktakes?count=${d.id}`)}><ClipboardCheck className="h-4 w-4" /> {t("inventoryRest.stocktakes.detail.continueCount")}</Button>
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => m.submit.mutate({ id: d.id, expectedVersion: ev() }, { onSuccess: () => q.refetch(), onError })}><Send className="h-4 w-4" /> {t("inventoryRest.stocktakes.detail.submitForApproval")}</Button>
              </>
            )}
            {d.status === "submitted" && (
              <>
                {canApprove && <Button variant="secondary" size="sm" disabled={busy} onClick={() => setDialog("recount")}><Undo2 className="h-4 w-4" /> {t("inventoryRest.stocktakes.detail.recount")}</Button>}
                {canApprove && <Button variant="primary" size="sm" disabled={busy} onClick={() => m.approve.mutate({ id: d.id, expectedVersion: ev() }, { onSuccess: () => q.refetch(), onError })}><CheckCircle2 className="h-4 w-4" /> {t("inventoryRest.stocktakes.detail.approve")}</Button>}
              </>
            )}
            {d.status === "approved" && canPost && (
              <Button variant="primary" size="sm" disabled={busy} onClick={() => m.post.mutate({ id: d.id, expectedVersion: ev() }, { onSuccess: () => q.refetch(), onError })}><CheckCircle2 className="h-4 w-4" /> {t("inventoryRest.stocktakes.detail.postAdjustment")}</Button>
            )}
            {["draft", "counting", "submitted", "approved"].includes(d.status) && canApprove && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDialog("cancel")}><Ban className="h-4 w-4" /> {t("inventoryRest.stocktakes.detail.cancel")}</Button>
            )}
            {d.status === "draft" && canApprove && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => m.remove.mutate({ id: d.id }, { onSuccess: () => onClose(), onError })}><Trash2 className="h-4 w-4" /> {t("inventoryRest.stocktakes.detail.delete")}</Button>
            )}
          </div>
        </div>
      )}

      <ReasonDialog open={dialog === "recount"} title={t("inventoryRest.stocktakes.detail.recountDialogTitle")} description={t("inventoryRest.stocktakes.detail.recountDialogBody")} confirmLabel={t("inventoryRest.stocktakes.detail.recountDialogConfirm")} tone="primary" pending={m.requestRecount.isPending} error={null}
        onClose={() => setDialog(null)} onConfirm={(reason) => d && m.requestRecount.mutate({ id: d.id, reason, expectedVersion: ev() }, { onSuccess: () => { setDialog(null); q.refetch(); }, onError })} />
      <ReasonDialog open={dialog === "cancel"} title={t("inventoryRest.stocktakes.detail.cancelDialogTitle")} description={t("inventoryRest.stocktakes.detail.cancelDialogBody")} confirmLabel={t("inventoryRest.stocktakes.detail.cancelDialogConfirm")} tone="danger" pending={m.cancel.isPending} error={null}
        onClose={() => setDialog(null)} onConfirm={(reason) => d && m.cancel.mutate({ id: d.id, reason, expectedVersion: ev() }, { onSuccess: () => { setDialog(null); onClose(); }, onError })} />
    </Drawer>
  );
}

function Field({ k, v, full }: { k: string; v: string; full?: boolean }) {
  return <div className={full ? "col-span-2" : ""}><div className="text-[10px] font-bold text-slate-400">{k}</div><div className="mt-0.5 font-bold text-slate-700">{v}</div></div>;
}
