import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ArrowDown,
  ArrowUp,
  Boxes,
  ChevronLeft,
  ChevronRight,
  Info,
  RefreshCw,
  Search,
} from "lucide-react";
import { PageHeader } from "@/shared/ui";
import { StatusBadge } from "@/shared/ui";
import { Button } from "@/shared/ui";
import { LoadingState, ErrorState, EmptyState } from "@/shared/ui";
import { Spinner } from "@/shared/ui";
import { Drawer, DetailStat } from "@/shared/ui";
import { formatCurrency, formatNumber, formatQty, formatDateTime } from "@/shared/lib";
import { useT } from "@/i18n";
import { useWarehouseScope, ALL_WAREHOUSES } from "@/modules/inventory/lib/warehouse-scope-provider";
import { useWarehouseInventory, useInventoryCategories } from "@/modules/inventory/lib/hooks/useInventory";
import { useInventoryItem } from "@/modules/inventory/lib/hooks/useInventoryItem";
import { useDebouncedValue } from "@/modules/inventory/lib/hooks/useDebouncedValue";
import { itemStatusLabel } from "@/modules/inventory/lib/status-labels";
import type { InventoryRow } from "@/modules/inventory/lib/adapters/inventory.adapter";

export function InventoryPage() {
  const t = useT();
  const { scope } = useWarehouseScope();
  const [params, setParams] = useSearchParams();
  const statusOptions = [
    { value: "", label: t("inventoryRest.balances.statusFilter.all") },
    { value: "available", label: t("status.available") },
    { value: "low", label: t("status.low") },
    { value: "out", label: t("status.outOfStock") },
    { value: "negative", label: t("status.negative") },
  ];

  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 350);
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState<string>(params.get("status") ?? "");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState("name");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [selected, setSelected] = useState<InventoryRow | null>(null);

  // A status deep-link from the dashboard (?status=low) seeds the filter once.
  useEffect(() => {
    const s = params.get("status");
    if (s && s !== status) setStatus(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // Any filter / scope / size change resets to page 1.
  useEffect(() => { setPage(1); }, [debouncedSearch, category, status, pageSize, scope]);

  const { data: categories } = useInventoryCategories(scope);
  const query = useWarehouseInventory({
    scope,
    q: debouncedSearch,
    category,
    status,
    page,
    pageSize,
    sort,
    dir,
  });
  const { data, isLoading, isError, error, refetch, isFetching, isPlaceholderData } = query;

  function toggleSort(key: string) {
    if (sort === key) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSort(key); setDir("asc"); }
    setPage(1);
  }

  function setStatusFilter(s: string) {
    setStatus(s);
    const next = new URLSearchParams(params);
    if (s) next.set("status", s); else next.delete("status");
    setParams(next, { replace: true });
  }

  const header = (
    <PageHeader
      eyebrow={t("inventoryRest.balances.eyebrow")}
      title={t("inventoryRest.balances.title")}
      subtitle={
        scope === ALL_WAREHOUSES
          ? t("inventoryRest.balances.subtitleAll")
          : t("inventoryRest.balances.subtitleScoped")
      }
      action={
        <Button variant="secondary" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className="h-4 w-4" /> {t("inventoryRest.ui.refresh")}
        </Button>
      }
    />
  );

  if (isLoading) return <>{header}<LoadingState /></>;
  if (isError || !data) return <>{header}<ErrorState error={error} onRetry={() => refetch()} /></>;

  const from = data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1;
  const to = Math.min(data.total, data.page * data.pageSize);
  const anyEstimated = data.rows.some((r) => r.costEstimated);

  return (
    <>
      {header}

      <article className="surface overflow-hidden">
        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-4">
          <label className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              className="field pr-10"
              placeholder={t("inventoryRest.balances.searchPlaceholder")}
              aria-label={t("inventoryRest.balances.searchAria")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <select className="field max-w-44" aria-label={t("inventoryRest.balances.categoryAria")} value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">{t("inventoryRest.filter.allCategories")}</option>
            {(categories ?? []).map((c) => (<option key={c} value={c}>{c}</option>))}
          </select>
          <div className="flex flex-wrap gap-1">
            {statusOptions.map((o) => (
              <button
                key={o.value || "all"}
                type="button"
                onClick={() => setStatusFilter(o.value)}
                className={`min-h-10 rounded-xl border px-3 text-xs font-extrabold transition ${
                  status === o.value ? "border-teal-600 bg-teal-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
          <span className="mr-auto flex items-center gap-2 text-xs font-bold text-slate-400">
            {isFetching && <Spinner className="h-3.5 w-3.5" />}
            {formatNumber(data.total)} {t("inventoryRest.ui.rowsSuffix")}
          </span>
        </div>

        {anyEstimated && (
          <div className="flex items-center gap-2 border-b border-amber-100 bg-amber-50/60 px-4 py-2 text-[11px] font-bold text-amber-700">
            <Info className="h-3.5 w-3.5" /> {t("inventoryRest.balances.estimatedNote")}
          </div>
        )}

        {data.rows.length === 0 ? (
          <EmptyState
            title={debouncedSearch || category || status ? t("inventoryRest.balances.emptyMatchTitle") : t("inventoryRest.balances.emptyTitle")}
            body={debouncedSearch || category || status ? t("inventoryRest.balances.emptyMatchBody") : t("inventoryRest.balances.emptyBody")}
          />
        ) : (
          <div className={`overflow-x-auto transition-opacity ${isPlaceholderData ? "opacity-60" : ""}`}>
            <table className="w-full min-w-[1040px] text-right">
              <thead className="bg-slate-50 text-[11px] font-extrabold text-slate-400">
                <tr>
                  <SortableTh label={t("inventoryRest.balances.col.item")} col="name" sort={sort} dir={dir} onSort={toggleSort} />
                  <th className="px-4 py-3">{t("inventoryRest.balances.col.warehouse")}</th>
                  <SortableTh label={t("inventoryRest.balances.col.qty")} col="qty" sort={sort} dir={dir} onSort={toggleSort} />
                  <th className="px-4 py-3">{t("inventoryRest.balances.col.reserved")}</th>
                  <th className="px-4 py-3">{t("inventoryRest.balances.col.available")}</th>
                  <SortableTh label={t("inventoryRest.balances.col.cost")} col="cost" sort={sort} dir={dir} onSort={toggleSort} />
                  <SortableTh label={t("inventoryRest.balances.col.value")} col="value" sort={sort} dir={dir} onSort={toggleSort} />
                  <th className="px-4 py-3">{t("inventoryRest.balances.col.reorder")}</th>
                  <th className="px-4 py-3">{t("inventoryRest.balances.col.status")}</th>
                  <th className="px-4 py-3">{t("inventoryRest.balances.col.lastMovement")}</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={`${r.warehouseId}:${r.itemId}`} className="table-row cursor-pointer" onClick={() => setSelected(r)}>
                    <td className="px-5 py-4">
                      <div className="font-extrabold text-slate-800">{r.name}</div>
                      <div className="mt-1 font-mono text-[11px] font-bold text-slate-400">{r.sku}{r.category ? ` · ${r.category}` : ""}</div>
                    </td>
                    <td className="px-4 py-4 text-sm font-bold text-slate-500">{r.warehouseName || "—"}</td>
                    <td className="px-4 py-4 text-sm font-extrabold text-slate-900 tabular-nums">{formatQty(r.qty, r.unit)}</td>
                    <td className="px-4 py-4 text-sm font-bold text-slate-400">—</td>
                    <td className="px-4 py-4 text-sm font-bold text-slate-600 tabular-nums">{formatNumber(r.available)}</td>
                    <td className="px-4 py-4 text-sm font-bold text-slate-600 tabular-nums">
                      {r.costEstimated && <span className="text-amber-600">≈ </span>}{formatCurrency(r.avgCost)}
                    </td>
                    <td className="px-4 py-4 text-sm font-extrabold text-slate-800 tabular-nums">
                      {r.costEstimated && <span className="text-amber-600">≈ </span>}{formatCurrency(r.value)}
                    </td>
                    <td className="px-4 py-4 text-sm font-bold text-slate-500 tabular-nums">{r.reorderPoint > 0 ? formatNumber(r.reorderPoint) : "—"}</td>
                    <td className="px-4 py-4"><StatusBadge>{itemStatusLabel[r.status]}</StatusBadge></td>
                    <td className="px-4 py-4 text-xs font-bold text-slate-400">{formatDateTime(r.lastMovementAt)}</td>
                    <td className="px-5 py-4"><ChevronLeft className="h-4 w-4 text-slate-300" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-5 py-4 text-xs font-bold text-slate-400">
          <div className="flex items-center gap-3">
            <span>{t("inventoryRest.ui.showingRange", { from: formatNumber(from), to: formatNumber(to), total: formatNumber(data.total) })}</span>
            <select className="field h-9 min-h-9 w-auto py-0 text-xs" aria-label={t("table.rowsPerPage")} value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
              {[10, 25, 50, 100].map((n) => (<option key={n} value={n}>{t("inventoryRest.ui.perPage", { count: n })}</option>))}
            </select>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-9 w-9" aria-label={t("inventoryRest.ui.prev")} disabled={data.page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              <ChevronRight className="h-4 w-4" />
            </Button>
            <span className="px-2 tabular-nums">{formatNumber(data.page)} / {formatNumber(data.totalPages)}</span>
            <Button variant="ghost" size="icon" className="h-9 w-9" aria-label={t("inventoryRest.ui.next")} disabled={data.page >= data.totalPages} onClick={() => setPage((p) => p + 1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </article>

      <Drawer
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.name ?? ""}
        eyebrow={t("inventoryRest.balances.detailEyebrow")}
        icon={Boxes}
      >
        {selected && <ItemDetail row={selected} />}
      </Drawer>
    </>
  );
}

function SortableTh({ label, col, sort, dir, onSort }: { label: string; col: string; sort: string; dir: string; onSort: (c: string) => void }) {
  const active = sort === col;
  return (
    <th className="px-4 py-3">
      <button type="button" onClick={() => onSort(col)} className="inline-flex items-center gap-1 font-extrabold text-slate-400 hover:text-slate-700">
        {label}
        {active && (dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
      </button>
    </th>
  );
}

function ItemDetail({ row }: { row: InventoryRow }) {
  const t = useT();
  const { distribution, movements } = useInventoryItem(row.itemId);
  return (
    <>
      <div className="flex items-center justify-between rounded-2xl bg-slate-950 p-5 text-white">
        <div>
          <div className="font-mono text-xs font-bold text-slate-400">{row.sku}</div>
          <div className="mt-2 text-2xl font-extrabold tabular-nums">
            {formatNumber(row.qty)} <span className="text-sm text-slate-400">{row.unit}</span>
          </div>
        </div>
        <StatusBadge>{itemStatusLabel[row.status]}</StatusBadge>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <DetailStat label={t("inventoryRest.balances.detail.value")} value={<>{row.costEstimated && <span className="text-amber-600">≈ </span>}{formatCurrency(row.value)}</>} />
        <DetailStat label={t("inventoryRest.balances.detail.unitCostWac")} value={<>{row.costEstimated && <span className="text-amber-600">≈ </span>}{formatCurrency(row.avgCost)}</>} />
        <DetailStat label={t("inventoryRest.balances.detail.reorderPoint")} value={row.reorderPoint > 0 ? formatQty(row.reorderPoint, row.unit) : "—"} />
        <DetailStat label={t("inventoryRest.balances.detail.warehouse")} value={row.warehouseName || "—"} />
      </div>
      {row.costEstimated && (
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-700">
          <Info className="h-3.5 w-3.5" /> {t("inventoryRest.balances.detail.estimated")}
        </div>
      )}

      <h3 className="mb-3 mt-6 text-sm font-extrabold text-slate-900">{t("inventoryRest.balances.detail.distributionTitle")}</h3>
      {distribution.isLoading ? (
        <div className="py-4"><Spinner /></div>
      ) : distribution.isError ? (
        <div className="rounded-xl border border-rose-100 bg-rose-50 p-3 text-xs font-bold text-rose-700">{t("inventoryRest.balances.detail.distributionError")}</div>
      ) : (distribution.data ?? []).length === 0 ? (
        <div className="text-xs font-bold text-slate-400">{t("inventoryRest.balances.detail.distributionEmpty")}</div>
      ) : (
        <div className="space-y-2">
          {(distribution.data ?? []).map((d) => (
            <div key={d.warehouseId} className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 px-3 py-3 text-sm">
              <span className="font-extrabold text-slate-700">{d.warehouseName}{d.isMain ? ` · ${t("inventoryRest.balances.detail.main")}` : ""}</span>
              <span className="font-bold text-slate-500 tabular-nums">{formatNumber(d.qty)} {row.unit} · {formatCurrency(d.value)}</span>
            </div>
          ))}
        </div>
      )}

      <h3 className="mb-3 mt-6 text-sm font-extrabold text-slate-900">{t("inventoryRest.balances.detail.movementsTitle")}</h3>
      {movements.isLoading ? (
        <div className="py-4"><Spinner /></div>
      ) : movements.isError ? (
        <div className="rounded-xl border border-rose-100 bg-rose-50 p-3 text-xs font-bold text-rose-700">{t("inventoryRest.balances.detail.movementsError")}</div>
      ) : (movements.data ?? []).length === 0 ? (
        <div className="text-xs font-bold text-slate-400">{t("inventoryRest.balances.detail.movementsEmpty")}</div>
      ) : (
        <div className="space-y-2">
          {(movements.data ?? []).map((m) => (
            <div key={m.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 px-3 py-2 text-xs">
              <div className="min-w-0">
                <div className="truncate font-extrabold text-slate-700">{m.reason || (m.type === "in" ? t("inventoryRest.movementType.in") : t("inventoryRest.movementType.out"))}</div>
                <div className="mt-0.5 text-[11px] font-bold text-slate-400">{formatDateTime(m.date)}{m.warehouseName ? ` · ${m.warehouseName}` : ""}</div>
              </div>
              <span className={`shrink-0 font-extrabold tabular-nums ${m.type === "in" ? "text-emerald-600" : "text-sky-600"}`}>
                {m.type === "in" ? "+" : "−"}{formatNumber(m.qty)}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
