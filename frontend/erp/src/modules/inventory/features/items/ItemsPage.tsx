// D1 — Inventory Item Master list. Server-mode DataTable over the paginating
// GET /api/inventory/v2/items. All list UI state (search, facet filters, page,
// pageSize, sort) lives in the URL so it survives returning from a full-page
// detail/edit route; scroll position is restored from sessionStorage. Cost
// columns are gated by the `item.cost.view` capability (requireCap + canColumn).
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Plus, Boxes, CheckCircle2, XCircle, Tag, Pencil } from "lucide-react";
import { PageHeader, Button, IconButton, Badge, StatusBadge, Select } from "@/shared/ui";
import { DataTable, Pagination, type ColumnDef } from "@/shared/tables";
import { MetricCard } from "@/modules/inventory/lib/MetricCard";
import { usePermissions, useCan } from "@/modules/inventory/lib/permission-provider";
import type { WarehouseAction } from "@/modules/inventory/lib/permissions";
import { formatCurrency, formatNumber, formatQty } from "@/shared/lib";
import { useT, useLang } from "@/i18n";
import { useItemList, useItemCategories, useUnits } from "@/modules/inventory/lib/hooks/useItems";
import { useWarehouseAdminList } from "@/modules/inventory/lib/hooks/useWarehouseAdmin";
import type { ItemRow } from "@/modules/inventory/lib/adapters/item.adapter";

const PAGE_SIZES = [10, 25, 50, 100];
const SCROLL_KEY = "inv-items:scrollY";
const SORTABLE = new Set(["name", "sku", "category", "created_at"]);

export function ItemsPage() {
  const t = useT();
  const lang = useLang();
  const navigate = useNavigate();
  const { can } = usePermissions();
  const canCreate = useCan("item.create");
  const canEdit = useCan("item.edit");
  const [params, setParams] = useSearchParams();

  // ── URL is the single source of truth for every list control ──
  const q = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const category = params.get("category") ?? "";
  const branch = params.get("branch") ?? "";
  const warehouse = params.get("warehouse") ?? "";
  const unit = params.get("unit") ?? "";
  const missingEn = params.get("missingEn") === "1";
  const belowReorder = params.get("belowReorder") === "1";
  const image = params.get("image") ?? "";
  const sort = SORTABLE.has(params.get("sort") ?? "") ? (params.get("sort") as string) : "name";
  const dir = params.get("dir") === "desc" ? "desc" : "asc";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = PAGE_SIZES.includes(Number(params.get("pageSize"))) ? Number(params.get("pageSize")) : 25;

  const patch = useCallback(
    (next: Record<string, string | number | null>, resetPage = true) => {
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(next)) {
            if (v === null || v === "" || v === "0") p.delete(k);
            else p.set(k, String(v));
          }
          if (resetPage && !("page" in next)) p.delete("page");
          return p;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const list = useItemList({
    q, status, category, warehouseId: warehouse, branchId: branch, unit,
    missingNameEn: missingEn ? "1" : "", belowReorder: belowReorder ? "1" : "", hasImage: image,
    page, pageSize, sort, dir,
  });
  const cats = useItemCategories();
  const units = useUnits();
  const whList = useWarehouseAdminList();

  const kpis = list.data?.kpis;
  const rows = list.data?.rows ?? [];
  const total = list.data?.pagination.total ?? 0;
  const totalPages = list.data?.pagination.totalPages ?? 1;

  // branches derived from the warehouse universe (id → name), and the warehouses
  // under the currently-selected branch (for the dependent warehouse filter).
  const branches = useMemo(() => {
    const map = new Map<string, string>();
    for (const w of whList.data?.warehouses ?? []) if (w.branchId) map.set(w.branchId, w.branchName || w.branchId);
    return [...map.entries()].map(([id, name]) => ({ id, name }));
  }, [whList.data]);
  const warehousesForFilter = useMemo(
    () => (whList.data?.warehouses ?? []).filter((w) => !branch || w.branchId === branch),
    [whList.data, branch],
  );

  // ── scroll restore across the detail/edit round-trip ──
  useEffect(() => {
    const saved = sessionStorage.getItem(SCROLL_KEY);
    if (saved) {
      const y = Number(saved);
      sessionStorage.removeItem(SCROLL_KEY);
      requestAnimationFrame(() => window.scrollTo(0, Number.isFinite(y) ? y : 0));
    }
  }, []);
  const goto = useCallback(
    (to: string) => {
      sessionStorage.setItem(SCROLL_KEY, String(window.scrollY));
      navigate(to);
    },
    [navigate],
  );

  // ── DataTable owns only the sort header interaction; we mirror it to the URL ──
  const initialSort = useMemo<{ columnId: string; dir: "asc" | "desc" }>(
    () => ({ columnId: sort, dir }),
    [sort, dir],
  );
  const lastSort = useRef<string>(`${sort}:${dir}`);
  const onStateChange = useCallback(
    (st: { page: number; pageSize: number; sort: { columnId: string; dir: "asc" | "desc" } | null; search: string }) => {
      const nextCol = st.sort && SORTABLE.has(st.sort.columnId) ? st.sort.columnId : "name";
      const nextDir = st.sort?.dir ?? "asc";
      const key = `${nextCol}:${nextDir}`;
      if (key === lastSort.current) return;
      lastSort.current = key;
      patch({ sort: nextCol, dir: nextDir });
    },
    [patch],
  );

  const bizName = (r: ItemRow) => (lang === "en" ? r.nameEn || r.name : r.name);

  const columns = useMemo<ColumnDef<ItemRow>[]>(() => {
    const dash = "—";
    const conv = (r: ItemRow) =>
      r.convRate > 1 && r.majorUnit
        ? t("items.conversionPreview", { major: r.majorUnit, factor: formatNumber(r.convRate), base: r.baseUnit || r.unit })
        : dash;
    return [
      {
        id: "sku", header: t("items.col.code"), accessor: (r) => r.sku, sortable: true, hideable: false,
        cell: (r) => <span className="font-mono text-xs text-slate-500" dir="ltr">{r.sku || dash}</span>,
      },
      {
        id: "name", header: t("items.col.nameAr"), accessor: (r) => r.name, sortable: true, hideable: false,
        cell: (r) => <span className="font-extrabold text-slate-900">{r.name}</span>,
      },
      {
        id: "nameEn", header: t("items.col.nameEn"), accessor: (r) => r.nameEn,
        cell: (r) => r.nameEn
          ? <span dir="ltr" className="text-slate-700">{r.nameEn}</span>
          : <Badge tone="warning">{t("items.badge.missingNameEn")}</Badge>,
      },
      { id: "category", header: t("items.col.category"), accessor: (r) => r.category || dash, sortable: true },
      { id: "majorUnit", header: t("items.col.majorUnit"), accessor: (r) => r.majorUnit || dash, defaultHidden: true },
      { id: "baseUnit", header: t("items.col.baseUnit"), accessor: (r) => r.baseUnit || r.unit || dash },
      {
        id: "conversion", header: t("items.col.conversion"), defaultHidden: true,
        cell: (r) => <span dir="ltr" className="text-xs text-slate-600">{conv(r)}</span>,
      },
      {
        id: "baseCost", header: t("items.col.baseCost"), numeric: true, requireCap: "item.cost.view",
        accessor: (r) => r.baseCost, cell: (r) => formatCurrency(r.baseCost),
      },
      {
        id: "majorCost", header: t("items.col.majorCost"), numeric: true, requireCap: "item.cost.view", defaultHidden: true,
        accessor: (r) => r.majorCost ?? -1, cell: (r) => (r.majorCost == null ? dash : formatCurrency(r.majorCost)),
      },
      {
        id: "locations", header: t("items.col.locations"), defaultHidden: true,
        cell: (r) => (r.assignedCount == null ? dash : formatNumber(r.assignedCount)),
      },
      {
        id: "availableQty", header: t("items.col.availableQty"), numeric: true,
        accessor: (r) => r.availableQty, cell: (r) => formatQty(r.availableQty),
      },
      {
        id: "reorderPoint", header: t("items.col.reorderPoint"), numeric: true, defaultHidden: true,
        cell: (r) => (r.reorderPoint == null ? dash : formatQty(r.reorderPoint)),
      },
      {
        id: "status", header: t("common.status"), hideable: false,
        cell: (r) => <StatusBadge>{r.active ? t("status.active") : t("common.inactive")}</StatusBadge>,
      },
    ];
  }, [t]);

  const hasFacets = !!(q || status || category || branch || warehouse || unit || missingEn || belowReorder || image);

  const filterBar = (
    <>
      <label className="relative min-w-0 flex-1 sm:min-w-56">
        <input
          className="field h-10 w-full py-2"
          placeholder={t("items.filter.searchPlaceholder")}
          value={q}
          onChange={(e) => patch({ q: e.target.value })}
          aria-label={t("common.search")}
          type="search"
        />
      </label>
      <Select className="h-10 w-auto" value={branch} onChange={(e) => patch({ branch: e.target.value, warehouse: null })} aria-label={t("items.filter.branch")}>
        <option value="">{t("items.filter.allBranches")}</option>
        {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </Select>
      <Select className="h-10 w-auto" value={warehouse} onChange={(e) => patch({ warehouse: e.target.value })} aria-label={t("items.filter.warehouse")}>
        <option value="">{t("items.filter.allWarehouses")}</option>
        {warehousesForFilter.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
      </Select>
      <Select className="h-10 w-auto" value={category} onChange={(e) => patch({ category: e.target.value })} aria-label={t("items.col.category")}>
        <option value="">{t("items.filter.allCategories")}</option>
        {(cats.data ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
      </Select>
      <Select className="h-10 w-auto" value={unit} onChange={(e) => patch({ unit: e.target.value })} aria-label={t("items.filter.unit")}>
        <option value="">{t("items.filter.allUnits")}</option>
        {(units.data ?? []).map((u) => <option key={u.code} value={u.code}>{lang === "en" ? u.nameEn || u.nameAr : u.nameAr}</option>)}
      </Select>
      <Select className="h-10 w-auto" value={status} onChange={(e) => patch({ status: e.target.value })} aria-label={t("common.status")}>
        <option value="">{t("common.all")}</option>
        <option value="active">{t("common.active")}</option>
        <option value="inactive">{t("common.inactive")}</option>
      </Select>
      <Select className="h-10 w-auto" value={image} onChange={(e) => patch({ image: e.target.value })} aria-label={t("items.filter.image")}>
        <option value="">{t("items.filter.image")}</option>
        <option value="has">{t("items.filter.hasImage")}</option>
        <option value="no">{t("items.filter.noImage")}</option>
      </Select>
      <FilterChip active={missingEn} onClick={() => patch({ missingEn: missingEn ? null : "1" })}>{t("items.filter.missingNameEn")}</FilterChip>
      <FilterChip active={belowReorder} onClick={() => patch({ belowReorder: belowReorder ? null : "1" })}>{t("items.filter.belowReorder")}</FilterChip>
    </>
  );

  return (
    <div>
      <PageHeader
        eyebrow={t("items.eyebrow")}
        title={t("items.listTitle")}
        subtitle={t("items.listSubtitle")}
        action={canCreate ? <Button variant="primary" onClick={() => goto("/inventory/items/new")}><Plus className="h-4 w-4" /> {t("items.newItem")}</Button> : null}
      />

      <section className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label={t("items.kpi.total")} value={formatNumber(kpis?.total ?? 0)} note={t("items.kpi.totalNote")} icon={Boxes} tone="blue" />
        <MetricCard label={t("items.kpi.active")} value={formatNumber(kpis?.active ?? 0)} note={t("items.kpi.activeNote")} icon={CheckCircle2} tone="teal" />
        <MetricCard label={t("items.kpi.inactive")} value={formatNumber(kpis?.inactive ?? 0)} note={t("items.kpi.inactiveNote")} icon={XCircle} tone="rose" />
        <MetricCard label={t("items.kpi.noSku")} value={formatNumber(kpis?.noSku ?? 0)} note={t("items.kpi.noSkuNote")} icon={Tag} tone="amber" />
      </section>

      <DataTable<ItemRow>
        mode="server"
        columns={columns}
        rows={rows}
        rowCount={total}
        getRowId={(r) => r.id}
        loading={list.isLoading || list.isFetching}
        error={list.isError ? list.error : undefined}
        onRetry={() => list.refetch()}
        initialSort={initialSort}
        onStateChange={onStateChange}
        searchable={false}
        paginate={false}
        columnMenu
        savedViewsModule="inventory-items"
        canColumn={(cap) => can(cap as WarehouseAction)}
        filterBar={filterBar}
        onRowClick={(r) => goto(`/inventory/items/${r.id}`)}
        mobileTitle={(r) => bizName(r)}
        rowActions={(r) =>
          canEdit ? (
            <IconButton aria-label={t("items.detail.edit")} size="sm" variant="secondary" onClick={() => goto(`/inventory/items/${r.id}/edit`)}>
              <Pencil className="h-4 w-4" />
            </IconButton>
          ) : null
        }
        emptyTitle={t("items.empty.title")}
        emptyBody={hasFacets ? t("items.empty.withFilters") : t("items.empty.noItems")}
        emptyAction={canCreate ? <Button onClick={() => goto("/inventory/items/new")}><Plus className="h-4 w-4" /> {t("items.newItem")}</Button> : undefined}
      />

      {total > 0 && (
        <div className="surface mt-3">
          <Pagination
            page={page}
            pageCount={totalPages}
            total={total}
            pageSize={pageSize}
            onPageChange={(p) => patch({ page: p }, false)}
            onPageSizeChange={(s) => patch({ pageSize: s })}
            pageSizeOptions={PAGE_SIZES}
          />
        </div>
      )}
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex min-h-11 items-center rounded-xl border px-3 text-xs font-extrabold transition ${
        active ? "border-teal-600 bg-teal-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
      }`}
    >
      {children}
    </button>
  );
}
