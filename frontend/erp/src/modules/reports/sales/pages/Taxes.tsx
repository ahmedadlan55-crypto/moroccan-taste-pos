// Sales Analytics Hub — "taxes" page (VAT from the stored columns).
//
// KPI row: vat_amount + the order-header extras (fees/rounding/tips — tips is
// frequently not tracked historically and renders "—" with an explain note),
// a stacked bar of VAT by category per day, and a by-rate table.
import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Legend, Tooltip as RechartsTooltip, XAxis, YAxis } from "recharts";
import { Coins, HandCoins, Landmark, ReceiptText, type LucideIcon } from "lucide-react";
import { Badge, EmptyState, ErrorState, ExplainNumber, LoadingState, MetricCard, type MetricTone } from "@/shared/ui";
import { ChartCard, useChartPalette, useChartsRtl } from "@/shared/charts";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatCurrency } from "@/shared/lib";
import { useT } from "@/i18n";
import { useUrlFilters } from "@/shared/hooks/useUrlFilters";
import { analyticsFilterCodec } from "../lib/filters";
import { buildFiltersBody, displayMetric, type AnalyticsQueryBody, type AnalyticsResult } from "../lib/api";
import { useAnalyticsQuery } from "../lib/useAnalyticsQuery";

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

export default function Taxes() {
  const t = useT();
  const { filters } = useUrlFilters(analyticsFilterCodec);
  const palette = useChartPalette();
  const rtl = useChartsRtl();
  const base = useMemo(() => buildFiltersBody(filters), [filters]);

  const dayDim = filters.businessDay ? "business_day" : "calendar_day";

  const kpiBody = useMemo<AnalyticsQueryBody>(
    () => ({ metrics: ["vat_amount", "fees_total", "rounding_total", "tips_total"], dimensions: [], ...base }),
    [base],
  );
  const dayCategoryBody = useMemo<AnalyticsQueryBody>(
    () => ({
      metrics: ["vat_amount"],
      dimensions: [dayDim, "vat_category"],
      sort: [{ by: dayDim, dir: "asc" }],
      ...base,
    }),
    [base, dayDim],
  );
  const rateBody = useMemo<AnalyticsQueryBody>(
    () => ({
      metrics: ["vat_amount", "net_ex_vat"],
      dimensions: ["vat_rate"],
      sort: [{ by: "vat_amount", dir: "desc" }],
      ...base,
    }),
    [base],
  );

  const kpis = useAnalyticsQuery("taxes-kpis", kpiBody);
  const byDayCategory = useAnalyticsQuery("taxes-day-category", dayCategoryBody);
  const byRate = useAnalyticsQuery("taxes-rate", rateBody);

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

  // Pivot day×category rows into one chart row per day with a value per category.
  const categories: Array<{ key: string; label: string }> = [];
  const byDayMap = new Map<string, Record<string, unknown>>();
  for (const r of byDayCategory.data?.rows ?? []) {
    const dayLabel = r.labels[0] ?? String(r.keys[0] ?? "—");
    const catKey = String(r.keys[1] ?? "—");
    const catLabel = r.labels[1] ?? catKey;
    if (!categories.some((c) => c.key === catKey)) categories.push({ key: catKey, label: catLabel });
    const entry = byDayMap.get(dayLabel) ?? { label: dayLabel };
    entry[catKey] = displayMetric(r, "vat_amount");
    byDayMap.set(dayLabel, entry);
  }
  const dayChartRows = [...byDayMap.values()];

  const tipsMasked = kpiValue(kpis.data, "tips_total") == null;

  const rateColumns: ColumnDef<RateRow>[] = [
    { id: "rate", header: t("salesReports.dims.vat_rate"), accessor: (r) => r.label, pinStart: true, width: 140 },
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

      {dayChartRows.length > 0 && (
        <ChartCard
          title={`${t("salesReports.metrics.vat_amount")} — ${t("salesReports.dims.vat_category")}`}
          tableLabel={t("salesReports.dims.vat_category")}
          tableColumns={[
            { key: "label", label: t(`salesReports.dims.${dayDim}`) },
            ...categories.map((c) => ({ key: c.key, label: c.label })),
          ]}
          tableRows={dayChartRows.map((row) => {
            const out: Record<string, unknown> = { label: row.label };
            for (const c of categories) {
              const v = row[c.key];
              out[c.key] = typeof v === "number" ? formatCurrency(v) : "—";
            }
            return out;
          })}
        >
          <BarChart data={dayChartRows}>
            <CartesianGrid stroke={palette.grid} vertical={false} />
            <XAxis dataKey="label" reversed={rtl.xAxisReversed} stroke={palette.axis} tick={{ fontSize: 11 }} />
            <YAxis orientation={rtl.dir === "rtl" ? "right" : "left"} stroke={palette.axis} tickFormatter={rtl.tickFormatterNumber} tick={{ fontSize: 11 }} />
            <RechartsTooltip contentStyle={rtl.tooltipStyle} formatter={(v) => rtl.tickFormatterCurrency(v)} />
            <Legend />
            {categories.map((c, i) => (
              <Bar
                key={c.key}
                dataKey={c.key}
                name={c.label}
                stackId="vat"
                fill={palette.series[i % palette.series.length]}
              />
            ))}
          </BarChart>
        </ChartCard>
      )}

      <DataTable<RateRow>
        columns={rateColumns}
        rows={rateRows}
        getRowId={(r) => r.key || r.label}
        paginate={false}
        columnMenu={false}
        emptyTitle={t("salesReports.states.empty")}
        mobileTitle={(r) => r.label}
      />
    </section>
  );
}
