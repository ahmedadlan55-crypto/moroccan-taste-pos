import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown, Download } from "lucide-react";
import { cn } from "@/shared/lib";
import {
  Checkbox,
  EmptyState,
  ErrorState,
  LoadingState,
  Skeleton,
} from "@/shared/ui";
import { useTableState, type TableStateApi } from "@/shared/hooks";
import type { ColumnDef } from "./types";
import { TableShell, Th, Thead } from "./primitives";
import { Pagination } from "./Pagination";
import { FilterBar } from "./FilterBar";
import { BulkActionBar } from "./BulkActionBar";
import { ColumnsMenu } from "./ColumnsMenu";
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
  filterBar?: ReactNode;
  toolbarActions?: ReactNode;
  columnMenu?: boolean;
  exportFilename?: string;
  /** Override CSV export (e.g. to call the server `downloadCsv`). Receives the
   *  current filtered+sorted rows. When omitted, a client-side CSV is downloaded. */
  onExport?: (rows: T[]) => void;

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
  onStateChange?: (state: {
    page: number;
    pageSize: number;
    sort: { columnId: string; dir: "asc" | "desc" } | null;
    search: string;
  }) => void;

  className?: string;
}

const OVERSCAN = 6;

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
    filterBar,
    toolbarActions,
    columnMenu = true,
    exportFilename,
    onExport,
    selectable = false,
    onSelectionChange,
    bulkActions,
    onRowClick,
    rowActions,
    stackOnMobile = true,
    mobileTitle,
    virtualize = false,
    rowHeight = 48,
    maxBodyHeight = 560,
    tableId,
    onStateChange,
    className,
  } = props;

  const isServer = mode === "server";

  const initialHidden = useMemo(
    () => columns.filter((c) => c.defaultHidden).map((c) => c.id),
    [columns],
  );

  const t: TableStateApi = useTableState({
    persistKey: tableId,
    initialPageSize,
    initialSort,
    initialHidden,
  });

  const [selected, setSelected] = useState<Set<string>>(new Set());

  // report state for server-mode callers
  useEffect(() => {
    onStateChange?.({ page: t.page, pageSize: t.pageSize, sort: t.sort, search: t.search });
  }, [t.page, t.pageSize, t.sort, t.search, onStateChange]);

  // ── derive the view (client mode does the work in-memory) ──
  const searched = useMemo(() => {
    if (isServer || !t.search.trim()) return rows;
    const needle = t.search.trim().toLowerCase();
    return rows.filter((row) =>
      columns.some((c) => {
        const v = c.accessor ? c.accessor(row) : undefined;
        return v != null && String(v).toLowerCase().includes(needle);
      }),
    );
  }, [rows, columns, t.search, isServer]);

  const sorted = useMemo(() => {
    if (isServer || !t.sort) return searched;
    const col = columns.find((c) => c.id === t.sort?.columnId);
    if (!col?.accessor) return searched;
    const acc = col.accessor;
    const dir = t.sort.dir === "asc" ? 1 : -1;
    return [...searched].sort((a, b) => compareValues(acc(a), acc(b)) * dir);
  }, [searched, columns, t.sort, isServer]);

  const total = isServer ? (rowCount ?? rows.length) : sorted.length;
  const pageCount = Math.max(1, Math.ceil(total / Math.max(1, t.pageSize)));

  const paged = useMemo(() => {
    if (isServer || !paginate) return sorted;
    const start = (t.page - 1) * t.pageSize;
    return sorted.slice(start, start + t.pageSize);
  }, [sorted, isServer, paginate, t.page, t.pageSize]);

  const visibleColumns = useMemo(
    () => columns.filter((c) => !t.hiddenColumns.includes(c.id)),
    [columns, t.hiddenColumns],
  );

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
  const bodyRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const virtualActive = virtualize && !isServer;
  const vStart = virtualActive ? Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN) : 0;
  const vCount = virtualActive ? Math.ceil(maxBodyHeight / rowHeight) + OVERSCAN * 2 : paged.length;
  const vEnd = virtualActive ? Math.min(paged.length, vStart + vCount) : paged.length;
  const windowRows = virtualActive ? paged.slice(vStart, vEnd) : paged;
  const padTop = virtualActive ? vStart * rowHeight : 0;
  const padBottom = virtualActive ? Math.max(0, (paged.length - vEnd) * rowHeight) : 0;

  const colSpan = visibleColumns.length + (selectable ? 1 : 0) + (rowActions ? 1 : 0);

  const canExport = !!exportFilename || !!onExport;
  const showToolbar = searchable || filterBar || toolbarActions || columnMenu || canExport;

  function handleExport() {
    const data = isServer ? rows : sorted;
    if (onExport) onExport(data);
    else if (exportFilename) downloadRowsCsv(visibleColumns, data, exportFilename);
  }

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

  const bodyRows = (
    <tbody>
      {virtualActive && padTop > 0 && (
        <tr aria-hidden="true">
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
              <td className="w-10 px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                <Checkbox
                  checked={isSel}
                  onChange={() => toggleRow(id)}
                  aria-label="تحديد الصف"
                />
              </td>
            )}
            {visibleColumns.map((col) => (
              <td
                key={col.id}
                dir={col.numeric ? "ltr" : undefined}
                style={col.width != null ? { width: col.width } : undefined}
                className={cn(
                  "px-3 py-2.5 align-middle text-slate-700",
                  col.numeric ? "text-left font-semibold tabular-nums" : ALIGN[col.align ?? "start"],
                )}
              >
                {renderCell(col, row)}
              </td>
            ))}
            {rowActions && (
              <td className="w-px px-3 py-2.5 text-left" onClick={(e) => e.stopPropagation()}>
                {rowActions(row)}
              </td>
            )}
          </tr>
        );
      })}
      {virtualActive && padBottom > 0 && (
        <tr aria-hidden="true">
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
              aria-label="تحديد كل الصفوف"
            />
          </Th>
        )}
        {visibleColumns.map((col) => {
          const sortable = col.sortable && !!col.accessor;
          return (
            <Th
              key={col.id}
              align={col.align}
              numeric={col.numeric}
              style={col.width != null ? { width: col.width } : undefined}
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
                  <Download className="h-4 w-4" /> تصدير CSV
                </button>
              )}
              {columnMenu && columns.some((c) => c.hideable !== false) && (
                <ColumnsMenu columns={columns} hiddenColumns={t.hiddenColumns} onToggle={t.toggleColumn} />
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
                    {visibleColumns.filter((col) => !col.mobileHidden).map((col) => (
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
                          aria-label={typeof mobileTitle?.(row) === "string" ? String(mobileTitle(row)) : "فتح تفاصيل الصف"}
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
                              aria-label="تحديد الصف"
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
