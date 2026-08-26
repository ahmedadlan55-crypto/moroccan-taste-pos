// ONE page for all nine purchasing reports.
//
// Header, filters, table, server totals, print and export — and nothing else
// around it. No KPI wall, no sibling decision tables, no readiness matrix, no
// second report embedded under the first. Everything that varies between the
// nine lives in `registry.ts`; what varies is data, not layout.
//
// PAPER IS A SEPARATE RENDER, NOT THE SCREEN WITH THINGS HIDDEN.
//   The screen table is a paginated DataTable, so printing it would emit one
//   page of rows plus the pagination strip. A `print-only` PrintDocument
//   therefore renders the COMPLETE row set with a real <tfoot>, exactly as
//   accounting/coa/CoaListPage does. Both are built from the same declared
//   columns, so they can never disagree about what a column means.
import { useMemo, useState, type ReactNode } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { Download, Printer } from "lucide-react";
import {
  Button,
  DatePicker,
  EmptyState,
  Num,
  PageHeader,
  PrintDocument,
  SearchableEntityCombobox,
  StatusBadge,
  fmt,
} from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import {
  amountScaleNote,
  cn,
  formatAsAt,
  formatDate,
  formatForPeriod,
  formatNumber,
  formatQty,
  normalizeRoutePath,
  todayISO,
} from "@/shared/lib";
import { downloadCsv } from "@/shared/lib/downloadCsv";
import { useLang, useT, translateApiError, type TFunction } from "@/i18n";
import { usePermissions } from "@/app/providers";
import { useServerFlags } from "@/app/server-flags";
import { WarehouseModuleProviders } from "@/modules/inventory/lib/providers";
import { WarehouseScopeSelect } from "@/modules/inventory/lib/WarehouseScopeSelect";
import { ALL_WAREHOUSES, useWarehouseScope } from "@/modules/inventory/lib/warehouse-scope-provider";
import { supplierFetcher, type SupplierHit } from "@/modules/inventory/lib/hooks/useEntitySearch";
import { useProcurementReport, type ListParams } from "@/modules/inventory/lib/hooks/useProcurement";
import {
  FilterCard,
  FilterField,
  ReportState,
  exportRowsCsv,
  printReport,
  useAppliedFilter,
} from "@/modules/accounting/components";
import {
  getPurchasingReport,
  type PurchasingColumn,
  type PurchasingColumnFormat,
  type PurchasingReportDef,
  type PurchasingTotalField,
} from "./registry";

type Row = Record<string, unknown>;

interface Applied {
  from: string;
  to: string;
  asOfDate: string;
}

/** First day of the current month — the period every purchasing report opens on. */
function monthStartISO(): string {
  const today = todayISO();
  return `${today.slice(0, 7)}-01`;
}

// ── value rendering ─────────────────────────────────────────────────────────
// One formatter pair per declared format: `cell` for the screen and the paper,
// `text` for the CSV. They are written together so an exported sheet can never
// disagree with the sheet it was exported from.

function translateEnum(t: TFunction, group: "entryType" | "checks", value: string): string {
  const path = `warehouseIntelligence.purchasingReports.${group}.${value}`;
  const label = t(path);
  return label === path ? value : label;
}

/**
 * `accounting` puts a negative in parentheses, the way `Num` renders it on
 * screen and the way a printed statement is read. CSV leaves the minus sign
 * alone so a spreadsheet still parses the cell as a number.
 */
function cellText(value: unknown, format: PurchasingColumnFormat, t: TFunction, accounting = false): string {
  if (value == null || value === "") return "—";
  switch (format) {
    // `fmt` — NOT formatCurrency, which appends "ر.س" / "SAR" to every cell.
    // A money column states its unit once (see the print masthead), never on
    // each of 500 rows where it only destroys decimal alignment.
    case "money":
      return fmt(Number(value));
    case "signedMoney": {
      const n = Number(value);
      return accounting && n < 0 ? `(${fmt(Math.abs(n))})` : fmt(n);
    }
    case "qty":
      return formatQty(Number(value));
    case "number":
      return formatNumber(Number(value));
    case "date":
      return formatDate(String(value));
    case "period":
      return String(value);
    // A server-side enum the dictionary does not know yet prints its own raw
    // value — never the untranslated key path, which reads as a broken screen.
    case "statementType":
      return translateEnum(t, "entryType", String(value));
    case "checkName":
      return translateEnum(t, "checks", String(value));
    default:
      return String(value);
  }
}

function cellNode(value: unknown, format: PurchasingColumnFormat, t: TFunction): ReactNode {
  if (format === "money") return <Num value={value == null ? null : Number(value)} />;
  if (format === "signedMoney") return <Num value={value == null ? null : Number(value)} signed />;
  if (format === "status") return value == null || value === "" ? "—" : <StatusBadge>{String(value)}</StatusBadge>;
  if (format === "period") return value == null || value === "" ? "—" : <span dir="ltr" className="tabular-nums">{String(value)}</span>;
  return cellText(value, format, t);
}

function isNumericFormat(format: PurchasingColumnFormat): boolean {
  return format === "money" || format === "signedMoney" || format === "qty" || format === "number";
}

// ── envelope reading ────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

interface SnapshotMeta {
  complete: boolean;
  rowCount: number;
  rowLimit: number;
}

function readSnapshot(envelope: unknown): SnapshotMeta | null {
  const value = asRecord(asRecord(envelope).snapshot);
  const rowCount = Number(value.rowCount);
  const rowLimit = Number(value.rowLimit);
  if (value.complete !== true || !Number.isInteger(rowCount) || rowCount < 0 || !Number.isInteger(rowLimit) || rowLimit < 1) return null;
  return { complete: true, rowCount, rowLimit };
}

function safeFilePart(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "all";
}

/**
 * The payload → rows. `data-quality` answers with an object of named checks
 * rather than an array; `shape` says which, so nothing is guessed from the
 * runtime type of a response that may legitimately be empty.
 */
function toRows(envelope: unknown, report: PurchasingReportDef): Row[] {
  const data = asRecord(envelope).data;
  if (report.shape === "checks") {
    return Object.entries(asRecord(data)).map(([check, count]) => ({ check, count }));
  }
  return Array.isArray(data) ? (data as Row[]) : [];
}

/** Server totals ONLY — never recomputed here from a capped row set. */
function readTotal(envelope: unknown, field: PurchasingTotalField): unknown {
  const root = asRecord(envelope);
  if (field.from === "root") return root[field.key];
  return asRecord(root[field.from])[field.key];
}

function hasTotals(envelope: unknown, report: PurchasingReportDef): boolean {
  return !!report.totals?.some((field) => readTotal(envelope, field) != null);
}

// ── page ────────────────────────────────────────────────────────────────────

function reportIdFromPath(pathname: string): string {
  const key = normalizeRoutePath(pathname);
  const prefix = "/reports/purchasing/";
  return key.startsWith(prefix) ? key.slice(prefix.length).split("/")[0] ?? "" : "";
}

export function PurchasingReportPage({ reportId }: { reportId?: string } = {}) {
  const t = useT();
  const lang = useLang();
  const { pathname } = useLocation();
  const params = useParams();
  const id = reportId ?? params.reportId ?? reportIdFromPath(pathname);
  const report = getPurchasingReport(id);
  const { can } = usePermissions();
  const { procurementP2P } = useServerFlags();
  const { scope, accessibleWarehouses = [] } = useWarehouseScope();
  const [supplier, setSupplier] = useState<SupplierHit | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const filter = useAppliedFilter<Applied>({ from: monthStartISO(), to: todayISO(), asOfDate: todayISO() });

  const warehouseId = scope === ALL_WAREHOUSES ? undefined : scope;
  const allowed = !!report && report.capsAny.some((cap) => can(cap));
  const supplierReady = !report?.requiresSupplier || !!supplier;
  const enabled = !!report && allowed && procurementP2P && supplierReady;

  // Only the params this report actually declares. Sending `asOfDate` to a
  // period report or `dateFrom` to ap-aging would silently change what the
  // server measured, and both are accepted by parseReportFilters.
  const request = useMemo<ListParams>(() => {
    if (!report) return {};
    const next: ListParams = { warehouseId };
    if (report.filters.includes("period")) {
      next.dateFrom = filter.applied.from || undefined;
      next.dateTo = filter.applied.to || undefined;
    }
    if (report.filters.includes("asOfDate")) next.asOfDate = filter.applied.asOfDate || undefined;
    if (report.filters.includes("supplier")) next.supplierId = supplier?.id;
    return next;
  }, [report, warehouseId, filter.applied, supplier?.id]);

  const query = useProcurementReport(id, request, enabled);

  const columns = useMemo<ColumnDef<Row>[]>(() => {
    if (!report) return [];
    return report.columns.map((column) => ({
      id: column.key,
      header: t(column.labelKey),
      label: t(column.labelKey),
      accessor: (row: Row) => row[column.key],
      cell: (row: Row) => cellNode(row[column.key], column.format, t),
      align: column.align,
      numeric: isNumericFormat(column.format),
      sortable: true,
      width: column.width,
      exportValue: (row: Row) => cellText(row[column.key], column.format, t),
    }));
  }, [report, t]);

  if (!report) {
    return (
      <div>
        <PageHeader title={t("warehouseIntelligence.purchasingReports.unknownTitle")} />
        <EmptyState
          title={t("warehouseIntelligence.purchasingReports.unknownTitle")}
          body={t("warehouseIntelligence.purchasingReports.unknownBody")}
          action={<Link className="text-sm font-bold text-teal-700" to="/reports/purchasing">{t("warehouseIntelligence.purchasingReports.backToDirectory")}</Link>}
        />
      </div>
    );
  }

  const rows = toRows(query.data, report);
  const snapshot = readSnapshot(query.data);
  const serverSupplier = asRecord(asRecord(query.data).supplier);
  const supplierIdentityReady = !report.requiresSupplier
    || (String(serverSupplier.id ?? "") === supplier?.id && String(serverSupplier.name ?? "").trim() !== "");
  // Both conditions matter: `complete:true` without an exact row count is not
  // enough, and a supplier statement without an authoritative supplier identity
  // is not a statement we may print or export.
  const completeSnapshot = snapshot?.complete === true
    && snapshot.rowCount === rows.length
    && supplierIdentityReady;
  const period = report.heading === "asAt"
    ? formatAsAt(filter.applied.asOfDate)
    : formatForPeriod(filter.applied.from, filter.applied.to);
  const title = t(report.labelKey);
  const selectedWarehouse = accessibleWarehouses.find((warehouse) => warehouse.id === scope);
  const scopeLabel = scope === ALL_WAREHOUSES
    ? t("purchasing.reports.allWarehouses")
    : selectedWarehouse
      ? `${selectedWarehouse.name}${selectedWarehouse.code ? ` (${selectedWarehouse.code})` : ""}`
      : scope;
  const supplierLabel = report.requiresSupplier
    ? [String(serverSupplier.name ?? supplier?.name ?? ""), String(serverSupplier.id ?? supplier?.id ?? ""), String(serverSupplier.vatNumber ?? supplier?.vatNumber ?? "")]
      .filter(Boolean).join(" · ")
    : "";
  const printMeta = [
    `${t("purchasing.reports.scopeLabel")}: ${scopeLabel}`,
    supplierLabel ? `${t("purchasing.reports.supplierIdentity")}: ${supplierLabel}` : "",
  ].filter(Boolean).join(" · ");
  // A row identity from the declared key(s). Some rows legitimately have none —
  // ap-aging groups unlinked invoices under a synthetic supplier — so the row's
  // position in the server's own ordering is the last resort.
  const rowId = (row: Row) => {
    const parts = report.rowIdKeys.map((key) => (row[key] == null ? "" : String(row[key]))).filter(Boolean);
    return parts.length ? parts.join(":") : `row-${rows.indexOf(row)}`;
  };

  const exportSheet = (visible: Row[]) => {
    setExportError("");
    if (!completeSnapshot) {
      setExportError(t("purchasing.reports.snapshotUnverified"));
      return;
    }
    const stamp = report.heading === "asAt" ? filter.applied.asOfDate : `${filter.applied.from}_${filter.applied.to}`;
    const supplierPart = report.requiresSupplier ? `-${safeFilePart(String(serverSupplier.id ?? supplier?.id ?? "supplier"))}` : "";
    const filename = `${report.id}${supplierPart}-${safeFilePart(scope)}-${stamp}.csv`;
    // `server-csv` — these two endpoints implement ?format=csv, and the supplier
    // statement's file carries the opening-balance row that the JSON keeps in
    // the envelope rather than in `data`. Rebuilding it here would lose it.
    if (report.exportMode === "server-csv") {
      setExporting(true);
      void downloadCsv(`/procurement/reports/${report.id}`, filename, { ...request, format: "csv", lang })
        .catch((error: unknown) => setExportError(translateApiError(error, t)))
        .finally(() => setExporting(false));
      return;
    }
    exportRowsCsv(
      filename,
      report.columns.map((column) => t(column.labelKey)),
      visible.map((row) => report.columns.map((column) => cellText(row[column.key], column.format, t))),
    );
  };

  return (
    <div data-testid="purchasing-report-page" data-report={report.id}>
      <PageHeader
        eyebrow={t("warehouseIntelligence.eyebrow")}
        title={title}
        subtitle={period}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => exportSheet(rows)} disabled={exporting || !rows.length || !completeSnapshot}>
              <Download className="h-4 w-4" />
              {t(exporting ? "warehouseIntelligence.actions.exporting" : "warehouseIntelligence.actions.export")}
            </Button>
            <Button variant="secondary" onClick={printReport} disabled={!rows.length || !completeSnapshot}>
              <Printer className="h-4 w-4" />
              {t("accounting.common.print")}
            </Button>
          </div>
        }
      />

      <FilterCard onRun={filter.run}>
        {report.filters.includes("supplier") && (
          <FilterField label={t("warehouseIntelligence.filters.supplier")}>
            <div className="min-w-64">
              <SearchableEntityCombobox<SupplierHit>
                value={supplier}
                onChange={setSupplier}
                fetcher={supplierFetcher}
                queryKey={["purchasing-report", "supplier"]}
                getKey={(value) => value.id}
                getLabel={(value) => value.name}
                getSublabel={(value) => value.vatNumber || value.nameEn || undefined}
                placeholder={t("warehouseIntelligence.filters.supplierPlaceholder")}
                ariaLabel={t("warehouseIntelligence.filters.supplier")}
              />
            </div>
          </FilterField>
        )}
        {report.filters.includes("period") && (
          <>
            <FilterField label={t("warehouseIntelligence.filters.from")}>
              <DatePicker value={filter.draft.from} onChange={(value) => filter.patch({ from: value })} max={filter.draft.to || undefined} />
            </FilterField>
            <FilterField label={t("warehouseIntelligence.filters.to")}>
              <DatePicker value={filter.draft.to} onChange={(value) => filter.patch({ to: value })} min={filter.draft.from || undefined} />
            </FilterField>
          </>
        )}
        {report.filters.includes("asOfDate") && (
          <FilterField label={t("warehouseIntelligence.purchasingReports.filters.asOfDate")}>
            <DatePicker value={filter.draft.asOfDate} onChange={(value) => filter.patch({ asOfDate: value })} />
          </FilterField>
        )}
        {report.filters.includes("warehouse") && (
          <FilterField label={t("warehouseIntelligence.purchasingReports.filters.warehouse")}>
            <WarehouseScopeSelect />
          </FilterField>
        )}
      </FilterCard>

      {exportError && <div role="alert" className="no-print mb-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-800">{exportError}</div>}

      {!allowed ? (
        <EmptyState title={t("warehouseIntelligence.purchasingReports.deniedTitle")} body={t("warehouseIntelligence.purchasingReports.deniedBody")} />
      ) : !procurementP2P ? (
        <EmptyState title={t("warehouseIntelligence.specialized.unavailableTitle")} body={t("warehouseIntelligence.specialized.unavailableBody")} />
      ) : !supplierReady ? (
        <EmptyState title={t("warehouseIntelligence.specialized.selectSupplierTitle")} body={t("warehouseIntelligence.specialized.selectSupplierBody")} />
      ) : (
        <ReportState
          isLoading={query.isLoading}
          error={query.isError ? query.error : null}
          isEmpty={rows.length === 0}
          onRetry={() => void query.refetch()}
          emptyTitle={t("warehouseIntelligence.specialized.emptyTitle")}
          emptyBody={t("warehouseIntelligence.specialized.emptyBody")}
        >
          <SnapshotSummary snapshot={snapshot} complete={completeSnapshot} />
          <ServerTotals report={report} envelope={query.data} />
          <DataTable<Row>
            columns={columns}
            rows={rows}
            getRowId={rowId}
            searchable={false}
            columnMenu={false}
            initialPageSize={50}
            initialSort={report.defaultSort ? { columnId: report.defaultSort.columnKey, dir: report.defaultSort.dir } : null}
            emptyTitle={t("warehouseIntelligence.specialized.emptyTitle")}
          />
          {completeSnapshot && (
            <PrintSheet report={report} rows={rows} envelope={query.data} title={title} period={period} scopeMeta={printMeta} />
          )}
        </ReportState>
      )}
    </div>
  );
}

function SnapshotSummary({ snapshot, complete }: { snapshot: SnapshotMeta | null; complete: boolean }) {
  const t = useT();
  if (!complete || !snapshot) {
    return (
      <div role="alert" className="no-print mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold leading-5 text-amber-900">
        {t("purchasing.reports.snapshotUnverified")}
      </div>
    );
  }
  return (
    <p className="no-print mb-3 text-xs font-semibold text-slate-500" data-testid="purchasing-report-snapshot">
      {t("purchasing.reports.completeSnapshot", { count: snapshot.rowCount, limit: snapshot.rowLimit })}
    </p>
  );
}

/** The server's own footer figures, on screen. Absent figures print nothing. */
function ServerTotals({ report, envelope }: { report: PurchasingReportDef; envelope: unknown }) {
  const t = useT();
  if (!report.totals || !hasTotals(envelope, report)) return null;
  return (
    <dl className="mb-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4" data-testid="purchasing-report-totals">
      {report.totals.map((field) => {
        const value = readTotal(envelope, field);
        if (value == null) return null;
        return (
          <div key={`${field.from}:${field.key}`} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
            <dt className="text-[11px] font-bold text-slate-500">{t(field.labelKey)}</dt>
            <dd className="mt-0.5 text-sm font-extrabold">
              {field.format === "number" ? <span dir="ltr" className="tabular-nums">{formatNumber(Number(value))}</span> : <Num value={Number(value)} strong signed={field.format === "signedMoney"} />}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/**
 * The paper copy: EVERY row, in declared column order, with the server totals
 * in a real <tfoot>. Separate from the screen table because DataTable paginates
 * — printing it would silently emit one page and call it the report.
 */
function PrintSheet({ report, rows, envelope, title, period, scopeMeta }: {
  report: PurchasingReportDef;
  rows: Row[];
  envelope: unknown;
  title: string;
  period: string;
  scopeMeta: string;
}) {
  const t = useT();
  const footer = report.totals?.filter((field) => field.column && readTotal(envelope, field) != null) ?? [];
  const byColumn = new Map(footer.map((field) => [field.column as string, field]));
  const align = (column: PurchasingColumn) => (column.align === "end" ? "text-end" : "text-start");
  // The unit is stated ONCE on the sheet, never on each money cell.
  const hasMoney = report.columns.some((column) => column.format === "money" || column.format === "signedMoney");
  const meta = [
    scopeMeta,
    t("warehouseIntelligence.purchasingReports.rowCount", { count: rows.length }),
    hasMoney ? amountScaleNote({ key: "units", factor: 1 }) : "",
  ].filter(Boolean).join(" · ");

  return (
    <PrintDocument
      title={title}
      subtitle={period}
      meta={meta}
      className="print-only print-long-report"
    >
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b-2 border-slate-400 text-slate-800">
            {report.columns.map((column) => (
              <th key={column.key} className={cn("px-2 py-2", align(column))}>{t(column.labelKey)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${report.id}-print-${index}`} className="text-slate-700">
              {report.columns.map((column) => (
                <td
                  key={column.key}
                  dir={isNumericFormat(column.format) ? "ltr" : undefined}
                  className={cn("px-2 py-1.5", align(column), isNumericFormat(column.format) && "tabular-nums")}
                >
                  {cellText(row[column.key], column.format, t, true)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {byColumn.size > 0 && (
          <tfoot>
            <tr className="border-t-2 border-slate-400 font-extrabold text-slate-900">
              {report.columns.map((column, index) => {
                const field = byColumn.get(column.key);
                if (!field) {
                  return (
                    <td key={column.key} className={cn("px-2 py-2", align(column))}>
                      {index === 0 ? t("accounting.common.total") : ""}
                    </td>
                  );
                }
                return (
                  <td key={column.key} dir="ltr" className={cn("px-2 py-2 tabular-nums", align(column))}>
                    {cellText(readTotal(envelope, field), field.format, t, true)}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        )}
      </table>
    </PrintDocument>
  );
}

/** Route entry — the warehouse scope context these endpoints are filtered by. */
export default function PurchasingReportRoute({ reportId }: { reportId?: string } = {}) {
  return (
    <WarehouseModuleProviders>
      <PurchasingReportPage reportId={reportId} />
    </WarehouseModuleProviders>
  );
}
