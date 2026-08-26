import { useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import { useParams, useSearchParams, Link } from "react-router-dom";
import { ArrowLeft, ArrowRight, Download, Printer, ArrowUpDown, AlertTriangle } from "lucide-react";
import { PageHeader,
  PrintDocument,
} from "@/shared/ui";
import { Button, DatePicker } from "@/shared/ui";
import { LoadingState, EmptyState, ErrorState } from "@/shared/ui";
import { useLang, useT, translateApiError } from "@/i18n";
import type { TFunction } from "@/i18n";
import { useWarehouseScope, ALL_WAREHOUSES } from "@/modules/inventory/lib/warehouse-scope-provider";
import { fetchReportPrintSnapshot, useReport, type ReportFilters } from "@/modules/inventory/lib/hooks/useReport";
import { localizeReportWarning, type ReportResult } from "@/modules/inventory/lib/adapters/reports.adapter";
import { downloadReportCsv } from "@/shared/lib";
import { formatCurrency, formatNumber, formatQty, formatDate, formatDateTime } from "@/shared/lib";
import { REPORTS, type ColFormat, type ReportColumn } from "@/modules/inventory/lib/reports-config";
import { PageCounter } from "@/shared/tables";

// Status filter option VALUES per report; labels resolve via
// inventoryRest.reports.statusFilter.<key> (partially_received → partiallyReceived).
const STATUS_OPTION_VALUES: Record<string, string[]> = {
  "stock-balance": ["available", "low", "out", "negative"],
  transfers: ["approved", "issued", "partially_received", "received", "cancelled", "reversed"],
  "receipts-issues": ["approved", "issued", "received", "cancelled"],
  adjustments: ["pending", "approved"],
};
const STATUS_KEY_MAP: Record<string, string> = { partially_received: "partiallyReceived" };
function statusFilterLabel(t: TFunction, v: string): string {
  return t(`inventoryRest.reports.statusFilter.${STATUS_KEY_MAP[v] ?? v}`);
}

function fmt(v: unknown, format?: ColFormat): string {
  const numeric = format === "currency" || format === "qty" || format === "number";
  if (v == null || v === "") return numeric ? formatNumber(0) : "—";
  switch (format) {
    case "currency": return formatCurrency(Number(v));
    case "qty": return formatQty(Number(v));
    case "number": return formatNumber(Number(v));
    case "date": return formatDate(String(v));
    case "datetime": return formatDateTime(String(v));
    default: return String(v);
  }
}

function StatusPill({ label, status = "" }: { label: string; status?: string }) {
  const semantic = status.toLowerCase();
  const bad = /negative|out|expired|critical|rejected|cancelled/.test(semantic)
    || /سالب|نافد|منتهٍ|حرج|مرفوض|ملغى|negative|out|expired|critical|rejected|cancelled/i.test(label);
  const warn = /low|soon|partial|pending/.test(semantic)
    || /منخفض|قريب|جزئي|بانتظار|low|soon|partial|pending/i.test(label);
  const cls = bad ? "bg-rose-50 text-rose-700" : warn ? "bg-amber-50 text-amber-700" : "bg-teal-50 text-teal-700";
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-bold ${cls}`}>{label || "—"}</span>;
}

function rawValueKey(column: ReportColumn, row: Record<string, unknown>, value: unknown) {
  if (column.key === "typeLabel") return String(row.type ?? value ?? "");
  if (column.key === "severityLabel") return String(row.severity ?? value ?? "");
  if (column.key === "status" || column.key === "statusLabel") return String(row.status ?? value ?? "");
  if (column.key === "reasonLabel") return String(row.reason ?? value ?? "");
  return String(value ?? "");
}

export function localizeReportValue(column: ReportColumn, value: unknown, row: Record<string, unknown>, t: TFunction) {
  if ((column.key === "label" || column.key === "note") && row.metric) {
    const qualityPath = row.measurementFailed && column.key === "note"
      ? "inventoryRest.reports.dataQuality.failedNote"
      : `inventoryRest.reports.dataQuality.${String(row.metric)}.${column.key}`;
    const qualityLabel = t(qualityPath);
    if (qualityLabel !== qualityPath) return qualityLabel;
  }
  const raw = rawValueKey(column, row, value);
  const path = `inventoryRest.reports.value.${raw}`;
  const translated = t(path);
  return translated === path ? String(value ?? "") : translated;
}

function ReportValue({ column, value, row, t }: { column: ReportColumn; value: unknown; row: Record<string, unknown>; t: TFunction }) {
  const raw = rawValueKey(column, row, value);
  const label = localizeReportValue(column, value, row, t);
  if (column.format === "status") return <StatusPill label={label} status={raw} />;
  if (column.format === "currency" || column.format === "qty" || column.format === "number" || column.format === "date" || column.format === "datetime") {
    return <>{fmt(value, column.format)}</>;
  }
  return <>{label || "—"}</>;
}

export function ReportDetailPage({ reportType: reportTypeOverride }: { reportType?: string } = {}) {
  const t = useT();
  const lang = useLang();
  const BackIcon = lang === "ar" ? ArrowRight : ArrowLeft;
  const { reportType: reportTypeParam = "" } = useParams();
  const reportType = reportTypeOverride ?? reportTypeParam;
  const config = REPORTS[reportType];
  const { scope, accessibleWarehouses } = useWarehouseScope();
  const [params, setParams] = useSearchParams();
  const [categoryDraft, setCategoryDraft] = useState(() => params.get("category") || "");
  const [searchDraft, setSearchDraft] = useState(() => params.get("q") || "");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  const [printSnapshot, setPrintSnapshot] = useState<ReportResult | null>(null);
  const [printContext, setPrintContext] = useState<{ filters: ReportFilters; scopeLabel: string } | null>(null);

  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(params.get("pageSize")) || 25));
  const sort = params.get("sort") || config?.defaultSort?.sort || "";
  const dir = (params.get("dir") as "asc" | "desc") || config?.defaultSort?.dir || "desc";
  const filters = useMemo(() => ({
    lang,
    from: params.get("from") || undefined,
    to: params.get("to") || undefined,
    category: params.get("category") || undefined,
    status: params.get("status") || undefined,
    type: params.get("type") || undefined,
    q: params.get("q") || undefined,
    window: Number(params.get("window")) || undefined,
    page, pageSize, sort: sort || undefined, dir,
  }), [params, page, pageSize, sort, dir, lang]);

  const { data, isLoading, isError, error, refetch, isFetching } = useReport(reportType, scope, filters);

  useEffect(() => setCategoryDraft(params.get("category") || ""), [params]);
  useEffect(() => setSearchDraft(params.get("q") || ""), [params]);

  if (!config) {
    return (
      <div>
        <PageHeader eyebrow={t("inventoryRest.reports.eyebrow")} title={t("inventoryRest.reports.unknownTitle")} />
        <EmptyState title={t("inventoryRest.reports.unknownTitle")} body={t("inventoryRest.reports.unknownBody")} action={<Link className="text-sm font-bold text-teal-700" to="/reports/inventory">{t("inventoryRest.reports.backToCenter")}</Link>} />
      </div>
    );
  }

  function patch(next: Record<string, string | number | undefined>, resetPage = true) {
    const sp = new URLSearchParams(params);
    Object.entries(next).forEach(([k, v]) => {
      if (v === undefined || v === "" || v === null) sp.delete(k);
      else sp.set(k, String(v));
    });
    if (resetPage) sp.delete("page");
    setParams(sp, { replace: true });
  }

  function toggleSort(col: ReportColumn) {
    if (!col.sortKey) return;
    const nextDir = sort === col.sortKey && dir === "desc" ? "asc" : "desc";
    patch({ sort: col.sortKey, dir: nextDir }, false);
  }

  async function onExport() {
    setExportError(null);
    setExporting(true);
    try {
      await downloadReportCsv(reportType, {
        lang,
        warehouseId: scope && scope !== ALL_WAREHOUSES ? scope : undefined,
        from: filters.from, to: filters.to, category: filters.category, status: filters.status,
        type: filters.type, q: filters.q, window: filters.window, sort: filters.sort, dir,
      });
    } catch (e) {
      setExportError(translateApiError(e, t));
    } finally {
      setExporting(false);
    }
  }

  async function onPrint() {
    if (!data || isFetching || printing) return;
    setPrintError(null);
    setPrinting(true);
    const requestFilters = { ...filters };
    const requestScope = scope;
    const requestWarehouse = accessibleWarehouses.find((warehouse) => warehouse.id === requestScope);
    const requestScopeLabel = requestScope === ALL_WAREHOUSES
      ? t("inventoryRest.reports.scopeAll")
      : t("inventoryRest.reports.scopeScoped", { scope: requestWarehouse?.name || requestScope });
    setPrintContext({ filters: requestFilters, scopeLabel: requestScopeLabel });
    try {
      const snapshot = await fetchReportPrintSnapshot(reportType, requestScope, requestFilters);
      // The browser must see the complete snapshot in the same commit before
      // it captures the print tree; otherwise React's async state batching can
      // leave the currently visible server page on paper.
      flushSync(() => setPrintSnapshot(snapshot));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      window.print();
    } catch (e) {
      setPrintError(translateApiError(e, t));
    } finally {
      setPrintSnapshot(null);
      setPrintContext(null);
      setPrinting(false);
    }
  }

  const reportData = printSnapshot ?? data;
  const rows = reportData?.rows ?? [];
  const totals = reportData?.totals ?? {};
  const pagination = data?.pagination ?? null;
  const total = printSnapshot ? rows.length : (pagination?.total ?? rows.length);
  const totalPages = pagination?.totalPages ?? 1;
  const fromRow = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const toRow = Math.min(page * pageSize, total);
  const scopedWarehouse = accessibleWarehouses.find((warehouse) => warehouse.id === scope);
  const scopedWarehouseLabel = scopedWarehouse?.name || scope;
  const scopeLabel = printSnapshot && printContext
    ? printContext.scopeLabel
    : reportData?.scope?.allWarehousesAccess && scope === ALL_WAREHOUSES
      ? t("inventoryRest.reports.scopeAll")
      : t("inventoryRest.reports.scopeScoped", { scope: scopedWarehouseLabel });
  const displayedFilters = printSnapshot && printContext ? printContext.filters : filters;
  const hasDateRange = config.filters.includes("dateRange");
  const statusOpts = STATUS_OPTION_VALUES[reportType];
  const sortableColumns = config.columns.filter((column) => column.sortKey);
  const printFilterParts = [
    displayedFilters.from ? `${t("inventoryRest.reports.filterFrom")}: ${formatDate(displayedFilters.from)}` : "",
    displayedFilters.to ? `${t("inventoryRest.reports.filterTo")}: ${formatDate(displayedFilters.to)}` : "",
    displayedFilters.category ? `${t("inventoryRest.reports.filterCategory")}: ${displayedFilters.category}` : "",
    displayedFilters.type ? `${t("inventoryRest.reports.filterType")}: ${displayedFilters.type === "in" ? t("inventoryRest.reports.filterTypeIn") : t("inventoryRest.reports.filterTypeOut")}` : "",
    displayedFilters.status ? `${t("inventoryRest.reports.filterStatus")}: ${statusFilterLabel(t, displayedFilters.status)}` : "",
    displayedFilters.window ? `${t("inventoryRest.reports.filterWindow")}: ${t("inventoryRest.reports.filterWindowDays", { days: displayedFilters.window })}` : "",
    displayedFilters.q ? `${t("inventoryRest.reports.filterSearch")}: ${displayedFilters.q}` : "",
  ].filter(Boolean);

  const actions = (
    <div className="no-print flex flex-wrap items-center gap-2">
      <Button variant="secondary" onClick={onExport} disabled={exporting}>
        <Download className="h-4 w-4" /> {exporting ? t("inventoryRest.reports.exporting") : t("inventoryRest.reports.exportCsv")}
      </Button>
      <Button variant="secondary" onClick={() => void onPrint()} disabled={!data || isFetching || printing}>
        <Printer className="h-4 w-4" /> {printing ? t("inventoryRest.reports.preparingPrint") : t("inventoryRest.ui.print")}
      </Button>
      <Link to="/reports/inventory" className="inline-flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-bold text-slate-500 hover:bg-slate-100">
        <BackIcon className="h-4 w-4" /> {t("inventoryRest.reports.reportsLink")}
      </Link>
    </div>
  );

  return (
    // One head, one hidden-chrome rule, for every printed report.
    <PrintDocument
      title={t(config.label)}
      subtitle={t("inventoryRest.reports.scopeSubtitle", { scope: scopeLabel, count: formatNumber(total) })}
      meta={printFilterParts.length > 0 ? printFilterParts.join(" · ") : undefined}
      className={config.columns.length >= 7 ? "print-landscape print-long-report" : "print-long-report"}
    >
      <PageHeader eyebrow={t("inventoryRest.reports.detailEyebrow")} title={t(config.label)} subtitle={t("inventoryRest.reports.scopeSubtitle", { scope: scopeLabel, count: formatNumber(total) })} action={actions} />

      {/* Filters */}
      {(config.filters.length > 0) && (
        <div className="no-print surface mb-4 flex flex-wrap items-end gap-3 p-4">
          {hasDateRange && (
            <>
              <label className="text-xs font-bold text-slate-500">{t("inventoryRest.reports.filterFrom")}
                <DatePicker className="mt-1 block" value={filters.from ?? ""} max={filters.to} onChange={(v) => patch({ from: v })} />
              </label>
              <label className="text-xs font-bold text-slate-500">{t("inventoryRest.reports.filterTo")}
                <DatePicker className="mt-1 block" value={filters.to ?? ""} min={filters.from} onChange={(v) => patch({ to: v })} />
              </label>
            </>
          )}
          {config.filters.includes("category") && (
            <label className="text-xs font-bold text-slate-500">{t("inventoryRest.reports.filterCategory")}
              <input type="text" className="field mt-1 block" placeholder={t("inventoryRest.reports.filterCategoryPlaceholder")} value={categoryDraft} onChange={(e) => setCategoryDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") patch({ category: categoryDraft, q: searchDraft }); }} />
            </label>
          )}
          {config.filters.includes("type") && (
            <label className="text-xs font-bold text-slate-500">{t("inventoryRest.reports.filterType")}
              <select className="field mt-1 block" value={filters.type ?? ""} onChange={(e) => patch({ type: e.target.value })}>
                <option value="">{t("inventoryRest.reports.filterTypeAll")}</option><option value="in">{t("inventoryRest.reports.filterTypeIn")}</option><option value="out">{t("inventoryRest.reports.filterTypeOut")}</option>
              </select>
            </label>
          )}
          {config.filters.includes("status") && statusOpts && (
            <label className="text-xs font-bold text-slate-500">{t("inventoryRest.reports.filterStatus")}
              <select className="field mt-1 block" value={filters.status ?? ""} onChange={(e) => patch({ status: e.target.value })}>
                <option value="">{t("inventoryRest.reports.filterStatusAll")}</option>
                {statusOpts.map((v) => <option key={v} value={v}>{statusFilterLabel(t, v)}</option>)}
              </select>
            </label>
          )}
          {config.filters.includes("window") && (
            <label className="text-xs font-bold text-slate-500">{t("inventoryRest.reports.filterWindow")}
              <select className="field mt-1 block" value={filters.window ?? 90} onChange={(e) => patch({ window: e.target.value })}>
                {[30, 60, 90, 180].map((w) => <option key={w} value={w}>{t("inventoryRest.reports.filterWindowDays", { days: formatNumber(w) })}</option>)}
              </select>
            </label>
          )}
          {config.filters.includes("q") && (
            <label className="text-xs font-bold text-slate-500">{t("inventoryRest.reports.filterSearch")}
              <input type="text" className="field mt-1 block" placeholder={t("inventoryRest.reports.filterSearchPlaceholder")} value={searchDraft} onChange={(e) => setSearchDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") patch({ category: categoryDraft, q: searchDraft }); }} />
            </label>
          )}
          {(config.filters.includes("category") || config.filters.includes("q")) && (
            <Button type="button" onClick={() => patch({ category: categoryDraft, q: searchDraft })}>
              {t("common.apply")}
            </Button>
          )}
        </div>
      )}

      {exportError && (
        <div className="no-print mb-4 flex items-center gap-2 rounded-xl bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700">
          <AlertTriangle className="h-4 w-4" /> {exportError}
        </div>
      )}
      {printError && (
        <div className="no-print mb-4 flex items-center gap-2 rounded-xl bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700">
          <AlertTriangle className="h-4 w-4" /> {printError}
        </div>
      )}

      {/* Data-quality warnings */}
      {reportData?.warnings && reportData.warnings.length > 0 && (
        <div className="mb-4 space-y-2">
          {reportData.warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> <span>{localizeReportWarning(w, t)}</span>
            </div>
          ))}
        </div>
      )}

      {isLoading && <LoadingState />}
      {isError && <ErrorState error={error} onRetry={refetch} />}

      {data && !isError && (
        <article className="surface overflow-hidden">
          {/* Totals strip */}
          <div className="flex flex-wrap gap-x-8 gap-y-2 border-b border-slate-100 px-5 py-4">
            {config.totals.map((tot) => (
              <div key={tot.key}>
                <div className="text-xs font-bold text-slate-400">{t(tot.label)}</div>
                <div className="text-base font-extrabold text-slate-900 tabular-nums">{fmt(totals[tot.key], tot.format)}</div>
              </div>
            ))}
            <div className="ms-auto self-end text-xs font-medium text-slate-400">
              {t("inventoryRest.reports.generated", { date: formatDateTime(reportData?.generatedAt) })}{isFetching && !isLoading ? t("inventoryRest.reports.updating") : ""}
            </div>
          </div>

          {rows.length === 0 ? (
            <EmptyState title={t("inventoryRest.reports.emptyTitle")} body={t("inventoryRest.reports.emptyBody")} />
          ) : (
            <>
              {sortableColumns.length > 0 && (
                <div className="no-print flex items-center gap-2 border-b border-slate-100 p-3 lg:hidden">
                  <select
                    className="field min-w-0 flex-1"
                    aria-label={t("inventoryRest.reports.sortBy")}
                    value={sort}
                    onChange={(event) => patch({ sort: event.target.value, dir }, false)}
                  >
                    {sortableColumns.map((column) => <option key={column.key} value={column.sortKey}>{t(column.label)}</option>)}
                  </select>
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={dir === "asc" ? t("inventoryRest.reports.sortAscending") : t("inventoryRest.reports.sortDescending")}
                    onClick={() => patch({ dir: dir === "asc" ? "desc" : "asc" }, false)}
                  >
                    <ArrowUpDown className="h-4 w-4" />
                    {dir === "asc" ? t("inventoryRest.reports.sortAscending") : t("inventoryRest.reports.sortDescending")}
                  </Button>
                </div>
              )}
              <div className="grid gap-3 p-3 sm:grid-cols-2 lg:hidden print:hidden">
                {rows.map((row, rowIndex) => (
                  <article key={rowIndex} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                    <h3 className="break-words text-sm font-extrabold text-slate-900">
                      {config.columns[0] && <ReportValue column={config.columns[0]} value={row[config.columns[0].key]} row={row} t={t} />}
                    </h3>
                    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-slate-100 pt-3">
                      {config.columns.slice(1).map((column) => (
                        <div key={column.key} className="min-w-0">
                          <dt className="text-[10px] font-bold text-slate-400">{t(column.label)}</dt>
                          <dd className="mt-1 break-words text-xs font-extrabold text-slate-700">
                            <ReportValue column={column} value={row[column.key]} row={row} t={t} />
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </article>
                ))}
              </div>
              <div className="hidden overflow-x-auto lg:block print:block">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-start text-xs font-bold text-slate-500">
                    {config.columns.map((c) => (
                      <th key={c.key} className="px-4 py-3 text-start">
                        {c.sortKey ? (
                          <button type="button" onClick={() => toggleSort(c)} className="inline-flex min-h-11 w-full items-center gap-1 text-start hover:text-teal-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40">
                            {t(c.label)}
                            <ArrowUpDown className={`h-3 w-3 ${sort === c.sortKey ? "text-teal-600" : "text-slate-300"}`} />
                          </button>
                        ) : t(c.label)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={i} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                      {config.columns.map((c) => {
                        const v = row[c.key];
                        const isNeg = (c.format === "currency" || c.format === "qty" || c.format === "number") && Number(v) < 0;
                        return (
                          <td key={c.key} className={`px-4 py-3 ${c.format === "currency" || c.format === "qty" || c.format === "number" ? "tabular-nums" : ""} ${isNeg ? "font-bold text-rose-600" : "text-slate-700"}`}>
                            <ReportValue column={c} value={v} row={row} t={t} />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </>
          )}

          {/* Pagination */}
          {pagination && total > 0 && (
            <div className="no-print flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-5 py-4 text-sm">
              <div className="font-medium text-slate-500">{t("inventoryRest.ui.showingRange", { from: formatNumber(fromRow), to: formatNumber(toRow), total: formatNumber(total) })}</div>
              <div className="flex items-center gap-2">
                <select className="field" value={pageSize} onChange={(e) => patch({ pageSize: e.target.value })}>
                  {[25, 50, 100, 200].map((s) => <option key={s} value={s}>{t("inventoryRest.ui.perPage", { count: s })}</option>)}
                </select>
                <Button variant="secondary" disabled={page <= 1} onClick={() => patch({ page: page - 1 }, false)} aria-label={t("inventoryRest.ui.prev")}>{t("inventoryRest.ui.prev")}</Button>
                <PageCounter page={page} pageCount={totalPages} className="px-1 font-bold text-slate-600" />
                <Button variant="secondary" disabled={page >= totalPages} onClick={() => patch({ page: page + 1 }, false)} aria-label={t("inventoryRest.ui.next")}>{t("inventoryRest.ui.next")}</Button>
              </div>
            </div>
          )}
        </article>
      )}
    </PrintDocument>
  );
}
