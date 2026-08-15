import { Download } from "lucide-react";
import { Button, DatePicker, PrintDocument } from "@/shared/ui";
import { formatForPeriod } from "@/shared/lib";
import { useT, type TFunction } from "@/i18n";
import {
  useEquityChanges,
  startOfYearISO,
  todayISO,
  type DateRange,
  type EquityBucket,
  type EquityChangesResponse,
  type EquityStatementLine,
} from "../api";
import {
  Num,
  fmt,
  ReportHeader,
  FilterCard,
  FilterField,
  ReportState,
  useAppliedFilter,
  printReport,
  exportRowsCsv,
} from "../components";

// /accounting/equity-changes — converted from the legacy-only equity-changes
// report. The server owns every bucket, line and the balance-sheet cross-check;
// this screen only renders the pinned /erp/reports/equity-changes payload.

function BucketSection({ bucket }: { bucket: EquityBucket }) {
  const t = useT();
  return (
    <div className="surface mb-5 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-teal-50/60 px-4 py-3">
        <span className="text-sm font-extrabold text-teal-800">{bucket.label}</span>
        <span className="flex items-center gap-4 text-xs font-bold text-slate-600">
          <span>
            {t("accounting.common.opening")}: <Num value={bucket.opening} signed />
          </span>
          <span>
            {t("accounting.common.closing")}: <Num value={bucket.closing} signed strong />
          </span>
        </span>
      </div>
      {bucket.accounts.length === 0 ? (
        // An empty bucket is stated honestly — no fabricated zero rows.
        <div className="px-4 py-4 text-sm font-semibold text-slate-400">{t("accounting.equity.none")}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[42rem] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-[11px] font-extrabold text-slate-500">
                <th className="px-4 py-2 text-right">{t("accounting.common.account")}</th>
                <th className="px-4 py-2 text-left">{t("accounting.equity.opening")}</th>
                <th className="px-4 py-2 text-left">{t("accounting.equity.periodDebit")}</th>
                <th className="px-4 py-2 text-left">{t("accounting.equity.periodCredit")}</th>
                <th className="px-4 py-2 text-left">{t("accounting.equity.closing")}</th>
              </tr>
            </thead>
            <tbody>
              {bucket.accounts.map((a) => (
                <tr key={a.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/70">
                  <td className="px-4 py-2">
                    <span className="font-semibold text-slate-700">{a.name}</span>{" "}
                    <code className="text-[11px] text-slate-400">{a.code}</code>
                  </td>
                  <td className="px-4 py-2 text-left"><Num value={a.opening} signed /></td>
                  <td className="px-4 py-2 text-left"><Num value={a.periodDebit} /></td>
                  <td className="px-4 py-2 text-left"><Num value={a.periodCredit} /></td>
                  <td className="px-4 py-2 text-left"><Num value={a.closing} signed strong /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Net-income / closing-entries statement line — visually distinct from buckets. */
function StatementLine({
  line,
  fallbackLabel,
  tone,
}: {
  line: EquityStatementLine | null;
  fallbackLabel: string;
  tone: "emerald" | "violet";
}) {
  if (!line) return null;
  const cls =
    tone === "emerald"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : "border-violet-200 bg-violet-50 text-violet-800";
  return (
    <div className={`mb-3 flex items-center justify-between rounded-xl border px-4 py-3 ${cls}`}>
      <span className="text-sm font-extrabold">{line.label || fallbackLabel}</span>
      <Num value={line.amount} signed strong />
    </div>
  );
}

function ReconciliationBadge({ rec, closing }: { rec: EquityChangesResponse["reconciliation"]; closing: number }) {
  const t = useT();
  if (rec.matches) {
    return (
      <div className="mb-5 inline-flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700">
        {t("accounting.equity.reconciled")}
      </div>
    );
  }
  // A mismatch is a books problem — it is NEVER hidden or softened.
  return (
    <div className="mb-5 rounded-xl border-2 border-rose-300 bg-rose-50 px-4 py-3 text-sm font-extrabold text-rose-800">
      <div>{t("accounting.equity.mismatch")}</div>
      <div className="mt-1 text-xs font-bold">
        {t("accounting.equity.mismatchClosing")} <span dir="ltr" className="tabular-nums">{fmt(closing)}</span>
        {" — "}
        {t("accounting.equity.mismatchBs")} <span dir="ltr" className="tabular-nums">{fmt(rec.bsTotEq)}</span>
        {" — "}
        {t("accounting.equity.mismatchDiff")} <span dir="ltr" className="tabular-nums">{fmt(closing - rec.bsTotEq)}</span>
      </div>
    </div>
  );
}

function exportCsv(t: TFunction, data: EquityChangesResponse) {
  const header = [
    t("accounting.equity.csv.item"),
    t("accounting.equity.csv.account"),
    t("accounting.equity.csv.code"),
    t("accounting.equity.csv.opening"),
    t("accounting.equity.csv.periodDebit"),
    t("accounting.equity.csv.periodCredit"),
    t("accounting.equity.csv.closing"),
  ];
  const rows: (string | number)[][] = [];
  for (const b of data.buckets) {
    if (b.accounts.length === 0) {
      rows.push([b.label, t("accounting.equity.none"), "", b.opening, "", "", b.closing]);
      continue;
    }
    for (const a of b.accounts) {
      rows.push([b.label, a.name, a.code, a.opening, a.periodDebit, a.periodCredit, a.closing]);
    }
    rows.push([t("accounting.equity.csv.bucketTotal", { label: b.label }), "", "", b.opening, "", "", b.closing]);
  }
  if (data.netIncomeLine) {
    rows.push([data.netIncomeLine.label || t("accounting.equity.netIncome"), "", "", "", "", "", data.netIncomeLine.amount]);
  }
  if (data.closingEntriesLine) {
    rows.push([data.closingEntriesLine.label || t("accounting.equity.closingEntries"), "", "", "", "", "", data.closingEntriesLine.amount]);
  }
  rows.push([t("accounting.equity.totalEquity"), "", "", data.totals.opening, "", "", data.totals.closing]);
  exportRowsCsv(`equity-changes-${data.from}-${data.to}.csv`, header, rows);
}

export function EquityChangesPage() {
  const t = useT();
  const filter = useAppliedFilter<DateRange>({ from: startOfYearISO(), to: todayISO() });
  const query = useEquityChanges(filter.applied);
  const data = query.data;
  const period = formatForPeriod(filter.applied.from, filter.applied.to);

  return (
    <div>
      <ReportHeader
        title={t("accounting.equity.title")}
        subtitle={t("accounting.equity.subtitle")}
        onPrint={printReport}
        extraActions={
          data && (
            <Button variant="secondary" onClick={() => exportCsv(t, data)}>
              <Download className="h-4 w-4" /> {t("table.exportCsv")}
            </Button>
          )
        }
      />
      <FilterCard onRun={filter.run} running={query.isFetching}>
        <FilterField label={t("accounting.common.fromDate")}>
          <DatePicker value={filter.draft.from} onChange={(from) => filter.patch({ from })} />
        </FilterField>
        <FilterField label={t("accounting.common.toDate")}>
          <DatePicker value={filter.draft.to} onChange={(to) => filter.patch({ to })} />
        </FilterField>
      </FilterCard>

      <ReportState
        isLoading={query.isLoading}
        error={query.error}
        isEmpty={!!data && data.buckets.length === 0}
        onRetry={() => query.refetch()}
        emptyBody={t("accounting.equity.emptyBody")}
      >
        {data && (
          <>
            {/* The balance-sheet cross-check is a verdict on this run, not a
                line of the statement of changes in equity. Screen only. */}
            <div className="no-print mb-4">
              <ReconciliationBadge rec={data.reconciliation} closing={data.totals.closing} />
            </div>

            <PrintDocument title={t("accounting.equity.printTitle")} subtitle={period}>
            {data.buckets.map((b) => (
              <BucketSection key={b.key} bucket={b} />
            ))}

            <StatementLine line={data.netIncomeLine} fallbackLabel={t("accounting.equity.netIncome")} tone="emerald" />
            <StatementLine line={data.closingEntriesLine} fallbackLabel={t("accounting.equity.closingEntries")} tone="violet" />

            <div className="surface flex flex-wrap items-center justify-between gap-3 border-t-2 border-slate-300 bg-slate-50 px-4 py-3">
              <span className="text-sm font-extrabold text-slate-900">{t("accounting.equity.totalEquity")}</span>
              <span className="flex items-center gap-6 text-sm font-bold text-slate-700">
                <span>
                  {t("accounting.common.opening")}: <Num value={data.totals.opening} signed strong />
                </span>
                <span>
                  {t("accounting.common.closing")}: <Num value={data.totals.closing} signed strong />
                </span>
              </span>
            </div>
            </PrintDocument>
          </>
        )}
      </ReportState>
    </div>
  );
}
