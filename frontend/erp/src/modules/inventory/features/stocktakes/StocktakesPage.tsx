import { useMemo } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, Plus, Search, ClipboardCheck, ClipboardList, AlertTriangle, Wallet } from "lucide-react";
import { PageHeader } from "@/shared/ui";
import { MetricCard } from "@/modules/inventory/lib/MetricCard";
import { StatusBadge } from "@/shared/ui";
import { Button } from "@/shared/ui";
import { LoadingState, EmptyState, ErrorState } from "@/shared/ui";
import { useWarehouses } from "@/modules/inventory/lib/hooks/useWarehouses";
import { useWarehouseScope } from "@/modules/inventory/lib/warehouse-scope-provider";
import { useCan } from "@/modules/inventory/lib/permission-provider";
import { formatCurrency, formatNumber, formatDate } from "@/shared/lib";
import { useT } from "@/i18n";
import { stocktakeStatusToLabel } from "@/modules/inventory/lib/status-labels";
import { useStocktakeList } from "@/modules/inventory/lib/hooks/useStocktakes";
import { StocktakeDetailDrawer } from "./StocktakeDetailDrawer";

const PAGE_SIZES = [10, 25, 50];

export function StocktakesPage() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { accessibleWarehouses, allWarehousesAccess } = useWarehouseScope();
  const canCreate = useCan("stocktake.create");
  const statusOptions = [
    { value: "", label: t("inventoryRest.stocktakes.statusFilter.all") },
    { value: "draft", label: t("status.draft") },
    { value: "counting", label: t("status.counting") },
    { value: "submitted", label: t("status.pendingApproval") },
    { value: "approved", label: t("status.approved") },
    { value: "posted", label: t("status.posted") },
    { value: "cancelled", label: t("status.cancelled") },
  ];

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
      <PageHeader eyebrow={t("inventoryRest.stocktakes.eyebrow")} title={t("inventoryRest.stocktakes.title")} subtitle={t("inventoryRest.stocktakes.subtitle")}
        action={canCreate ? <Button variant="primary" onClick={() => navigate("/inventory/stocktakes?new=1")}><Plus className="h-4 w-4" /> {t("inventoryRest.stocktakes.newStocktake")}</Button> : null} />

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label={t("inventoryRest.stocktakes.kpi.counting")} value={formatNumber(k?.counting ?? 0)} note={t("inventoryRest.stocktakes.kpi.countingNote")} icon={ClipboardCheck} tone="amber" />
        <MetricCard label={t("inventoryRest.stocktakes.kpi.submitted")} value={formatNumber(k?.submitted ?? 0)} note={t("inventoryRest.stocktakes.kpi.submittedNote")} icon={ClipboardList} tone="blue" />
        <MetricCard label={t("inventoryRest.stocktakes.kpi.variance")} value={formatNumber(k?.varianceLines ?? 0)} note={t("inventoryRest.stocktakes.kpi.varianceNote")} icon={AlertTriangle} tone="rose" />
        <MetricCard label={t("inventoryRest.stocktakes.kpi.postedVariance")} value={formatCurrency(k?.postedVarianceValue ?? 0)} note={t("inventoryRest.stocktakes.kpi.postedVarianceNote")} icon={Wallet} tone="teal" />
      </section>

      <section className="surface mt-4 flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <label className="relative flex-1">
            <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input className="field w-full pr-10" placeholder={t("inventoryRest.stocktakes.searchPlaceholder")} defaultValue={q} onChange={(e) => patch({ q: e.target.value })} aria-label={t("inventoryRest.invtx.list.searchAria")} />
          </label>
          <select className="field lg:w-52" value={warehouseId} onChange={(e) => patch({ wh: e.target.value })} aria-label={t("inventoryRest.stocktakes.warehouseAria")}>
            <option value="">{t("inventoryRest.filter.allWarehouses")}</option>
            {whOptions.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap gap-1">
          {statusOptions.map((o) => (
            <button key={o.value} type="button" onClick={() => patch({ status: o.value })}
              className={`min-h-10 rounded-xl border px-3 text-xs font-extrabold transition ${status === o.value ? "border-teal-600 bg-teal-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>{o.label}</button>
          ))}
        </div>
      </section>

      <section className="mt-4">
        {isLoading ? <LoadingState /> : isError ? <ErrorState error={error} onRetry={() => refetch()} /> : !data || data.rows.length === 0 ? (
          <EmptyState title={t("inventoryRest.stocktakes.emptyTitle")} body={q || status || warehouseId ? t("inventoryRest.ui.fixFilters") : t("inventoryRest.stocktakes.emptyBody")} action={canCreate ? <Button onClick={() => navigate("/inventory/stocktakes?new=1")}><Plus className="h-4 w-4" /> {t("inventoryRest.stocktakes.newStocktake")}</Button> : undefined} />
        ) : (
          <>
            <div className="surface hidden overflow-hidden md:block">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs font-bold text-slate-500"><tr>
                  <th className="px-4 py-3 text-right">{t("inventoryRest.stocktakes.col.number")}</th><th className="px-4 py-3 text-right">{t("inventoryRest.stocktakes.col.warehouse")}</th><th className="px-4 py-3 text-right">{t("inventoryRest.stocktakes.col.status")}</th>
                  <th className="px-4 py-3 text-right">{t("inventoryRest.stocktakes.col.countedTotal")}</th><th className="px-4 py-3 text-right">{t("inventoryRest.stocktakes.col.variance")}</th><th className="px-4 py-3 text-left">{t("inventoryRest.stocktakes.col.varianceValue")}</th>
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
                <span>{t("inventoryRest.ui.showingRange", { from: formatNumber(from), to: formatNumber(to), total: formatNumber(pg?.total ?? 0) })}</span>
                <select className="field min-h-9 py-1 text-xs" value={pageSize} onChange={(e) => patch({ pageSize: e.target.value })} aria-label={t("table.rowsPerPage")}>{PAGE_SIZES.map((s) => <option key={s} value={s}>{t("inventoryRest.ui.perPage", { count: s })}</option>)}</select>
                {isFetching && <span className="text-teal-600">{t("inventoryRest.ui.updatingShort")}</span>}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="icon" aria-label={t("inventoryRest.ui.prev")} disabled={page <= 1} onClick={() => patch({ page: page - 1 }, false)}><ChevronRight className="h-4 w-4" /></Button>
                <span className="text-xs font-bold text-slate-600">{formatNumber(page)} / {formatNumber(totalPages)}</span>
                <Button variant="ghost" size="icon" aria-label={t("inventoryRest.ui.next")} disabled={page >= totalPages} onClick={() => patch({ page: page + 1 }, false)}><ChevronLeft className="h-4 w-4" /></Button>
              </div>
            </div>
          </>
        )}
      </section>

      <StocktakeDetailDrawer id={view} onClose={() => patch({ view: null }, false)} />
    </div>
  );
}
