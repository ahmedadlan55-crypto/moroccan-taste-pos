import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Search, Printer, Download, AlertTriangle, ClipboardList, Wallet, Info } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/metric-card/MetricCard";
import { StatusBadge } from "@/components/status-badge/StatusBadge";
import { Button } from "@/components/ui/button";
import { LoadingState, EmptyState, ErrorState } from "@/components/states/States";
import { useWarehouses } from "@/lib/hooks/useWarehouses";
import { useWarehouseScope } from "@/app/warehouse-scope-provider";
import { getToken } from "@/lib/api-client";
import { formatCurrency, formatNumber, formatQty } from "@/lib/formatters";
import { reorderStatusToLabel, stockoutRiskToLabel, REORDER_STATUS_OPTIONS, STOCKOUT_RISK_OPTIONS } from "@/lib/status-labels";
import { useReplenishment, useReplenishmentSummary } from "@/lib/hooks/useReplenishment";

const PAGE_SIZES = [25, 50, 100];

async function exportCsv(params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  const token = getToken();
  const res = await fetch(`/api/inventory/v2/replenishment/export${qs ? `?${qs}` : ""}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, credentials: "same-origin" });
  if (!res.ok) throw new Error("تعذّر التصدير");
  const blob = await res.blob(); const href = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = href; a.download = `replenishment-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(href);
}

export function ReplenishmentPage() {
  const [params, setParams] = useSearchParams();
  const { accessibleWarehouses, allWarehousesAccess } = useWarehouseScope();
  const allWh = useWarehouses();
  const q = params.get("q") ?? "";
  const warehouseId = params.get("wh") ?? "";
  const status = params.get("status") ?? "";
  const risk = params.get("risk") ?? "";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = PAGE_SIZES.includes(Number(params.get("pageSize"))) ? Number(params.get("pageSize")) : 25;
  const [showHow, setShowHow] = useState(false);
  const [expErr, setExpErr] = useState<string | null>(null);

  function patch(next: Record<string, string | number | null>, resetPage = true) {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) { if (v === null || v === "") p.delete(k); else p.set(k, String(v)); }
    if (resetPage && !("page" in next)) p.delete("page");
    setParams(p, { replace: true });
  }
  const { data, isLoading, isError, error, refetch, isFetching } = useReplenishment({ q, warehouseId, status, risk, page, pageSize });
  const summary = useReplenishmentSummary({ warehouseId });
  const whOptions = useMemo(() => allWarehousesAccess ? (allWh.data?.warehouses ?? []).map((w) => ({ id: w.id, name: w.name })) : accessibleWarehouses.map((w) => ({ id: w.id, name: w.name })), [allWarehousesAccess, accessibleWarehouses, allWh.data]);
  const pg = data?.pagination; const totalPages = pg?.totalPages ?? 1; const s = summary.data;

  return (
    <div>
      <PageHeader eyebrow="ذكاء المخزون" title="خطة إعادة الطلب" subtitle="توصيات إعادة الطلب حسب القواعد والاستهلاك — للاسترشاد فقط، لا تُنشئ أمر شراء."
        action={<div className="no-print flex gap-2">
          <Button variant="secondary" onClick={() => setShowHow((v) => !v)}><Info className="h-4 w-4" /> كيف تُحسب؟</Button>
          <Button variant="secondary" onClick={() => exportCsv({ ...(warehouseId ? { warehouseId } : {}), ...(risk ? { risk } : {}), ...(q ? { q } : {}) }).catch(() => setExpErr("تعذّر التصدير"))}><Download className="h-4 w-4" /> CSV</Button>
          <Button variant="secondary" onClick={() => window.print()}><Printer className="h-4 w-4" /> طباعة</Button>
        </div>} />

      {showHow && (
        <div className="no-print mb-4 rounded-2xl border border-blue-100 bg-blue-50/60 p-4 text-sm text-blue-900">
          <div className="mb-1 font-extrabold">طريقة حساب التوصية ({s?.lookbackDays ?? 30} يومًا)</div>
          <ul className="list-disc space-y-1 pr-5 text-xs font-medium">
            <li>متوسط الصرف اليومي = إجمالي الصادر خلال الفترة ÷ عدد الأيام.</li>
            <li>أيام التغطية = الرصيد ÷ متوسط الصرف اليومي (تُترك فارغة إن لم يوجد صرف).</li>
            <li>إن كان الرصيد ≤ نقطة إعادة الطلب: الهدف = الحد الأقصى (أو نقطة إعادة الطلب + كمية إعادة الطلب)، والكمية المقترحة = الأكبر بين كمية إعادة الطلب و(الهدف − الرصيد).</li>
            <li>مخاطر النفاد تُقارن أيام التغطية بمهلة التوريد. هذه توصيات فقط ولا تُنشئ أمر شراء.</li>
          </ul>
        </div>
      )}

      <section className="grid gap-4 sm:grid-cols-3">
        <MetricCard label="أصناف تحتاج إعادة طلب" value={formatNumber(s?.reorderItems ?? 0)} note="الرصيد ≤ نقطة إعادة الطلب" icon={AlertTriangle} tone="rose" />
        <MetricCard label="إجمالي الكمية المقترحة" value={formatCurrency(s?.recommendedValue ?? 0)} note="قيمة تقديرية" icon={Wallet} tone="amber" />
        <MetricCard label="عناصر مرصودة" value={formatNumber(s?.total ?? 0)} note={`خلال ${s?.lookbackDays ?? 30} يومًا`} icon={ClipboardList} tone="blue" />
      </section>

      <section className="no-print surface mt-4 flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <label className="relative flex-1"><Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input className="field w-full pr-10" placeholder="بحث بالاسم أو SKU…" defaultValue={q} onChange={(e) => patch({ q: e.target.value })} aria-label="بحث" /></label>
          <select className="field lg:w-48" value={warehouseId} onChange={(e) => patch({ wh: e.target.value })} aria-label="المستودع"><option value="">كل المستودعات</option>{whOptions.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
          <select className="field lg:w-40" value={status} onChange={(e) => patch({ status: e.target.value })} aria-label="الحالة">{REORDER_STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
          <select className="field lg:w-36" value={risk} onChange={(e) => patch({ risk: e.target.value })} aria-label="المخاطر">{STOCKOUT_RISK_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
        </div>
        {expErr && <p className="text-xs font-bold text-rose-600">{expErr}</p>}
      </section>

      <section className="mt-4">
        {isLoading ? <LoadingState /> : isError ? <ErrorState error={error} onRetry={() => refetch()} /> : !data || data.rows.length === 0 ? (
          <EmptyState title="لا توجد توصيات" body="لا توجد أصناف تطابق عوامل التصفية ضمن نطاقك." />
        ) : (
          <>
            <div className="surface hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs font-bold text-slate-500"><tr>
                  <th className="px-3 py-3 text-right">الصنف</th><th className="px-3 py-3 text-right">المستودع</th><th className="px-3 py-3">الحالي</th><th className="px-3 py-3">حد الطلب</th>
                  <th className="px-3 py-3">المقترح</th><th className="px-3 py-3">أيام التغطية</th><th className="px-3 py-3">المخاطر</th><th className="px-3 py-3">الحالة</th>
                </tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {data.rows.map((r) => (
                    <tr key={r.itemId + r.warehouseId} className={r.recommendedQty > 0 ? "bg-rose-50/40" : ""}>
                      <td className="px-3 py-2 font-bold text-slate-800">{r.name}<span className="mr-2 font-mono text-[10px] text-slate-400">{r.sku}</span></td>
                      <td className="px-3 py-2 text-slate-600">{r.warehouseName}</td>
                      <td className="px-3 py-2 text-center tabular-nums">{formatQty(r.onHand)}</td>
                      <td className="px-3 py-2 text-center tabular-nums text-slate-500">{formatQty(r.reorderPoint)}</td>
                      <td className="px-3 py-2 text-center font-extrabold tabular-nums text-teal-700">{r.recommendedQty > 0 ? formatQty(r.recommendedQty) : "—"}</td>
                      <td className="px-3 py-2 text-center tabular-nums">{r.daysOfCover === null ? "—" : formatNumber(r.daysOfCover)}</td>
                      <td className="px-3 py-2 text-center"><StatusBadge>{stockoutRiskToLabel(r.stockoutRisk)}</StatusBadge></td>
                      <td className="px-3 py-2 text-center"><StatusBadge>{reorderStatusToLabel(r.reorderStatus)}</StatusBadge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="space-y-3 md:hidden">
              {data.rows.map((r) => (
                <div key={r.itemId + r.warehouseId} className="surface p-4">
                  <div className="flex items-center justify-between"><span className="font-extrabold text-slate-900">{r.name}</span><StatusBadge>{reorderStatusToLabel(r.reorderStatus)}</StatusBadge></div>
                  <div className="mt-2 grid grid-cols-2 gap-1 text-xs text-slate-600">
                    <span>الحالي: {formatQty(r.onHand)}</span><span>حد الطلب: {formatQty(r.reorderPoint)}</span>
                    <span className="font-bold text-teal-700">المقترح: {r.recommendedQty > 0 ? formatQty(r.recommendedQty) : "—"}</span><span>التغطية: {r.daysOfCover === null ? "—" : formatNumber(r.daysOfCover)} يوم</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="no-print mt-4 flex items-center justify-between gap-3 text-xs font-medium text-slate-500">
              <span>{formatNumber(pg?.total ?? 0)} عنصر {isFetching && <span className="text-teal-600">· تحديث…</span>}</span>
              <div className="flex items-center gap-2">
                <select className="field min-h-9 py-1 text-xs" value={pageSize} onChange={(e) => patch({ pageSize: e.target.value })} aria-label="حجم الصفحة">{PAGE_SIZES.map((n) => <option key={n} value={n}>{n} / صفحة</option>)}</select>
                <Button variant="ghost" size="icon" aria-label="السابق" disabled={page <= 1} onClick={() => patch({ page: page - 1 }, false)}>‹</Button>
                <span className="font-bold text-slate-600">{formatNumber(page)} / {formatNumber(totalPages)}</span>
                <Button variant="ghost" size="icon" aria-label="التالي" disabled={page >= totalPages} onClick={() => patch({ page: page + 1 }, false)}>›</Button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
