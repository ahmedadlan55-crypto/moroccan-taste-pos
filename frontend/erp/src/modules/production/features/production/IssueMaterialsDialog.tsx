import { useEffect, useMemo, useState } from "react";
import { PackageMinus, TriangleAlert } from "lucide-react";
import { Button, FullPageFlow } from "@/shared/ui";
import { useCan } from "@/modules/inventory/lib/permission-provider";
import { formatCurrency, formatQty } from "@/shared/lib";
import { useProductionMutations } from "@/modules/inventory/lib/hooks/useProduction";
import type { ProductionDetail } from "@/modules/inventory/lib/adapters/production.adapter";
import { ApiError } from "@/shared/api";
import { useT, useLang } from "@/i18n";

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
  const t = useT();
  const lang = useLang();
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
      title={t("production.issue.title", { number: detail.order.number })}
      description={t("production.issue.description", { warehouse: detail.order.warehouseName })}
      eyebrow={t("production.list.title")}
      icon={PackageMinus}
      size="lg"
      dismissable={!issueMaterials.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={issueMaterials.isPending}>{t("common.cancel")}</Button>
          <Button
            variant="primary"
            disabled={issueMaterials.isPending || lines.length === 0 || (overIssue && !allowOverIssue)}
            onClick={() => void submit()}
          >
            {issueMaterials.isPending ? t("production.issue.submitting") : t("production.issue.submit")}
          </Button>
        </>
      }
    >
      {/* shared/ui FullPageFlow pins dir="rtl" on its own root and lives outside
          this module — override it on our content so the overlay follows the
          active UI language instead of always rendering RTL. */}
      <div dir={lang === "ar" ? "rtl" : "ltr"}>
      <section className="surface overflow-hidden">
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs font-bold text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-start">{t("production.issue.col.material")}</th>
                    <th className="px-3 py-2 text-start">{t("production.issue.col.planned")}</th>
                    <th className="px-3 py-2 text-start">{t("production.issue.col.issued")}</th>
                    <th className="px-3 py-2 text-start">{t("production.issue.col.remaining")}</th>
                    <th className="px-3 py-2 text-start">{t("production.issue.col.available")}</th>
                    <th className="px-3 py-2 text-start">{t("production.issue.col.thisIssueQty")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {detail.plan.map((p) => (
                    <tr key={p.itemId}>
                      <td className="px-3 py-2 font-bold text-slate-800">
                        {p.itemName}
                        {p.trackingMode !== "none" && <span className="ms-2 rounded-md bg-sky-50 px-1.5 py-0.5 text-[10px] font-bold text-sky-700">FEFO</span>}
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
                          aria-label={t("production.issue.qtyAria", { name: p.itemName })}
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
                {t("production.issue.laborLabel")}
                <input type="number" min="0" step="any" dir="ltr" className="field mt-1 w-full tabular-nums" value={laborCost} onChange={(e) => setLaborCost(e.target.value)} aria-label={t("production.issue.laborAria")} />
              </label>
              <label className="block text-xs font-bold text-slate-500">
                {t("production.issue.overheadLabel")}
                <input type="number" min="0" step="any" dir="ltr" className="field mt-1 w-full tabular-nums" value={overheadCost} onChange={(e) => setOverheadCost(e.target.value)} aria-label={t("production.issue.overheadAria")} />
              </label>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-center">
                <div className="text-[11px] font-bold text-slate-400">{t("production.issue.estValue")}</div>
                <div className="mt-0.5 font-extrabold tabular-nums text-slate-900">{formatCurrency(total)}</div>
              </div>
            </div>

            <label className="mt-3 block text-xs font-bold text-slate-500">
              {t("production.issue.reasonLabel")}
              <input className="field mt-1 w-full" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("production.issue.reasonPlaceholder")} aria-label={t("production.issue.reasonAria")} />
            </label>

            {overIssue && (
              <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-bold text-amber-800">
                <TriangleAlert className="me-1 inline h-4 w-4" />
                {t("production.issue.overIssueWarn")}
                {isMgr ? (
                  <label className="mt-2 flex items-center gap-2 font-bold">
                    <input type="checkbox" checked={allowOverIssue} onChange={(e) => setAllowOverIssue(e.target.checked)} />
                    {t("production.issue.overIssueAck")}
                  </label>
                ) : (
                  <div className="mt-1 font-medium">{t("production.issue.overIssueNoPerm")}</div>
                )}
              </div>
            )}

            {needsAck && (
              <label className="mt-3 flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-bold text-rose-800">
                <input type="checkbox" checked={acknowledgeNegative} onChange={(e) => setAcknowledgeNegative(e.target.checked)} />
                {t("production.issue.negativeAck")}
              </label>
            )}

            {errMsg && !needsAck && <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{errMsg}</p>}

        </div>
      </section>
      </div>
    </FullPageFlow>
  );
}
