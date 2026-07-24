// Sales Analytics Hub — "builder" page (v1 custom report).
//
// Pick metrics (registry-driven, already cap-filtered server-side), a primary
// and optional secondary dimension, top/bottom-N + sort, then RUN — the query
// fires only for the exact configuration that was run (editing anything
// re-arms the Run button instead of auto-refetching). Results render in the
// shared PivotTable with an optional bar-chart toggle.
//
// The builder config persists in PAGE-LOCAL URL params (b_m CSV, b_d1, b_d2,
// b_n) read/written directly via useSearchParams — the shared analytics codec
// (filters.ts) is untouched and its keys coexist on the same URL.
//
// TODO(sales-hub): save-view + schedule wiring lands next wave — the buttons
// render disabled with a "coming soon" tooltip until then.
import { useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, Tooltip as RechartsTooltip, XAxis, YAxis } from "recharts";
import { BarChart3, CalendarClock, Play, Save } from "lucide-react";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  MultiSelectCombobox,
  NumberInput,
  SegmentedControl,
  Select,
  Toggle,
  Tooltip,
  type MultiSelectOption,
} from "@/shared/ui";
import { ChartCard, useChartPalette, useChartsRtl } from "@/shared/charts";
import { formatCurrency, formatNumber } from "@/shared/lib";
import { useT } from "@/i18n";
import { useUrlFilters } from "@/shared/hooks/useUrlFilters";
import { analyticsFilterCodec } from "../lib/filters";
import { buildFiltersBody, stableStringify, type AnalyticsQueryBody } from "../lib/api";
import { useAnalyticsQuery, useAnalyticsRegistry } from "../lib/useAnalyticsQuery";
import { PivotTable, type PivotMeasure } from "../components/PivotTable";
import { buildTree } from "../lib/pivot";

/** Page-local URL params (NOT part of the shared analytics codec). */
const P_METRICS = "b_m";
const P_DIM1 = "b_d1";
const P_DIM2 = "b_d2";
const P_N = "b_n";

const DEFAULT_DIM = "business_day";
const DEFAULT_N = 10;
const NONE = "";

/** registry format → display formatter (percent values arrive as 0–100 points). */
function formatterFor(format: string): (v: number) => string {
  if (format === "money") return formatCurrency;
  if (format === "percent") return (v) => `${formatNumber(v)}%`;
  return formatNumber;
}

export default function Builder() {
  const t = useT();
  const { filters } = useUrlFilters(analyticsFilterCodec);
  const [searchParams, setSearchParams] = useSearchParams();
  const palette = useChartPalette();
  const rtl = useChartsRtl();
  const registry = useAnalyticsRegistry();

  // ── config (URL-backed) ──
  const metricIds = useMemo(
    () => (searchParams.get(P_METRICS) ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    [searchParams],
  );
  const dim1 = searchParams.get(P_DIM1) || DEFAULT_DIM;
  const dim2 = searchParams.get(P_DIM2) || NONE;
  const topN = Math.max(1, Number(searchParams.get(P_N)) || DEFAULT_N);

  const patchParam = (key: string, value: string | null) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value == null || value === "") next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );
  };

  // ── config (local: sort) ──
  const [sortMetric, setSortMetric] = useState<string>(NONE);
  const [direction, setDirection] = useState<"top" | "bottom">("top");

  const effectiveSort = sortMetric && metricIds.includes(sortMetric) ? sortMetric : metricIds[0] ?? NONE;

  const knownMetrics = registry.data?.metrics ?? [];
  const knownDims = (registry.data?.dimensions ?? []).filter((d) => d.groupable);

  const metricOptions: MultiSelectOption[] = knownMetrics.map((m) => ({
    value: m.id,
    label: t(`salesReports.metrics.${m.id}`),
  }));
  const dimOptions = knownDims.map((d) => ({ value: d.id, label: t(`salesReports.dims.${d.id}`) }));

  const dimensions = useMemo(() => (dim2 && dim2 !== dim1 ? [dim1, dim2] : [dim1]), [dim1, dim2]);

  const body = useMemo<AnalyticsQueryBody>(
    () => ({
      metrics: metricIds,
      dimensions,
      ...buildFiltersBody(filters),
      ...(effectiveSort ? { sort: [{ by: effectiveSort, dir: direction === "top" ? "desc" : "asc" }] } : {}),
      limit: topN,
    }),
    [metricIds, dimensions, filters, effectiveSort, direction, topN],
  );

  // Run-gating: the query is enabled ONLY while the current config matches the
  // config that was last run — any edit re-arms the Run button (no auto-fire).
  const configSig = stableStringify(body);
  const [ranSig, setRanSig] = useState<string | null>(null);
  const canRun = metricIds.length > 0 && dimensions.length > 0;
  const enabled = canRun && ranSig === configSig;

  const result = useAnalyticsQuery("builder", body, { enabled });

  const [showChart, setShowChart] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const measures: PivotMeasure[] = metricIds.map((id) => {
    const reg = knownMetrics.find((m) => m.id === id);
    return { id, label: t(`salesReports.metrics.${id}`), format: formatterFor(reg?.format ?? "count") };
  });

  const rows = result.data?.rows ?? [];
  const chartMetric = effectiveSort || metricIds[0] || "";
  // Top-level aggregation for the bar chart (level-0 subtotals when 2 dims).
  const chartRows = useMemo(() => {
    if (!chartMetric || rows.length === 0) return [];
    return buildTree(rows, dimensions, [chartMetric], result.data?.subtotals).map((node) => ({
      label: node.labels[0] ?? "—",
      value: node.values[chartMetric] ?? null,
    }));
  }, [rows, dimensions, chartMetric, result.data?.subtotals]);
  const chartFmt = formatterFor(knownMetrics.find((m) => m.id === chartMetric)?.format ?? "count");

  const field = (label: string, control: ReactNode) => (
    <div className="flex min-w-44 flex-col gap-1.5">
      <span className="text-xs font-extrabold text-slate-500">{label}</span>
      {control}
    </div>
  );

  return (
    <section aria-labelledby="sales-hub-page-builder" className="space-y-4">
      <div>
        <h2 id="sales-hub-page-builder" className="text-lg font-extrabold text-slate-900">
          {t("salesReports.pages.builder.title")}
        </h2>
        <p className="mt-0.5 text-sm font-medium text-slate-500">{t("salesReports.pages.builder.subtitle")}</p>
      </div>

      {/* ── config panel ── */}
      <div className="surface space-y-3 p-4" data-testid="builder-config">
        <div className="flex flex-wrap items-end gap-3">
          {field(
            t("salesReports.builder.metrics"),
            <MultiSelectCombobox
              options={metricOptions}
              values={metricIds}
              onChange={(values) => patchParam(P_METRICS, values.join(","))}
              ariaLabel={t("salesReports.builder.metrics")}
            />,
          )}
          {field(
            t("salesReports.builder.dimensions"),
            <Select
              aria-label={t("salesReports.builder.dimensions")}
              value={dim1}
              onChange={(e) => patchParam(P_DIM1, e.target.value)}
              options={dimOptions}
            />,
          )}
          {field(
            `${t("salesReports.builder.dimensions")} 2`,
            <Select
              aria-label={`${t("salesReports.builder.dimensions")} 2`}
              value={dim2}
              onChange={(e) => patchParam(P_DIM2, e.target.value || null)}
              options={[{ value: NONE, label: "—" }, ...dimOptions.filter((d) => d.value !== dim1)]}
            />,
          )}
          {field(
            "N",
            <NumberInput
              aria-label="N"
              value={topN}
              min={1}
              max={500}
              step={1}
              onChange={(v) => patchParam(P_N, v == null ? null : String(Math.max(1, Math.floor(v))))}
            />,
          )}
          {field(
            t("salesReports.builder.sort"),
            <div className="flex items-center gap-2">
              <SegmentedControl
                size="sm"
                aria-label={t("salesReports.builder.sort")}
                value={direction}
                onChange={setDirection}
                options={[
                  { value: "top", label: "↑" },
                  { value: "bottom", label: "↓" },
                ]}
              />
              <Select
                aria-label={t("salesReports.builder.sort")}
                value={effectiveSort}
                onChange={(e) => setSortMetric(e.target.value)}
                options={metricIds.map((id) => ({ value: id, label: t(`salesReports.metrics.${id}`) }))}
              />
            </div>,
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => setRanSig(configSig)} disabled={!canRun} data-testid="builder-run">
            <Play className="h-4 w-4" /> {t("salesReports.builder.runQuery")}
          </Button>
          {/* Save-view / schedule: wiring lands next wave (TODO above). */}
          <Tooltip content={t("salesReports.builder.comingSoon")}>
            <Button variant="secondary" disabled data-testid="builder-save">
              <Save className="h-4 w-4" /> {t("salesReports.builder.saveReport")}
            </Button>
          </Tooltip>
          <Tooltip content={t("salesReports.builder.comingSoon")}>
            <Button variant="secondary" disabled data-testid="builder-schedule">
              <CalendarClock className="h-4 w-4" /> {t("salesReports.builder.schedule")}
            </Button>
          </Tooltip>
          {enabled && rows.length > 0 && chartMetric && (
            <div className="ms-auto">
              {/* Optional bar chart of the sort metric by the primary dimension. */}
              <Toggle
                checked={showChart}
                onChange={setShowChart}
                aria-label={t("salesReports.builder.showChart")}
                label={
                  <span className="inline-flex items-center gap-1.5">
                    <BarChart3 className="h-4 w-4 text-slate-500" aria-hidden="true" />
                    {t("salesReports.builder.showChart")}
                  </span>
                }
              />
            </div>
          )}
        </div>
      </div>

      {/* ── result ── */}
      {!enabled ? (
        <EmptyState title={t("salesReports.builder.runQuery")} body={t("salesReports.pages.builder.subtitle")} />
      ) : result.isPending ? (
        <LoadingState />
      ) : result.isError ? (
        <ErrorState error={result.error} onRetry={() => result.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title={t("salesReports.states.empty")} />
      ) : (
        <>
          {result.data?.meta?.completeness?.complete === false && (
            <div data-testid="completeness-notice">
              <Badge tone="warning">{t("salesReports.states.notAvailableHistorically")}</Badge>
            </div>
          )}
          {showChart && chartRows.length > 0 && (
            <ChartCard
              title={t(`salesReports.metrics.${chartMetric}`)}
              tableLabel={t(`salesReports.dims.${dim1}`)}
              tableColumns={[
                { key: "label", label: t(`salesReports.dims.${dim1}`) },
                { key: "value", label: t(`salesReports.metrics.${chartMetric}`) },
              ]}
              tableRows={chartRows.map((r) => ({
                label: r.label,
                value: r.value == null ? "—" : chartFmt(r.value),
              }))}
            >
              <BarChart data={chartRows}>
                <CartesianGrid stroke={palette.grid} vertical={false} />
                <XAxis dataKey="label" reversed={rtl.xAxisReversed} stroke={palette.axis} tick={{ fontSize: 11 }} />
                <YAxis orientation={rtl.dir === "rtl" ? "right" : "left"} stroke={palette.axis} tickFormatter={rtl.tickFormatterNumber} tick={{ fontSize: 11 }} />
                <RechartsTooltip contentStyle={rtl.tooltipStyle} formatter={(v) => rtl.tickFormatterNumber(v)} />
                <Bar dataKey="value" name={t(`salesReports.metrics.${chartMetric}`)} fill={palette.series[0]} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ChartCard>
          )}
          <PivotTable
            rows={rows}
            subtotals={result.data?.subtotals}
            rowDims={dimensions}
            rowDimLabels={dimensions.map((d) => t(`salesReports.dims.${d}`))}
            measures={measures}
            expanded={expanded}
            onToggle={(key) =>
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              })
            }
          />
        </>
      )}
    </section>
  );
}
