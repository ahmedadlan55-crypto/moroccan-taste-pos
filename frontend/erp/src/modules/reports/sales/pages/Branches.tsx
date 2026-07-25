// Sales Analytics Hub — "branches" page.
//
// Brand → branch pivot (API subtotals win) over net / orders — plus the growth
// metric column when a compare mode is on — and a grouped current-vs-compare
// bar per branch. A BRANCH (leaf) row click drills OUT: it navigates to the
// explorer segment with branchId set and by=business_day, preserving every
// current filter param (the navigate itself is the history push). Brand rows
// toggle their group.
import { lazy, Suspense, useMemo, useState, type ReactElement } from "react";
import { Coins, ShoppingBag } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { Badge, EmptyState, ErrorState, ExplainNumber, LoadingState, MetricCard, Skeleton } from "@/shared/ui";
import { useChartPalette } from "@/shared/charts/palette";
import { useChartsRtl } from "@/shared/charts/rtl";
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
import { PivotTable, type PivotMeasure } from "../components/PivotTable";
import type { FlatPivotRow } from "../lib/pivot";

const SEGMENT = "branches";
const DIMS = ["brand", "branch"] as const;

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

/** Merge extra params over the CURRENT search and render a hub segment URL. */
function segmentHref(search: string, segment: string, extra: Record<string, string>): string {
  const sp = new URLSearchParams(search);
  for (const [k, v] of Object.entries(extra)) sp.set(k, v);
  const qs = sp.toString();
  return `/reports/sales/${segment}${qs ? `?${qs}` : ""}`;
}

const fmtPercent = (v: number) => `${formatNumber(v)}%`;

export default function Branches() {
  const t = useT();
  const palette = useChartPalette();
  const rtl = useChartsRtl();
  const navigate = useNavigate();
  const location = useLocation();
  const { filters } = useUrlFilters(analyticsFilterCodec);
  const registry = useAnalyticsRegistry();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const hasCompare = filters.compare !== "none";
  // E2E-wave fix: `growth` is a PARAMETERIZED registry metric — requesting it
  // plainly is a planner VALIDATION_ERROR (422), so with a compare mode on
  // this page errored on load. The growth column now derives client-side from
  // the compare envelope's per-row delta (see pivotRows below).
  const metricIds = ["net_ex_vat", "orders"];

  const base = buildFiltersBody(filters);
  const compare = compareSpec(filters);
  const body: AnalyticsQueryBody = {
    ...base,
    metrics: metricIds,
    dimensions: [...DIMS],
    sort: [{ by: "net_ex_vat", dir: "desc" }],
    ...(compare ? { compare } : {}),
  };

  // Data queries wait for a VALID metric catalog: without one there is nothing
  // to label or explain, and a disabled query never fires a doomed request.
  const catalogReady = registry.data != null && Array.isArray(registry.data.metrics);
  const query = useAnalyticsQuery(SEGMENT, body, { enabled: catalogReady });

  const branchBars = useMemo(
    () =>
      (query.data?.rows ?? [])
        .map((row) => ({
          key: String(row.keys[1] ?? ""),
          label: row.labels[1] ?? String(row.keys[1] ?? ""),
          net: displayMetric(row, "net_ex_vat"),
          compareNet: typeof row.compare?.net_ex_vat === "number" ? row.compare.net_ex_vat : null,
        }))
        .filter((r) => r.net != null || r.compareNet != null),
    [query.data],
  );

  const measures = useMemo<PivotMeasure[]>(() => {
    const list: PivotMeasure[] = [
      { id: "net_ex_vat", label: t("salesReports.metrics.net_ex_vat"), format: formatCurrency },
      { id: "orders", label: t("salesReports.metrics.orders"), format: formatNumber },
    ];
    if (hasCompare) {
      list.push({ id: "growth", label: t("salesReports.metrics.growth"), format: fmtPercent });
    }
    return list;
  }, [t, hasCompare]);

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

  const srcRows = query.data?.rows ?? [];
  if (srcRows.length === 0) return <EmptyState title={t("salesReports.states.empty")} />;
  // Client-derived growth column (see metricIds note): the compare envelope
  // already carries the per-row growth % as delta.net_ex_vat.
  const rows = hasCompare
    ? srcRows.map((r) => ({
        ...r,
        values: {
          ...r.values,
          growth: typeof r.delta?.net_ex_vat === "number" ? r.delta.net_ex_vat : null,
        },
      }))
    : srcRows;

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const onRowClick = (row: FlatPivotRow) => {
    if (row.isSubtotal) {
      toggle(row.key);
      return;
    }
    // Leaf = branch: drill to the explorer segment scoped to this branch, by
    // business day, keeping every current filter param.
    const branchKey = String(row.keys[1] ?? "");
    if (branchKey === "") return;
    navigate(segmentHref(location.search, "explorer", { branchId: branchKey, by: "business_day" }));
  };

  const kpis = [
    { id: "net_ex_vat", icon: Coins, tone: "teal" as const, format: formatCurrency },
    { id: "orders", icon: ShoppingBag, tone: "violet" as const, format: formatNumber },
  ];

  return (
    <section className="space-y-4" data-testid="page-branches">
      <CompletenessNotice meta={query.data?.meta} />

      <div className="grid gap-4 sm:grid-cols-2" data-testid="kpi-row">
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
              subtitle={t("salesReports.dims.branch")}
              isEmpty={branchBars.length === 0}
              emptyLabel={t("salesReports.charts.empty")}
              tableLabel={t("salesReports.charts.showTable")}
              tableCaption={`${t("salesReports.metrics.net_ex_vat")} — ${t("salesReports.dims.branch")}`}
              tableColumns={[
                { key: "label", label: t("salesReports.dims.branch") },
                { key: "netText", label: t("salesReports.metrics.net_ex_vat") },
                ...(hasCompare ? [{ key: "compareText", label: t("salesReports.topbar.compare") }] : []),
              ]}
              tableRows={branchBars.map((r) => ({
                label: r.label,
                netText: r.net == null ? "—" : formatCurrency(r.net),
                compareText: r.compareNet == null ? "—" : formatCurrency(r.compareNet),
              }))}
            >
              <R.BarChart data={branchBars} margin={{ top: 8, left: 8, right: 8 }}>
                <R.CartesianGrid stroke={palette.grid} vertical={false} />
                <R.XAxis dataKey="label" reversed={rtl.xAxisReversed} tick={{ fontSize: 11, fill: palette.axis }} />
                <R.YAxis tick={{ fontSize: 11, fill: palette.axis }} tickFormatter={rtl.tickFormatterNumber} width={64} />
                <R.Tooltip contentStyle={rtl.tooltipStyle} formatter={(value) => rtl.tickFormatterCurrency(value)} />
                {hasCompare && <R.Legend />}
                <R.Bar dataKey="net" name={t("salesReports.metrics.net_ex_vat")} fill={palette.series[0]} radius={[6, 6, 0, 0]} />
                {hasCompare && (
                  <R.Bar
                    dataKey="compareNet"
                    name={t("salesReports.topbar.compare")}
                    fill={palette.series[2]}
                    radius={[6, 6, 0, 0]}
                  />
                )}
              </R.BarChart>
            </ChartCard>
          )}
        </ChartKit>
      </Suspense>

      <PivotTable
        rows={rows}
        subtotals={query.data?.subtotals}
        rowDims={[...DIMS]}
        rowDimLabels={DIMS.map((d) => t(`salesReports.dims.${d}`))}
        measures={measures}
        expanded={expanded}
        onToggle={toggle}
        onRowClick={onRowClick}
      />
    </section>
  );
}
