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
import { stocktakeStatusToLabel } from "@/modules/inventory/lib/status-labels";
import { useStocktakeDetail, useStocktakeMutations } from "@/modules/inventory/lib/hooks/useStocktakes";
import { printStocktake } from "./printStocktake";

const ACTION_LABEL: Record<string, string> = { create: "إنشاء", edit: "تعديل", start: "بدء العد", submit: "تقديم", "request-recount": "إعادة عد", approve: "اعتماد", post: "ترحيل", cancel: "إلغاء", delete: "حذف", scope: "تحديد الأصناف" };

export function StocktakeDetailDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
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
    setErr(e instanceof ApiError ? (e.isConflict ? "تغيّرت البيانات منذ آخر تحميل — أُعيد التحميل، حاول مجددًا." : e.message) : "تعذّر تنفيذ الإجراء.");
    if (e instanceof ApiError && e.isConflict) q.refetch();
  }
  const ev = () => (d ? d.version : undefined);

  return (
    <Drawer open={!!id} onClose={onClose} title={d?.number ?? "محضر الجرد"} eyebrow="الجرد والتسويات" icon={ClipboardCheck}>
      {!d ? (q.isLoading ? <LoadingState rows={3} /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : null) : (
        <div className="space-y-5">
          <div className="flex items-center gap-2">
            <StatusBadge>{stocktakeStatusToLabel(d.status)}</StatusBadge>
            <span className="text-xs font-bold text-slate-400">الإصدار {d.version}</span>
            {d.blindCount && <span className="rounded-lg bg-violet-50 px-2 py-0.5 text-[10px] font-extrabold text-violet-700">عدّ أعمى</span>}
          </div>

          {err && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">{err}</p>}

          <div className="grid grid-cols-2 gap-3 text-sm">
            <Field k="المستودع" v={d.warehouse.name} />
            <Field k="التاريخ" v={formatDate(d.date)} />
            <Field k="النطاق" v={d.scopeType === "full" ? "كامل المستودع" : d.scopeType === "category" ? "حسب الفئة" : "أصناف محددة"} />
            <Field k="المعدود / الإجمالي" v={`${formatQty(d.countedLines)} / ${formatQty(d.totalLines)}`} />
            <Field k="أسطر الفروقات" v={formatQty(d.varianceLines)} />
            <Field k="إجمالي قيمة الفرق" v={formatCurrency(d.totalVarianceValue)} />
            {d.reason && <Field k="السبب" v={d.reason} full />}
            {d.referenceEvidence && <Field k="الدليل/المرجع" v={d.referenceEvidence} full />}
            {d.adjustmentNumber && <Field k="تسوية مرتبطة" v={d.adjustmentNumber} full />}
            {d.recountReason && <Field k="سبب إعادة العد" v={d.recountReason} full />}
          </div>

          {/* Variance review */}
          <section>
            <h4 className="mb-2 text-xs font-extrabold text-slate-500">مراجعة الفروقات</h4>
            <div className="overflow-x-auto rounded-xl border border-slate-100">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500"><tr>
                  <th className="px-2 py-2 text-right">الصنف</th><th>اللقطة</th><th>حركات العد</th><th>النظري</th><th>المعدود</th><th>فرق</th><th>قيمة</th>
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
              <h4 className="mb-2 text-xs font-extrabold text-slate-500">الحركات المخزنية (التسوية)</h4>
              <div className="space-y-1">
                {d.movements.map((mv) => (
                  <div key={mv.id} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-1.5 text-xs">
                    <span className={`font-bold ${mv.type === "in" ? "text-emerald-700" : "text-rose-700"}`}>{mv.type === "in" ? "وارد" : "صادر"} {formatQty(mv.qty)}</span>
                    <span className="text-slate-400">{mv.referenceType}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
          {d.journals.length > 0 && (
            <section>
              <h4 className="mb-2 text-xs font-extrabold text-slate-500">القيد المحاسبي</h4>
              {d.journals.map((j) => (
                <div key={j.id} className="rounded-xl border border-slate-100 p-3 text-xs">
                  <div className="mb-1 flex justify-between font-bold text-slate-600"><span>{j.number}</span><span>مدين {formatCurrency(j.totalDebit)} / دائن {formatCurrency(j.totalCredit)}</span></div>
                  {j.entries.map((e, i) => (
                    <div key={i} className="flex justify-between text-slate-500"><span>{e.accountCode} {e.accountName}</span><span className="tabular-nums">{e.debit > 0 ? `مدين ${formatCurrency(e.debit)}` : `دائن ${formatCurrency(e.credit)}`}</span></div>
                  ))}
                </div>
              ))}
            </section>
          )}

          {/* Timeline */}
          <section>
            <h4 className="mb-2 text-xs font-extrabold text-slate-500">السجل الزمني</h4>
            <ol className="space-y-2">
              {d.timeline.map((e, i) => (
                <li key={i} className="flex items-start gap-2 text-xs">
                  <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-teal-500" />
                  <div><span className="font-bold text-slate-700">{ACTION_LABEL[e.action] ?? e.action}</span><span className="text-slate-400"> · {e.actor} · {formatDate(e.at)}</span>{e.note && <div className="text-slate-500">{e.note}</div>}</div>
                </li>
              ))}
            </ol>
          </section>

          {/* Actions (status + permission driven) */}
          <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-4">
            <Button variant="secondary" size="sm" onClick={() => printStocktake(d, "count")}><Printer className="h-4 w-4" /> ورقة عد</Button>
            {d.countedLines > 0 && <Button variant="secondary" size="sm" onClick={() => printStocktake(d, "variance")}><FileText className="h-4 w-4" /> تقرير الفروقات</Button>}

            {d.status === "draft" && (
              <Button variant="primary" size="sm" disabled={busy} onClick={() => m.start.mutate({ id: d.id, expectedVersion: ev() }, { onSuccess: () => navigate(`/inventory/stocktakes?count=${d.id}`), onError })}><Play className="h-4 w-4" /> بدء العد</Button>
            )}
            {d.status === "counting" && (
              <>
                <Button variant="primary" size="sm" onClick={() => navigate(`/inventory/stocktakes?count=${d.id}`)}><ClipboardCheck className="h-4 w-4" /> متابعة العد</Button>
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => m.submit.mutate({ id: d.id, expectedVersion: ev() }, { onSuccess: () => q.refetch(), onError })}><Send className="h-4 w-4" /> تقديم للاعتماد</Button>
              </>
            )}
            {d.status === "submitted" && (
              <>
                {canApprove && <Button variant="secondary" size="sm" disabled={busy} onClick={() => setDialog("recount")}><Undo2 className="h-4 w-4" /> إعادة عد</Button>}
                {canApprove && <Button variant="primary" size="sm" disabled={busy} onClick={() => m.approve.mutate({ id: d.id, expectedVersion: ev() }, { onSuccess: () => q.refetch(), onError })}><CheckCircle2 className="h-4 w-4" /> اعتماد</Button>}
              </>
            )}
            {d.status === "approved" && canPost && (
              <Button variant="primary" size="sm" disabled={busy} onClick={() => m.post.mutate({ id: d.id, expectedVersion: ev() }, { onSuccess: () => q.refetch(), onError })}><CheckCircle2 className="h-4 w-4" /> ترحيل التسوية</Button>
            )}
            {["draft", "counting", "submitted", "approved"].includes(d.status) && canApprove && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDialog("cancel")}><Ban className="h-4 w-4" /> إلغاء</Button>
            )}
            {d.status === "draft" && canApprove && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => m.remove.mutate({ id: d.id }, { onSuccess: () => onClose(), onError })}><Trash2 className="h-4 w-4" /> حذف</Button>
            )}
          </div>
        </div>
      )}

      <ReasonDialog open={dialog === "recount"} title="طلب إعادة عد" description="سيعود المحضر إلى حالة العد. اذكر السبب." confirmLabel="إعادة العد" tone="primary" pending={m.requestRecount.isPending} error={null}
        onClose={() => setDialog(null)} onConfirm={(reason) => d && m.requestRecount.mutate({ id: d.id, reason, expectedVersion: ev() }, { onSuccess: () => { setDialog(null); q.refetch(); }, onError })} />
      <ReasonDialog open={dialog === "cancel"} title="إلغاء المحضر" description="لا يمكن التراجع. اذكر سبب الإلغاء." confirmLabel="تأكيد الإلغاء" tone="danger" pending={m.cancel.isPending} error={null}
        onClose={() => setDialog(null)} onConfirm={(reason) => d && m.cancel.mutate({ id: d.id, reason, expectedVersion: ev() }, { onSuccess: () => { setDialog(null); onClose(); }, onError })} />
    </Drawer>
  );
}

function Field({ k, v, full }: { k: string; v: string; full?: boolean }) {
  return <div className={full ? "col-span-2" : ""}><div className="text-[10px] font-bold text-slate-400">{k}</div><div className="mt-0.5 font-bold text-slate-700">{v}</div></div>;
}
