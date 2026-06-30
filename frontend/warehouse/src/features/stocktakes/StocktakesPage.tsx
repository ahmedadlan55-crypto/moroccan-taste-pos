import { useMemo } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, Plus, Search, ClipboardCheck, ClipboardList, AlertTriangle, Wallet } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/metric-card/MetricCard";
import { StatusBadge } from "@/components/status-badge/StatusBadge";
import { Button } from "@/components/ui/button";
import { LoadingState, EmptyState, ErrorState } from "@/components/states/States";
import { useWarehouses } from "@/lib/hooks/useWarehouses";
import { useWarehouseScope } from "@/app/warehouse-scope-provider";
import { useCan } from "@/app/permission-provider";
import { formatCurrency, formatNumber, formatDate } from "@/lib/formatters";
import { stocktakeStatusToLabel, STOCKTAKE_STATUS_OPTIONS } from "@/lib/status-labels";
import { useStocktakeList } from "@/lib/hooks/useStocktakes";
import { StocktakeDetailDrawer } from "./StocktakeDetailDrawer";

const PAGE_SIZES = [10, 25, 50];

export function StocktakesPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { accessibleWarehouses, allWarehousesAccess } = useWarehouseScope();
  const canCreate = useCan("stocktake.create");

  const q = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const warehouseId = params.get("wh") ?? "";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = PAGE_SIZES.includes(Number(params.get("pageSize"))) ? Number(params.get("pageSize")) : 25;
  const view = params.get("view");

  function patch(next: Record<string, string | number | null>, resetPage = true) {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) { if (v === null || v === "") p.delete(k); else p.set(k, String(v)); }
    if (resetPage && !("page" in next)) p.delete("page");
    setParams(p, { replace: true });
  }

  const { data, isLoading, isError, error, refetch, isFetching } = useStocktakeList({ q, status, warehouseId, page, pageSize, sort: "created_at", dir: "desc" });
  const allWh = useWarehouses();
  const whOptions = useMemo(() => {
    if (!allWarehousesAccess) return accessibleWarehouses.map((w) => ({ id: w.id, name: w.name }));
    return (allWh.data?.warehouses ?? []).map((w) => ({ id: w.id, name: w.name }));
  }, [allWarehousesAccess, accessibleWarehouses, allWh.data]);

  const k = data?.kpis;
  const pg = data?.pagination;
  const totalPages = pg?.totalPages ?? 1;
  const from = pg && pg.total > 0 ? (pg.page - 1) * pg.pageSize + 1 : 0;
  const to = pg ? Math.min(pg.page * pg.pageSize, pg.total) : 0;

  return (
    <div>
      <PageHeader eyebrow="الرقابة" title="الجرد والتسويات" subtitle="عدّ محكوم، تسوية الفروقات عبر محرّك التعديل، واعتماد يفصل بين العادّ والمراجع."
        action={canCreate ? <Button variant="primary" onClick={() => navigate("/stocktakes/new")}><Plus className="h-4 w-4" /> جرد جديد</Button> : null} />

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="قيد العد" value={formatNumber(k?.counting ?? 0)} note="جارٍ عدّها الآن" icon={ClipboardCheck} tone="amber" />
        <MetricCard label="بانتظار الاعتماد" value={formatNumber(k?.submitted ?? 0)} note="مقدَّمة للمراجع" icon={ClipboardList} tone="blue" />
        <MetricCard label="فروقات مرصودة" value={formatNumber(k?.varianceLines ?? 0)} note="أسطر باختلاف" icon={AlertTriangle} tone="rose" />
        <MetricCard label="قيمة الفروقات المرحّلة" value={formatCurrency(k?.postedVarianceValue ?? 0)} note="من محاضر مُرحّلة" icon={Wallet} tone="teal" />
      </section>

      <section className="surface mt-4 flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <label className="relative flex-1">
            <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input className="field w-full pr-10" placeholder="بحث برقم المحضر أو السبب…" defaultValue={q} onChange={(e) => patch({ q: e.target.value })} aria-label="بحث" />
          </label>
          <select className="field lg:w-52" value={warehouseId} onChange={(e) => patch({ wh: e.target.value })} aria-label="المستودع">
            <option value="">كل المستودعات</option>
            {whOptions.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap gap-1">
          {STOCKTAKE_STATUS_OPTIONS.map((o) => (
            <button key={o.value} type="button" onClick={() => patch({ status: o.value })}
              className={`min-h-10 rounded-xl border px-3 text-xs font-extrabold transition ${status === o.value ? "border-teal-600 bg-teal-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>{o.label}</button>
          ))}
        </div>
      </section>

      <section className="mt-4">
        {isLoading ? <LoadingState /> : isError ? <ErrorState error={error} onRetry={() => refetch()} /> : !data || data.rows.length === 0 ? (
          <EmptyState title="لا توجد محاضر جرد" body={q || status || warehouseId ? "جرّب تعديل عوامل التصفية." : "ابدأ بإنشاء محضر جرد."} action={canCreate ? <Button onClick={() => navigate("/stocktakes/new")}><Plus className="h-4 w-4" /> جرد جديد</Button> : undefined} />
        ) : (
          <>
            <div className="surface hidden overflow-hidden md:block">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs font-bold text-slate-500"><tr>
                  <th className="px-4 py-3 text-right">رقم المحضر</th><th className="px-4 py-3 text-right">المستودع</th><th className="px-4 py-3 text-right">الحالة</th>
                  <th className="px-4 py-3 text-right">المعدود/الإجمالي</th><th className="px-4 py-3 text-right">فروقات</th><th className="px-4 py-3 text-left">قيمة الفرق</th>
                </tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {data.rows.map((r) => (
                    <tr key={r.id} className="cursor-pointer transition hover:bg-slate-50" onClick={() => patch({ view: r.id }, false)}>
                      <td className="px-4 py-3 font-extrabold text-slate-900">{r.number}</td>
                      <td className="px-4 py-3 text-slate-600">{r.warehouse.name}</td>
                      <td className="px-4 py-3"><StatusBadge>{stocktakeStatusToLabel(r.status)}</StatusBadge></td>
                      <td className="px-4 py-3 tabular-nums text-slate-600">{formatNumber(r.countedLines)} / {formatNumber(r.totalLines)}</td>
                      <td className="px-4 py-3 tabular-nums font-bold text-slate-700">{formatNumber(r.varianceLines)}</td>
                      <td className="px-4 py-3 text-left font-bold tabular-nums text-slate-800">{formatCurrency(r.totalVarianceValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="space-y-3 md:hidden">
              {data.rows.map((r) => (
                <button key={r.id} type="button" onClick={() => patch({ view: r.id }, false)} className="surface block w-full p-4 text-right">
                  <div className="flex items-center justify-between gap-2"><span className="font-extrabold text-slate-900">{r.number}</span><StatusBadge>{stocktakeStatusToLabel(r.status)}</StatusBadge></div>
                  <div className="mt-2 flex items-center justify-between text-xs text-slate-500"><span>{r.warehouse.name} · {formatDate(r.date)}</span><span className="font-bold text-slate-800">{formatNumber(r.countedLines)}/{formatNumber(r.totalLines)} · {formatCurrency(r.totalVarianceValue)}</span></div>
                </button>
              ))}
            </div>
            <div className="mt-4 flex flex-col items-center justify-between gap-3 sm:flex-row">
              <div className="flex items-center gap-3 text-xs font-medium text-slate-500">
                <span>عرض {formatNumber(from)}–{formatNumber(to)} من {formatNumber(pg?.total ?? 0)}</span>
                <select className="field min-h-9 py-1 text-xs" value={pageSize} onChange={(e) => patch({ pageSize: e.target.value })} aria-label="حجم الصفحة">{PAGE_SIZES.map((s) => <option key={s} value={s}>{s} / صفحة</option>)}</select>
                {isFetching && <span className="text-teal-600">تحديث…</span>}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="icon" aria-label="السابق" disabled={page <= 1} onClick={() => patch({ page: page - 1 }, false)}><ChevronRight className="h-4 w-4" /></Button>
                <span className="text-xs font-bold text-slate-600">{formatNumber(page)} / {formatNumber(totalPages)}</span>
                <Button variant="ghost" size="icon" aria-label="التالي" disabled={page >= totalPages} onClick={() => patch({ page: page + 1 }, false)}><ChevronLeft className="h-4 w-4" /></Button>
              </div>
            </div>
          </>
        )}
      </section>

      <StocktakeDetailDrawer id={view} onClose={() => patch({ view: null }, false)} />
    </div>
  );
}
