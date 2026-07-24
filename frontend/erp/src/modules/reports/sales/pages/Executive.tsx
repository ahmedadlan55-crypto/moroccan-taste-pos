// Sales Analytics Hub — "executive" page.
//
// KPI row (net / gross / orders / avg ticket / discounts / refunds) fed by a
// dimensionless query whose single row carries values + compare/delta, a net
// line by business day (compare series overlaid when a compare mode is on), a
// net-by-channel bar (the readable channel-totals variant), and the by-day
// table synced to the same data. Chart clicks drill: a day point pins
// from=to=that day (push), a channel bar adds the channel filter.
//
// PERF: recharts (and ChartCard, which imports it) are loaded through the
// page-local deferred ChartKit below, so this lazily-routed chunk mounts fast
// — states (loading/empty/error) and the KPI row never wait on the chart
// vendor bundle.
import { lazy, Suspense, useMemo, type ReactElement } from "react";
import { Coins, Percent, Receipt, ShoppingBag, Ticket, Undo2, type LucideIcon } from "lucide-react";
import {
  Badge,
  EmptyState,
  ErrorState,
  ExplainNumber,
  LoadingState,
  MetricCard,
  Skeleton,
  type MetricTone,
} from "@/shared/ui";
import { useChartPalette } from "@/shared/charts/palette";
import { useChartsRtl } from "@/shared/charts/rtl";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { useUrlFilters } from "@/shared/hooks/useUrlFilters";
import { computeCompareRange } from "@/shared/ui/date-range-picker";
import { formatCurrency, formatNumber } from "@/shared/lib";
import { useT, type TFunction } from "@/i18n";
import { analyticsFilterCodec, type AnalyticsFilters } from "../lib/filters";
import {
  buildFiltersBody,
  displayMetric,
  type AnalyticsCompareSpec,
  type AnalyticsQueryBody,
  type AnalyticsRegistry,
  type AnalyticsResult,
  type AnalyticsResultRow,
} from "../lib/api";
import { useAnalyticsQuery, useAnalyticsRegistry } from "../lib/useAnalyticsQuery";

const SEGMENT = "executive";

/** KPI metric codes in card order. */
const KPI_METRICS = [
  "net_ex_vat",
  "gross_product_sales",
  "orders",
  "avg_ticket",
  "discounts_total",
  "refunds_out",
] as const;

const KPI_CARDS: Array<{ id: (typeof KPI_METRICS)[number]; icon: LucideIcon; tone: MetricTone; format: (v: number) => string }> = [
  { id: "net_ex_vat", icon: Coins, tone: "teal", format: formatCurrency },
  { id: "gross_product_sales", icon: Receipt, tone: "blue", format: formatCurrency },
  { id: "orders", icon: ShoppingBag, tone: "violet", format: formatNumber },
  { id: "avg_ticket", icon: Ticket, tone: "amber", format: formatCurrency },
  { id: "discounts_total", icon: Percent, tone: "rose", format: formatCurrency },
  { id: "refunds_out", icon: Undo2, tone: "rose", format: formatCurrency },
];

/* ── deferred chart kit (page-local copy by design; see wave notes) ── */

type Recharts = typeof import("recharts");
interface ChartKitBag {
  R: Recharts;
  ChartCard: (typeof import("@/shared/charts/ChartCard"))["ChartCard"];
}
const ChartKit = lazy(async () => {
  const [R, card] = await Promise.all([import("recharts"), import("@/shared/charts/ChartCard")]);
  const bag: ChartKitBag = { R, ChartCard: card.ChartCard };
  return {
    default: function ChartKitHost({ children }: { children: (kit: ChartKitBag) => ReactElement }) {
      return children(bag);
    },
  };
});

/* ── tiny local helpers (deliberately page-local; see wave notes) ── */

function compareSpec(filters: AnalyticsFilters): AnalyticsCompareSpec | undefined {
  if (filters.compare === "none") return undefined;
  return { mode: filters.compare, ...computeCompareRange(filters.compare, { from: filters.from, to: filters.to }) };
}

function metricExplain(t: TFunction, registry: AnalyticsRegistry | undefined, code: string) {
  const equationKey = registry?.metrics?.find?.((m) => m.id === code)?.equationKey;
  return (
    <ExplainNumber
      title={t(`salesReports.metrics.${code}`)}
      formula={equationKey ? t(`salesReports.explain.${equationKey}`) : undefined}
      triggerLabel={t(`salesReports.metrics.${code}`)}
    />
  );
}

function CompletenessNotice({ meta }: { meta?: AnalyticsResult["meta"] }) {
  const t = useT();
  if (!meta?.completeness || meta.completeness.complete) return null;
  return (
    <div
      data-testid="completeness-notice"
      className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-bold text-amber-800"
    >
      <span>{t("salesReports.states.notAvailableHistorically")}</span>
      {(meta.completeness.missingDays?.length ?? 0) > 0 && (
        <Badge tone="warning">{formatNumber(meta.completeness.missingDays!.length)}</Badge>
      )}
    </div>
  );
}

/** The masked/missing contract for a single-row (dimensionless) KPI result. */
function kpiValue(
  result: AnalyticsResult | undefined,
  row: AnalyticsResultRow | undefined,
  id: string,
  format: (v: number) => string,
): string {
  if (!row || result?.meta.maskedMetrics.includes(id)) return "—";
  const v = displayMetric(row, id);
  return v == null ? "—" : format(v);
}

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function dayFromChartClick(state: unknown): string | null {
  const label = (state as { activeLabel?: unknown } | null)?.activeLabel;
  return typeof label === "string" && ISO_DAY_RE.test(label) ? label : null;
}

function keyFromChartClick(state: unknown): string | null {
  const payload = (state as { activePayload?: Array<{ payload?: { key?: unknown } }> } | null)?.activePayload;
  const key = payload?.[0]?.payload?.key;
  return typeof key === "string" && key !== "" ? key : null;
}

interface DayRow {
  day: string;
  label: string;
  net: number | null;
  compareNet: number | null;
  orders: number | null;
  avgTicket: number | null;
  discounts: number | null;
}

export default function Executive() {
  const t = useT();
  const palette = useChartPalette();
  const rtl = useChartsRtl();
  const { filters, patch } = useUrlFilters(analyticsFilterCodec);
  const registry = useAnalyticsRegistry();

  const base = buildFiltersBody(filters);
  const compare = compareSpec(filters);

  const kpiBody: AnalyticsQueryBody = { ...base, metrics: [...KPI_METRICS], dimensions: [], ...(compare ? { compare } : {}) };
  const byDayBody: AnalyticsQueryBody = {
    ...base,
    metrics: ["net_ex_vat", "orders", "avg_ticket", "discounts_total"],
    dimensions: ["business_day"],
    sort: [{ by: "business_day", dir: "asc" }],
    ...(compare ? { compare } : {}),
  };
  const byChannelBody: AnalyticsQueryBody = {
    ...base,
    metrics: ["net_ex_vat"],
    dimensions: ["channel"],
    sort: [{ by: "net_ex_vat", dir: "desc" }],
  };

  // Data queries wait for a VALID metric catalog: without one there is nothing
  // to label or explain, and a disabled query never fires a doomed request.
  const catalogReady = registry.data != null && Array.isArray(registry.data.metrics);
  const kpis = useAnalyticsQuery(SEGMENT, kpiBody, { enabled: catalogReady });
  const byDay = useAnalyticsQuery(SEGMENT, byDayBody, { enabled: catalogReady });
  const byChannel = useAnalyticsQuery(SEGMENT, byChannelBody, { enabled: catalogReady });

  const hasCompare = filters.compare !== "none";
  const kpiRow = kpis.data?.rows[0];

  const dayRows = useMemo<DayRow[]>(
    () =>
      (byDay.data?.rows ?? []).map((row) => ({
        day: String(row.keys[0] ?? ""),
        label: row.labels[0] ?? String(row.keys[0] ?? ""),
        net: displayMetric(row, "net_ex_vat"),
        compareNet: typeof row.compare?.net_ex_vat === "number" ? row.compare.net_ex_vat : null,
        orders: displayMetric(row, "orders"),
        avgTicket: displayMetric(row, "avg_ticket"),
        discounts: displayMetric(row, "discounts_total"),
      })),
    [byDay.data],
  );

  const channelRows = useMemo(
    () =>
      (byChannel.data?.rows ?? []).map((row) => ({
        key: String(row.keys[0] ?? ""),
        label: row.labels[0] ?? String(row.keys[0] ?? ""),
        net: displayMetric(row, "net_ex_vat"),
      })),
    [byChannel.data],
  );

  const columns = useMemo<ColumnDef<DayRow>[]>(
    () => [
      {
        id: "day",
        header: t("salesReports.dims.business_day"),
        accessor: (r) => r.day,
        cell: (r) => r.label,
        pinStart: true,
        width: 128,
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
      {
        id: "net",
        header: t("salesReports.metrics.net_ex_vat"),
        accessor: (r) => r.net,
        cell: (r) => (r.net == null ? "—" : formatCurrency(r.net)),
        numeric: true,
        sortable: true,
      },
      {
        id: "avgTicket",
        header: t("salesReports.metrics.avg_ticket"),
        accessor: (r) => r.avgTicket,
        cell: (r) => (r.avgTicket == null ? "—" : formatCurrency(r.avgTicket)),
        numeric: true,
        sortable: true,
      },
      {
        id: "discounts",
        header: t("salesReports.metrics.discounts_total"),
        accessor: (r) => r.discounts,
        cell: (r) => (r.discounts == null ? "—" : formatCurrency(r.discounts)),
        numeric: true,
        sortable: true,
      },
    ],
    [t],
  );

  const isLoading = registry.isLoading || kpis.isLoading || byDay.isLoading || byChannel.isLoading;
  const error = registry.error ?? kpis.error ?? byDay.error ?? byChannel.error;

  if (isLoading) return <LoadingState rows={6} />;
  if (error) {
    return (
      <ErrorState
        error={error}
        title={t("salesReports.states.loadFailed")}
        onRetry={() => {
          void registry.refetch();
          void kpis.refetch();
          void byDay.refetch();
          void byChannel.refetch();
        }}
      />
    );
  }
  if (dayRows.length === 0) return <EmptyState title={t("salesReports.states.empty")} />;

  const drillToDay = (state: unknown) => {
    const day = dayFromChartClick(state);
    if (day) patch({ from: day, to: day, preset: "custom" }, { push: true });
  };
  const drillToChannel = (state: unknown) => {
    const key = keyFromChartClick(state);
    if (key) patch({ channel: [key] }, { push: true });
  };

  const deltaFor = (id: string): string | undefined => {
    if (!hasCompare) return undefined;
    const d = kpiRow?.delta?.[id];
    if (typeof d !== "number" || !Number.isFinite(d)) return undefined;
    return `${d >= 0 ? "+" : ""}${formatNumber(d)}%`;
  };

  return (
    <section className="space-y-4" data-testid="page-executive">
      <CompletenessNotice meta={byDay.data?.meta} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6" data-testid="kpi-row">
        {KPI_CARDS.map(({ id, icon, tone, format }) => (
          <MetricCard
            key={id}
            label={t(`salesReports.metrics.${id}`)}
            value={kpiValue(kpis.data, kpiRow, id, format)}
            delta={deltaFor(id)}
            icon={icon}
            tone={tone}
            explain={metricExplain(t, registry.data, id)}
          />
        ))}
      </div>

      <Suspense fallback={<Skeleton className="h-80" />}>
        <ChartKit>
          {({ R, ChartCard }) => (
            <div className="grid gap-4 xl:grid-cols-2">
              <ChartCard
                title={t("salesReports.metrics.net_ex_vat")}
                subtitle={t("salesReports.dims.business_day")}
                isEmpty={dayRows.every((r) => r.net == null)}
                emptyLabel={t("inventoryRest.analytics.chartEmpty")}
                tableLabel={t("inventoryRest.analytics.showTable")}
                tableCaption={`${t("salesReports.metrics.net_ex_vat")} — ${t("salesReports.dims.business_day")}`}
                tableColumns={[
                  { key: "label", label: t("salesReports.dims.business_day") },
                  { key: "netText", label: t("salesReports.metrics.net_ex_vat") },
                  ...(hasCompare ? [{ key: "compareText", label: t("salesReports.topbar.compare") }] : []),
                ]}
                tableRows={dayRows.map((r) => ({
                  label: r.label,
                  netText: r.net == null ? "—" : formatCurrency(r.net),
                  compareText: r.compareNet == null ? "—" : formatCurrency(r.compareNet),
                }))}
                onPointClick={drillToDay}
              >
                <R.LineChart data={dayRows} margin={{ top: 8, left: 8, right: 8 }}>
                  <R.CartesianGrid stroke={palette.grid} vertical={false} />
                  <R.XAxis
                    dataKey="day"
                    reversed={rtl.xAxisReversed}
                    tick={{ fontSize: 11, fill: palette.axis }}
                    tickFormatter={(v: string) => String(v).slice(5)}
                  />
                  <R.YAxis tick={{ fontSize: 11, fill: palette.axis }} tickFormatter={rtl.tickFormatterNumber} width={64} />
                  <R.Tooltip contentStyle={rtl.tooltipStyle} formatter={(value) => rtl.tickFormatterCurrency(value)} />
                  <R.Line
                    type="monotone"
                    dataKey="net"
                    name={t("salesReports.metrics.net_ex_vat")}
                    stroke={palette.series[0]}
                    strokeWidth={2}
                    dot={false}
                  />
                  {hasCompare && (
                    <R.Line
                      type="monotone"
                      dataKey="compareNet"
                      name={t("salesReports.topbar.compare")}
                      stroke={palette.series[2]}
                      strokeWidth={2}
                      strokeDasharray="6 4"
                      dot={false}
                    />
                  )}
                </R.LineChart>
              </ChartCard>

              <ChartCard
                title={t("salesReports.metrics.net_ex_vat")}
                subtitle={t("salesReports.dims.channel")}
                isEmpty={channelRows.length === 0 || channelRows.every((r) => r.net == null)}
                emptyLabel={t("inventoryRest.analytics.chartEmpty")}
                tableLabel={t("inventoryRest.analytics.showTable")}
                tableCaption={`${t("salesReports.metrics.net_ex_vat")} — ${t("salesReports.dims.channel")}`}
                tableColumns={[
                  { key: "label", label: t("salesReports.dims.channel") },
                  { key: "netText", label: t("salesReports.metrics.net_ex_vat") },
                ]}
                tableRows={channelRows.map((r) => ({
                  label: r.label,
                  netText: r.net == null ? "—" : formatCurrency(r.net),
                }))}
                onPointClick={drillToChannel}
              >
                <R.BarChart data={channelRows} margin={{ top: 8, left: 8, right: 8 }}>
                  <R.CartesianGrid stroke={palette.grid} vertical={false} />
                  <R.XAxis dataKey="label" reversed={rtl.xAxisReversed} tick={{ fontSize: 11, fill: palette.axis }} />
                  <R.YAxis tick={{ fontSize: 11, fill: palette.axis }} tickFormatter={rtl.tickFormatterNumber} width={64} />
                  <R.Tooltip contentStyle={rtl.tooltipStyle} formatter={(value) => rtl.tickFormatterCurrency(value)} />
                  <R.Bar dataKey="net" name={t("salesReports.metrics.net_ex_vat")} fill={palette.series[0]} radius={[6, 6, 0, 0]} />
                </R.BarChart>
              </ChartCard>
            </div>
          )}
        </ChartKit>
      </Suspense>

      <DataTable<DayRow>
        columns={columns}
        rows={dayRows}
        getRowId={(r) => r.day}
        initialSort={{ columnId: "day", dir: "asc" }}
        onRowClick={(r) => patch({ from: r.day, to: r.day, preset: "custom" }, { push: true })}
        emptyTitle={t("salesReports.states.empty")}
      />
    </section>
  );
}
