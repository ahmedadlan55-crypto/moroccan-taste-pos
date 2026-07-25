// Sales Analytics Hub — "voids" page (voids & returns).
//
// KPI row (voids_count/value, returns_count/value, qty_returned) + a bar of
// returns value by return_reason (the reason dimension IS projected — see
// lib/analytics/registry/dimensions.js) + a per-CASHIER voids DataTable with
// warning tones on high void rates.
//
// E2E-wave fix: the original detail table grouped RETURN-fact metrics by
// [return_reason, cashier]. No fact carries both dimensions (return_reason is
// return-fact-only, cashier is order/line-fact-only), so the planner refused
// the combination (ANALYTICS_UNSUPPORTED_COMBINATION 422) and the table
// errored on every load. The honest split: reasons stay on the return fact
// (chart above), and the cashier table carries order-fact void measures.
import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Tooltip as RechartsTooltip, XAxis, YAxis } from "recharts";
import { Ban, PackageX, RotateCcw, Undo2, XCircle, type LucideIcon } from "lucide-react";
import { Badge, EmptyState, ErrorState, ExplainNumber, LoadingState, MetricCard, type MetricTone } from "@/shared/ui";
import { ChartCard, useChartPalette, useChartsRtl } from "@/shared/charts";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatCurrency, formatNumber } from "@/shared/lib";
import { useT } from "@/i18n";
import { useUrlFilters } from "@/shared/hooks/useUrlFilters";
import { analyticsFilterCodec } from "../lib/filters";
import { buildFiltersBody, displayMetric, type AnalyticsQueryBody, type AnalyticsResult } from "../lib/api";
import { useAnalyticsQuery } from "../lib/useAnalyticsQuery";

const KPI_METRICS = ["voids_count", "voids_value", "returns_count", "returns_value", "qty_returned"] as const;

/** A per-cashier void/return rate at/above this (percent points) reads warning. */
const HIGH_RATE_PCT = 5;

const fmtPct = (v: number) => `${formatNumber(v)}%`;

function kpiValue(result: AnalyticsResult | undefined, id: string): number | null {
  if (!result) return null;
  const v = result.totals?.[id];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const row = result.rows[0];
  return row ? displayMetric(row, id) : null;
}

const KPIS: Array<{ id: string; eq: string; fmt: (v: number) => string; icon: LucideIcon; tone: MetricTone }> = [
  { id: "voids_count", eq: "count", fmt: formatNumber, icon: Ban, tone: "rose" },
  { id: "voids_value", eq: "sum", fmt: formatCurrency, icon: XCircle, tone: "rose" },
  { id: "returns_count", eq: "count", fmt: formatNumber, icon: RotateCcw, tone: "amber" },
  { id: "returns_value", eq: "sum", fmt: formatCurrency, icon: Undo2, tone: "amber" },
  { id: "qty_returned", eq: "sum", fmt: formatNumber, icon: PackageX, tone: "violet" },
];

interface ReasonRow {
  key: string;
  label: string;
  returns_count: number | null;
  returns_value: number | null;
  qty_returned: number | null;
}

interface CashierVoidsRow {
  key: string;
  cashier: string;
  voids_count: number | null;
  voids_value: number | null;
  void_rate: number | null;
}

export default function Voids() {
  const t = useT();
  const { filters } = useUrlFilters(analyticsFilterCodec);
  const palette = useChartPalette();
  const rtl = useChartsRtl();
  const base = useMemo(() => buildFiltersBody(filters), [filters]);

  const kpiBody = useMemo<AnalyticsQueryBody>(
    () => ({ metrics: [...KPI_METRICS], dimensions: [], ...base }),
    [base],
  );
  const reasonBody = useMemo<AnalyticsQueryBody>(
    () => ({
      metrics: ["returns_count", "returns_value", "qty_returned"],
      dimensions: ["return_reason"],
      sort: [{ by: "returns_value", dir: "desc" }],
      ...base,
    }),
    [base],
  );
  // per-cashier voids (ORDER fact — the only fact carrying both the cashier
  // dimension and the void measures; see the header note).
  const cashierBody = useMemo<AnalyticsQueryBody>(
    () => ({
      metrics: ["voids_count", "voids_value", "void_rate_by_cashier"],
      dimensions: ["cashier"],
      sort: [{ by: "voids_value", dir: "desc" }],
      limit: 100,
      ...base,
    }),
    [base],
  );

  const kpis = useAnalyticsQuery("voids-kpis", kpiBody);
  const byReason = useAnalyticsQuery("voids-reason", reasonBody);
  const byCashier = useAnalyticsQuery("voids-cashier", cashierBody);

  if (byReason.isPending) return <LoadingState />;
  if (byReason.isError) return <ErrorState error={byReason.error} onRetry={() => byReason.refetch()} />;

  const reasonRows: ReasonRow[] = (byReason.data?.rows ?? []).map((r) => ({
    key: String(r.keys[0] ?? ""),
    label: r.labels[0] ?? String(r.keys[0] ?? "—"),
    returns_count: displayMetric(r, "returns_count"),
    returns_value: displayMetric(r, "returns_value"),
    qty_returned: displayMetric(r, "qty_returned"),
  }));

  const hasKpiData = KPI_METRICS.some((id) => kpiValue(kpis.data, id) != null);
  if (reasonRows.length === 0 && !hasKpiData) return <EmptyState title={t("salesReports.states.empty")} />;

  const incomplete = byReason.data?.meta?.completeness?.complete === false;

  const detailRows: CashierVoidsRow[] = (byCashier.data?.rows ?? []).map((r, i) => ({
    key: `${String(r.keys[0] ?? "")}|${i}`,
    cashier: r.labels[0] ?? String(r.keys[0] ?? "—"),
    voids_count: displayMetric(r, "voids_count"),
    voids_value: displayMetric(r, "voids_value"),
    void_rate: displayMetric(r, "void_rate_by_cashier"),
  }));

  const detailColumns: ColumnDef<CashierVoidsRow>[] = [
    { id: "cashier", header: t("salesReports.dims.cashier"), accessor: (r) => r.cashier, pinStart: true, width: 170 },
    {
      id: "voids_count",
      header: t("salesReports.metrics.voids_count"),
      accessor: (r) => r.voids_count,
      cell: (r) => (r.voids_count == null ? "—" : formatNumber(r.voids_count)),
      numeric: true,
      sortable: true,
    },
    {
      id: "voids_value",
      header: t("salesReports.metrics.voids_value"),
      accessor: (r) => r.voids_value,
      cell: (r) => (r.voids_value == null ? "—" : formatCurrency(r.voids_value)),
      numeric: true,
      sortable: true,
    },
    {
      id: "void_rate",
      header: t("salesReports.metrics.void_rate_by_cashier"),
      accessor: (r) => r.void_rate,
      cell: (r) => (r.void_rate == null ? "—" : fmtPct(r.void_rate)),
      numeric: true,
      sortable: true,
      cellTone: (r) => (r.void_rate != null && r.void_rate >= HIGH_RATE_PCT ? "warning" : undefined),
    },
  ];

  return (
    <section aria-labelledby="sales-hub-page-voids" className="space-y-4">
      <div>
        <h2 id="sales-hub-page-voids" className="text-lg font-extrabold text-slate-900">
          {t("salesReports.pages.voids.title")}
        </h2>
        <p className="mt-0.5 text-sm font-medium text-slate-500">{t("salesReports.pages.voids.subtitle")}</p>
      </div>

      {incomplete && (
        <div data-testid="completeness-notice">
          <Badge tone="warning">{t("salesReports.states.notAvailableHistorically")}</Badge>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {KPIS.map((k) => {
          const label = t(`salesReports.metrics.${k.id}`);
          const v = kpiValue(kpis.data, k.id);
          return (
            <div key={k.id} data-testid={`kpi-${k.id}`}>
              <MetricCard
                label={label}
                value={v == null ? "—" : k.fmt(v)}
                icon={k.icon}
                tone={k.tone}
                explain={
                  <ExplainNumber title={label} formula={t(`salesReports.explain.${k.eq}`)} triggerLabel={label} />
                }
              />
            </div>
          );
        })}
      </div>

      {reasonRows.length > 0 && (
        <ChartCard
          title={`${t("salesReports.metrics.returns_value")} — ${t("salesReports.dims.return_reason")}`}
          tableLabel={t("salesReports.dims.return_reason")}
          tableColumns={[
            { key: "label", label: t("salesReports.dims.return_reason") },
            { key: "returns_value", label: t("salesReports.metrics.returns_value") },
            { key: "returns_count", label: t("salesReports.metrics.returns_count") },
          ]}
          tableRows={reasonRows.map((r) => ({
            label: r.label,
            returns_value: r.returns_value == null ? "—" : formatCurrency(r.returns_value),
            returns_count: r.returns_count == null ? "—" : formatNumber(r.returns_count),
          }))}
        >
          <BarChart data={reasonRows}>
            <CartesianGrid stroke={palette.grid} vertical={false} />
            <XAxis dataKey="label" reversed={rtl.xAxisReversed} stroke={palette.axis} tick={{ fontSize: 11 }} />
            <YAxis orientation={rtl.dir === "rtl" ? "right" : "left"} stroke={palette.axis} tickFormatter={rtl.tickFormatterNumber} tick={{ fontSize: 11 }} />
            <RechartsTooltip contentStyle={rtl.tooltipStyle} formatter={(v) => rtl.tickFormatterCurrency(v)} />
            <Bar dataKey="returns_value" name={t("salesReports.metrics.returns_value")} fill={palette.series[2]} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ChartCard>
      )}

      {byCashier.isError ? (
        <ErrorState error={byCashier.error} onRetry={() => byCashier.refetch()} />
      ) : (
        detailRows.length > 0 && (
          <DataTable<CashierVoidsRow>
            columns={detailColumns}
            rows={detailRows}
            getRowId={(r) => r.key}
            paginate={false}
            columnMenu={false}
            emptyTitle={t("salesReports.states.empty")}
            mobileTitle={(r) => r.cashier}
          />
        )
      )}
    </section>
  );
}
