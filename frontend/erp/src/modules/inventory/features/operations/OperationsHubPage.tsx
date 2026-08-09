/**
 * SCREEN 1 — the unified inventory operations hub (`/inventory/operations`).
 *
 * ONE server-paginated list over every inventory document family. Nothing about
 * the vocabulary is hardcoded: the tabs, the type filter and the status filter
 * are all built from `GET /inventory/operations/meta` + the per-type `counts`
 * the list endpoint returns, so a document family the deployment does not have
 * (or the caller may not see) never renders a tab that can only be empty.
 *
 * Rules this screen holds to:
 *  • SERVER-side pagination/sort/filter only — the whole point of the read model.
 *  • A failed request renders ErrorState, NEVER an empty table (DataTable does
 *    this itself once `error` is passed; passing `loading`/`error` is the
 *    contract, not a suggestion).
 *  • `deniedTypes` / `unavailableTypes` are SURFACED. A user must never silently
 *    see fewer documents than exist.
 *  • Row identity is the composite `<type>:<id>`; navigation always uses
 *    documentType + documentId separately (ids repeat across the source tables).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { EyeOff, PackageSearch, ServerOff } from "lucide-react";
import { DatePicker, PageHeader, Select, StatusBadge, Badge } from "@/shared/ui";
import { DataTable, Pagination, type ColumnDef } from "@/shared/tables";
import { usePermissions } from "@/shared/permissions";
import { useDebounce } from "@/shared/hooks";
import { formatCurrency, formatDate, formatNumber, formatQty } from "@/shared/lib";
import { useT, useLang } from "@/i18n";
import { useWarehouses } from "@/modules/inventory/lib/hooks/useWarehouses";
import { useWarehouseScope, ALL_WAREHOUSES } from "@/modules/inventory/lib/warehouse-scope-provider";
import {
  useOperationsList,
  useOperationsMeta,
  type OperationRow,
} from "@/modules/inventory/lib/hooks/useOperations";
import { ALL_TAB, buildTabs, statusLabel, tabCount, typeLabel } from "./labels";

const PAGE_SIZES = [10, 25, 50, 100];
/** The server's sort allow-list (GET /meta → `sortable`); the column ids below
 *  ARE these keys so DataTable's header click maps 1:1 onto the wire. */
const FALLBACK_SORTABLE = ["date", "documentNumber", "status", "documentType", "totalValue", "createdAt"];

export function OperationsHubPage() {
  const t = useT();
  const lang = useLang();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { can } = usePermissions();
  const { scope, setScope, accessibleWarehouses, allWarehousesAccess } = useWarehouseScope();

  const meta = useOperationsMeta();

  // ── URL is the single source of truth for every list control ──
  const tabId = params.get("tab") ?? ALL_TAB;
  const typeFilter = params.get("type") ?? "";
  const statusFilter = params.get("status") ?? "";
  const dateFrom = params.get("dateFrom") ?? "";
  const dateTo = params.get("dateTo") ?? "";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = PAGE_SIZES.includes(Number(params.get("pageSize"))) ? Number(params.get("pageSize")) : 25;
  const sortable = meta.data?.sortable?.length ? meta.data.sortable : FALLBACK_SORTABLE;
  const sortParam = params.get("sort") ?? "";
  const sort = sortable.includes(sortParam) ? sortParam : "date";
  const dir = params.get("dir") === "asc" ? "asc" : "desc";

  const patch = useCallback(
    (next: Record<string, string | number | null>, resetPage = true) => {
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(next)) {
            if (v === null || v === "") p.delete(k);
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

  // ── debounced search ──
  // The box echoes instantly; only the QUERY (and the URL mirror) waits for the
  // pause, so one refetch per pause instead of one per keystroke.
  const [searchInput, setSearchInput] = useState(() => params.get("q") ?? "");
  const search = useDebounce(searchInput, 300);
  useEffect(() => {
    if (search !== (params.get("q") ?? "")) patch({ q: search });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // ── tabs + the effective type set on the wire ──
  const tabs = useMemo(() => buildTabs(meta.data?.types ?? []), [meta.data]);
  const activeTab = useMemo(
    () => tabs.find((x) => x.id === tabId) ?? tabs[0] ?? { id: ALL_TAB, labelKey: "operations.hub.tab.all", types: [] },
    [tabs, tabId],
  );
  // The type SELECT narrows WITHIN the active tab; it never widens past it, so
  // the tab strip and the rows on screen can never disagree.
  const typeOptions = useMemo(() => {
    const visible = (meta.data?.types ?? []).filter((x) => x.visible);
    return activeTab.types.length ? visible.filter((x) => activeTab.types.includes(x.documentType)) : visible;
  }, [meta.data, activeTab]);
  const effectiveTypes = useMemo(() => {
    if (typeFilter && typeOptions.some((x) => x.documentType === typeFilter)) return [typeFilter];
    return activeTab.types;
  }, [typeFilter, typeOptions, activeTab]);

  const statusOptions = meta.data?.canonicalStatuses ?? [];
  const warehouseId = scope && scope !== ALL_WAREHOUSES ? scope : "";

  const list = useOperationsList({
    page,
    pageSize,
    types: effectiveTypes,
    statuses: statusFilter ? [statusFilter] : [],
    warehouseId,
    dateFrom,
    dateTo,
    search,
    sort,
    dir,
  });

  // Warehouse options: a scoped user only ever sees their own warehouses.
  const allWh = useWarehouses();
  const whOptions = useMemo(() => {
    if (!allWarehousesAccess) return accessibleWarehouses.map((w) => ({ id: w.id, name: w.name }));
    return (allWh.data?.warehouses ?? []).map((w) => ({ id: w.id, name: w.name }));
  }, [allWarehousesAccess, accessibleWarehouses, allWh.data]);

  // ── DataTable owns the sort-header interaction; mirror it back to the URL ──
  const initialSort = useMemo<{ columnId: string; dir: "asc" | "desc" }>(() => ({ columnId: sort, dir }), [sort, dir]);
  const onStateChange = useCallback(
    (st: { page: number; pageSize: number; sort: { columnId: string; dir: "asc" | "desc" } | null; search: string }) => {
      const nextCol = st.sort && sortable.includes(st.sort.columnId) ? st.sort.columnId : "date";
      const nextDir = st.sort?.dir ?? "desc";
      if (nextCol === sort && nextDir === dir) return;
      patch({ sort: nextCol, dir: nextDir });
    },
    [patch, sortable, sort, dir],
  );

  const rows = list.data?.data ?? [];
  const counts = list.data?.counts ?? {};
  const total = list.data?.pagination.total ?? 0;
  const totalPages = list.data?.pagination.totalPages ?? 1;
  const deniedTypes = list.data?.deniedTypes ?? [];
  const unavailableTypes = list.data?.unavailableTypes ?? [];

  const columns = useMemo<ColumnDef<OperationRow>[]>(() => {
    const dash = "—";
    const side = (s: OperationRow["source"]) => s.label || s.id || dash;
    return [
      {
        id: "documentNumber",
        header: t("operations.hub.col.number"),
        accessor: (r) => r.documentNumber ?? r.documentId,
        sortable: true,
        hideable: false,
        priority: 1,
        cell: (r) => (
          <span className="font-extrabold text-slate-900" dir="ltr">
            {r.documentNumber ?? r.documentId}
          </span>
        ),
      },
      {
        id: "documentType",
        header: t("operations.hub.col.type"),
        accessor: (r) => typeLabel(t, r.documentType, r.documentTypeLabel),
        sortable: true,
        hideable: false,
        priority: 2,
        cell: (r) => <Badge tone="neutral">{typeLabel(t, r.documentType, r.documentTypeLabel)}</Badge>,
      },
      {
        id: "date",
        header: t("operations.hub.col.date"),
        accessor: (r) => r.date,
        sortable: true,
        priority: 3,
        cell: (r) => <span className="text-slate-500">{formatDate(r.date)}</span>,
      },
      {
        id: "status",
        header: t("operations.hub.col.status"),
        accessor: (r) => statusLabel(t, r.status),
        sortable: true,
        priority: 4,
        cell: (r) => <StatusBadge>{statusLabel(t, r.status)}</StatusBadge>,
      },
      {
        id: "source",
        header: t("operations.hub.col.source"),
        accessor: (r) => side(r.source),
        ellipsis: true,
      },
      {
        id: "destination",
        header: t("operations.hub.col.destination"),
        accessor: (r) => side(r.destination),
        ellipsis: true,
      },
      {
        id: "party",
        header: t("operations.hub.col.party"),
        accessor: (r) => r.partyLabel || r.productSummary || dash,
        ellipsis: true,
      },
      {
        id: "lineCount",
        header: t("operations.hub.col.lines"),
        numeric: true,
        accessor: (r) => r.lineCount,
        cell: (r) => (r.lineCount == null ? dash : formatNumber(r.lineCount)),
      },
      {
        id: "totalQuantity",
        header: t("operations.hub.col.quantity"),
        numeric: true,
        accessor: (r) => r.totalQuantity,
        cell: (r) => (r.totalQuantity == null ? dash : formatQty(r.totalQuantity)),
      },
      {
        id: "totalValue",
        header: t("operations.hub.col.value"),
        numeric: true,
        sortable: true,
        accessor: (r) => r.totalValue,
        // A signed source (adjustment / stocktake) reports a VARIANCE: −500 means
        // the count destroyed 500 of value. Never ABS() it away.
        cellTone: (r) => (r.valueSigned && (r.totalValue ?? 0) < 0 ? "negative" : undefined),
        cell: (r) => (r.totalValue == null ? dash : formatCurrency(r.totalValue)),
      },
      {
        id: "currency",
        header: t("operations.hub.col.currency"),
        accessor: (r) => r.currency,
        defaultHidden: true,
      },
      {
        id: "createdBy",
        header: t("operations.hub.col.createdBy"),
        accessor: (r) => r.createdByName || r.createdBy || dash,
        ellipsis: true,
      },
      {
        id: "approvedBy",
        header: t("operations.hub.col.approvedBy"),
        accessor: (r) => r.approvedByName || r.approvedBy || dash,
        ellipsis: true,
      },
    ];
  }, [t]);

  const hasFilters = !!(search || typeFilter || statusFilter || warehouseId || dateFrom || dateTo || activeTab.types.length);

  // Even the list separator is language-dependent: Arabic uses «،», English «,».
  const joinTypes = (list: string[]) =>
    list.map((x) => typeLabel(t, x)).join(lang === "ar" ? "، " : ", ");

  const filterBar = (
    <>
      <label className="relative min-w-0 flex-1 sm:min-w-56">
        <input
          className="field h-10 w-full py-2"
          type="search"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={t("operations.hub.searchPlaceholder")}
          aria-label={t("operations.hub.searchPlaceholder")}
        />
      </label>
      <Select
        className="h-10 w-auto"
        value={typeFilter}
        onChange={(e) => patch({ type: e.target.value })}
        aria-label={t("operations.hub.filter.type")}
      >
        <option value="">{t("operations.hub.filter.allTypes")}</option>
        {typeOptions.map((o) => (
          <option key={o.documentType} value={o.documentType}>
            {typeLabel(t, o.documentType, o.label)}
          </option>
        ))}
      </Select>
      <Select
        className="h-10 w-auto"
        value={statusFilter}
        onChange={(e) => patch({ status: e.target.value })}
        aria-label={t("operations.hub.filter.status")}
      >
        <option value="">{t("operations.hub.filter.allStatuses")}</option>
        {statusOptions.map((s) => (
          <option key={s} value={s}>
            {statusLabel(t, s)}
          </option>
        ))}
      </Select>
      <Select
        className="h-10 w-auto"
        value={warehouseId}
        onChange={(e) => {
          setScope(e.target.value || ALL_WAREHOUSES);
          patch({ page: null }, false);
        }}
        aria-label={t("operations.hub.filter.warehouse")}
      >
        <option value="">{t("operations.hub.filter.allWarehouses")}</option>
        {whOptions.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </Select>
      <DatePicker
        className="h-10 w-auto"
        value={dateFrom}
        onChange={(v) => patch({ dateFrom: v })}
        aria-label={t("operations.hub.filter.dateFrom")}
      />
      <DatePicker
        className="h-10 w-auto"
        value={dateTo}
        onChange={(v) => patch({ dateTo: v })}
        aria-label={t("operations.hub.filter.dateTo")}
      />
    </>
  );

  return (
    <div>
      <PageHeader eyebrow={t("operations.eyebrow")} title={t("operations.title")} subtitle={t("operations.subtitle")} />

      {/* Tabs — built from /meta, counted from the list endpoint's per-type
          counts (which honor every filter EXCEPT the type filter, so a tab
          never reads 0 just because another tab is selected). */}
      <div role="tablist" aria-label={t("operations.title")} className="mb-4 flex flex-wrap gap-1.5">
        {tabs.map((tab) => {
          const active = tab.id === activeTab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => patch({ tab: tab.id === ALL_TAB ? null : tab.id, type: null })}
              className={`min-h-10 rounded-xl border px-4 text-sm font-extrabold transition ${
                active
                  ? "border-teal-600 bg-teal-600 text-white"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {t(tab.labelKey)}
              {list.data && (
                <span className="ms-2 text-xs font-bold opacity-80" dir="ltr">
                  {formatNumber(tabCount(tab, counts))}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Server-reported result size for the ACTIVE filter set (announced, so a
          filter change is perceivable without watching the table repaint). */}
      {!list.isError && (
        <p
          className="mb-3 inline-flex items-center gap-2 text-xs font-bold text-slate-400"
          role="status"
          aria-live="polite"
        >
          <PackageSearch className="h-4 w-4" aria-hidden="true" />
          {t("operations.hub.resultCount", { count: formatNumber(total) })}
        </p>
      )}

      {/* A user must never silently see fewer documents than exist. */}
      {(deniedTypes.length > 0 || unavailableTypes.length > 0) && (
        <div className="mb-4 space-y-2">
          {deniedTypes.length > 0 && (
            <p className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">
              <EyeOff className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>
                {t("operations.hub.notice.denied", { types: joinTypes(deniedTypes) })}
              </span>
            </p>
          )}
          {unavailableTypes.length > 0 && (
            <p className="flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-600">
              <ServerOff className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>
                {t("operations.hub.notice.unavailable", { types: joinTypes(unavailableTypes) })}
              </span>
            </p>
          )}
        </div>
      )}

      <DataTable<OperationRow>
        mode="server"
        columns={columns}
        rows={rows}
        rowCount={total}
        getRowId={(r) => r.id}
        loading={list.isLoading}
        error={list.isError ? list.error : undefined}
        onRetry={() => list.refetch()}
        initialSort={initialSort}
        onStateChange={onStateChange}
        searchable={false}
        paginate={false}
        columnMenu
        canColumn={(cap) => can(cap as Parameters<typeof can>[0])}
        filterBar={filterBar}
        onRowClick={(r) => navigate(`/inventory/operations/${r.documentType}/${r.documentId}`)}
        mobileTitle={(r) => r.documentNumber ?? r.documentId}
        emptyTitle={t("operations.hub.empty.title")}
        emptyBody={hasFilters ? t("operations.hub.empty.filtered") : t("operations.hub.empty.body")}
      />

      {total > 0 && !list.isError && (
        <div className="surface mt-3">
          <Pagination
            page={page}
            pageCount={totalPages}
            total={total}
            pageSize={pageSize}
            onPageChange={(p) => patch({ page: p }, false)}
            onPageSizeChange={(s) => patch({ pageSize: s })}
            pageSizeOptions={PAGE_SIZES.filter((s) => s <= (meta.data?.maxPageSize ?? 100))}
          />
        </div>
      )}
    </div>
  );
}
