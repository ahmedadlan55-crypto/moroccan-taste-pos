// Inventory performance — the measured half of the warehouse control centre.
//
// This section replaced a static "readiness register": fifteen paragraphs
// explaining which metrics the system could not produce. A control centre is
// judged by what it measures, so every one of those paragraphs is now either a
// chart on this screen or genuinely out of scope and simply absent. Nothing
// here is prose about data; everything here IS data.
//
// ─── COLOUR ────────────────────────────────────────────────────────────────
// recharts writes concrete colour strings into fill/stroke attributes, and hex
// literals are refused in this tree. `useChartPalette()` resolves the
// --mt-chart-* tokens at runtime — it is the ONLY way chart colour enters here.
//
// ─── NULL IS A VALUE ───────────────────────────────────────────────────────
// Turnover, days-on-hand, margin and availability are `number | null` all the
// way from SQL to this file. Null renders as an em dash with the reason beside
// it. Coercing them to 0 anywhere in this chain turns "nothing to divide by"
// into "never turns" — the opposite conclusion, indistinguishable on screen.
import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  Pie,
  PieChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Activity,
  CalendarClock,
  Layers,
  PackageSearch,
  Percent,
  Repeat,
  TrendingUp,
} from "lucide-react";
import { Badge, ErrorState, LoadingState, MetricCard } from "@/shared/ui";
// Deep import on purpose: the charts barrel drags Heatmap in with it.
import { ChartCard } from "@/shared/charts/ChartCard";
import { useChartPalette } from "@/shared/charts/palette";
import { useChartsRtl } from "@/shared/charts/rtl";
import { cn, formatCurrency, formatNumber, formatQty } from "@/shared/lib";
import { useLang, useT, type TFunction } from "@/i18n";
import { ALL_WAREHOUSES } from "@/modules/inventory/lib/warehouse-scope-provider";
import { useInventoryPerformance } from "./api";
import type {
  AbcClass,
  AgeingBucket,
  ConsumedItemRow,
  InventoryPerformance as InventoryPerformanceData,
} from "./contracts";

const CHART_HEIGHT = 300;

/** An em dash, not a zero. See the null note in the file header. */
function dash(value: number | null, format: (value: number) => string): string {
  return value == null ? "—" : format(value);
}

function pct(value: number | null): string {
  return value == null ? "—" : `${formatNumber(value)}%`;
}

function times(value: number | null): string {
  return value == null ? "—" : `${formatNumber(value)}×`;
}

/**
 * Item label. Arabic UI shows the Arabic name; English UI prefers `name_en` and
 * falls back to the Arabic one rather than printing an opaque item id — a
 * warehouse operator recognises "شاي أخضر", never "MTG-TNG-0001".
 */
function itemLabel(row: { name: string; nameEn: string | null; itemId: string }, lang: string): string {
  if (lang === "en") return row.nameEn || row.name || row.itemId;
  return row.name || row.nameEn || row.itemId;
}

/** Long names blow out a bar chart's axis gutter; the tooltip keeps the whole one. */
function truncate(label: string, max = 22): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

const ABC_TONE: Record<AbcClass, string> = {
  A: "bg-teal-50 text-teal-800 border-teal-200",
  B: "bg-amber-50 text-amber-800 border-amber-200",
  C: "bg-slate-50 text-slate-600 border-slate-200",
};

function AbcBadge({ abcClass }: { abcClass: AbcClass }) {
  return (
    <span className={cn("inline-flex h-6 min-w-6 items-center justify-center rounded-lg border px-2 text-[11px] font-extrabold", ABC_TONE[abcClass])}>
      {abcClass}
    </span>
  );
}

/* ── 1. Headline metrics ──────────────────────────────────────────────────── */

function PerformanceKpis({ data }: { data: InventoryPerformanceData }) {
  const t = useT();
  const k = data.kpis;
  return (
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label={t("warehouseIntelligence.performance.kpisAria")}>
      <MetricCard
        label={t("warehouseIntelligence.performance.turnover")}
        value={times(k.turnoverRatio)}
        note={k.turnoverRatio == null
          ? t("warehouseIntelligence.performance.turnoverUnavailable")
          : t("warehouseIntelligence.performance.turnoverNote", { annual: formatNumber(k.annualizedTurnover ?? 0) })}
        icon={Repeat}
      />
      <MetricCard
        label={t("warehouseIntelligence.performance.daysOnHand")}
        value={dash(k.daysOnHand, (v) => t("warehouseIntelligence.performance.daysValue", { days: formatNumber(v) }))}
        note={t("warehouseIntelligence.performance.daysOnHandNote", { average: formatCurrency(k.averageInventoryValue) })}
        icon={CalendarClock}
        tone="blue"
      />
      <MetricCard
        label={t("warehouseIntelligence.performance.consumption")}
        value={formatCurrency(k.consumptionValue)}
        note={t("warehouseIntelligence.performance.consumptionNote", { skus: formatNumber(k.consumedSkus) })}
        icon={Activity}
        tone="teal"
      />
      <MetricCard
        label={t("warehouseIntelligence.performance.deadStock")}
        value={formatCurrency(k.deadStockValue)}
        note={t("warehouseIntelligence.performance.deadStockNote", {
          items: formatNumber(k.deadStockItems),
          share: pct(k.deadStockPct),
        })}
        icon={PackageSearch}
        tone="rose"
      />
    </section>
  );
}

/* ── 2. Most-consumed items ───────────────────────────────────────────────── */

type ConsumedMetric = "value" | "qty";

function TopConsumedChart({ rows, metric, onMetricChange }: {
  rows: ConsumedItemRow[];
  metric: ConsumedMetric;
  onMetricChange: (metric: ConsumedMetric) => void;
}) {
  const t = useT();
  const lang = useLang();
  const palette = useChartPalette();
  const rtl = useChartsRtl();

  const chartRows = useMemo(
    () => rows
      .slice(0, 10)
      .map((row) => ({
        label: truncate(itemLabel(row, lang)),
        full: itemLabel(row, lang),
        value: row.value,
        qty: row.qty,
        abcClass: row.abcClass,
      }))
      // A horizontal bar chart draws its first datum at the BOTTOM, so a
      // descending list renders upside down — the biggest consumer lands where
      // the eye looks last.
      .reverse(),
    [rows, lang],
  );

  return (
    <ChartCard
      title={t("warehouseIntelligence.performance.topConsumed")}
      subtitle={t("warehouseIntelligence.performance.topConsumedSubtitle")}
      height={CHART_HEIGHT}
      isEmpty={rows.length === 0}
      emptyLabel={t("warehouseIntelligence.performance.noConsumption")}
      actions={<MetricToggle value={metric} onChange={onMetricChange} t={t} />}
      tableLabel={t("warehouseIntelligence.performance.showTable")}
      tableCaption={t("warehouseIntelligence.performance.topConsumed")}
      tableColumns={[
        { key: "item", label: t("warehouseIntelligence.table.item") },
        { key: "qty", label: t("warehouseIntelligence.table.qty") },
        { key: "value", label: t("warehouseIntelligence.table.value") },
        { key: "abc", label: t("warehouseIntelligence.performance.abcClass") },
        { key: "cover", label: t("warehouseIntelligence.performance.cover") },
      ]}
      tableRows={rows.map((row) => ({
        item: itemLabel(row, lang),
        qty: `${formatQty(row.qty)} ${row.unit}`.trim(),
        value: formatCurrency(row.value),
        abc: row.abcClass,
        cover: dash(row.daysOfCover, (v) => t("warehouseIntelligence.performance.daysValue", { days: formatNumber(v) })),
      }))}
    >
      <BarChart data={chartRows} layout="vertical" margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
        <CartesianGrid stroke={palette.grid} strokeDasharray="3 3" horizontal={false} />
        <XAxis
          type="number"
          tick={{ fontSize: 11, fill: palette.axis }}
          tickFormatter={metric === "value" ? rtl.tickFormatterCurrency : rtl.tickFormatterNumber}
          reversed={rtl.xAxisReversed}
        />
        <YAxis
          type="category"
          dataKey="label"
          width={132}
          tick={{ fontSize: 11, fill: palette.axis }}
          orientation={rtl.dir === "rtl" ? "right" : "left"}
        />
        <Tooltip
          contentStyle={rtl.tooltipStyle}
          formatter={metric === "value" ? rtl.tickFormatterCurrency : rtl.tickFormatterNumber}
          labelFormatter={(_label, payload) => String(payload?.[0]?.payload?.full ?? "")}
        />
        <Bar dataKey={metric} name={t(`warehouseIntelligence.performance.metric.${metric}`)} radius={[0, 6, 6, 0]} maxBarSize={26}>
          {/* Colour carries the ABC class, so the chart says WHICH items matter,
              not merely how tall their bars are. */}
          {chartRows.map((row) => (
            <Cell
              key={row.full}
              fill={row.abcClass === "A" ? palette.series[0] : row.abcClass === "B" ? palette.series[1] : palette.series[4]}
            />
          ))}
        </Bar>
      </BarChart>
    </ChartCard>
  );
}

function MetricToggle({ value, onChange, t }: { value: ConsumedMetric; onChange: (v: ConsumedMetric) => void; t: TFunction }) {
  return (
    <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-0.5" role="group" aria-label={t("warehouseIntelligence.performance.metricToggle")}>
      {(["value", "qty"] as const).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={cn(
            "min-h-8 rounded-lg px-3 text-xs font-extrabold transition",
            value === option ? "bg-white text-teal-700 shadow-sm" : "text-slate-500 hover:text-slate-700",
          )}
        >
          {t(`warehouseIntelligence.performance.metric.${option}`)}
        </button>
      ))}
    </div>
  );
}

/* ── 3. Best sellers ──────────────────────────────────────────────────────── */

function BestSellersChart({ data }: { data: InventoryPerformanceData }) {
  const t = useT();
  const palette = useChartPalette();
  const rtl = useChartsRtl();
  const rows = data.topSelling.rows;

  const chartRows = useMemo(
    () => rows.slice(0, 10).map((row) => ({
      label: truncate(row.name),
      full: row.name,
      revenue: row.revenue,
      grossProfit: row.grossProfit,
    })).reverse(),
    [rows],
  );

  return (
    <ChartCard
      title={t("warehouseIntelligence.performance.bestSellers")}
      subtitle={t("warehouseIntelligence.performance.bestSellersSubtitle")}
      height={CHART_HEIGHT}
      isEmpty={rows.length === 0}
      emptyLabel={t(data.topSelling.state === "available"
        ? "warehouseIntelligence.performance.noSales"
        : "warehouseIntelligence.performance.salesUnavailable")}
      tableLabel={t("warehouseIntelligence.performance.showTable")}
      tableCaption={t("warehouseIntelligence.performance.bestSellers")}
      tableColumns={[
        { key: "product", label: t("warehouseIntelligence.performance.product") },
        { key: "qty", label: t("warehouseIntelligence.table.qty") },
        { key: "revenue", label: t("warehouseIntelligence.performance.revenue") },
        { key: "profit", label: t("warehouseIntelligence.performance.grossProfit") },
        { key: "margin", label: t("warehouseIntelligence.performance.margin") },
      ]}
      tableRows={rows.map((row) => ({
        product: row.name,
        qty: formatQty(row.qty),
        revenue: formatCurrency(row.revenue),
        profit: formatCurrency(row.grossProfit),
        margin: pct(row.marginPct),
      }))}
    >
      <BarChart data={chartRows} layout="vertical" margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
        <CartesianGrid stroke={palette.grid} strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" tick={{ fontSize: 11, fill: palette.axis }} tickFormatter={rtl.tickFormatterCurrency} reversed={rtl.xAxisReversed} />
        <YAxis type="category" dataKey="label" width={132} tick={{ fontSize: 11, fill: palette.axis }} orientation={rtl.dir === "rtl" ? "right" : "left"} />
        <Tooltip
          contentStyle={rtl.tooltipStyle}
          formatter={rtl.tickFormatterCurrency}
          labelFormatter={(_label, payload) => String(payload?.[0]?.payload?.full ?? "")}
        />
        <Legend wrapperStyle={{ fontSize: 12, fontWeight: 700 }} />
        {/* Revenue and profit side by side: the best seller and the most
            profitable seller are frequently different products, and a revenue
            bar alone hides that. */}
        <Bar dataKey="revenue" name={t("warehouseIntelligence.performance.revenue")} fill={palette.series[0]} radius={[0, 6, 6, 0]} maxBarSize={14} />
        <Bar dataKey="grossProfit" name={t("warehouseIntelligence.performance.grossProfit")} fill={palette.series[2]} radius={[0, 6, 6, 0]} maxBarSize={14} />
      </BarChart>
    </ChartCard>
  );
}

/* ── 4. ABC Pareto ────────────────────────────────────────────────────────── */

function AbcParetoChart({ data }: { data: InventoryPerformanceData }) {
  const t = useT();
  const lang = useLang();
  const palette = useChartPalette();
  const rtl = useChartsRtl();

  const chartRows = useMemo(
    () => data.topConsumed.slice(0, 12).map((row) => ({
      label: truncate(itemLabel(row, lang), 14),
      full: itemLabel(row, lang),
      value: row.value,
      cumulativeShare: row.cumulativeShare,
      abcClass: row.abcClass,
    })),
    [data.topConsumed, lang],
  );

  return (
    <ChartCard
      title={t("warehouseIntelligence.performance.pareto")}
      subtitle={t("warehouseIntelligence.performance.paretoSubtitle")}
      height={CHART_HEIGHT}
      isEmpty={chartRows.length === 0}
      emptyLabel={t("warehouseIntelligence.performance.noConsumption")}
      actions={
        <div className="flex flex-wrap items-center gap-1.5">
          {data.abcSummary.map((summary) => (
            <span key={summary.abcClass} className={cn("inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-extrabold", ABC_TONE[summary.abcClass])}>
              {summary.abcClass}
              <span className="tabular-nums opacity-70">{formatNumber(summary.items)}</span>
              <span className="tabular-nums">{formatNumber(summary.sharePct)}%</span>
            </span>
          ))}
        </div>
      }
      tableLabel={t("warehouseIntelligence.performance.showTable")}
      tableCaption={t("warehouseIntelligence.performance.pareto")}
      tableColumns={[
        { key: "abc", label: t("warehouseIntelligence.performance.abcClass") },
        { key: "items", label: t("warehouseIntelligence.performance.itemCount") },
        { key: "itemShare", label: t("warehouseIntelligence.performance.itemShare") },
        { key: "value", label: t("warehouseIntelligence.table.value") },
        { key: "valueShare", label: t("warehouseIntelligence.performance.valueShare") },
      ]}
      tableRows={data.abcSummary.map((summary) => ({
        abc: summary.abcClass,
        items: formatNumber(summary.items),
        itemShare: `${formatNumber(summary.itemSharePct)}%`,
        value: formatCurrency(summary.value),
        valueShare: `${formatNumber(summary.sharePct)}%`,
      }))}
    >
      <ComposedChart data={chartRows} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
        <CartesianGrid stroke={palette.grid} strokeDasharray="3 3" />
        <XAxis dataKey="label" tick={{ fontSize: 10, fill: palette.axis }} interval={0} angle={-30} textAnchor="end" height={64} reversed={rtl.xAxisReversed} />
        <YAxis yAxisId="value" tick={{ fontSize: 11, fill: palette.axis }} tickFormatter={rtl.tickFormatterCurrency} width={72} orientation={rtl.dir === "rtl" ? "right" : "left"} />
        {/* The cumulative line is a PERCENTAGE and must not share the value
            axis — on the same scale it flattens against the bars and the 80%
            crossing, which is the entire point of a Pareto chart, disappears. */}
        <YAxis yAxisId="share" domain={[0, 100]} tick={{ fontSize: 11, fill: palette.axis }} tickFormatter={(v) => `${formatNumber(Number(v))}%`} width={52} orientation={rtl.dir === "rtl" ? "left" : "right"} />
        <Tooltip contentStyle={rtl.tooltipStyle} labelFormatter={(_label, payload) => String(payload?.[0]?.payload?.full ?? "")} />
        <Legend wrapperStyle={{ fontSize: 12, fontWeight: 700 }} />
        <Bar yAxisId="value" dataKey="value" name={t("warehouseIntelligence.performance.consumptionValue")} radius={[6, 6, 0, 0]} maxBarSize={40}>
          {chartRows.map((row) => (
            <Cell key={row.full} fill={row.abcClass === "A" ? palette.series[0] : row.abcClass === "B" ? palette.series[1] : palette.series[4]} />
          ))}
        </Bar>
        <Line yAxisId="share" type="monotone" dataKey="cumulativeShare" name={t("warehouseIntelligence.performance.cumulativeShare")} stroke={palette.warn} strokeWidth={2} dot={{ r: 3 }} />
      </ComposedChart>
    </ChartCard>
  );
}

/* ── 5. Movement trend ────────────────────────────────────────────────────── */

function MovementTrendChart({ data }: { data: InventoryPerformanceData }) {
  const t = useT();
  const palette = useChartPalette();
  const rtl = useChartsRtl();
  const rows = data.consumptionTrend;

  return (
    <ChartCard
      title={t("warehouseIntelligence.performance.flowTrend")}
      subtitle={t(data.period.bucket === "week"
        ? "warehouseIntelligence.performance.flowTrendWeekly"
        : "warehouseIntelligence.performance.flowTrendDaily")}
      height={CHART_HEIGHT}
      isEmpty={rows.length === 0}
      emptyLabel={t("warehouseIntelligence.performance.noMovement")}
      tableLabel={t("warehouseIntelligence.performance.showTable")}
      tableCaption={t("warehouseIntelligence.performance.flowTrend")}
      tableColumns={[
        { key: "period", label: t("warehouseIntelligence.table.period") },
        { key: "in", label: t("warehouseIntelligence.table.inQty") },
        { key: "out", label: t("warehouseIntelligence.table.outQty") },
        { key: "net", label: t("warehouseIntelligence.performance.net") },
        { key: "outValue", label: t("warehouseIntelligence.performance.consumptionValue") },
      ]}
      tableRows={rows.map((row) => ({
        period: row.bucket,
        in: formatQty(row.inQty),
        out: formatQty(row.outQty),
        net: formatQty(row.netQty),
        outValue: formatCurrency(row.outValue),
      }))}
    >
      <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
        <CartesianGrid stroke={palette.grid} strokeDasharray="3 3" />
        <XAxis dataKey="bucket" tick={{ fontSize: 10, fill: palette.axis }} reversed={rtl.xAxisReversed} minTickGap={16} />
        <YAxis yAxisId="qty" tick={{ fontSize: 11, fill: palette.axis }} tickFormatter={rtl.tickFormatterNumber} width={60} orientation={rtl.dir === "rtl" ? "right" : "left"} />
        <YAxis yAxisId="value" tick={{ fontSize: 11, fill: palette.axis }} tickFormatter={rtl.tickFormatterCurrency} width={72} orientation={rtl.dir === "rtl" ? "left" : "right"} />
        <Tooltip contentStyle={rtl.tooltipStyle} />
        <Legend wrapperStyle={{ fontSize: 12, fontWeight: 700 }} />
        <Bar yAxisId="qty" dataKey="inQty" name={t("warehouseIntelligence.table.inQty")} fill={palette.pos} radius={[4, 4, 0, 0]} maxBarSize={22} />
        <Bar yAxisId="qty" dataKey="outQty" name={t("warehouseIntelligence.table.outQty")} fill={palette.series[3]} radius={[4, 4, 0, 0]} maxBarSize={22} />
        <Line yAxisId="value" type="monotone" dataKey="outValue" name={t("warehouseIntelligence.performance.consumptionValue")} stroke={palette.series[0]} strokeWidth={2} dot={false} />
      </ComposedChart>
    </ChartCard>
  );
}

/* ── 6. Category mix ──────────────────────────────────────────────────────── */

function CategoryMixChart({ data }: { data: InventoryPerformanceData }) {
  const t = useT();
  const palette = useChartPalette();
  const rtl = useChartsRtl();
  const uncategorised = t("warehouseIntelligence.performance.uncategorised");
  const rows = useMemo(
    () => data.categoryMix
      .filter((row) => row.value > 0)
      .map((row) => ({ name: row.category || uncategorised, value: row.value, share: row.share })),
    [data.categoryMix, uncategorised],
  );

  return (
    <ChartCard
      title={t("warehouseIntelligence.performance.categoryMix")}
      subtitle={t("warehouseIntelligence.performance.categoryMixSubtitle")}
      height={CHART_HEIGHT}
      isEmpty={rows.length === 0}
      emptyLabel={t("warehouseIntelligence.performance.noConsumption")}
      tableLabel={t("warehouseIntelligence.performance.showTable")}
      tableCaption={t("warehouseIntelligence.performance.categoryMix")}
      tableColumns={[
        { key: "category", label: t("warehouseIntelligence.performance.category") },
        { key: "value", label: t("warehouseIntelligence.table.value") },
        { key: "share", label: t("warehouseIntelligence.performance.valueShare") },
      ]}
      tableRows={rows.map((row) => ({
        category: row.name,
        value: formatCurrency(row.value),
        share: `${formatNumber(row.share)}%`,
      }))}
    >
      <PieChart margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
        <Pie data={rows} dataKey="value" nameKey="name" innerRadius="52%" outerRadius="80%" paddingAngle={2}>
          {rows.map((row, index) => (
            <Cell key={row.name} fill={palette.series[index % palette.series.length]} />
          ))}
        </Pie>
        <Tooltip contentStyle={rtl.tooltipStyle} formatter={rtl.tickFormatterCurrency} />
        <Legend wrapperStyle={{ fontSize: 12, fontWeight: 700 }} />
      </PieChart>
    </ChartCard>
  );
}

/* ── 7. Stock ageing ──────────────────────────────────────────────────────── */

const AGEING_ORDER: AgeingBucket[] = ["0_30", "31_60", "61_90", "91_180", "over_180", "never"];

function AgeingChart({ data }: { data: InventoryPerformanceData }) {
  const t = useT();
  const palette = useChartPalette();
  const rtl = useChartsRtl();

  const rows = useMemo(() => {
    const byBucket = new Map(data.ageing.map((row) => [row.bucket, row]));
    return AGEING_ORDER.map((bucket) => {
      const row = byBucket.get(bucket);
      return {
        bucket,
        label: t(`warehouseIntelligence.performance.ageing.${bucket}`),
        value: row?.value ?? 0,
        items: row?.items ?? 0,
        qty: row?.qty ?? 0,
        sharePct: row?.sharePct ?? 0,
      };
    });
  }, [data.ageing, t]);

  const hasValue = rows.some((row) => row.value > 0 || row.items > 0);

  return (
    <ChartCard
      title={t("warehouseIntelligence.performance.ageing.title")}
      subtitle={t("warehouseIntelligence.performance.ageing.subtitle")}
      height={CHART_HEIGHT}
      isEmpty={!hasValue}
      emptyLabel={t("warehouseIntelligence.performance.noStock")}
      tableLabel={t("warehouseIntelligence.performance.showTable")}
      tableCaption={t("warehouseIntelligence.performance.ageing.title")}
      tableColumns={[
        { key: "bucket", label: t("warehouseIntelligence.performance.ageing.bucket") },
        { key: "items", label: t("warehouseIntelligence.performance.itemCount") },
        { key: "qty", label: t("warehouseIntelligence.table.qty") },
        { key: "value", label: t("warehouseIntelligence.table.value") },
        { key: "share", label: t("warehouseIntelligence.performance.valueShare") },
      ]}
      tableRows={rows.map((row) => ({
        bucket: row.label,
        items: formatNumber(row.items),
        qty: formatQty(row.qty),
        value: formatCurrency(row.value),
        share: `${formatNumber(row.sharePct)}%`,
      }))}
    >
      <BarChart data={rows} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
        <CartesianGrid stroke={palette.grid} strokeDasharray="3 3" />
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: palette.axis }} interval={0} reversed={rtl.xAxisReversed} />
        <YAxis tick={{ fontSize: 11, fill: palette.axis }} tickFormatter={rtl.tickFormatterCurrency} width={72} orientation={rtl.dir === "rtl" ? "right" : "left"} />
        <Tooltip contentStyle={rtl.tooltipStyle} formatter={rtl.tickFormatterCurrency} />
        <Bar dataKey="value" name={t("warehouseIntelligence.table.value")} radius={[6, 6, 0, 0]} maxBarSize={48}>
          {/* Fresh stock reads as healthy, the two oldest buckets as risk. The
              ramp is the message: an ageing chart in one flat colour says
              nothing a table did not already say. */}
          {rows.map((row) => (
            <Cell
              key={row.bucket}
              fill={row.bucket === "0_30" ? palette.pos
                : row.bucket === "31_60" ? palette.series[1]
                  : row.bucket === "61_90" ? palette.series[2]
                    : row.bucket === "91_180" ? palette.warn
                      : palette.neg}
            />
          ))}
        </Bar>
      </BarChart>
    </ChartCard>
  );
}

/* ── 8. Warehouse mix ─────────────────────────────────────────────────────── */

function WarehouseMixChart({ data }: { data: InventoryPerformanceData }) {
  const t = useT();
  const palette = useChartPalette();
  const rtl = useChartsRtl();
  const rows = data.warehouseMix;

  return (
    <ChartCard
      title={t("warehouseIntelligence.performance.warehouseMix")}
      subtitle={t("warehouseIntelligence.performance.warehouseMixSubtitle")}
      height={CHART_HEIGHT}
      isEmpty={rows.length === 0 || rows.every((row) => row.value === 0 && row.qty === 0)}
      emptyLabel={t("warehouseIntelligence.performance.noStock")}
      tableLabel={t("warehouseIntelligence.performance.showTable")}
      tableCaption={t("warehouseIntelligence.performance.warehouseMix")}
      tableColumns={[
        { key: "warehouse", label: t("warehouseIntelligence.table.warehouse") },
        { key: "qty", label: t("warehouseIntelligence.table.qty") },
        { key: "value", label: t("warehouseIntelligence.table.value") },
      ]}
      tableRows={rows.map((row) => ({
        warehouse: row.name || row.code,
        qty: formatQty(row.qty),
        value: formatCurrency(row.value),
      }))}
    >
      <BarChart data={rows.map((row) => ({ ...row, label: truncate(row.name || row.code, 18) }))} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
        <CartesianGrid stroke={palette.grid} strokeDasharray="3 3" />
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: palette.axis }} interval={0} reversed={rtl.xAxisReversed} />
        <YAxis tick={{ fontSize: 11, fill: palette.axis }} tickFormatter={rtl.tickFormatterCurrency} width={72} orientation={rtl.dir === "rtl" ? "right" : "left"} />
        <Tooltip contentStyle={rtl.tooltipStyle} formatter={rtl.tickFormatterCurrency} />
        <Bar dataKey="value" name={t("warehouseIntelligence.table.value")} fill={palette.series[0]} radius={[6, 6, 0, 0]} maxBarSize={64} />
      </BarChart>
    </ChartCard>
  );
}

/* ── 9. Movers table — the actionable tail of the charts ──────────────────── */

function MoversTable({ data }: { data: InventoryPerformanceData }) {
  const t = useT();
  const lang = useLang();
  const rows = data.topConsumed.slice(0, 10);
  if (rows.length === 0) return null;
  return (
    <section className="surface overflow-hidden" aria-labelledby="movers-title">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 bg-slate-50/70 px-4 py-3">
        <div>
          <h2 id="movers-title" className="text-sm font-extrabold text-slate-900">{t("warehouseIntelligence.performance.moversTitle")}</h2>
          <p className="mt-1 text-xs font-semibold leading-5 text-slate-500">{t("warehouseIntelligence.performance.moversSubtitle")}</p>
        </div>
        <Badge tone="neutral">{t("warehouseIntelligence.performance.skuCount", { count: data.abcItemCount })}</Badge>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[880px] border-collapse text-sm">
          <thead className="bg-white">
            <tr>
              {["item", "abcClass", "demandPattern", "consumedQty", "consumptionValue", "valueShare", "onHand", "cover"].map((key) => (
                <th key={key} className="whitespace-nowrap border-b border-slate-100 px-3 py-3 text-start text-xs font-extrabold text-slate-500">
                  {t(`warehouseIntelligence.performance.col.${key}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => (
              <tr key={row.itemId} className="hover:bg-slate-50/70">
                <td className="px-3 py-3">
                  <span className="block font-bold text-slate-800">{itemLabel(row, lang)}</span>
                  {row.sku && <span className="mt-0.5 block text-[11px] font-semibold text-slate-400" dir="ltr">{row.sku}</span>}
                </td>
                <td className="px-3 py-3"><AbcBadge abcClass={row.abcClass} /></td>
                <td className="px-3 py-3">
                  {/* Below the minimum observations there is no pattern to
                      report. An em dash says that; "X" would claim the item is
                      the steadiest in the warehouse on the strength of one
                      movement. */}
                  {row.xyzClass
                    ? <span className="text-xs font-extrabold text-slate-700">{t(`warehouseIntelligence.performance.xyz.${row.xyzClass}`)}</span>
                    : <span className="text-xs font-bold text-slate-300">—</span>}
                </td>
                <td className="whitespace-nowrap px-3 py-3 font-bold tabular-nums text-slate-700">{formatQty(row.qty)} {row.unit}</td>
                <td className="whitespace-nowrap px-3 py-3 font-extrabold tabular-nums text-slate-900">{formatCurrency(row.value)}</td>
                <td className="whitespace-nowrap px-3 py-3 font-bold tabular-nums text-slate-600">{formatNumber(row.share)}%</td>
                <td className="whitespace-nowrap px-3 py-3 font-bold tabular-nums text-slate-700">{formatQty(row.onHandQty)}</td>
                <td className="whitespace-nowrap px-3 py-3 font-bold tabular-nums text-slate-700">
                  {dash(row.daysOfCover, (v) => t("warehouseIntelligence.performance.daysValue", { days: formatNumber(v) }))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ── Section ──────────────────────────────────────────────────────────────── */

export function InventoryPerformanceSection({ from, to, scope }: { from: string; to: string; scope: string }) {
  const t = useT();
  const [metric, setMetric] = useState<ConsumedMetric>("value");
  const query = useInventoryPerformance({ from, to, warehouseId: scope === ALL_WAREHOUSES ? undefined : scope });

  if (query.isLoading && !query.data) return <LoadingState rows={4} />;
  if (query.isError && !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const data = query.data;
  if (!data) return null;

  return (
    <div className="space-y-4" data-testid="inventory-performance">
      <section className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-teal-50 text-teal-700"><TrendingUp className="h-5 w-5" /></span>
          <div>
            <h2 className="text-sm font-extrabold text-slate-900">{t("warehouseIntelligence.performance.title")}</h2>
            <p className="text-xs font-semibold text-slate-500">{t("warehouseIntelligence.performance.subtitle")}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral">
            <Percent className="me-1 inline h-3 w-3" />
            {t("warehouseIntelligence.performance.availability", { pct: pct(data.kpis.availabilityPct) })}
          </Badge>
          <Badge tone="neutral">
            <Layers className="me-1 inline h-3 w-3" />
            {t("warehouseIntelligence.performance.basis")}
          </Badge>
        </div>
      </section>

      <PerformanceKpis data={data} />

      <div className="grid gap-4 xl:grid-cols-2">
        <TopConsumedChart rows={data.topConsumed} metric={metric} onMetricChange={setMetric} />
        <BestSellersChart data={data} />
        <AbcParetoChart data={data} />
        <MovementTrendChart data={data} />
        <CategoryMixChart data={data} />
        <AgeingChart data={data} />
        <WarehouseMixChart data={data} />
      </div>

      <MoversTable data={data} />
    </div>
  );
}
