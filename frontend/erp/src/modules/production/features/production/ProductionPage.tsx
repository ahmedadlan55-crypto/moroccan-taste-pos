import { useMemo } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, Plus, Search, Factory, ClipboardList, Wallet, PackageCheck } from "lucide-react";
import { PageHeader } from "@/shared/ui";
import { MetricCard } from "@/modules/inventory/lib/MetricCard";
import { StatusBadge } from "@/shared/ui";
import { Button, DatePicker } from "@/shared/ui";
import { LoadingState, EmptyState, ErrorState } from "@/shared/ui";
import { useWarehouses } from "@/modules/inventory/lib/hooks/useWarehouses";
import { useWarehouseScope } from "@/modules/inventory/lib/warehouse-scope-provider";
import { useCan } from "@/modules/inventory/lib/permission-provider";
import { formatCurrency, formatNumber, formatDate, formatQty } from "@/shared/lib";
import { productionStatusToLabel, PRODUCTION_STATUS_OPTIONS } from "@/modules/inventory/lib/status-labels";
import { useProductionList } from "@/modules/inventory/lib/hooks/useProduction";
import { useT } from "@/i18n";
import { productionStatusLabel } from "./status-i18n";
import { ProductionBatchListPanel } from "../batches/ProductionBatchListPanel";
import { PageCounter } from "@/shared/tables";

const PAGE_SIZES = [10, 25, 50];

export function ProductionPage() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { accessibleWarehouses, allWarehousesAccess } = useWarehouseScope();
  const canCreate = useCan("production.create");

  const q = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const warehouseId = params.get("wh") ?? "";
  const dateFrom = params.get("dateFrom") ?? "";
  const dateTo = params.get("dateTo") ?? "";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = PAGE_SIZES.includes(Number(params.get("pageSize"))) ? Number(params.get("pageSize")) : 25;
  const sort = params.get("sort") ?? "created_at";
  const dir = params.get("dir") === "asc" ? "asc" : "desc";

  function patch(next: Record<string, string | number | null>, resetPage = true) {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) { if (v === null || v === "") p.delete(k); else p.set(k, String(v)); }
    if (resetPage && !("page" in next)) p.delete("page");
    setParams(p, { replace: true });
  }

  const { data, isLoading, isError, error, refetch, isFetching } = useProductionList({ q, status, warehouseId, dateFrom, dateTo, page, pageSize, sort, dir });

  const allWh = useWarehouses();
  const whOptions = useMemo(() => {
    if (!allWarehousesAccess) return accessibleWarehouses.map((w) => ({ id: w.id, name: w.name }));
    return (allWh.data?.warehouses ?? []).map((w) => ({ id: w.id, name: w.name }));
  }, [allWarehousesAccess, accessibleWarehouses, allWh.data]);

  function toggleSort(col: string) {
    if (sort === col) patch({ dir: dir === "asc" ? "desc" : "asc" }, false);
    else patch({ sort: col, dir: "desc" }, false);
  }

  const k = data?.kpis;
  const pg = data?.pagination;
  const totalPages = pg?.totalPages ?? 1;
  const from = pg && pg.total > 0 ? (pg.page - 1) * pg.pageSize + 1 : 0;
  const to = pg ? Math.min(pg.page * pg.pageSize, pg.total) : 0;

  // Two surfaces, one screen: the single-order list (default) and the
  // multi-product DOCUMENT list. `?view=batches` keeps the choice in the URL so
  // it survives a refresh and stays shareable.
  const view = params.get("view") === "batches" ? "batches" : "orders";
  function setView(next: "orders" | "batches") {
    const p = new URLSearchParams(params);
    if (next === "orders") p.delete("view");
    else p.set("view", "batches");
    p.delete("page");
    setParams(p, { replace: true });
  }

  const tabs = (
    <div className="mb-4 flex flex-wrap gap-1.5" role="tablist" aria-label={t("production.batch.list.title")}>
      {(["orders", "batches"] as const).map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={view === id}
          onClick={() => setView(id)}
          className={`min-h-10 rounded-xl border px-4 text-sm font-extrabold transition ${
            view === id ? "border-teal-600 bg-teal-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          }`}
        >
          {id === "orders" ? t("production.batch.list.tabOrders") : t("production.batch.list.tabBatches")}
        </button>
      ))}
    </div>
  );

  if (view === "batches") {
    return (
      <div>
        <PageHeader
          eyebrow={t("production.batch.eyebrow")}
          title={t("production.batch.list.title")}
          subtitle={t("production.batch.list.subtitle")}
          action={canCreate ? (<Button variant="primary" onClick={() => navigate("/inventory/production/new")}><Plus className="h-4 w-4" /> {t("production.batch.create.submit")}</Button>) : null}
        />
        {tabs}
        <ProductionBatchListPanel />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow={t("production.list.eyebrow")}
        title={t("production.list.title")}
        subtitle={t("production.list.subtitle")}
        action={canCreate ? (<Button variant="primary" onClick={() => navigate("/inventory/production/new")}><Plus className="h-4 w-4" /> {t("production.list.newOrder")}</Button>) : null}
      />

      {tabs}

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label={t("production.list.kpi.inProgress")} value={formatNumber(k?.inProgress ?? 0)} note={t("production.list.kpi.inProgressNote", { count: formatNumber(k?.partiallyCompleted ?? 0) })} icon={Factory} tone="blue" />
        <MetricCard label={t("production.list.kpi.pending")} value={formatNumber((k?.draft ?? 0) + (k?.approved ?? 0))} note={t("production.list.kpi.pendingNote")} icon={ClipboardList} tone="amber" />
        <MetricCard label={t("production.list.kpi.wip")} value={formatCurrency(k?.wipValue ?? 0)} note={t("production.list.kpi.wipNote")} icon={Wallet} tone="teal" />
        <MetricCard label={t("production.list.kpi.completed")} value={formatNumber((k?.completed ?? 0) + (k?.closed ?? 0))} note={t("production.list.kpi.completedNote", { value: formatCurrency(k?.producedValue ?? 0) })} icon={PackageCheck} tone="teal" />
      </section>

      <section className="surface mt-4 flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <label className="relative flex-1">
            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input className="field w-full ps-10" placeholder={t("production.list.searchPlaceholder")} defaultValue={q} onChange={(e) => patch({ q: e.target.value })} aria-label={t("common.search")} />
          </label>
          <select className="field lg:w-52" value={warehouseId} onChange={(e) => patch({ wh: e.target.value })} aria-label={t("production.list.warehouseAria")}>
            <option value="">{t("production.list.allWarehouses")}</option>
            {whOptions.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <DatePicker className="lg:w-40" value={dateFrom} onChange={(v) => patch({ dateFrom: v })} aria-label={t("production.list.dateFromAria")} />
          <DatePicker className="lg:w-40" value={dateTo} onChange={(v) => patch({ dateTo: v })} aria-label={t("production.list.dateToAria")} />
        </div>
        <div className="flex flex-wrap gap-1">
          {PRODUCTION_STATUS_OPTIONS.map((o) => (
            <button key={o.value} type="button" onClick={() => patch({ status: o.value })}
              className={`min-h-10 rounded-xl border px-3 text-xs font-extrabold transition ${status === o.value ? "border-teal-600 bg-teal-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>
              {o.value === "" ? t("production.filters.allStatuses") : productionStatusLabel(t, o.value)}
            </button>
          ))}
        </div>
      </section>

      <section className="mt-4">
        {isLoading ? (
          <LoadingState />
        ) : isError ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : !data || data.rows.length === 0 ? (
          <EmptyState title={t("production.list.emptyTitle")} body={q || status || warehouseId ? t("production.list.emptyWithFilters") : t("production.list.emptyNoOrders")} action={canCreate ? <Button onClick={() => navigate("/inventory/production/new")}><Plus className="h-4 w-4" /> {t("production.list.newOrder")}</Button> : undefined} />
        ) : (
          <>
            <div className="surface hidden overflow-hidden md:block">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs font-bold text-slate-500">
                  <tr>
                    <th className="px-4 py-3 text-start"><SortBtn label={t("production.list.col.orderNumber")} col="order_number" sort={sort} dir={dir} onSort={toggleSort} /></th>
                    <th className="px-4 py-3 text-start">{t("production.list.col.product")}</th>
                    <th className="px-4 py-3 text-start"><SortBtn label={t("common.status")} col="status" sort={sort} dir={dir} onSort={toggleSort} /></th>
                    <th className="px-4 py-3 text-start"><SortBtn label={t("production.list.col.qty")} col="qty_planned" sort={sort} dir={dir} onSort={toggleSort} /></th>
                    <th className="px-4 py-3 text-start">{t("production.list.col.warehouses")}</th>
                    <th className="px-4 py-3 text-start"><SortBtn label={t("production.list.col.date")} col="planned_date" sort={sort} dir={dir} onSort={toggleSort} /></th>
                    <th className="px-4 py-3 text-end">WIP</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.rows.map((r) => (
                    <tr key={r.id} className="cursor-pointer transition hover:bg-slate-50" onClick={() => navigate(`/inventory/production/${r.id}`)}>
                      <td className="px-4 py-3">
                        <span className="font-extrabold text-slate-900">{r.number}</span>
                        {r.source === "legacy" && <span className="ms-2 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">{t("production.list.legacyBadge")}</span>}
                      </td>
                      <td className="px-4 py-3 text-slate-600">{r.productName}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-1">
                          <StatusBadge>{productionStatusToLabel(r.status)}</StatusBadge>
                          {r.partiallyCompleted && <StatusBadge>{t("production.status.partial")}</StatusBadge>}
                        </div>
                      </td>
                      <td className="px-4 py-3 tabular-nums text-slate-700">
                        {formatQty(r.qtyProduced)} / {formatQty(r.qtyPlanned, r.productUnit)}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-500">{r.warehouseName}{r.outputWarehouseId !== r.warehouseId ? ` ← ${r.outputWarehouseName}` : ""}</td>
                      <td className="px-4 py-3 text-slate-500">{formatDate(r.plannedDate)}</td>
                      <td className="px-4 py-3 text-end font-bold tabular-nums text-slate-800">{formatCurrency(r.wipBalance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-3 md:hidden">
              {data.rows.map((r) => (
                <button key={r.id} type="button" onClick={() => navigate(`/inventory/production/${r.id}`)} className="surface block w-full p-4 text-start">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-extrabold text-slate-900">{r.number}</span>
                    <StatusBadge>{productionStatusToLabel(r.status)}</StatusBadge>
                  </div>
                  <div className="mt-1 text-sm font-medium text-slate-600">{r.productName}</div>
                  <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                    <span>{formatQty(r.qtyProduced)} / {formatQty(r.qtyPlanned, r.productUnit)} · {formatDate(r.plannedDate)}</span>
                    <span className="font-bold text-slate-800">{formatCurrency(r.wipBalance)}</span>
                  </div>
                </button>
              ))}
            </div>

            <div className="mt-4 flex flex-col items-center justify-between gap-3 sm:flex-row">
              <div className="flex items-center gap-3 text-xs font-medium text-slate-500">
                <span>{t("table.showing")} {formatNumber(from)}–{formatNumber(to)} {t("table.of")} {formatNumber(pg?.total ?? 0)}</span>
                <select className="field min-h-9 py-1 text-xs" value={pageSize} onChange={(e) => patch({ pageSize: e.target.value })} aria-label={t("table.rowsPerPage")}>{PAGE_SIZES.map((s) => <option key={s} value={s}>{t("table.perPage", { count: s })}</option>)}</select>
                {isFetching && <span className="text-teal-600">{t("production.list.updating")}</span>}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="icon" aria-label={t("table.prevPage")} disabled={page <= 1} onClick={() => patch({ page: page - 1 }, false)}><ChevronRight className="h-4 w-4 rotate-180 rtl:rotate-0" aria-hidden="true" /></Button>
                <PageCounter page={page} pageCount={totalPages} className="text-xs font-bold text-slate-600" />
                <Button variant="ghost" size="icon" aria-label={t("table.nextPage")} disabled={page >= totalPages} onClick={() => patch({ page: page + 1 }, false)}><ChevronLeft className="h-4 w-4 rotate-180 rtl:rotate-0" aria-hidden="true" /></Button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function SortBtn({ label, col, sort, dir, onSort }: { label: string; col: string; sort: string; dir: string; onSort: (c: string) => void }) {
  return (
    <button type="button" className="inline-flex items-center gap-1 font-bold hover:text-slate-800" onClick={() => onSort(col)}>
      {label}{sort === col && <span aria-hidden="true">{dir === "asc" ? "▲" : "▼"}</span>}
    </button>
  );
}
