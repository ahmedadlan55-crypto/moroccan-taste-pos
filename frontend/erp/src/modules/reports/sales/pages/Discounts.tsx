// Sales Analytics Hub — "discounts" page.
//
// KPI row (dimensionless analytics query) + two ChartCard/table pairs:
// discounts by day (click-to-filter drill onto that day) and by cashier
// (drill → the cashiers segment, preserving the current search params).
// Honest limitation: the discount reason / promo dimension is NOT projected
// into the fact store yet — a banner says so, and the reason table slots in
// under the TODO below when the dimension lands.
import { useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, Tooltip as RechartsTooltip, XAxis, YAxis } from "recharts";
import { BadgePercent, Percent, ShoppingCart, TicketPercent, type LucideIcon } from "lucide-react";
import { Badge, EmptyState, ErrorState, ExplainNumber, LoadingState, MetricCard, type MetricTone } from "@/shared/ui";
import { ChartCard, useChartPalette, useChartsRtl } from "@/shared/charts";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatCurrency, formatNumber } from "@/shared/lib";
import { useT } from "@/i18n";
import { useUrlFilters } from "@/shared/hooks/useUrlFilters";
import { analyticsFilterCodec } from "../lib/filters";
import { buildFiltersBody, displayMetric, type AnalyticsQueryBody, type AnalyticsResult } from "../lib/api";
import { useAnalyticsQuery } from "../lib/useAnalyticsQuery";

const METRICS = ["discounts_total", "discount_pct", "discounted_orders", "orders"] as const;

/** discount_pct at/above this (percent points) reads as a warning tone. */
const HIGH_DISCOUNT_PCT = 10;

const fmtPct = (v: number) => `${formatNumber(v)}%`;

function kpiValue(result: AnalyticsResult | undefined, id: string): number | null {
  if (!result) return null;
  const v = result.totals?.[id];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const row = result.rows[0];
  return row ? displayMetric(row, id) : null;
}

interface DimRow {
  key: string;
  label: string;
  discounts_total: number | null;
  discount_pct: number | null;
  discounted_orders: number | null;
  orders: number | null;
}

function toDimRows(result: AnalyticsResult | undefined): DimRow[] {
  return (result?.rows ?? []).map((r) => ({
    key: String(r.keys[0] ?? ""),
    label: r.labels[0] ?? String(r.keys[0] ?? "—"),
    discounts_total: displayMetric(r, "discounts_total"),
    discount_pct: displayMetric(r, "discount_pct"),
    discounted_orders: displayMetric(r, "discounted_orders"),
    orders: displayMetric(r, "orders"),
  }));
}

const KPIS: Array<{ id: string; eq: string; fmt: (v: number) => string; icon: LucideIcon; tone: MetricTone }> = [
  { id: "discounts_total", eq: "sum", fmt: formatCurrency, icon: BadgePercent, tone: "rose" },
  { id: "discount_pct", eq: "discountPct", fmt: fmtPct, icon: Percent, tone: "amber" },
  { id: "discounted_orders", eq: "count", fmt: formatNumber, icon: TicketPercent, tone: "violet" },
  { id: "orders", eq: "count", fmt: formatNumber, icon: ShoppingCart, tone: "teal" },
];

export default function Discounts() {
  const t = useT();
  const navigate = useNavigate();
  const { search } = useLocation();
  const { filters, patch } = useUrlFilters(analyticsFilterCodec);
  const palette = useChartPalette();
  const rtl = useChartsRtl();

  const dayDim = filters.businessDay ? "business_day" : "calendar_day";
  const base = useMemo(() => buildFiltersBody(filters), [filters]);

  const kpiBody = useMemo<AnalyticsQueryBody>(() => ({ metrics: [...METRICS], dimensions: [], ...base }), [base]);
  const dayBody = useMemo<AnalyticsQueryBody>(
    () => ({ metrics: [...METRICS], dimensions: [dayDim], sort: [{ by: dayDim, dir: "asc" }], ...base }),
    [base, dayDim],
  );
  const cashierBody = useMemo<AnalyticsQueryBody>(
    () => ({
      metrics: [...METRICS, "discount_rate_by_cashier"],
      dimensions: ["cashier"],
      sort: [{ by: "discounts_total", dir: "desc" }],
      limit: 25,
      ...base,
    }),
    [base],
  );

  const kpis = useAnalyticsQuery("discounts-kpis", kpiBody);
  const byDay = useAnalyticsQuery("discounts-day", dayBody);
  const byCashier = useAnalyticsQuery("discounts-cashier", cashierBody);

  // Page-level states follow the PRIMARY (by-day) query.
  if (byDay.isPending) return <LoadingState />;
  if (byDay.isError) return <ErrorState error={byDay.error} onRetry={() => byDay.refetch()} />;

  const dayRows = toDimRows(byDay.data);
  const cashierRows = toDimRows(byCashier.data);
  if (dayRows.length === 0) return <EmptyState title={t("salesReports.states.empty")} />;

  const incomplete = byDay.data?.meta?.completeness?.complete === false;

  const drillToDay = (state: unknown) => {
    const label = (state as { activeLabel?: unknown } | null)?.activeLabel;
    const hit = dayRows.find((r) => r.label === String(label ?? ""));
    if (hit?.key) patch({ from: hit.key, to: hit.key, preset: "custom" }, { push: true });
  };

  const dimCol = (header: string): ColumnDef<DimRow> => ({
    id: "label",
    header,
    accessor: (r) => r.label,
    pinStart: true,
    width: 160,
  });
  const metricCols: ColumnDef<DimRow>[] = [
    {
      id: "discounts_total",
      header: t("salesReports.metrics.discounts_total"),
      accessor: (r) => r.discounts_total,
      cell: (r) => (r.discounts_total == null ? "—" : formatCurrency(r.discounts_total)),
      numeric: true,
      sortable: true,
    },
    {
      id: "discount_pct",
      header: t("salesReports.metrics.discount_pct"),
      accessor: (r) => r.discount_pct,
      cell: (r) => (r.discount_pct == null ? "—" : fmtPct(r.discount_pct)),
      numeric: true,
      sortable: true,
      cellTone: (r) => (r.discount_pct != null && r.discount_pct >= HIGH_DISCOUNT_PCT ? "warning" : undefined),
    },
    {
      id: "discounted_orders",
      header: t("salesReports.metrics.discounted_orders"),
      accessor: (r) => r.discounted_orders,
      cell: (r) => (r.discounted_orders == null ? "—" : formatNumber(r.discounted_orders)),
      numeric: true,
      sortable: true,
    },
    {
      id: "orders",
      header: t("salesReports.metrics.orders"),
      accessor: (r) => r.orders,
      cell: (r) => (r.orders == null ? "—" : formatNumber(r.orders)),
      numeric: true,
      sortable: true,
    },
  ];

  const chartTable = (rows: DimRow[], dimLabel: string) => ({
    tableColumns: [
      { key: "label", label: dimLabel },
      { key: "discounts_total", label: t("salesReports.metrics.discounts_total") },
      { key: "discount_pct", label: t("salesReports.metrics.discount_pct") },
    ],
    tableRows: rows.map((r) => ({
      label: r.label,
      discounts_total: r.discounts_total == null ? "—" : formatCurrency(r.discounts_total),
      discount_pct: r.discount_pct == null ? "—" : fmtPct(r.discount_pct),
    })),
  });

  return (
    <section aria-labelledby="sales-hub-page-discounts" className="space-y-4">
      <div>
        <h2 id="sales-hub-page-discounts" className="text-lg font-extrabold text-slate-900">
          {t("salesReports.pages.discounts.title")}
        </h2>
        <p className="mt-0.5 text-sm font-medium text-slate-500">{t("salesReports.pages.discounts.subtitle")}</p>
      </div>

      {/* Honest limitation: no discount_reason/promo projection yet (queued for
          a later wave). TODO(sales-hub): when the reason dimension is projected,
          add a third ChartCard/table here grouped by discount_reason. */}
      <div data-testid="discounts-reason-gap">
        <Badge tone="warning">
          {t("salesReports.dims.discount_reason")}: {t("salesReports.states.notAvailableHistorically")}
        </Badge>
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

      <ChartCard
        title={`${t("salesReports.metrics.discounts_total")} — ${t(`salesReports.dims.${dayDim}`)}`}
        tableLabel={t(`salesReports.dims.${dayDim}`)}
        onPointClick={drillToDay}
        {...chartTable(dayRows, t(`salesReports.dims.${dayDim}`))}
      >
        <BarChart data={dayRows}>
          <CartesianGrid stroke={palette.grid} vertical={false} />
          <XAxis dataKey="label" reversed={rtl.xAxisReversed} stroke={palette.axis} tick={{ fontSize: 11 }} />
          <YAxis orientation={rtl.dir === "rtl" ? "right" : "left"} stroke={palette.axis} tickFormatter={rtl.tickFormatterNumber} tick={{ fontSize: 11 }} />
          <RechartsTooltip contentStyle={rtl.tooltipStyle} formatter={(v) => rtl.tickFormatterCurrency(v)} />
          <Bar dataKey="discounts_total" name={t("salesReports.metrics.discounts_total")} fill={palette.series[0]} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ChartCard>

      <DataTable<DimRow>
        columns={[dimCol(t(`salesReports.dims.${dayDim}`)), ...metricCols]}
        rows={dayRows}
        getRowId={(r) => r.key || r.label}
        paginate={false}
        columnMenu={false}
        emptyTitle={t("salesReports.states.empty")}
        mobileTitle={(r) => r.label}
        onRowClick={(r) => r.key && patch({ from: r.key, to: r.key, preset: "custom" }, { push: true })}
      />

      {byCashier.isError ? (
        <ErrorState error={byCashier.error} onRetry={() => byCashier.refetch()} />
      ) : (
        cashierRows.length > 0 && (
          <>
            <ChartCard
              title={`${t("salesReports.metrics.discounts_total")} — ${t("salesReports.dims.cashier")}`}
              tableLabel={t("salesReports.dims.cashier")}
              onPointClick={() => navigate(`/reports/sales/cashiers${search}`)}
              {...chartTable(cashierRows, t("salesReports.dims.cashier"))}
            >
              <BarChart data={cashierRows}>
                <CartesianGrid stroke={palette.grid} vertical={false} />
                <XAxis dataKey="label" reversed={rtl.xAxisReversed} stroke={palette.axis} tick={{ fontSize: 11 }} />
                <YAxis orientation={rtl.dir === "rtl" ? "right" : "left"} stroke={palette.axis} tickFormatter={rtl.tickFormatterNumber} tick={{ fontSize: 11 }} />
                <RechartsTooltip contentStyle={rtl.tooltipStyle} formatter={(v) => rtl.tickFormatterCurrency(v)} />
                <Bar dataKey="discounts_total" name={t("salesReports.metrics.discounts_total")} fill={palette.series[1]} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ChartCard>

            <DataTable<DimRow>
              columns={[dimCol(t("salesReports.dims.cashier")), ...metricCols]}
              rows={cashierRows}
              getRowId={(r) => r.key || r.label}
              paginate={false}
              columnMenu={false}
              emptyTitle={t("salesReports.states.empty")}
              mobileTitle={(r) => r.label}
              onRowClick={() => navigate(`/reports/sales/cashiers${search}`)}
            />
          </>
        )
      )}
    </section>
  );
}
