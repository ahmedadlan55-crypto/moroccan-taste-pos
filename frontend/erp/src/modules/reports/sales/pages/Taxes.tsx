// Sales Analytics Hub — "taxes" page (VAT from the stored columns).
//
// KPI row: vat_amount + the order-header extras (fees/rounding/tips — tips is
// frequently not tracked historically and renders "—" with an explain note),
// and the by-rate table. Reports are decision tables — the VAT-by-category
// trend chart lives on the dashboard, not here.
//
// THE FILING SECTION, and why it had to be added
//   This page used to show the SALES side only: `vat_amount` by rate, headed
//   "VAT". That is not the figure a VAT return carries. Every refund the branch
//   issued still had its VAT sitting inside that number, so the page OVERSTATED
//   the period's liability by the whole of `returns_vat` — in a month with one
//   large refund, materially, and in the direction that costs the owner money.
//
//   The filing table below states both sides and their difference, per tax
//   category and rate, which is the shape a return is filled in from:
//
//     taxable base (ex-VAT)   VAT on sales   returns base   VAT on returns   net base   net VAT
//
//   `net_vat` and `net_product_sales_ex_vat` are REGISTRY metrics with their own
//   equations and mutation coverage, not arithmetic done in this file: a figure
//   that goes on a government return does not get computed in a React component.
//
//   Sales sit on the `line` fact and returns on the `return` fact; both express
//   vat_category and vat_rate, so one request answers the whole table and
//   QueryService merges the two facts on the dimension key.
import { useMemo } from "react";
import { Coins, HandCoins, Landmark, ReceiptText, type LucideIcon } from "lucide-react";
import { Badge, EmptyState, ErrorState, ExplainNumber, LoadingState, MetricCard, type MetricTone } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatCurrency } from "@/shared/lib";
import { useT } from "@/i18n";
import { useUrlFilters } from "@/shared/hooks/useUrlFilters";
import { analyticsFilterCodec } from "../lib/filters";
import { buildFiltersBody, displayMetric, reportQuerySpec, type AnalyticsQueryBody, type AnalyticsResult } from "../lib/api";
import { useAnalyticsQuery } from "../lib/useAnalyticsQuery";
import { REPORT_BY_ID, reportQuery } from "../lib/reportRegistry";

const SEGMENT = "taxes";
// All three queries — and the ExportMenu's file — come from lib/reportRegistry.

function kpiValue(result: AnalyticsResult | undefined, id: string): number | null {
  if (!result) return null;
  const v = result.totals?.[id];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const row = result.rows[0];
  return row ? displayMetric(row, id) : null;
}

const KPIS: Array<{ id: string; eq: string; icon: LucideIcon; tone: MetricTone }> = [
  { id: "vat_amount", eq: "sum", icon: Landmark, tone: "teal" },
  { id: "fees_total", eq: "sum", icon: ReceiptText, tone: "blue" },
  { id: "rounding_total", eq: "sum", icon: Coins, tone: "violet" },
  { id: "tips_total", eq: "sum", icon: HandCoins, tone: "amber" },
];

interface RateRow {
  key: string;
  label: string;
  vat_amount: number | null;
  net_ex_vat: number | null;
}

/** One line of the filing table: a (category, rate) pair, both sides of it. */
interface FilingRow {
  key: string;
  category: string;
  rate: string;
  /** One entry per FILING_METRICS id — read by column below. */
  values: Record<string, number | null>;
}

/** The filing table's columns, read off the registry query it renders. */
const FILING_METRICS: readonly string[] = reportQuery(REPORT_BY_ID[SEGMENT], "filing")!.metrics;

export default function Taxes() {
  const t = useT();
  const { filters } = useUrlFilters(analyticsFilterCodec);
  const base = useMemo(() => buildFiltersBody(filters), [filters]);

  const kpiBody = useMemo<AnalyticsQueryBody>(
    () => ({ ...reportQuerySpec(SEGMENT, "kpis", filters), ...base }),
    [base, filters],
  );
  const rateBody = useMemo<AnalyticsQueryBody>(
    () => ({
      ...reportQuerySpec(SEGMENT, "byRate", filters),
      sort: [{ by: "vat_amount", dir: "desc" }],
      ...base,
    }),
    [base, filters],
  );

  // The filing table: sales (line fact) and returns (return fact) in ONE
  // request, grouped by category × rate. Both facts express both dimensions;
  // QueryService merges them on the dimension key, so a (category, rate) that
  // had only returns still appears — a refund of something not sold this month
  // is exactly the case a hand-joined table drops.
  const filingBody = useMemo<AnalyticsQueryBody>(
    () => ({
      // A category × rate grid is tiny, but DEFAULT_LIMIT is 50 and a truncated
      // TAX table is not a thing that may happen silently — the registry query
      // carries the explicit limit.
      ...reportQuerySpec(SEGMENT, "filing", filters),
      sort: [{ by: "vat_amount", dir: "desc" }],
      ...base,
    }),
    [base, filters],
  );

  const kpis = useAnalyticsQuery("taxes-kpis", kpiBody);
  const byRate = useAnalyticsQuery("taxes-rate", rateBody);
  const filing = useAnalyticsQuery("taxes-filing", filingBody);

  if (byRate.isPending) return <LoadingState />;
  if (byRate.isError) return <ErrorState error={byRate.error} onRetry={() => byRate.refetch()} />;

  const rateRows: RateRow[] = (byRate.data?.rows ?? []).map((r) => ({
    key: String(r.keys[0] ?? ""),
    label: r.labels[0] ?? String(r.keys[0] ?? "—"),
    vat_amount: displayMetric(r, "vat_amount"),
    net_ex_vat: displayMetric(r, "net_ex_vat"),
  }));
  if (rateRows.length === 0) return <EmptyState title={t("salesReports.states.empty")} />;

  const incomplete = byRate.data?.meta?.completeness?.complete === false;

  const tipsMasked = kpiValue(kpis.data, "tips_total") == null;

  const filingRows: FilingRow[] = (filing.data?.rows ?? []).map((r, i) => ({
    key: `${String(r.keys[0] ?? "")}|${String(r.keys[1] ?? "")}|${i}`,
    category: r.labels[0] ?? String(r.keys[0] ?? "—"),
    rate: r.labels[1] ?? String(r.keys[1] ?? "—"),
    // Keyed by the REGISTRY's column list, so adding a filing column there adds
    // it to the header, the body and the total row at once.
    values: Object.fromEntries(FILING_METRICS.map((m) => [m, displayMetric(r, m)])),
  }));

  // The period totals come from the server's ROLLUP, never from adding up the
  // rows on screen: the two differ the moment a limit bites, and a VAT total
  // that silently excludes a truncated row is the worst number on the page.
  const filingTotals = filing.data?.totals;

  const rateColumns: ColumnDef<RateRow>[] = [
    { id: "rate", header: t("salesReports.dims.vat_rate"), accessor: (r) => r.label, pinStart: true, hideable: false, width: 140 },
    {
      id: "vat_amount",
      header: t("salesReports.metrics.vat_amount"),
      accessor: (r) => r.vat_amount,
      cell: (r) => (r.vat_amount == null ? "—" : formatCurrency(r.vat_amount)),
      numeric: true,
      sortable: true,
    },
    {
      id: "net_ex_vat",
      header: t("salesReports.metrics.net_ex_vat"),
      accessor: (r) => r.net_ex_vat,
      cell: (r) => (r.net_ex_vat == null ? "—" : formatCurrency(r.net_ex_vat)),
      numeric: true,
      sortable: true,
    },
  ];

  return (
    <section aria-labelledby="sales-hub-page-taxes" className="space-y-4">
      <div>
        <h2 id="sales-hub-page-taxes" className="text-lg font-extrabold text-slate-900">
          {t("salesReports.pages.taxes.title")}
        </h2>
        <p className="mt-0.5 text-sm font-medium text-slate-500">{t("salesReports.pages.taxes.subtitle")}</p>
      </div>

      {incomplete && (
        <div data-testid="completeness-notice">
          <Badge tone="warning">{t("salesReports.states.notAvailableHistorically")}</Badge>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {KPIS.map((k) => {
          const label = t(`salesReports.metrics.${k.id}`);
          const v = kpiValue(kpis.data, k.id);
          const isMaskedTips = k.id === "tips_total" && tipsMasked;
          return (
            <div key={k.id} data-testid={`kpi-${k.id}`}>
              <MetricCard
                label={label}
                value={v == null ? "—" : formatCurrency(v)}
                icon={k.icon}
                tone={k.tone}
                explain={
                  <ExplainNumber
                    title={label}
                    formula={t(`salesReports.explain.${k.eq}`)}
                    // Tips: "—" is a data-availability statement, not a zero.
                    footnote={isMaskedTips ? t("salesReports.states.notAvailableHistorically") : undefined}
                    triggerLabel={label}
                  />
                }
              />
            </div>
          );
        })}
      </div>

      <DataTable<RateRow>
        columns={rateColumns}
        rows={rateRows}
        getRowId={(r) => r.key || r.label}
        tableId="sales-hub-taxes-by-rate"
        paginate={false}
        emptyTitle={t("salesReports.states.empty")}
        mobileTitle={(r) => r.label}
      />

      <article className="surface p-5" data-testid="vat-filing">
        <header className="mb-1">
          <h3 className="text-base font-extrabold text-slate-900">{t("salesReports.filing.title")}</h3>
          <p className="mt-0.5 text-xs font-bold text-slate-500">{t("salesReports.filing.note")}</p>
        </header>

        {filing.isError ? (
          <ErrorState error={filing.error} onRetry={() => filing.refetch()} />
        ) : filing.isPending ? (
          <LoadingState rows={4} />
        ) : filingRows.length === 0 ? (
          <EmptyState title={t("salesReports.states.empty")} />
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-start">
              <thead className="text-[11px] font-extrabold text-slate-400">
                <tr>
                  <th scope="col" className="px-3 py-2 text-start">
                    {t("salesReports.dims.vat_category")}
                  </th>
                  <th scope="col" className="px-3 py-2 text-start">
                    {t("salesReports.dims.vat_rate")}
                  </th>
                  {FILING_METRICS.map((m) => (
                    <th key={m} scope="col" dir="ltr" className="px-3 py-2 text-end">
                      {t(`salesReports.metrics.${m}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filingRows.map((r) => (
                  <tr key={r.key} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2 text-sm font-bold text-slate-700">{r.category}</td>
                    <td className="px-3 py-2 text-sm font-bold text-slate-700">{r.rate}</td>
                    {FILING_METRICS.map((m) => (
                      <td key={m} dir="ltr" className="px-3 py-2 text-end text-sm font-bold tabular-nums text-slate-600">
                        {r.values[m] == null ? "—" : formatCurrency(r.values[m]!)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              {filingTotals && (
                <tfoot>
                  <tr data-testid="vat-filing-total" className="border-t-2 border-slate-300 bg-slate-100">
                    <td colSpan={2} className="px-3 py-2.5 text-sm font-extrabold text-slate-900">
                      {t("salesReports.report.totalRow")}
                    </td>
                    {FILING_METRICS.map((m) => {
                      const v = filingTotals[m];
                      return (
                        <td
                          key={m}
                          dir="ltr"
                          className="px-3 py-2.5 text-end text-sm font-extrabold tabular-nums text-slate-900"
                        >
                          {typeof v === "number" && Number.isFinite(v) ? formatCurrency(v) : "—"}
                        </td>
                      );
                    })}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </article>
    </section>
  );
}
