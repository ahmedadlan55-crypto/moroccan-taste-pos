// Sales Analytics Hub — "cashiers" page (hub-gated: analytics.employees.view).
//
// One per-cashier query drives everything: the KPI row (orders / net / avg
// ticket from the query totals), a per-cashier table whose discount/void/return
// rate cells carry the warning cellTone above the CLIENT-SIDE P75 of the
// column, and a top-cashiers-by-net bar chart.
import { lazy, Suspense, useMemo, type ReactElement } from "react";
import { Coins, ShoppingBag, Ticket } from "lucide-react";
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
  type AnalyticsCompareSpec,
  type AnalyticsQueryBody,
  type AnalyticsRegistry,
  type AnalyticsResult,
} from "../lib/api";
import { useAnalyticsQuery, useAnalyticsRegistry } from "../lib/useAnalyticsQuery";

const SEGMENT = "cashiers";
const METRICS = [
  "orders",
  "net_ex_vat",
  "avg_ticket",
  "discount_rate_by_cashier",
  "void_rate_by_cashier",
  "return_rate_by_cashier",
] as const;
const TOP_N = 10;

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

function totalValue(result: AnalyticsResult | undefined, id: string): number | null {
  if (!result || result.meta.maskedMetrics.includes(id)) return null;
  const v = result.totals?.[id];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const fmtPercent = (v: number) => `${formatNumber(v)}%`;

/** Client-side P75 (linear index method) over the non-null values. */
function p75(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
  if (nums.length < 2) return null;
  return nums[Math.floor(0.75 * (nums.length - 1))];
}

interface CashierRow {
  key: string;
  label: string;
  orders: number | null;
  net: number | null;
  avgTicket: number | null;
  discountRate: number | null;
  voidRate: number | null;
  returnRate: number | null;
}

export default function Cashiers() {
  const t = useT();
  const palette = useChartPalette();
  const rtl = useChartsRtl();
  const { filters } = useUrlFilters(analyticsFilterCodec);
  const registry = useAnalyticsRegistry();

  const base = buildFiltersBody(filters);
  const compare = compareSpec(filters);
  const body: AnalyticsQueryBody = {
    ...base,
    metrics: [...METRICS],
    dimensions: ["cashier"],
    sort: [{ by: "net_ex_vat", dir: "desc" }],
    ...(compare ? { compare } : {}),
  };

  // Data queries wait for a VALID metric catalog: without one there is nothing
  // to label or explain, and a disabled query never fires a doomed request.
  const catalogReady = registry.data != null && Array.isArray(registry.data.metrics);
  const query = useAnalyticsQuery(SEGMENT, body, { enabled: catalogReady });

  const cashierRows = useMemo<CashierRow[]>(
    () =>
      (query.data?.rows ?? []).map((row) => ({
        key: String(row.keys[0] ?? ""),
        label: row.labels[0] ?? String(row.keys[0] ?? ""),
        orders: displayMetric(row, "orders"),
        net: displayMetric(row, "net_ex_vat"),
        avgTicket: displayMetric(row, "avg_ticket"),
        discountRate: displayMetric(row, "discount_rate_by_cashier"),
        voidRate: displayMetric(row, "void_rate_by_cashier"),
        returnRate: displayMetric(row, "return_rate_by_cashier"),
      })),
    [query.data],
  );

  const thresholds = useMemo(
    () => ({
      discountRate: p75(cashierRows.map((r) => r.discountRate)),
      voidRate: p75(cashierRows.map((r) => r.voidRate)),
      returnRate: p75(cashierRows.map((r) => r.returnRate)),
    }),
    [cashierRows],
  );

  const columns = useMemo<ColumnDef<CashierRow>[]>(() => {
    const warnTone =
      (pick: (r: CashierRow) => number | null, threshold: number | null) =>
      (r: CashierRow): "warning" | undefined => {
        const v = pick(r);
        return threshold != null && v != null && v > threshold ? "warning" : undefined;
      };
    return [
      {
        id: "cashier",
        header: t("salesReports.dims.cashier"),
        accessor: (r) => r.label,
        pinStart: true,
        width: 160,
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
        id: "discountRate",
        header: t("salesReports.metrics.discount_rate_by_cashier"),
        accessor: (r) => r.discountRate,
        cell: (r) => (r.discountRate == null ? "—" : fmtPercent(r.discountRate)),
        cellTone: warnTone((r) => r.discountRate, thresholds.discountRate),
        numeric: true,
        sortable: true,
      },
      {
        id: "voidRate",
        header: t("salesReports.metrics.void_rate_by_cashier"),
        accessor: (r) => r.voidRate,
        cell: (r) => (r.voidRate == null ? "—" : fmtPercent(r.voidRate)),
        cellTone: warnTone((r) => r.voidRate, thresholds.voidRate),
        numeric: true,
        sortable: true,
      },
      {
        id: "returnRate",
        header: t("salesReports.metrics.return_rate_by_cashier"),
        accessor: (r) => r.returnRate,
        cell: (r) => (r.returnRate == null ? "—" : fmtPercent(r.returnRate)),
        cellTone: warnTone((r) => r.returnRate, thresholds.returnRate),
        numeric: true,
        sortable: true,
      },
    ];
  }, [t, thresholds]);

  const topCashiers = useMemo(
    () =>
      cashierRows
        .filter((r) => r.net != null)
        .slice()
        .sort((a, b) => (b.net as number) - (a.net as number))
        .slice(0, TOP_N),
    [cashierRows],
  );

  if (registry.isLoading || query.isLoading) return <LoadingState rows={6} />;
  const loadError = registry.error ?? query.error;
  if (loadError) {
    return (
      <ErrorState
        error={loadError}
        title={t("salesReports.states.loadFailed")}
        onRetry={() => {
          void registry.refetch();
          void query.refetch();
        }}
      />
    );
  }
  if (cashierRows.length === 0) return <EmptyState title={t("salesReports.states.empty")} />;

  const kpis = [
    { id: "orders", icon: ShoppingBag, tone: "violet" as const, format: formatNumber },
    { id: "net_ex_vat", icon: Coins, tone: "teal" as const, format: formatCurrency },
    { id: "avg_ticket", icon: Ticket, tone: "amber" as const, format: formatCurrency },
  ];

  return (
    <section className="space-y-4" data-testid="page-cashiers">
      <CompletenessNotice meta={query.data?.meta} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="kpi-row">
        {kpis.map(({ id, icon, tone, format }) => {
          const v = totalValue(query.data, id);
          return (
            <MetricCard
              key={id}
              label={t(`salesReports.metrics.${id}`)}
              value={v == null ? "—" : format(v)}
              icon={icon}
              tone={tone}
              explain={metricExplain(t, registry.data, id)}
            />
          );
        })}
      </div>

      <Suspense fallback={<Skeleton className="h-80" />}>
        <ChartKit>
          {({ R, ChartCard }) => (
            <ChartCard
              title={t("salesReports.metrics.net_ex_vat")}
              subtitle={t("salesReports.dims.cashier")}
              isEmpty={topCashiers.length === 0}
              emptyLabel={t("inventoryRest.analytics.chartEmpty")}
              tableLabel={t("inventoryRest.analytics.showTable")}
              tableCaption={`${t("salesReports.metrics.net_ex_vat")} — ${t("salesReports.dims.cashier")}`}
              tableColumns={[
                { key: "label", label: t("salesReports.dims.cashier") },
                { key: "netText", label: t("salesReports.metrics.net_ex_vat") },
              ]}
              tableRows={topCashiers.map((r) => ({
                label: r.label,
                netText: r.net == null ? "—" : formatCurrency(r.net),
              }))}
            >
              <R.BarChart data={topCashiers} margin={{ top: 8, left: 8, right: 8 }}>
                <R.CartesianGrid stroke={palette.grid} vertical={false} />
                <R.XAxis dataKey="label" reversed={rtl.xAxisReversed} tick={{ fontSize: 11, fill: palette.axis }} />
                <R.YAxis tick={{ fontSize: 11, fill: palette.axis }} tickFormatter={rtl.tickFormatterNumber} width={64} />
                <R.Tooltip contentStyle={rtl.tooltipStyle} formatter={(value) => rtl.tickFormatterCurrency(value)} />
                <R.Bar dataKey="net" name={t("salesReports.metrics.net_ex_vat")} fill={palette.series[0]} radius={[6, 6, 0, 0]} />
              </R.BarChart>
            </ChartCard>
          )}
        </ChartKit>
      </Suspense>

      <DataTable<CashierRow>
        columns={columns}
        rows={cashierRows}
        getRowId={(r) => r.key}
        initialSort={{ columnId: "net", dir: "desc" }}
        emptyTitle={t("salesReports.states.empty")}
      />
    </section>
  );
}
