// The period total, above the table.
//
// WHY ABOVE AND NOT A FOOTER
//   The pivot it replaces carried the grand total in a sticky <tfoot>. DataTable
//   has no footer at all, and adding one to the shared kit would have to answer
//   for virtualization spacers, the mobile card list, pagination and CSV export
//   — a lot of blast radius for a row of numbers.
//
//   Above is also simply better. The pivot's own mobile branch already made the
//   argument in its code: a total placed after five hundred rows is a total
//   nobody reads. Above the table it is read first, needs no sticky machinery,
//   and behaves identically on desktop, on mobile and on paper.
//
// WHY THESE NUMBERS ARE NOT SUMMED HERE
//   They come from `result.totals`, which the server computes with a ROLLUP over
//   the WHOLE grouping. The rows on screen are one page of a capped, sorted
//   slice. Adding up what is visible would produce a smaller number that looks
//   authoritative — the exact failure the pivot's own comment spent a paragraph
//   warning about, and which explorer-groupby.test.tsx pins with a fixture whose
//   on-screen sum (300) deliberately differs from the server total (1,000).
import { formatterFor } from "../lib/resultTable";
import { useT } from "@/i18n";
import type { AnalyticsRegistry } from "../lib/api";

export interface ReportTotalsProps {
  /** result.totals — the server's ROLLUP, never a sum of the rows on screen. */
  totals: Record<string, number | null> | undefined;
  /** Which metrics to show, in column order. */
  metricIds: string[];
  registry: AnalyticsRegistry | undefined;
  /** Metrics the caller may not see — rendered "—", not omitted. */
  maskedMetrics?: string[];
  label?: string;
  note?: string;
}

export function ReportTotals({
  totals,
  metricIds,
  registry,
  maskedMetrics = [],
  label,
  note,
}: ReportTotalsProps) {
  const t = useT();
  if (!totals || metricIds.length === 0) return null;
  const masked = new Set(maskedMetrics);

  return (
    <div
      data-testid="report-totals"
      className="rounded-xl border border-slate-200 bg-slate-50/60 p-3"
    >
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <span className="text-xs font-extrabold text-slate-600">
          {label ?? t("salesReports.groupBy.grandTotal")}
        </span>
        <span className="text-[11px] font-bold text-slate-400">
          {note ?? t("salesReports.groupBy.grandTotalNote")}
        </span>
      </div>
      <dl className="flex flex-wrap gap-x-6 gap-y-2">
        {metricIds.map((id) => {
          const raw = masked.has(id) ? null : totals[id];
          const v = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
          return (
            <div key={id} className="min-w-0" data-total-metric={id}>
              <dt className="truncate text-[11px] font-bold text-slate-500">
                {t(`salesReports.metrics.${id}`)}
              </dt>
              <dd
                dir="ltr"
                className="text-sm font-extrabold tabular-nums text-slate-900"
              >
                {v == null ? "—" : formatterFor(registry, id)(v)}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}
