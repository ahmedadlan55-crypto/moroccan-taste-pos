// Sales Analytics Hub — "modifiers" page.
//
// Modifier performance by modifier_kind: quantity, avg modifiers per item and
// attach rate. The historical-completeness notice renders PROMINENTLY (above
// the KPI row): historical rows carry combo choices only and price_delta is
// null historically, so meta.completeness drives the
// states.notAvailableHistorically banner.
import { lazy, Suspense, useMemo, type ReactElement } from "react";
import { Layers, Percent, Sigma } from "lucide-react";
import { Badge, EmptyState, ErrorState, ExplainNumber, LoadingState, MetricCard, Skeleton } from "@/shared/ui";
import { useChartPalette } from "@/shared/charts/palette";
import { useChartsRtl } from "@/shared/charts/rtl";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { useUrlFilters } from "@/shared/hooks/useUrlFilters";
import { computeCompareRange } from "@/shared/ui/date-range-picker";
import { formatNumber } from "@/shared/lib";
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

const SEGMENT = "modifiers";
const METRICS = ["modifier_qty", "modifiers_per_item", "attach_rate"] as const;
/** The one modifier dimension in the registry: modifier_kind (m.kind). */
const DIMS = ["modifier_kind"] as const;

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

interface KindRow {
  key: string;
  label: string;
  qty: number | null;
  perItem: number | null;
  attach: number | null;
}

export default function Modifiers() {
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
    dimensions: [...DIMS],
    sort: [{ by: "modifier_qty", dir: "desc" }],
    ...(compare ? { compare } : {}),
  };

  // Data queries wait for a VALID metric catalog: without one there is nothing
  // to label or explain, and a disabled query never fires a doomed request.
  const catalogReady = registry.data != null && Array.isArray(registry.data.metrics);
  const query = useAnalyticsQuery(SEGMENT, body, { enabled: catalogReady });

  const kindRows = useMemo<KindRow[]>(
    () =>
      (query.data?.rows ?? []).map((row) => ({
        key: String(row.keys[0] ?? ""),
        label: row.labels[0] ?? String(row.keys[0] ?? ""),
        qty: displayMetric(row, "modifier_qty"),
        perItem: displayMetric(row, "modifiers_per_item"),
        attach: displayMetric(row, "attach_rate"),
      })),
    [query.data],
  );

  const columns = useMemo<ColumnDef<KindRow>[]>(
    () => [
      {
        id: "kind",
        header: t("salesReports.dims.modifier_kind"),
        accessor: (r) => r.label,
        pinStart: true,
        width: 160,
        sortable: true,
      },
      {
        id: "qty",
        header: t("salesReports.metrics.modifier_qty"),
        accessor: (r) => r.qty,
        cell: (r) => (r.qty == null ? "—" : formatNumber(r.qty)),
        numeric: true,
        sortable: true,
      },
      {
        id: "perItem",
        header: t("salesReports.metrics.modifiers_per_item"),
        accessor: (r) => r.perItem,
        cell: (r) => (r.perItem == null ? "—" : formatNumber(r.perItem)),
        numeric: true,
        sortable: true,
      },
      {
        id: "attach",
        header: t("salesReports.metrics.attach_rate"),
        accessor: (r) => r.attach,
        cell: (r) => (r.attach == null ? "—" : fmtPercent(r.attach)),
        numeric: true,
        sortable: true,
      },
    ],
    [t],
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
  if (kindRows.length === 0) return <EmptyState title={t("salesReports.states.empty")} />;

  const kpis = [
    { id: "modifier_qty", icon: Layers, tone: "teal" as const, format: formatNumber },
    { id: "modifiers_per_item", icon: Sigma, tone: "blue" as const, format: formatNumber },
    { id: "attach_rate", icon: Percent, tone: "amber" as const, format: fmtPercent },
  ];

  return (
    <section className="space-y-4" data-testid="page-modifiers">
      {/* Prominent: modifier history = combo choices only; price_delta null historically. */}
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
              title={t("salesReports.metrics.modifier_qty")}
              subtitle={t("salesReports.dims.modifier_kind")}
              isEmpty={kindRows.every((r) => r.qty == null)}
              emptyLabel={t("inventoryRest.analytics.chartEmpty")}
              tableLabel={t("inventoryRest.analytics.showTable")}
              tableCaption={`${t("salesReports.metrics.modifier_qty")} — ${t("salesReports.dims.modifier_kind")}`}
              tableColumns={[
                { key: "label", label: t("salesReports.dims.modifier_kind") },
                { key: "qtyText", label: t("salesReports.metrics.modifier_qty") },
                { key: "attachText", label: t("salesReports.metrics.attach_rate") },
              ]}
              tableRows={kindRows.map((r) => ({
                label: r.label,
                qtyText: r.qty == null ? "—" : formatNumber(r.qty),
                attachText: r.attach == null ? "—" : fmtPercent(r.attach),
              }))}
            >
              <R.BarChart data={kindRows} margin={{ top: 8, left: 8, right: 8 }}>
                <R.CartesianGrid stroke={palette.grid} vertical={false} />
                <R.XAxis dataKey="label" reversed={rtl.xAxisReversed} tick={{ fontSize: 11, fill: palette.axis }} />
                <R.YAxis tick={{ fontSize: 11, fill: palette.axis }} tickFormatter={rtl.tickFormatterNumber} width={64} />
                <R.Tooltip contentStyle={rtl.tooltipStyle} formatter={(value) => rtl.tickFormatterNumber(value)} />
                <R.Bar dataKey="qty" name={t("salesReports.metrics.modifier_qty")} fill={palette.series[0]} radius={[6, 6, 0, 0]} />
              </R.BarChart>
            </ChartCard>
          )}
        </ChartKit>
      </Suspense>

      <DataTable<KindRow>
        columns={columns}
        rows={kindRows}
        getRowId={(r) => r.key}
        initialSort={{ columnId: "qty", dir: "desc" }}
        emptyTitle={t("salesReports.states.empty")}
      />
    </section>
  );
}
