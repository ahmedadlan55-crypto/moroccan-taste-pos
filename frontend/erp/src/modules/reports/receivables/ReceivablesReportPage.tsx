// ONE page for all thirteen order-to-cash reports.
//
// The reports differ only in their columns, their date controls and one extra
// capability, and every one of those differences is declared in `registry.ts`.
// So there is one component, not thirteen near-copies that drift apart the first
// time the print header or the totals rule changes.
//
// WHAT THIS PAGE DELIBERATELY DOES NOT DO
//   · It does NOT render the server's `columns[].label`. Those are hard-coded
//     Arabic in O2CReportingService.js and would print Arabic headers on an
//     English screen. Labels come from the registry's i18n keys; the server's
//     array stays what it is — the CSV contract, used by the export endpoint.
//   · It does NOT sum anything. The <tfoot> is `totals` from the server, mapped
//     column-by-column through `totalsKey`, and a column whose total the server
//     did not send prints nothing rather than a client-side zero.
//   · It does NOT treat an empty report as a failure. These reports are
//     branch-scoped and FAIL CLOSED in SQL: a caller with no branch grants gets
//     HTTP 200 with zero rows, on purpose. That is an EmptyState, never an error.
import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { Download } from "lucide-react";
import { Button, DatePicker, EmptyState, Num, PermissionDenied, PrintDocument } from "@/shared/ui";
import { StatementTable, type StatementColumn, type StatementRowBase, type StatementTotals } from "@/shared/reports";
import {
  downloadCsv,
  formatAsAt,
  formatDate,
  formatForPeriod,
  formatNumber,
  formatQty,
  startOfYearISO,
  todayISO,
} from "@/shared/lib";
import { usePermissions } from "@/shared/permissions";
import { translateApiError, useT, type TFunction } from "@/i18n";
import { o2cApi } from "@/modules/sales/lib/api";
import { qk } from "@/modules/sales/lib/query-keys";
import {
  FilterCard,
  FilterField,
  ReportHeader,
  ReportState,
  printReport,
  useAppliedFilter,
} from "@/modules/accounting/components";
import {
  RECEIVABLES_EXPORT_CAP,
  RECEIVABLES_REPORT_BY_ID,
  RECEIVABLES_ROOT,
  receivablesTerm,
  type ReceivablesCellFormat,
  type ReceivablesColumn,
  type ReceivablesReportDef,
} from "./registry";

type ServerRow = Record<string, unknown>;

interface ReportRow extends StatementRowBase {
  source: ServerRow;
}

interface Filters {
  from: string;
  to: string;
  asOf: string;
}

/** Query params the endpoint actually reads — see `ReceivablesFilterKind`. */
function requestParams(def: ReceivablesReportDef, applied: Filters): Record<string, string> {
  if (def.filter === "period") return { from: applied.from, to: applied.to };
  if (def.filter === "asOf") return { asOf: applied.asOf };
  return {};
}

/**
 * The format a cell renders in. Normally the column's own; `formatFrom` lets a
 * measure inherit it from the vocabulary term of another column on the same row
 * (sales-summary, whose value column is money on every line but the count).
 */
function cellFormat(column: ReceivablesColumn, row: ServerRow): ReceivablesCellFormat {
  if (!column.formatFrom) return column.format;
  const term = receivablesTerm("metric", row[column.formatFrom]);
  return term?.format ?? column.format;
}

/** A server literal translated through its vocabulary, or the literal itself. */
function textOf(column: ReceivablesColumn, row: ServerRow, t: TFunction): string {
  const raw = row[column.key];
  if (column.vocabulary) {
    const term = receivablesTerm(column.vocabulary, raw);
    if (term) return t(`receivablesReports.values.${column.vocabulary}.${term.key}`);
  }
  if (raw == null || raw === "") return "—";
  return String(raw);
}

function renderCell(column: ReceivablesColumn, row: ServerRow, t: TFunction): ReactNode {
  const raw = row[column.key];
  switch (cellFormat(column, row)) {
    case "money":
      return <Num value={raw == null ? null : Number(raw)} signed />;
    case "count":
      return <span className="tabular-nums font-semibold text-slate-700">{formatNumber(Number(raw) || 0)}</span>;
    case "qty":
      return <span className="tabular-nums font-semibold text-slate-700">{formatQty(Number(raw) || 0)}</span>;
    case "date":
      return <span className="font-semibold text-slate-700">{raw == null || raw === "" ? "—" : formatDate(String(raw))}</span>;
    default:
      return <span className="font-semibold text-slate-700">{textOf(column, row, t)}</span>;
  }
}

export function ReceivablesReportPage({ reportId }: { reportId?: string } = {}) {
  const t = useT();
  const { can } = usePermissions();
  const params = useParams();
  const id = reportId ?? params.reportId ?? "";
  const def = RECEIVABLES_REPORT_BY_ID[id];

  const filter = useAppliedFilter<Filters>({
    from: startOfYearISO(),
    to: todayISO(),
    asOf: todayISO(),
  });
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const allowed = !def?.cap || can(def.cap);
  const query = useQuery({
    queryKey: qk.reports(id, def ? requestParams(def, filter.applied) : {}),
    queryFn: ({ signal }) => o2cApi.report(id, def ? requestParams(def, filter.applied) : {}, signal),
    enabled: !!def && allowed,
  });

  const serverRows = useMemo<ServerRow[]>(
    () => (Array.isArray(query.data?.data) ? (query.data?.data as ServerRow[]) : []),
    [query.data],
  );

  const labelColumn = def?.columns[0];
  const measureColumns = useMemo(() => def?.columns.slice(1) ?? [], [def]);

  const rows = useMemo<ReportRow[]>(() => {
    if (!labelColumn) return [];
    return serverRows.map((row, index) => {
      const label = textOf(labelColumn, row, t);
      return { id: `row-${index}`, depth: 0, kind: "line" as const, label, labelText: label, source: row };
    });
  }, [serverRows, labelColumn, t]);

  const columns = useMemo<Array<StatementColumn<ReportRow>>>(
    () =>
      measureColumns.map((column) => ({
        id: column.key,
        header: t(`receivablesReports.columns.${column.labelKey}`),
        align: column.format === "text" || column.format === "date" ? ("start" as const) : ("end" as const),
        render: (row: ReportRow) => renderCell(column, row.source, t),
      })),
    [measureColumns, t],
  );

  // SERVER TOTALS ONLY. A column the server sent no total for is left blank —
  // an invented zero under a column of real figures is a wrong number wearing
  // the authority of a bottom line.
  const totals = useMemo<StatementTotals | null>(() => {
    const fromServer = query.data?.totals;
    if (!fromServer) return null;
    const values: Record<string, ReactNode> = {};
    let any = false;
    for (const column of measureColumns) {
      if (!column.totalsKey) continue;
      const value = fromServer[column.totalsKey];
      if (value === undefined || value === null) continue;
      any = true;
      values[column.key] =
        column.format === "count" ? formatNumber(Number(value)) : <Num value={Number(value)} strong signed />;
    }
    return any ? { label: t("receivablesReports.totalsLabel"), values } : null;
  }, [query.data, measureColumns, t]);

  if (!def) {
    return (
      <EmptyState
        title={t("receivablesReports.states.unknownTitle")}
        action={
          <Link className="text-sm font-bold text-teal-700" to={RECEIVABLES_ROOT}>
            {t("receivablesReports.states.back")}
          </Link>
        }
      />
    );
  }

  if (!allowed) return <PermissionDenied />;

  const title = t(`receivablesReports.reports.${def.i18nKey}.title`);
  const subtitle =
    def.filter === "period"
      ? formatForPeriod(filter.applied.from, filter.applied.to)
      : formatAsAt(def.filter === "asOf" ? (query.data?.asOf ?? filter.applied.asOf) : todayISO());

  async function onExport() {
    if (!def) return;
    setExportError(null);
    setExporting(true);
    try {
      await downloadCsv(
        `/order-to-cash/reports/${def.id}/export`,
        `o2c-${def.id}-${todayISO()}.csv`,
        requestParams(def, filter.applied),
      );
    } catch (error) {
      setExportError(translateApiError(error, t));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div>
      <ReportHeader
        title={title}
        subtitle={t(`receivablesReports.reports.${def.i18nKey}.subtitle`)}
        onPrint={printReport}
        extraActions={
          can(RECEIVABLES_EXPORT_CAP) ? (
            <Button variant="secondary" onClick={onExport} loading={exporting} disabled={rows.length === 0}>
              <Download className="h-4 w-4" /> {t("table.exportCsv")}
            </Button>
          ) : null
        }
      />

      {def.filter !== "none" && (
        <FilterCard onRun={filter.run} running={query.isFetching}>
          {def.filter === "period" ? (
            <>
              <FilterField label={t("receivablesReports.filters.from")}>
                <DatePicker value={filter.draft.from} onChange={(from) => filter.patch({ from })} />
              </FilterField>
              <FilterField label={t("receivablesReports.filters.to")}>
                <DatePicker value={filter.draft.to} onChange={(to) => filter.patch({ to })} />
              </FilterField>
            </>
          ) : (
            <FilterField label={t("receivablesReports.filters.asOf")}>
              <DatePicker value={filter.draft.asOf} onChange={(asOf) => filter.patch({ asOf })} />
            </FilterField>
          )}
        </FilterCard>
      )}

      {exportError && (
        <p className="no-print mb-4 text-sm font-bold text-rose-700" role="alert">
          {exportError}
        </p>
      )}

      <ReportState
        isLoading={query.isLoading}
        error={query.error}
        isEmpty={rows.length === 0}
        onRetry={() => query.refetch()}
      >
        <PrintDocument title={title} subtitle={subtitle} className="print-long-report">
          <div className="surface p-4">
            <StatementTable
              rows={rows}
              columns={columns}
              labelHeader={t(`receivablesReports.columns.${def.columns[0].labelKey}`)}
              totals={totals}
            />
          </div>
        </PrintDocument>
      </ReportState>
    </div>
  );
}

export default ReceivablesReportPage;
