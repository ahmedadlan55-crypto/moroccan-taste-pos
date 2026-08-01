import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown, Download } from "lucide-react";
import { cn } from "@/shared/lib";
import {
  Checkbox,
  EmptyState,
  ErrorState,
  LoadingState,
  Skeleton,
} from "@/shared/ui";
import { useTx } from "@/shared/ui/i18n";
import { useDebounce, useTableState, type TableStateApi } from "@/shared/hooks";
import { apiClient } from "@/shared/api";
import type { ColumnDef } from "./types";
import { TableShell, Th, Thead } from "./primitives";
import { Pagination } from "./Pagination";
import { FilterBar } from "./FilterBar";
import { BulkActionBar } from "./BulkActionBar";
import { ColumnsMenu } from "./ColumnsMenu";
import { SavedViews, type SavedViewState } from "./SavedViews";
import { downloadRowsCsv } from "./csv";

const ALIGN: Record<"start" | "center" | "end", string> = {
  start: "text-right",
  center: "text-center",
  end: "text-left",
};

function compareValues(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "ar", { numeric: true });
}

export interface DataTableProps<T> {
  columns: ColumnDef<T>[];
  rows: T[];
  getRowId: (row: T) => string;

  /** "client" (default) sorts/filters/paginates in-memory; "server" renders rows
   *  as-is and reports state changes via onStateChange for the caller to refetch. */
  mode?: "client" | "server";
  /** Server total row count (required for server-mode pagination). */
  rowCount?: number;

  // ── state (loading / empty / error) ──
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  emptyTitle?: string;
  emptyBody?: string;
  emptyAction?: ReactNode;

  // ── initial table state ──
  initialPageSize?: number;
  initialSort?: { columnId: string; dir: "asc" | "desc" } | null;
  pageSizeOptions?: number[];
  paginate?: boolean;

  // ── toolbar ──
  searchable?: boolean;
  searchPlaceholder?: string;
  /** Debounce (ms) applied before the toolbar search commits to filtering /
   *  onStateChange. The input echoes immediately; downstream is debounced. */
  searchDebounceMs?: number;
  filterBar?: ReactNode;
  toolbarActions?: ReactNode;
  columnMenu?: boolean;
  exportFilename?: string;
  /** Override CSV export (e.g. to call the server `downloadCsv`). Receives the
   *  current filtered+sorted rows. When omitted, a client-side CSV is downloaded. */
  onExport?: (rows: T[]) => void;
  /**
   * When set, a "Saved views" control is rendered in the toolbar and views are
   * persisted/loaded via `/api/saved-views?module=<savedViewsModule>` (A2), with
   * a localStorage fallback if that endpoint is not reachable. A view captures
   * `{ hiddenColumns, sort, pageSize, filters }`.
   */
  savedViewsModule?: string;

  // ── selection ──
  selectable?: boolean;
  onSelectionChange?: (ids: string[]) => void;
  bulkActions?: (ids: string[], clear: () => void) => ReactNode;

  // ── rows ──
  onRowClick?: (row: T) => void;
  rowActions?: (row: T) => ReactNode;

  // ── responsive / perf ──
  stackOnMobile?: boolean;
  mobileTitle?: (row: T) => ReactNode;
  virtualize?: boolean;
  rowHeight?: number;
  maxBodyHeight?: number;

  /** Persist column visibility / page size / sort per table id. Also reported
   *  to onStateChange so server callers can key their queries. */
  tableId?: string;
  /** When true (and `tableId` set), per-user column visibility additionally
   *  syncs via `/api/user-preferences` (A2), still with localStorage fallback. */
  syncColumnPrefs?: boolean;
  onStateChange?: (state: {
    page: number;
    pageSize: number;
    sort: { columnId: string; dir: "asc" | "desc" } | null;
    search: string;
  }) => void;

  /**
   * Resolve whether the current user holds a column's `requireCap`. When a
   * column sets `requireCap`, pass this from the screen's permission hook (e.g.
   * `canColumn={(cap) => can(cap)}` using `useCan`/`usePermissions`) to gate the
   * column. DEFAULT: show all — DataTable stays decoupled from the permission
   * modules (importing the hook here crashes suites that partially-mock them),
   * so a `requireCap` column is only hidden when a `canColumn` resolver denies it.
   * Columns with no `requireCap` are always shown.
   */
  canColumn?: (cap: string) => boolean;

  className?: string;
}

const OVERSCAN = 6;
/** Above this many rendered rows we virtualize even without an explicit
 *  `virtualize` prop (and regardless of client/server mode). */
const VIRTUAL_ROW_THRESHOLD = 200;

/** Fallback px width for a `pinStart` column that has no numeric `width`. */
const DEFAULT_PIN_WIDTH = 120;
/** `cellTone` → soft token background + strong text (StatusBadge families). */
const CELL_TONE_CLASS: Record<"positive" | "negative" | "warning", string> = {
  positive: "bg-emerald-50 text-emerald-700",
  negative: "bg-rose-50 text-rose-700",
  warning: "bg-amber-50 text-amber-700",
};

/**
 * The ONE generic data table. Column defs (header/accessor/cell/align/sortable/
 * hideable/width/numeric), client + server modes, global search, per-column sort,
 * a FilterBar slot, pagination, a column show/hide menu, CSV export, row-click +
 * row actions, a BulkActionBar (selection), loading/empty/error states, numeric
 * cells (LTR tabular), a mobile stacked-card layout, and optional virtualization.
 */
export function DataTable<T>(props: DataTableProps<T>) {
  const {
    columns,
    rows,
    getRowId,
    mode = "client",
    rowCount,
    loading = false,
    error,
    onRetry,
    emptyTitle,
    emptyBody,
    emptyAction,
    initialPageSize = 25,
    initialSort = null,
    pageSizeOptions,
    paginate = true,
    searchable = false,
    searchPlaceholder,
    searchDebounceMs = 300,
    filterBar,
    toolbarActions,
    columnMenu = true,
    exportFilename,
    onExport,
    savedViewsModule,
    selectable = false,
    onSelectionChange,
    bulkActions,
    onRowClick,
    rowActions,
    stackOnMobile = true,
    mobileTitle,
    virtualize = false,
    rowHeight = 52,
    maxBodyHeight = 560,
    tableId,
    syncColumnPrefs = false,
    onStateChange,
    canColumn,
    className,
  } = props;

  const isServer = mode === "server";

  // ── permission-gated columns ──
  // A column is dropped (header + cells + columns-menu + CSV export) when it sets
  // `requireCap` and the injected `canColumn` resolver denies it. Default is
  // show-all: DataTable does NOT import the permission modules (calling the hook
  // here crashes consumer suites that partially-mock them), so callers wire caps
  // via the `canColumn` prop from their own `useCan`/`usePermissions`.
  const resolveCap = useCallback(
    (cap: string) => (canColumn ? canColumn(cap) : true),
    [canColumn],
  );
  const permittedColumns = useMemo(
    () => columns.filter((c) => !c.requireCap || resolveCap(c.requireCap)),
    [columns, resolveCap],
  );

  const initialHidden = useMemo(
    () => permittedColumns.filter((c) => c.defaultHidden).map((c) => c.id),
    [permittedColumns],
  );

  const tx = useTx();
  const t: TableStateApi = useTableState({
    persistKey: tableId,
    initialPageSize,
    initialSort,
    initialHidden,
  });

  const [selected, setSelected] = useState<Set<string>>(new Set());

  // ── debounced search ──
  // The input echoes immediately and CLIENT-mode in-memory filtering stays
  // instant (t.search is set on every keystroke). Only the DOWNSTREAM, expensive
  // signal — the onStateChange report that server callers use to refetch — is
  // debounced, so a server table refetches once the user pauses (~searchDebounceMs)
  // instead of on every keystroke.
  const debouncedSearch = useDebounce(t.search, searchDebounceMs);

  // report state for server-mode callers (search is debounced; the rest is live)
  useEffect(() => {
    onStateChange?.({ page: t.page, pageSize: t.pageSize, sort: t.sort, search: debouncedSearch });
  }, [t.page, t.pageSize, t.sort, debouncedSearch, onStateChange]);

  // ── derive the view (client mode does the work in-memory) ──
  const searched = useMemo(() => {
    if (isServer || !t.search.trim()) return rows;
    const needle = t.search.trim().toLowerCase();
    return rows.filter((row) =>
      permittedColumns.some((c) => {
        const v = c.accessor ? c.accessor(row) : undefined;
        return v != null && String(v).toLowerCase().includes(needle);
      }),
    );
  }, [rows, permittedColumns, t.search, isServer]);

  const sorted = useMemo(() => {
    if (isServer || !t.sort) return searched;
    const col = permittedColumns.find((c) => c.id === t.sort?.columnId);
    if (!col?.accessor) return searched;
    const acc = col.accessor;
    const dir = t.sort.dir === "asc" ? 1 : -1;
    return [...searched].sort((a, b) => compareValues(acc(a), acc(b)) * dir);
  }, [searched, permittedColumns, t.sort, isServer]);

  const total = isServer ? (rowCount ?? rows.length) : sorted.length;
  const pageCount = Math.max(1, Math.ceil(total / Math.max(1, t.pageSize)));

  const paged = useMemo(() => {
    if (isServer || !paginate) return sorted;
    const start = (t.page - 1) * t.pageSize;
    return sorted.slice(start, start + t.pageSize);
  }, [sorted, isServer, paginate, t.page, t.pageSize]);

  const visibleColumns = useMemo(
    () => permittedColumns.filter((c) => !t.hiddenColumns.includes(c.id)),
    [permittedColumns, t.hiddenColumns],
  );

  // ── pinStart offsets ──
  // Cumulative insetInlineStart (logical: right in RTL, left in LTR) per pinned
  // column, summed from the NUMERIC `width` of the pinned columns before it
  // (DEFAULT_PIN_WIDTH when a pinned column has no numeric width). Empty map
  // when nothing is pinned → the render below is byte-identical to before.
  const pinOffsets = useMemo(() => {
    const map = new Map<string, number>();
    let acc = 0;
    for (const col of visibleColumns) {
      if (!col.pinStart) continue;
      map.set(col.id, acc);
      acc += typeof col.width === "number" ? col.width : DEFAULT_PIN_WIDTH;
    }
    return map;
  }, [visibleColumns]);

  /** Sticky positioning for a pinned cell. zIndex stays BELOW the sticky header
   *  (thead is z-10): td=5 beats scrolled static cells, th=1 beats its static
   *  siblings inside the thead stacking context. */
  function applyPinStyle(style: CSSProperties, col: ColumnDef<T>, layer: "th" | "td"): void {
    const offset = pinOffsets.get(col.id);
    if (offset === undefined) return;
    style.position = "sticky";
    style.insetInlineStart = offset;
    style.zIndex = layer === "td" ? 5 : 1;
    if (typeof col.width !== "number") style.width = DEFAULT_PIN_WIDTH;
  }

  // Mobile-card column order: keep declaration order, then float columns with an
  // explicit `priority` to the front in ascending order (stable for ties / undefined).
  const mobileColumns = useMemo(() => {
    const shown = visibleColumns.filter((c) => !c.mobileHidden);
    return shown
      .map((col, idx) => ({ col, idx }))
      .sort((a, b) => {
        const pa = a.col.priority ?? Number.POSITIVE_INFINITY;
        const pb = b.col.priority ?? Number.POSITIVE_INFINITY;
        return pa - pb || a.idx - b.idx;
      })
      .map((x) => x.col);
  }, [visibleColumns]);

  // ── selection ──
  const pageIds = useMemo(() => paged.map(getRowId), [paged, getRowId]);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const somePageSelected = pageIds.some((id) => selected.has(id));

  const emitSelection = (next: Set<string>) => {
    setSelected(next);
    onSelectionChange?.([...next]);
  };
  const toggleRow = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    emitSelection(next);
  };
  const toggleAllOnPage = () => {
    const next = new Set(selected);
    if (allPageSelected) pageIds.forEach((id) => next.delete(id));
    else pageIds.forEach((id) => next.add(id));
    emitSelection(next);
  };
  const clearSelection = () => emitSelection(new Set());

  // ── virtualization window (non-mobile table body) ──
  // Virtualize when explicitly requested OR when the rendered page exceeds the
  // threshold — regardless of client/server mode (a 200-row server page benefits
  // just as much). Basing this on the RENDERED array (`paged`) keeps small
  // paginated pages untouched. Sticky header still works: the scroll container
  // wraps the whole <table>, so <thead className="sticky top-0"> pins inside it.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const virtualActive = virtualize || paged.length > VIRTUAL_ROW_THRESHOLD;
  const vStart = virtualActive ? Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN) : 0;
  const vCount = virtualActive ? Math.ceil(maxBodyHeight / rowHeight) + OVERSCAN * 2 : paged.length;
  const vEnd = virtualActive ? Math.min(paged.length, vStart + vCount) : paged.length;
  const windowRows = virtualActive ? paged.slice(vStart, vEnd) : paged;
  const padTop = virtualActive ? vStart * rowHeight : 0;
  const padBottom = virtualActive ? Math.max(0, (paged.length - vEnd) * rowHeight) : 0;

  const colSpan = visibleColumns.length + (selectable ? 1 : 0) + (rowActions ? 1 : 0);

  const canExport = !!exportFilename || !!onExport;
  const showToolbar =
    searchable || filterBar || toolbarActions || columnMenu || canExport || !!savedViewsModule;

  function handleExport() {
    const data = isServer ? rows : sorted;
    if (onExport) onExport(data);
    // `visibleColumns` already excludes cap-denied + hidden columns, so a
    // permission-gated column never leaks into the CSV.
    else if (exportFilename) downloadRowsCsv(visibleColumns, data, exportFilename);
  }

  // Apply a saved view onto the live table state.
  const applySavedView = (s: SavedViewState) => {
    if (s.hiddenColumns) t.setHiddenColumns(s.hiddenColumns);
    if (s.sort !== undefined) t.setSort(s.sort ?? null);
    if (s.pageSize) t.setPageSize(s.pageSize);
    if (s.filters) {
      t.clearFilters();
      for (const [k, v] of Object.entries(s.filters)) t.setFilter(k, v);
    }
  };

  // ── optional per-user column-visibility sync (A2 /api/user-preferences) ──
  // Hydrate once from the server (overriding localStorage when present), then
  // push updates. Fully best-effort: any failure leaves the localStorage-backed
  // useTableState persistence as the source of truth.
  const prefHydrated = useRef(false);
  useEffect(() => {
    if (!syncColumnPrefs || !tableId) return;
    let alive = true;
    apiClient
      .get<{ value?: { hiddenColumns?: string[] } }>("/user-preferences", {
        params: { key: `table:${tableId}` },
      })
      .then((pref) => {
        if (alive && Array.isArray(pref?.value?.hiddenColumns)) {
          t.setHiddenColumns(pref.value.hiddenColumns as string[]);
        }
      })
      .catch(() => {
        /* 404 while A2 ships / unreachable → keep localStorage state */
      })
      .finally(() => {
        prefHydrated.current = true;
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncColumnPrefs, tableId]);

  useEffect(() => {
    if (!syncColumnPrefs || !tableId || !prefHydrated.current) return;
    apiClient
      .put("/user-preferences", { key: `table:${tableId}`, value: { hiddenColumns: t.hiddenColumns } })
      .catch(() => {
        /* best-effort */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.hiddenColumns]);

  const sortIcon = (colId: string) => {
    if (t.sort?.columnId !== colId) return <ChevronsUpDown className="h-3.5 w-3.5 text-slate-300" />;
    return t.sort.dir === "asc" ? (
      <ArrowUp className="h-3.5 w-3.5 text-teal-600" />
    ) : (
      <ArrowDown className="h-3.5 w-3.5 text-teal-600" />
    );
  };

  function renderCell(col: ColumnDef<T>, row: T): ReactNode {
    if (col.cell) return col.cell(row);
    const v = col.accessor ? col.accessor(row) : undefined;
    return v == null ? "—" : String(v);
  }

  /** Best-effort native tooltip for an ellipsized cell (from the raw string value). */
  function cellTitle(col: ColumnDef<T>, row: T): string | undefined {
    if (!col.ellipsis) return undefined;
    const v = col.accessor ? col.accessor(row) : undefined;
    return v == null ? undefined : String(v);
  }

  const bodyRows = (
    <tbody>
      {virtualActive && padTop > 0 && (
        <tr aria-hidden="true" className="print:hidden" data-virtual-spacer="true">
          <td colSpan={colSpan} style={{ height: padTop }} />
        </tr>
      )}
      {windowRows.map((row) => {
        const id = getRowId(row);
        const isSel = selected.has(id);
        return (
          <tr
            key={id}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            className={cn(
              "border-b border-slate-100 transition last:border-0 hover:bg-slate-50/80",
              onRowClick && "cursor-pointer",
              isSel && "bg-teal-50/50",
            )}
            style={virtualActive ? { height: rowHeight } : undefined}
          >
            {selectable && (
              <td className="w-10 px-3 py-3.5" onClick={(e) => e.stopPropagation()}>
                <Checkbox
                  checked={isSel}
                  onChange={() => toggleRow(id)}
                  aria-label={tx("table.selectRow")}
                />
              </td>
            )}
            {visibleColumns.map((col) => {
              const style: CSSProperties = {};
              if (col.width != null) style.width = col.width;
              // Ellipsis needs a cap to truncate against; fall back to ~18rem.
              if (col.ellipsis) style.maxWidth = col.width ?? "18rem";
              applyPinStyle(style, col, "td");
              const pinned = pinOffsets.has(col.id);
              const tone = col.cellTone?.(row);
              const content = renderCell(col, row);
              return (
                <td
                  key={col.id}
                  dir={col.numeric ? "ltr" : undefined}
                  style={Object.keys(style).length ? style : undefined}
                  className={cn(
                    "px-3 py-3.5 align-middle text-slate-700",
                    col.numeric ? "text-left font-semibold tabular-nums" : ALIGN[col.align ?? "start"],
                    // Pinned cells need an OPAQUE background (rows underneath
                    // scroll behind them) + a subtle end-side separator. A
                    // cellTone background wins over the pin white (cn/twMerge).
                    pinned && "border-e border-slate-200 bg-white",
                    tone && CELL_TONE_CLASS[tone],
                  )}
                >
                  {col.ellipsis ? (
                    <div className="truncate" title={cellTitle(col, row)}>
                      {content}
                    </div>
                  ) : (
                    content
                  )}
                </td>
              );
            })}
            {rowActions && (
              <td className="w-px px-3 py-3.5 text-left" onClick={(e) => e.stopPropagation()}>
                {rowActions(row)}
              </td>
            )}
          </tr>
        );
      })}
      {virtualActive && padBottom > 0 && (
        <tr aria-hidden="true" className="print:hidden" data-virtual-spacer="true">
          <td colSpan={colSpan} style={{ height: padBottom }} />
        </tr>
      )}
    </tbody>
  );

  const head = (
    <Thead className="sticky top-0 z-10">
      <tr>
        {selectable && (
          <Th className="w-10">
            <Checkbox
              checked={allPageSelected}
              indeterminate={!allPageSelected && somePageSelected}
              onChange={toggleAllOnPage}
              aria-label={tx("table.selectAllRows")}
            />
          </Th>
        )}
        {visibleColumns.map((col) => {
          const sortable = col.sortable && !!col.accessor;
          const thStyle: CSSProperties = {};
          if (col.width != null) thStyle.width = col.width;
          applyPinStyle(thStyle, col, "th");
          return (
            <Th
              key={col.id}
              align={col.align}
              numeric={col.numeric}
              style={Object.keys(thStyle).length ? thStyle : undefined}
              className={cn(pinOffsets.has(col.id) && "border-e border-slate-200 bg-slate-50")}
              aria-sort={
                t.sort?.columnId === col.id ? (t.sort.dir === "asc" ? "ascending" : "descending") : undefined
              }
            >
              {sortable ? (
                <button
                  type="button"
                  onClick={() => t.toggleSort(col.id)}
                  className={cn(
                    "inline-flex items-center gap-1 font-extrabold transition hover:text-slate-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100",
                    col.numeric && "flex-row-reverse",
                  )}
                >
                  {col.header}
                  {sortIcon(col.id)}
                </button>
              ) : (
                col.header
              )}
            </Th>
          );
        })}
        {rowActions && <Th className="w-px" />}
      </tr>
    </Thead>
  );

  // ── error / loading full-panel states ──
  if (error) {
    return (
      <div className={className}>
        <ErrorState error={error} onRetry={onRetry} />
      </div>
    );
  }
  const initialLoading = loading && rows.length === 0;

  return (
    <div className={cn("surface overflow-hidden", className)}>
      {showToolbar && (
        <FilterBar
          search={searchable ? t.search : undefined}
          onSearchChange={searchable ? t.setSearch : undefined}
          searchPlaceholder={searchPlaceholder}
          actions={
            <>
              {toolbarActions}
              {canExport && paged.length > 0 && (
                <button
                  type="button"
                  onClick={handleExport}
                  className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-600 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"
                >
                  <Download className="h-4 w-4" /> {tx("table.exportCsv")}
                </button>
              )}
              {savedViewsModule && (
                <SavedViews
                  tableId={tableId ?? savedViewsModule}
                  module={savedViewsModule}
                  current={{
                    hiddenColumns: t.hiddenColumns,
                    sort: t.sort,
                    pageSize: t.pageSize,
                    filters: t.filters,
                  }}
                  onApply={applySavedView}
                />
              )}
              {columnMenu && permittedColumns.some((c) => c.hideable !== false) && (
                <ColumnsMenu columns={permittedColumns} hiddenColumns={t.hiddenColumns} onToggle={t.toggleColumn} />
              )}
            </>
          }
        >
          {filterBar}
        </FilterBar>
      )}

      {initialLoading ? (
        <div className="p-4">
          <LoadingState />
        </div>
      ) : paged.length === 0 ? (
        <EmptyState title={emptyTitle} body={emptyBody} action={emptyAction} />
      ) : (
        <>
          {/* Desktop / tablet: real table */}
          <div className={stackOnMobile ? "hidden md:block" : undefined}>
            {virtualActive ? (
              <div
                ref={bodyRef}
                className="scrollbar-thin overflow-y-auto"
                style={{ maxHeight: maxBodyHeight }}
                onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
              >
                <TableShell>
                  {head}
                  {bodyRows}
                </TableShell>
              </div>
            ) : (
              <TableShell>
                {head}
                {bodyRows}
              </TableShell>
            )}
            {loading && rows.length > 0 && (
              <div className="px-4 py-2">
                <Skeleton className="h-1 w-full" />
              </div>
            )}
          </div>

          {/* Mobile: stacked cards */}
          {stackOnMobile && (
            <ul className="divide-y divide-slate-100 md:hidden">
              {paged.map((row) => {
                const id = getRowId(row);
                const mobileContent = (
                  <div className="min-w-0 flex-1 space-y-1.5">
                    {mobileTitle && (
                      <div className="break-words text-sm font-extrabold text-slate-900">{mobileTitle(row)}</div>
                    )}
                    {mobileColumns.map((col) => (
                      <div key={col.id} className="flex min-w-0 items-baseline justify-between gap-3 text-xs">
                        <span className="shrink-0 font-bold text-slate-400">
                          {typeof col.header === "string" ? col.header : (col.label ?? col.id)}
                        </span>
                        <span
                          dir={col.numeric ? "ltr" : undefined}
                          className={cn(
                            "min-w-0 flex-1 break-words text-end font-semibold text-slate-700 [overflow-wrap:anywhere]",
                            col.numeric && "tabular-nums",
                          )}
                        >
                          {renderCell(col, row)}
                        </span>
                      </div>
                    ))}
                  </div>
                );
                return (
                  <li key={id} className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      {onRowClick ? (
                        <button
                          type="button"
                          onClick={() => onRowClick(row)}
                          className="min-w-0 flex-1 rounded-xl text-right outline-none transition active:bg-slate-50 focus-visible:ring-4 focus-visible:ring-teal-100"
                          aria-label={typeof mobileTitle?.(row) === "string" ? String(mobileTitle(row)) : tx("table.openRowDetails")}
                        >
                          {mobileContent}
                        </button>
                      ) : mobileContent}
                      <div className="flex shrink-0 items-center gap-2">
                        {selectable && (
                          <span onClick={(e) => e.stopPropagation()}>
                            <Checkbox
                              checked={selected.has(id)}
                              onChange={() => toggleRow(id)}
                              aria-label={tx("table.selectRow")}
                            />
                          </span>
                        )}
                        {rowActions && <span onClick={(e) => e.stopPropagation()}>{rowActions(row)}</span>}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {paginate && !initialLoading && total > 0 && (
        <Pagination
          page={t.page}
          pageCount={pageCount}
          total={total}
          pageSize={t.pageSize}
          onPageChange={t.setPage}
          onPageSizeChange={t.setPageSize}
          pageSizeOptions={pageSizeOptions}
        />
      )}

      {selectable && bulkActions && (
        <BulkActionBar count={selected.size} onClear={clearSelection}>
          {bulkActions([...selected], clearSelection)}
        </BulkActionBar>
      )}
    </div>
  );
}
