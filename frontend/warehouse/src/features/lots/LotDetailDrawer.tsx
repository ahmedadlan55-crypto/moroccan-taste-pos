import { useState } from "react";
import { Boxes, ShieldX, ShieldCheck, AlertOctagon } from "lucide-react";
import { Drawer } from "@/components/drawer/Drawer";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge/StatusBadge";
import { LoadingState, ErrorState } from "@/components/states/States";
import { ApiError } from "@/lib/api-error";
import { useCan } from "@/app/permission-provider";
import { formatQty, formatDate } from "@/lib/formatters";
import { lotStatusToLabel, expiryClassToLabel } from "@/lib/status-labels";
import { useLotDetail, useLotMovements, useLotTrace, useLotMutations } from "@/lib/hooks/useLots";
import { ReasonDialog } from "@/features/_shared/ReasonDialog";

const TABS = [
  { id: "basics", label: "البيانات الأساسية" },
  { id: "warehouses", label: "توزيع المستودعات" },
  { id: "trace", label: "التتبّع" },
  { id: "movements", label: "الحركات" },
] as const;
type TabId = (typeof TABS)[number]["id"];
const REF_LABEL: Record<string, string> = {
  inv_receipt: "استلام", inv_issue: "صرف", inv_adjustment: "تعديل", transfer_out: "تحويل صادر", transfer_in: "تحويل وارد",
  production_consume: "استهلاك إنتاج", production_output: "إنتاج", sale: "بيع", stocktake: "جرد", opening: "افتتاحي", lot_import: "ترحيل",
};
function refLabel(t: string | null): string { return t ? (REF_LABEL[t.replace(/_reverse$/, "")] ?? t) + (/_reverse$/.test(t) ? " (عكس)" : "") : "—"; }

export function LotDetailDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useLotDetail(id);
  const trace = useLotTrace(id);
  const mv = useLotMovements(id);
  const m = useLotMutations();
  const canQ = useCan("lot.quarantine");
  const canR = useCan("lot.recall");
  const [tab, setTab] = useState<TabId>("basics");
  const [err, setErr] = useState<string | null>(null);
  const d = q.data?.lot;
  const busy = m.quarantine.isPending || m.release.isPending || m.recall.isPending;

  const [pendingAct, setPendingAct] = useState<null | "quarantine" | "release" | "recall">(null);
  const ACT_META = {
    quarantine: { title: "حجر الدفعة", desc: "الدفعة المحجورة تُستثنى من FEFO ولا تُصرف حتى الإفراج.", label: "حجر" },
    release: { title: "الإفراج عن الدفعة", desc: "تعود الدفعة متاحة للصرف ضمن ترتيب FEFO.", label: "إفراج" },
    recall: { title: "استدعاء الدفعة", desc: "الاستدعاء نهائي — راجع تبويب التتبع لمعرفة المستندات المتأثرة.", label: "استدعاء" },
  } as const;
  function confirmAct(kind: "quarantine" | "release" | "recall", reason: string) {
    if (!d) return;
    setErr(null);
    m[kind].mutate({ id: d.id, reason, expectedVersion: d.version }, {
      onSuccess: () => { setPendingAct(null); q.refetch(); trace.refetch(); },
      onError: (e) => { setPendingAct(null); setErr(e instanceof ApiError ? (e.isConflict ? "تغيّرت الدفعة منذ آخر تحميل — أعد المحاولة." : e.message) : "تعذّر تنفيذ الإجراء."); },
    });
  }
  function act(kind: "quarantine" | "release" | "recall") { setPendingAct(kind); }

  return (
    <Drawer open={!!id} onClose={onClose} title={d ? `الدفعة ${d.lotNumber}` : "تفاصيل الدفعة"} eyebrow="كتالوج الدفعات" icon={Boxes}>
      {!d ? (q.isLoading ? <LoadingState rows={3} /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : null) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge>{lotStatusToLabel(d.lifecycleStatus)}</StatusBadge>
            <StatusBadge>{expiryClassToLabel(d.expiryClass)}</StatusBadge>
            <span className="text-xs font-bold text-slate-400">الإصدار {d.version}</span>
            {d.isImported && <span className="text-xs font-bold text-amber-600">مُرحّلة</span>}
          </div>
          {err && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">{err}</p>}

          <div className="flex flex-wrap gap-1 border-b border-slate-100 pb-2">
            {TABS.map((t) => (
              <button key={t.id} type="button" onClick={() => setTab(t.id)}
                className={`rounded-lg px-3 py-1.5 text-xs font-extrabold transition ${tab === t.id ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-100"}`}>{t.label}</button>
            ))}
          </div>

          {tab === "basics" && (
            <div className="grid grid-cols-2 gap-3 text-sm">
              <F k="رقم الدفعة" v={d.lotNumber} /><F k="الصنف" v={d.itemName} />
              <F k="تاريخ الصلاحية" v={d.expiryDate || "—"} /><F k="أيام متبقية" v={d.daysToExpiry == null ? "—" : String(d.daysToExpiry)} />
              <F k="تاريخ الإنتاج" v={d.manufactureDate || "—"} /><F k="إجمالي الرصيد" v={formatQty(d.totalQty)} />
              <F k="المصدر" v={refLabel(d.sourceType)} /><F k="مرجع المصدر" v={d.sourceId || "—"} />
              {d.notes && <F k="ملاحظات" v={d.notes} full />}
            </div>
          )}

          {tab === "warehouses" && (
            <div className="space-y-1">
              {q.data?.distribution.length === 0 ? <p className="text-sm text-slate-400">لا يوجد رصيد في أي مستودع.</p> : q.data?.distribution.map((w) => (
                <div key={w.warehouseId} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm">
                  <span className="font-bold text-slate-700">{w.warehouseName}</span><span className="tabular-nums text-slate-600">{formatQty(w.qty)}</span>
                </div>
              ))}
            </div>
          )}

          {tab === "trace" && (
            trace.isLoading ? <LoadingState rows={2} /> : (
              <div className="space-y-4">
                {trace.data && trace.data.recallImpact.length > 0 && (
                  <div className="rounded-xl border border-rose-100 bg-rose-50/60 p-3 text-xs text-rose-900">
                    <div className="mb-1 font-extrabold">المستندات المتأثرة عند الاستدعاء</div>
                    <ul className="list-disc space-y-0.5 pr-5">{trace.data.recallImpact.map((r, i) => <li key={i}>{refLabel(r.referenceType)} {r.referenceId || ""} — {formatQty(r.qty)}</li>)}</ul>
                  </div>
                )}
                <ol className="space-y-2">
                  {(trace.data?.timeline ?? []).map((e, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs">
                      <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${e.signedQty >= 0 ? "bg-emerald-500" : "bg-sky-500"}`} />
                      <div>
                        <span className="font-bold text-slate-700">{refLabel(e.referenceType)} · {e.warehouseName}</span>
                        <span className={`font-extrabold ${e.signedQty >= 0 ? "text-emerald-700" : "text-sky-700"}`}> {e.signedQty >= 0 ? "+" : "−"}{formatQty(Math.abs(e.signedQty))}</span>
                        <span className="text-slate-400"> · {e.actor || "—"} · {formatDate(e.at)}</span>
                      </div>
                    </li>
                  ))}
                  {(trace.data?.timeline ?? []).length === 0 && <p className="text-sm text-slate-400">لا توجد حركات للدفعة.</p>}
                </ol>
              </div>
            )
          )}

          {tab === "movements" && (
            mv.isLoading ? <LoadingState rows={2} /> : (
              <div className="space-y-1">
                {(mv.data ?? []).length === 0 ? <p className="text-sm text-slate-400">لا توجد حركات.</p> : (mv.data ?? []).map((r) => (
                  <div key={r.id} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-1.5 text-xs">
                    <span>{refLabel(r.referenceType)} · {r.warehouseName} · {formatDate(r.occurredAt)}</span>
                    <span className={`font-bold ${r.signedQty >= 0 ? "text-emerald-700" : "text-sky-700"}`}>{r.signedQty >= 0 ? "+" : "−"}{formatQty(Math.abs(r.signedQty))}</span>
                  </div>
                ))}
              </div>
            )
          )}

          <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-4">
            {canQ && d.lifecycleStatus === "active" && <Button variant="secondary" size="sm" disabled={busy} onClick={() => act("quarantine")}><ShieldX className="h-4 w-4" /> حجر</Button>}
            {canQ && d.lifecycleStatus === "quarantined" && <Button variant="primary" size="sm" disabled={busy} onClick={() => act("release")}><ShieldCheck className="h-4 w-4" /> إفراج</Button>}
            {canR && (d.lifecycleStatus === "active" || d.lifecycleStatus === "quarantined") && <Button variant="danger" size="sm" disabled={busy} onClick={() => act("recall")}><AlertOctagon className="h-4 w-4" /> استدعاء</Button>}
            <Button variant="ghost" size="sm" onClick={() => window.print()}>طباعة بطاقة الدفعة</Button>
          </div>

          <ReasonDialog
            open={!!pendingAct}
            title={pendingAct ? ACT_META[pendingAct].title : ""}
            description={pendingAct ? ACT_META[pendingAct].desc : undefined}
            confirmLabel={pendingAct ? ACT_META[pendingAct].label : "تأكيد"}
            tone={pendingAct === "recall" ? "danger" : "primary"}
            pending={busy}
            error={null}
            onConfirm={(reason) => pendingAct && confirmAct(pendingAct, reason)}
            onClose={() => setPendingAct(null)}
          />
        </div>
      )}
    </Drawer>
  );
}

function F({ k, v, full }: { k: string; v: string; full?: boolean }) {
  return <div className={full ? "col-span-2" : ""}><div className="text-[10px] font-bold text-slate-400">{k}</div><div className="mt-0.5 font-bold text-slate-700">{v}</div></div>;
}
