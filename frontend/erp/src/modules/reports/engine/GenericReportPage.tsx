// The ONE page every registry-driven report renders through.
//
// It owns the four things a report has and a workspace does not: a fixed
// question (the registry entry), a period (the filter card), a printed identity
// (PrintDocument's masthead — legal name, VAT number, printed-at, page N of M)
// and nothing to click that changes data.
//
// Two decisions worth keeping:
//
//   · THE TABLE IS NOT PAGINATED. A printed report that silently stops at row
//     25 is a wrong report, not a short one — and DataTable's toolbar and pager
//     are screen chrome that would print as furniture around the figures. So
//     every toolbar input is off (`columnMenu={false}`, no search, no built-in
//     export) and `paginate={false}`: what is on screen is exactly what comes
//     out of the printer. Export and print live in the page header, which is
//     `.no-print`. Report loaders must request an all-rows snapshot whose
//     endpoint rejects an oversized result explicitly; a workspace's ordinary
//     LIMIT is never accepted as a printable report.
//
//   · TOTALS COME FROM THE SERVER OR NOT AT ALL. `ReportTotal[]` is passed
//     through from what the endpoint already computed. This page never sums a
//     column, because a locally-computed total sitting above a server-filtered
//     table is a second answer to the same question that drifts the first time
//     the server changes a filter.
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, FileText, Printer } from "lucide-react";
import { Link } from "react-router-dom";
import {
  Button,
  DatePicker,
  EmptyState,
  Num,
  PageHeader,
  PermissionDenied,
  PrintDocument,
  Select,
} from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { usePermissions } from "@/shared/permissions";
import { useAuth } from "@/app/providers";
import { capturePrintDocument, downloadReportPdf, formatDate, formatDateTime, formatNumber, formatAsAt, formatForPeriod, pdfAvailable } from "@/shared/lib";
import { useLang, useT, type TFunction } from "@/i18n";
import { FilterCard, FilterField, ReportState, exportRowsCsv, printReport } from "@/modules/accounting/components";
import type {
  ReportCell,
  ReportDefinition,
  ReportField,
  ReportFilterDef,
  ReportFilterValues,
  ReportRow,
  ReportSectionDef,
} from "./types";
import { findReport } from "./types";

// Month NAMES already exist once in the product (the payroll module's period
// picker). A report that re-translated them would be a second list to keep in
// step with the first, so this points at the existing one.
const MONTH_KEY = "people.payroll.months";

// ── filter defaults ─────────────────────────────────────────────────────────
// A report opens ANSWERED: a manager who clicks "payroll register" wants the
// latest payroll, not an empty form. Dates default to the current month, the
// month/year pair to today, a select to its first option, and a remote picker
// to whatever its first loaded option turns out to be (below).
function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function monthStartISO(now: Date): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-01`;
}

function todayISO(now: Date): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function defaultFilterValue(filter: ReportFilterDef, now: Date): string {
  if (filter.defaultValue != null) return filter.defaultValue;
  switch (filter.kind) {
    case "date":
      return filter.id === "to" ? todayISO(now) : monthStartISO(now);
    case "month":
      return String(now.getMonth() + 1);
    case "year":
      return String(now.getFullYear());
    case "select":
      return filter.options?.[0]?.value ?? "";
    default:
      return "";
  }
}

function initialValues(report: ReportDefinition, now: Date): Record<string, string> {
  const values: Record<string, string> = {};
  for (const filter of report.filters) values[filter.id] = defaultFilterValue(filter, now);
  return values;
}

// ── cell rendering ──────────────────────────────────────────────────────────
/** The CSV and the screen must never disagree, so both go through this. */
function cellText(value: ReportCell, field: ReportField, t: TFunction): string {
  if (value == null || value === "") return "—";
  switch (field.format) {
    case "date":
      return formatDate(String(value));
    case "datetime":
      return formatDateTime(String(value));
    case "count":
      return formatNumber(Number(value));
    case "money":
      return formatNumber(Number(value));
    case "status": {
      const key = field.labels?.[String(value)];
      return key ? t(key) : String(value);
    }
    default:
      return String(value);
  }
}

function toColumn(field: ReportField, t: TFunction): ColumnDef<ReportRow> {
  const numeric = field.format === "money" || field.format === "count";
  return {
    id: field.key,
    header: t(field.labelKey),
    numeric,
    accessor: (row) => (numeric ? Number(row[field.key] ?? 0) : cellText(row[field.key] ?? null, field, t)),
    cell:
      field.format === "money"
        ? (row) => <Num value={Number(row[field.key] ?? 0)} />
        : field.format === "code"
          ? (row) => (
              <span dir="ltr" className="font-mono text-xs">
                {cellText(row[field.key] ?? null, field, t)}
              </span>
            )
          : undefined,
    sortable: true,
  };
}

// ── the printed period line ─────────────────────────────────────────────────
// Derived from the filters the report actually declares, so the sheet always
// states the basis of what is on it: a range, a month, a named run, or — when a
// report has no period at all (open custody balances) — the instant it was run.
function periodLabel(
  report: ReportDefinition,
  values: ReportFilterValues,
  remoteLabel: string,
  t: TFunction,
  now: Date,
): string {
  const ids = new Set(report.filters.map((filter) => filter.id));
  if (ids.has("from") && ids.has("to")) return formatForPeriod(values.from, values.to);
  if (ids.has("month") && ids.has("year")) {
    return `${t(`${MONTH_KEY}.${values.month}`)} ${values.year}`;
  }
  if (remoteLabel) return remoteLabel;
  return formatAsAt(todayISO(now));
}

export interface GenericReportPageProps {
  section: ReportSectionDef;
  reportId: string;
}

export function GenericReportPage({ section, reportId }: GenericReportPageProps) {
  const t = useT();
  const { can } = usePermissions();
  const report = findReport(section, reportId);

  if (!report) {
    return (
      <div>
        <PageHeader eyebrow={t(section.eyebrowKey)} title={t("operationalReports.unknown.title")} />
        <EmptyState
          title={t("operationalReports.unknown.title")}
          body={t("operationalReports.unknown.body")}
          action={
            <Link className="text-sm font-bold text-teal-700" to={section.path}>
              {t("operationalReports.backToDirectory")}
            </Link>
          }
        />
      </div>
    );
  }

  // The capability is checked here and not only on the catalogue row: a report
  // URL is shareable, and hiding a row is not a permission check.
  if (!can(report.cap)) return <PermissionDenied />;

  return <ReportBody key={report.id} section={section} report={report} />;
}

function ReportBody({ section, report }: { section: ReportSectionDef; report: ReportDefinition }) {
  const t = useT();
  const now = useMemo(() => new Date(), []);
  // Deliberately NOT `useAppliedFilter`: the remote picker has to seed BOTH the
  // draft and the applied value the moment its options land (otherwise the page
  // opens on an empty select and answers nothing), and that needs two setters.
  const [draft, setDraft] = useState<Record<string, string>>(() => initialValues(report, now));
  const [applied, setApplied] = useState<Record<string, string>>(() => initialValues(report, now));

  const remote = report.filters.find((filter) => filter.kind === "remote");
  const optionsQuery = useQuery({
    queryKey: remote?.optionsKey ?? ["reports", "no-remote-filter"],
    queryFn: ({ signal }) => remote?.loadOptions?.(signal) ?? Promise.resolve([]),
    enabled: !!remote?.loadOptions,
  });
  const remoteOptions = optionsQuery.data ?? [];

  useEffect(() => {
    const first = remoteOptions[0]?.value;
    if (!remote || !first) return;
    setDraft((prev) => (prev[remote.id] ? prev : { ...prev, [remote.id]: first }));
    setApplied((prev) => (prev[remote.id] ? prev : { ...prev, [remote.id]: first }));
  }, [remote, remoteOptions]);

  const ready = !remote || !!applied[remote.id];
  const query = useQuery({
    queryKey: ["reports", section.path, report.id, applied],
    queryFn: ({ signal }) => report.load(applied, signal),
    enabled: ready,
  });

  const rows = query.data?.rows ?? [];
  const totals = query.data?.totals ?? [];
  const columns = useMemo(() => report.columns.map((field) => toColumn(field, t)), [report, t]);
  const remoteLabel = remote ? (remoteOptions.find((o) => o.value === applied[remote.id])?.label ?? "") : "";
  const title = t(report.labelKey);
  const period = periodLabel(report, applied, remoteLabel, t, now);
  // Stable per RESULT, not per render. Reprinting the same figures must quote
  // the same reference, or two identical sheets carry two different ids and
  // neither can be traced.
  const reportRunId = useMemo(
    () => `${report.id}-${Date.now().toString(36)}`,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [report.id, query.dataUpdatedAt],
  );
  const userName = useAuth().user?.username ?? "";
  const lang = useLang();

  // Ask whether this deployment can render a PDF BEFORE offering the button.
  // The browser binary is an OS package: showing an action that 503s when
  // pressed is worse than not showing it.
  const [canPdf, setCanPdf] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void pdfAvailable().then((ok) => { if (alive) setCanPdf(ok); });
    return () => { alive = false; };
  }, []);

  const onPdf = async () => {
    const html = capturePrintDocument();
    if (!html) return;
    setPdfBusy(true);
    try {
      const rendered = await downloadReportPdf({
        html,
        title,
        filename: report.csvName,
        landscape: report.columns.length >= 7,
        direction: lang === "ar" ? "rtl" : "ltr",
      });
      // A host with no renderer is not an error the user caused — fall back
      // to the print dialog, which produces the same document.
      if (!rendered) printReport();
    } catch {
      printReport();
    } finally {
      setPdfBusy(false);
    }
  };
  const invalidDateRange = Boolean(draft.from && draft.to && draft.from > draft.to);

  function onExport() {
    exportRowsCsv(
      `${report.csvName}.csv`,
      report.columns.map((field) => t(field.labelKey)),
      rows.map((row) => report.columns.map((field) => cellText(row[field.key] ?? null, field, t))),
    );
  }

  return (
    <PrintDocument
      title={title}
      subtitle={period}
      meta={t(section.titleKey)}
      className={report.columns.length >= 7 ? "print-landscape print-long-report" : "print-long-report"}
      // This shell renders every row it loaded (paginate={false}), so the sheet
      // it prints genuinely IS the whole report — which is what `complete`
      // claims, and the reason it can honestly be claimed here.
      provenance={{ reportRunId, rowCount: rows.length, complete: true, user: userName }}
    >
      <PageHeader
        eyebrow={t(section.eyebrowKey)}
        title={title}
        subtitle={t(report.descriptionKey)}
        action={
          <div className="no-print flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <Link
              to={section.path}
              className="inline-flex min-h-11 flex-1 items-center justify-center rounded-xl px-3 text-sm font-bold text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 sm:flex-none"
            >
              {t("operationalReports.backToDirectory")}
            </Link>
            <Button className="flex-1 sm:flex-none" variant="secondary" onClick={onExport} disabled={rows.length === 0 || query.isFetching}>
              <Download className="h-4 w-4" /> {t("table.exportCsv")}
            </Button>
            {canPdf && (
              <Button className="flex-1 sm:flex-none" variant="secondary" onClick={onPdf} disabled={rows.length === 0 || query.isFetching || pdfBusy}>
                <FileText className="h-4 w-4" /> {t("operationalReports.downloadPdf")}
              </Button>
            )}
            <Button className="flex-1 sm:flex-none" variant="secondary" onClick={printReport} disabled={rows.length === 0 || query.isFetching}>
              <Printer className="h-4 w-4" /> {t("operationalReports.print")}
            </Button>
          </div>
        }
      />

      {report.filters.length > 0 && (
        <FilterCard
          onRun={() => {
            if (!invalidDateRange) setApplied(draft);
          }}
          running={query.isFetching}
          runLabel={t("operationalReports.run")}
          runDisabled={invalidDateRange}
        >
          {report.filters.map((filter) => (
            <FilterField key={filter.id} label={t(filter.labelKey)}>
              <FilterControl
                filter={filter}
                value={draft[filter.id] ?? ""}
                onChange={(value) => setDraft((prev) => ({ ...prev, [filter.id]: value }))}
                min={filter.id === "to" ? draft.from : undefined}
                max={filter.id === "from" ? draft.to : undefined}
                remoteOptions={filter.kind === "remote" ? remoteOptions : []}
                loading={filter.kind === "remote" && optionsQuery.isLoading}
              />
            </FilterField>
          ))}
          {invalidDateRange && (
            <p className="col-span-full text-sm font-bold text-rose-700" role="alert">
              {t("operationalReports.filter.invalidRange")}
            </p>
          )}
        </FilterCard>
      )}

      {/* On screen the period has to be stated somewhere; on paper the masthead
          already carries it, and a document that names its own period twice
          reads as two different claims. */}
      <div className="no-print mb-4 text-sm font-bold text-slate-600" data-report-period>
        {period}
      </div>

      <ReportState
        isLoading={query.isLoading || !ready}
        error={query.error}
        isEmpty={rows.length === 0}
        onRetry={() => query.refetch()}
        emptyTitle={t("operationalReports.empty.title")}
        emptyBody={t("operationalReports.empty.body")}
      >
        {totals.length > 0 && (
          <div className="surface mb-4 flex flex-wrap gap-x-8 gap-y-3 p-4" data-report-totals>
            {totals.map((total) => (
              <div key={total.labelKey} className="min-w-32">
                <div className="text-[11px] font-bold text-slate-500">{t(total.labelKey)}</div>
                <div className="text-base font-extrabold text-slate-900">
                  {total.format === "money" ? (
                    <Num value={total.value} strong />
                  ) : (
                    <span dir="ltr" className="tabular-nums">
                      {formatNumber(total.value)}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <DataTable
          columns={columns}
          rows={rows}
          getRowId={(row) => row.id}
          columnMenu={false}
          paginate={false}
          stackOnMobile
          mobileTitle={(row) => cellText(row[report.columns[0]?.key] ?? null, report.columns[0], t)}
          tableId={`report-${report.id}`}
        />
      </ReportState>
    </PrintDocument>
  );
}

function FilterControl({
  filter,
  value,
  onChange,
  remoteOptions,
  loading,
  min,
  max,
}: {
  filter: ReportFilterDef;
  value: string;
  onChange: (value: string) => void;
  remoteOptions: ReadonlyArray<{ value: string; label: string }>;
  loading: boolean;
  min?: string;
  max?: string;
}) {
  const t = useT();
  if (filter.kind === "date") {
    return <DatePicker className="w-full sm:w-44" value={value} onChange={onChange} min={min} max={max} />;
  }
  if (filter.kind === "month") {
    return (
      <Select className="w-full sm:w-40" value={value} onChange={(event) => onChange(event.target.value)}>
        {Array.from({ length: 12 }, (_, index) => index + 1).map((month) => (
          <option key={month} value={String(month)}>
            {t(`${MONTH_KEY}.${month}`)}
          </option>
        ))}
      </Select>
    );
  }
  if (filter.kind === "year") {
    const current = new Date().getFullYear();
    return (
      <Select className="w-full sm:w-32" value={value} onChange={(event) => onChange(event.target.value)}>
        {[current + 1, current, current - 1, current - 2, current - 3].map((year) => (
          <option key={year} value={String(year)}>
            {year}
          </option>
        ))}
      </Select>
    );
  }
  if (filter.kind === "remote") {
    return (
      <Select
        className="w-full sm:w-64"
        value={value}
        disabled={loading || remoteOptions.length === 0}
        onChange={(event) => onChange(event.target.value)}
      >
        {remoteOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    );
  }
  return (
    <Select className="w-full sm:w-44" value={value} onChange={(event) => onChange(event.target.value)}>
      {(filter.options ?? []).map((option) => (
        <option key={option.value} value={option.value}>
          {t(option.labelKey)}
        </option>
      ))}
    </Select>
  );
}
