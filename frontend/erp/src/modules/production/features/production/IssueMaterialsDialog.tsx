import { useEffect, useMemo, useState } from "react";
import { PackageMinus, TriangleAlert } from "lucide-react";
import { Button, FullPageFlow } from "@/shared/ui";
import { useCan } from "@/modules/inventory/lib/permission-provider";
import { formatCurrency, formatQty } from "@/shared/lib";
import { useProductionMutations } from "@/modules/inventory/lib/hooks/useProduction";
import type { ProductionDetail } from "@/modules/inventory/lib/adapters/production.adapter";
import { ApiError } from "@/shared/api";

// Partial materials issue: pre-fills each plan line's REMAINING qty, lets the
// user issue any subset (FEFO allocation happens server-side for tracked
// items), and captures labor/overhead for THIS event. Over-issue beyond the
// tolerance needs a manager + reason (allowOverIssue). The negative-stock
// policy may also ask for an explicit acknowledgment.
export function IssueMaterialsDialog({
  open, detail, onClose, onDone,
}: {
  open: boolean;
  detail: ProductionDetail;
  onClose: () => void;
  onDone: () => void;
}) {
  const { issueMaterials } = useProductionMutations();
  const isMgr = useCan("production.approve"); // manager/admin mirror
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [laborCost, setLaborCost] = useState("");
  const [overheadCost, setOverheadCost] = useState("");
  const [reason, setReason] = useState("");
  const [allowOverIssue, setAllowOverIssue] = useState(false);
  const [acknowledgeNegative, setAcknowledgeNegative] = useState(false);

  useEffect(() => {
    if (!open) return;
    const init: Record<string, string> = {};
    for (const p of detail.plan) init[p.itemId] = p.remaining > 0 ? String(p.remaining) : "";
    setQtys(init);
    setLaborCost(""); setOverheadCost(""); setReason("");
    setAllowOverIssue(false); setAcknowledgeNegative(false);
    issueMaterials.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const lines = useMemo(
    () => detail.plan
      .map((p) => ({ itemId: p.itemId, qty: Number(qtys[p.itemId]) || 0 }))
      .filter((l) => l.qty > 0),
    [detail.plan, qtys],
  );
  const total = useMemo(() => {
    let t = Number(laborCost) || 0;
    t += Number(overheadCost) || 0;
    for (const p of detail.plan) t += (Number(qtys[p.itemId]) || 0) * p.unitCost;
    return t;
  }, [detail.plan, qtys, laborCost, overheadCost]);

  const overIssue = useMemo(
    () => detail.plan.some((p) => (Number(qtys[p.itemId]) || 0) > Math.max(p.remaining, 0) + 1e-9),
    [detail.plan, qtys],
  );

  const err = issueMaterials.error instanceof ApiError ? issueMaterials.error : null;
  const errMsg = err ? err.message : issueMaterials.error?.message ?? null;
  const needsAck = err?.code === "NEGATIVE_CONFIRMATION_REQUIRED";

  async function submit() {
    await issueMaterials.mutateAsync({
      id: detail.order.id,
      lines,
      laborCost: Number(laborCost) || 0,
      overheadCost: Number(overheadCost) || 0,
      reason: reason.trim() || undefined,
      allowOverIssue: allowOverIssue || undefined,
      acknowledgeNegative: acknowledgeNegative || undefined,
      expectedVersion: detail.order.version,
    });
    onDone();
  }

  return (
    <FullPageFlow
      open={open}
      onClose={onClose}
      title={`إصدار مواد — ${detail.order.number}`}
      description={`يخصم من ${detail.order.warehouseName} بتكلفة WAC لحظة الإصدار؛ المواد المتتبعة تُخصص FEFO تلقائيًا.`}
      eyebrow="أوامر الإنتاج"
      icon={PackageMinus}
      size="lg"
      dismissable={!issueMaterials.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={issueMaterials.isPending}>إلغاء</Button>
          <Button
            variant="primary"
            disabled={issueMaterials.isPending || lines.length === 0 || (overIssue && !allowOverIssue)}
            onClick={() => void submit()}
          >
            {issueMaterials.isPending ? "جارٍ الإصدار…" : "إصدار المواد"}
          </Button>
        </>
      }
    >
      <section className="surface overflow-hidden">
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs font-bold text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-right">المادة</th>
                    <th className="px-3 py-2 text-right">المخطط</th>
                    <th className="px-3 py-2 text-right">صُرف</th>
                    <th className="px-3 py-2 text-right">المتبقي</th>
                    <th className="px-3 py-2 text-right">المتاح</th>
                    <th className="px-3 py-2 text-right">كمية هذا الإصدار</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {detail.plan.map((p) => (
                    <tr key={p.itemId}>
                      <td className="px-3 py-2 font-bold text-slate-800">
                        {p.itemName}
                        {p.trackingMode !== "none" && <span className="mr-2 rounded-md bg-sky-50 px-1.5 py-0.5 text-[10px] font-bold text-sky-700">FEFO</span>}
                      </td>
                      <td className="px-3 py-2 tabular-nums text-slate-600">{formatQty(p.qtyPlanned, p.itemUnit)}</td>
                      <td className="px-3 py-2 tabular-nums text-slate-600">{formatQty(p.qtyIssued)}</td>
                      <td className="px-3 py-2 font-bold tabular-nums text-slate-800">{formatQty(Math.max(p.remaining, 0))}</td>
                      <td className={`px-3 py-2 tabular-nums ${p.available < p.remaining ? "font-bold text-rose-600" : "text-slate-600"}`}>{formatQty(p.available)}</td>
                      <td className="px-3 py-2">
                        <input
                          type="number" min="0" step="any" dir="ltr"
                          className="field w-28 tabular-nums"
                          value={qtys[p.itemId] ?? ""}
                          onChange={(e) => setQtys((s) => ({ ...s, [p.itemId]: e.target.value }))}
                          aria-label={`كمية ${p.itemName}`}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

        <div className="border-t border-slate-200 p-5 sm:p-6">
            <div className="grid gap-4 sm:grid-cols-3">
              <label className="block text-xs font-bold text-slate-500">
                تكلفة عمالة (اختياري)
                <input type="number" min="0" step="any" dir="ltr" className="field mt-1 w-full tabular-nums" value={laborCost} onChange={(e) => setLaborCost(e.target.value)} aria-label="تكلفة العمالة" />
              </label>
              <label className="block text-xs font-bold text-slate-500">
                تكاليف غير مباشرة (اختياري)
                <input type="number" min="0" step="any" dir="ltr" className="field mt-1 w-full tabular-nums" value={overheadCost} onChange={(e) => setOverheadCost(e.target.value)} aria-label="تكاليف غير مباشرة" />
              </label>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-center">
                <div className="text-[11px] font-bold text-slate-400">قيمة الحدث التقديرية</div>
                <div className="mt-0.5 font-extrabold tabular-nums text-slate-900">{formatCurrency(total)}</div>
              </div>
            </div>

            <label className="mt-3 block text-xs font-bold text-slate-500">
              سبب/ملاحظة الإصدار
              <input className="field mt-1 w-full" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="مثال: دفعة الصباح" aria-label="سبب الإصدار" />
            </label>

            {overIssue && (
              <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-bold text-amber-800">
                <TriangleAlert className="ml-1 inline h-4 w-4" />
                كمية تتجاوز المتبقي المخطط — يتطلب تجاوزًا صريحًا من مدير مع سبب.
                {isMgr ? (
                  <label className="mt-2 flex items-center gap-2 font-bold">
                    <input type="checkbox" checked={allowOverIssue} onChange={(e) => setAllowOverIssue(e.target.checked)} />
                    أقرّ بتجاوز الكمية المخططة (صلاحية مدير)
                  </label>
                ) : (
                  <div className="mt-1 font-medium">ليست لديك صلاحية التجاوز — قلّل الكمية أو اطلب مديرًا.</div>
                )}
              </div>
            )}

            {needsAck && (
              <label className="mt-3 flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-bold text-rose-800">
                <input type="checkbox" checked={acknowledgeNegative} onChange={(e) => setAcknowledgeNegative(e.target.checked)} />
                أُدرك أن هذا الإصدار سيجعل الرصيد سالبًا وفق سياسة المخزون — تأكيد صريح.
              </label>
            )}

            {errMsg && !needsAck && <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{errMsg}</p>}

        </div>
      </section>
    </FullPageFlow>
  );
}
