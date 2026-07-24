// Sales Analytics Hub — "payments" page.
//
// Collections KPIs (payments in / refunds out / net collections / tips — tips
// renders "—" when null), stacked payments-in bars by payment method by day,
// and a per-method table with the in/out direction split (refunds cells carry
// the negative cellTone). Wave 4: a method row (or its bar series) drills by
// pinning the shared `paymentMethod` codec param (push:true — Back restores).
import { lazy, Suspense, useMemo, type ReactElement } from "react";
import { HandCoins, Undo2, Wallet, Coins } from "lucide-react";
import { Badge, EmptyState, ErrorState, ExplainNumber, LoadingState, MetricCard, Skeleton } from "@/shared/ui";
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
  setPageExportRequest,
  type AnalyticsCompareSpec,
  type AnalyticsQueryBody,
  type AnalyticsRegistry,
  type AnalyticsResult,
  type AnalyticsResultRow,
} from "../lib/api";
import { useAnalyticsQuery, useAnalyticsRegistry } from "../lib/useAnalyticsQuery";

const SEGMENT = "payments";
const KPI_METRICS = ["payments_in", "refunds_out", "net_collections", "tips_total"] as const;

// The TopBar ExportMenu asks this page's registry entry for its export shape.
setPageExportRequest(SEGMENT, () => ({
  metrics: ["payments_in", "refunds_out", "net_collections"],
  dimensions: ["payment_method"],
  sort: [{ by: "payments_in", dir: "desc" }],
}));

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

/* ── tiny local helpers (page-local copies by design) ── */

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
      triggerLabel={`${t("salesReports.explain.trigger")} — ${t(`salesReports.metrics.${code}`)}`}
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

interface MethodRow {
  key: string;
  label: string;
  paymentsIn: number | null;
  refundsOut: number | null;
  net: number | null;
}

interface StackedDay {
  day: string;
  [methodKey: string]: string | number;
}

export default function Payments() {
  const t = useT();
  const palette = useChartPalette();
  const rtl = useChartsRtl();
  const { filters, patch } = useUrlFilters(analyticsFilterCodec);
  const registry = useAnalyticsRegistry();

  // Wave-4 drill: pin the clicked method as the shared paymentMethod filter.
  const drillMethod = (method: string) => {
    if (method !== "") patch({ paymentMethod: [method] }, { push: true });
  };

  const base = buildFiltersBody(filters);
  const compare = compareSpec(filters);

  const kpiBody: AnalyticsQueryBody = {
    ...base,
    metrics: [...KPI_METRICS],
    dimensions: [],
    ...(compare ? { compare } : {}),
  };
  const byDayMethodBody: AnalyticsQueryBody = {
    ...base,
    metrics: ["payments_in"],
    dimensions: ["business_day", "payment_method"],
    sort: [{ by: "business_day", dir: "asc" }],
  };
  const byMethodBody: AnalyticsQueryBody = {
    ...base,
    metrics: ["payments_in", "refunds_out", "net_collections"],
    dimensions: ["payment_method"],
    sort: [{ by: "payments_in", dir: "desc" }],
  };

  // Data queries wait for a VALID metric catalog: without one there is nothing
  // to label or explain, and a disabled query never fires a doomed request.
  const catalogReady = registry.data != null && Array.isArray(registry.data.metrics);
  const kpis = useAnalyticsQuery(SEGMENT, kpiBody, { enabled: catalogReady });
  const byDayMethod = useAnalyticsQuery(SEGMENT, byDayMethodBody, { enabled: catalogReady });
  const byMethod = useAnalyticsQuery(SEGMENT, byMethodBody, { enabled: catalogReady });

  const kpiRow = kpis.data?.rows[0];

  // Pivot day×method rows into one object per day with a key per method.
  const { stackedDays, methodSeries } = useMemo(() => {
    const rows = byDayMethod.data?.rows ?? [];
    const series = new Map<string, string>(); // key → label
    const byDay = new Map<string, StackedDay>();
    for (const row of rows) {
      const day = String(row.keys[0] ?? "");
      const method = String(row.keys[1] ?? "");
      if (day === "" || method === "") continue;
      series.set(method, row.labels[1] ?? method);
      const v = displayMetric(row, "payments_in");
      const entry = byDay.get(day) ?? { day };
      if (v != null) entry[`m_${method}`] = v;
      byDay.set(day, entry);
    }
    return {
      stackedDays: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
      methodSeries: [...series.entries()].map(([key, label]) => ({ key: `m_${key}`, method: key, label })),
    };
  }, [byDayMethod.data]);

  const methodRows = useMemo<MethodRow[]>(
    () =>
      (byMethod.data?.rows ?? []).map((row) => ({
        key: String(row.keys[0] ?? ""),
        label: row.labels[0] ?? String(row.keys[0] ?? ""),
        paymentsIn: displayMetric(row, "payments_in"),
        refundsOut: displayMetric(row, "refunds_out"),
        net: displayMetric(row, "net_collections"),
      })),
    [byMethod.data],
  );

  const columns = useMemo<ColumnDef<MethodRow>[]>(
    () => [
      {
        id: "method",
        header: t("salesReports.dims.payment_method"),
        accessor: (r) => r.label,
        pinStart: true,
        width: 160,
        sortable: true,
      },
      {
        id: "paymentsIn",
        header: t("salesReports.metrics.payments_in"),
        accessor: (r) => r.paymentsIn,
        cell: (r) => (r.paymentsIn == null ? "—" : formatCurrency(r.paymentsIn)),
        numeric: true,
        sortable: true,
      },
      {
        id: "refundsOut",
        header: t("salesReports.metrics.refunds_out"),
        accessor: (r) => r.refundsOut,
        cell: (r) => (r.refundsOut == null ? "—" : formatCurrency(r.refundsOut)),
        cellTone: (r) => (r.refundsOut != null && r.refundsOut > 0 ? "negative" : undefined),
        numeric: true,
        sortable: true,
      },
      {
        id: "net",
        header: t("salesReports.metrics.net_collections"),
        accessor: (r) => r.net,
        cell: (r) => (r.net == null ? "—" : formatCurrency(r.net)),
        numeric: true,
        sortable: true,
      },
    ],
    [t],
  );

  const isLoading = registry.isLoading || kpis.isLoading || byDayMethod.isLoading || byMethod.isLoading;
  const error = registry.error ?? kpis.error ?? byDayMethod.error ?? byMethod.error;

  if (isLoading) return <LoadingState rows={6} />;
  if (error) {
    return (
      <ErrorState
        error={error}
        title={t("salesReports.states.loadFailed")}
        onRetry={() => {
          void registry.refetch();
          void kpis.refetch();
          void byDayMethod.refetch();
          void byMethod.refetch();
        }}
      />
    );
  }
  if (methodRows.length === 0 && stackedDays.length === 0) {
    return <EmptyState title={t("salesReports.states.empty")} />;
  }

  const kpiCards = [
    { id: "payments_in", icon: HandCoins, tone: "teal" as const },
    { id: "refunds_out", icon: Undo2, tone: "rose" as const },
    { id: "net_collections", icon: Wallet, tone: "blue" as const },
    { id: "tips_total", icon: Coins, tone: "amber" as const },
  ];

  return (
    <section className="space-y-4" data-testid="page-payments">
      <CompletenessNotice meta={byMethod.data?.meta} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="kpi-row">
        {kpiCards.map(({ id, icon, tone }) => (
          <MetricCard
            key={id}
            label={t(`salesReports.metrics.${id}`)}
            value={kpiValue(kpis.data, kpiRow, id, formatCurrency)}
            icon={icon}
            tone={tone}
            explain={metricExplain(t, registry.data, id)}
          />
        ))}
      </div>

      <Suspense fallback={<Skeleton className="h-80" />}>
        <ChartKit>
          {({ R, ChartCard }) => (
            <ChartCard
              title={t("salesReports.metrics.payments_in")}
              subtitle={`${t("salesReports.dims.payment_method")} — ${t("salesReports.dims.business_day")}`}
              isEmpty={stackedDays.length === 0}
              emptyLabel={t("salesReports.charts.empty")}
              tableLabel={t("salesReports.charts.showTable")}
              tableCaption={`${t("salesReports.metrics.payments_in")} — ${t("salesReports.dims.payment_method")}`}
              tableColumns={[
                { key: "day", label: t("salesReports.dims.business_day") },
                ...methodSeries.map((s) => ({ key: s.key, label: s.label })),
              ]}
              tableRows={stackedDays.map((d) => {
                const row: Record<string, unknown> = { day: d.day };
                for (const s of methodSeries) {
                  const v = d[s.key];
                  row[s.key] = typeof v === "number" ? formatCurrency(v) : "—";
                }
                return row;
              })}
            >
              <R.BarChart data={stackedDays} margin={{ top: 8, left: 8, right: 8 }}>
                <R.CartesianGrid stroke={palette.grid} vertical={false} />
                <R.XAxis
                  dataKey="day"
                  reversed={rtl.xAxisReversed}
                  tick={{ fontSize: 11, fill: palette.axis }}
                  tickFormatter={(v: string) => String(v).slice(5)}
                />
                <R.YAxis tick={{ fontSize: 11, fill: palette.axis }} tickFormatter={rtl.tickFormatterNumber} width={64} />
                <R.Tooltip contentStyle={rtl.tooltipStyle} formatter={(value) => rtl.tickFormatterCurrency(value)} />
                <R.Legend />
                {methodSeries.map((s, i) => (
                  <R.Bar
                    key={s.key}
                    dataKey={s.key}
                    name={s.label}
                    stackId="in"
                    fill={palette.series[i % palette.series.length]}
                    radius={i === methodSeries.length - 1 ? [6, 6, 0, 0] : undefined}
                    cursor="pointer"
                    onClick={() => drillMethod(s.method)}
                  />
                ))}
              </R.BarChart>
            </ChartCard>
          )}
        </ChartKit>
      </Suspense>

      <DataTable<MethodRow>
        columns={columns}
        rows={methodRows}
        getRowId={(r) => r.key}
        initialSort={{ columnId: "paymentsIn", dir: "desc" }}
        onRowClick={(r) => drillMethod(r.key)}
        emptyTitle={t("salesReports.states.empty")}
      />
    </section>
  );
}
