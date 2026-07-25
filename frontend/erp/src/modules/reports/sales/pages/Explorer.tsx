// Sales Analytics Hub — "explorer" page.
//
// Free exploration over a CURATED primary dimension (`by` URL param, page-local
// codec — the shared filters.ts codec is untouched), an optional second
// dimension, a metric multi-pick (any registry metric), and a top/bottom-N
// control. Renders the API rows + subtotals in PivotTable and a bar chart of
// the top rows. Leaf row clicks drill: the clicked key becomes a shared-codec
// filter (wave 4 covers payment_method / hour / menu_item / cashier too) and
// `by` advances along the chain branch → business_day → hour → cashier → the
// orders segment (the cashier hand-off pins `cashierId` on the composed URL).
import { lazy, Suspense, useEffect, useMemo, useState, type ReactElement } from "react";
import { ArrowDownWideNarrow, ArrowUpWideNarrow, Coins, ShoppingBag, type LucideIcon } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Badge,
  EmptyState,
  ErrorState,
  ExplainNumber,
  LoadingState,
  MetricCard,
  MultiSelectCombobox,
  SegmentedControl,
  Select,
  Skeleton,
  type MetricTone,
} from "@/shared/ui";
import { useChartPalette } from "@/shared/charts/palette";
import { useChartsRtl } from "@/shared/charts/rtl";
import { useUrlFilters } from "@/shared/hooks/useUrlFilters";
import { computeCompareRange } from "@/shared/ui/date-range-picker";
import { formatCurrency, formatNumber } from "@/shared/lib";
import { useT, type TFunction } from "@/i18n";
import {
  analyticsFilterCodec,
  csvParam,
  makeCodec,
  stringParam,
  type AnalyticsFilters,
} from "../lib/filters";
import {
  buildFiltersBody,
  setPageExportRequest,
  type AnalyticsCompareSpec,
  type AnalyticsQueryBody,
  type AnalyticsRegistry,
  type AnalyticsResult,
} from "../lib/api";
import { useAnalyticsQuery, useAnalyticsRegistry } from "../lib/useAnalyticsQuery";
import { METRIC_CODES } from "../lib/registry-fixture";
import { PivotTable, type PivotMeasure } from "../components/PivotTable";
import type { FlatPivotRow } from "../lib/pivot";

const SEGMENT = "explorer";

/** Curated primary/secondary dimensions this wave. */
const EXPLORER_DIMS = [
  "branch",
  "business_day",
  "channel",
  "order_type",
  "payment_method",
  "cashier",
  "menu_item",
  "hour",
] as const;
type ExplorerDim = (typeof EXPLORER_DIMS)[number];

/** The drill chain; a leaf click on the LAST link navigates to orders. */
const DRILL_CHAIN: ExplorerDim[] = ["branch", "business_day", "hour", "cashier"];

const N_OPTIONS = ["10", "20", "50"] as const;

/** Page-local URL codec — coexists with the shared codec on the same URL. */
const explorerCodec = makeCodec({
  by: stringParam("branch"),
  second: stringParam(""),
  m: csvParam(["net_ex_vat", "orders"]),
  n: stringParam("10"),
  dir: stringParam("top"),
});

function asDim(raw: string, fallback: ExplorerDim = "branch"): ExplorerDim {
  return (EXPLORER_DIMS as readonly string[]).includes(raw) ? (raw as ExplorerDim) : fallback;
}

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

/** Merge extra params over the CURRENT search and render a hub segment URL. */
function segmentHref(search: string, segment: string, extra: Record<string, string>): string {
  const sp = new URLSearchParams(search);
  for (const [k, v] of Object.entries(extra)) sp.set(k, v);
  const qs = sp.toString();
  return `/reports/sales/${segment}${qs ? `?${qs}` : ""}`;
}

const fmtPercent = (v: number) => `${formatNumber(v)}%`;

/** registry format code → display formatter (percent values arrive ×100 already). */
function formatterFor(registry: AnalyticsRegistry | undefined, id: string): (v: number) => string {
  const format = registry?.metrics?.find?.((m) => m.id === id)?.format;
  if (format === "money") return formatCurrency;
  if (format === "percent") return fmtPercent;
  return formatNumber;
}

function totalValue(result: AnalyticsResult | undefined, id: string): number | null {
  if (!result || result.meta.maskedMetrics.includes(id)) return null;
  const v = result.totals?.[id];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const KPI_ICONS: LucideIcon[] = [Coins, ShoppingBag];
const KPI_TONES: MetricTone[] = ["teal", "violet", "blue", "amber"];

export default function Explorer() {
  const t = useT();
  const palette = useChartPalette();
  const rtl = useChartsRtl();
  const navigate = useNavigate();
  const location = useLocation();
  const { filters } = useUrlFilters(analyticsFilterCodec);
  const page = useUrlFilters(explorerCodec);
  const registry = useAnalyticsRegistry();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const by = asDim(page.filters.by);
  const second = page.filters.second === "" ? null : asDim(page.filters.second, "business_day");
  const metricIds = page.filters.m.length > 0 ? page.filters.m : ["net_ex_vat"];
  const topBottom = page.filters.dir === "bottom" ? "bottom" : "top";
  const limit = (N_OPTIONS as readonly string[]).includes(page.filters.n) ? Number(page.filters.n) : 10;

  const dims = second && second !== by ? [by, second] : [by];
  const sortMetric = metricIds[0];

  const base = buildFiltersBody(filters);
  const compare = compareSpec(filters);
  const body: AnalyticsQueryBody = {
    ...base,
    metrics: metricIds,
    dimensions: dims,
    sort: [{ by: sortMetric, dir: topBottom === "top" ? "desc" : "asc" }],
    limit,
    ...(compare ? { compare } : {}),
  };

  // Data queries wait for a VALID metric catalog: without one there is nothing
  // to label or explain, and a disabled query never fires a doomed request.
  const catalogReady = registry.data != null && Array.isArray(registry.data.metrics);
  const query = useAnalyticsQuery(SEGMENT, body, { enabled: catalogReady });

  // Export registration is DYNAMIC here (the shape follows the page-local URL
  // state), so it re-registers whenever the picked metrics/dimensions change.
  useEffect(() => {
    setPageExportRequest(SEGMENT, () => ({
      metrics: metricIds,
      dimensions: dims,
      sort: [{ by: sortMetric, dir: topBottom === "top" ? "desc" : "asc" }],
      limit,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metricIds.join("|"), dims.join("|"), sortMetric, topBottom, limit]);

  const metricOptions = useMemo(() => {
    const ids = registry.data?.metrics?.map?.((m) => m.id) ?? [...METRIC_CODES];
    return ids.map((id) => ({ value: id, label: t(`salesReports.metrics.${id}`) }));
  }, [registry.data, t]);

  const measures = useMemo<PivotMeasure[]>(
    () =>
      metricIds.map((id) => ({
        id,
        label: t(`salesReports.metrics.${id}`),
        format: formatterFor(registry.data, id),
      })),
    [metricIds, registry.data, t],
  );

  // Bar chart of the top rows for the PRIMARY dimension: single-dim results use
  // the rows directly; two-dim results prefer the API level-0 subtotals (a
  // derived metric is not client-summable).
  const chartRows = useMemo(() => {
    const result = query.data;
    if (!result) return [];
    const source =
      dims.length === 1
        ? result.rows
        : (result.subtotals ?? []).filter((r) => r.keys[0] != null && r.keys[1] == null);
    return source
      .map((row) => ({
        key: String(row.keys[0] ?? ""),
        label: row.labels[0] ?? String(row.keys[0] ?? ""),
        value: typeof row.values[sortMetric] === "number" ? (row.values[sortMetric] as number) : null,
      }))
      .filter((r) => r.value != null)
      .slice(0, limit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data, dims.join("|"), sortMetric, limit]);

  const dimOptions = EXPLORER_DIMS.map((d) => ({ value: d, label: t(`salesReports.dims.${d}`) }));
  const secondOptions = [
    { value: "", label: t("common.none") },
    ...dimOptions.filter((o) => o.value !== by),
  ];

  const drillLeaf = (row: FlatPivotRow) => {
    const key = String(row.keys[0] ?? "");
    if (key === "") return;
    // Chain end (cashier): hand off to the orders segment with the cashier
    // pinned — merged into the composed URL so it is ONE history push.
    if (by === "cashier") {
      navigate(segmentHref(location.search, "orders", { cashierId: key }));
      return;
    }
    // ONE composed navigation (E2E-wave fix): this used to be two back-to-back
    // patches — shared-codec patch({branchId...}) then page.patch({by...}) —
    // and react-router's setSearchParams resolves each functional update from
    // the location its own hook captured, so in one tick the SECOND call wrote
    // over the first: the drill advanced `by` but silently DROPPED the filter
    // it had just pinned. Merging both changes into one URL fixes the drill
    // and keeps it a single history entry the user can Back out of.
    const extra: Record<string, string> = {};
    if (by === "branch") extra.branchId = key;
    else if (by === "business_day") { extra.from = key; extra.to = key; extra.preset = "custom"; }
    else if (by === "channel") extra.channel = key;
    else if (by === "order_type") extra.orderType = key;
    else if (by === "payment_method") extra.paymentMethod = key;
    else if (by === "hour") extra.hour = key;
    else if (by === "menu_item") extra.menuItemId = key;
    // Advance `by` along the chain (dimensions outside the chain only pin).
    const at = DRILL_CHAIN.indexOf(by);
    if (at !== -1 && at < DRILL_CHAIN.length - 1) extra.by = DRILL_CHAIN[at + 1];
    navigate(segmentHref(location.search, "explorer", extra));
  };

  const onRowClick = (row: FlatPivotRow) => {
    if (row.isSubtotal) {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(row.key)) next.delete(row.key);
        else next.add(row.key);
        return next;
      });
      return;
    }
    drillLeaf(row);
  };

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

  const rows = query.data?.rows ?? [];

  const controls = (
    <div className="surface flex flex-wrap items-end gap-3 p-4" data-testid="explorer-controls">
      <label className="flex min-w-40 flex-col gap-1.5">
        <span className="text-xs font-extrabold text-slate-500">{t("salesReports.explorer.primaryDim")}</span>
        <Select
          value={by}
          onChange={(e) =>
            page.patch({ by: e.target.value, second: page.filters.second === e.target.value ? "" : page.filters.second })
          }
          options={dimOptions}
          aria-label={t("salesReports.explorer.primaryDim")}
        />
      </label>
      <label className="flex min-w-40 flex-col gap-1.5">
        <span className="text-xs font-extrabold text-slate-500">{t("salesReports.explorer.secondaryDim")}</span>
        <Select
          value={second ?? ""}
          onChange={(e) => page.patch({ second: e.target.value })}
          options={secondOptions}
          aria-label={t("salesReports.explorer.secondaryDim")}
        />
      </label>
      <div className="flex min-w-52 flex-col gap-1.5">
        <span className="text-xs font-extrabold text-slate-500">{t("salesReports.builder.metrics")}</span>
        <MultiSelectCombobox
          options={metricOptions}
          values={metricIds}
          onChange={(values) => page.patch({ m: values.length > 0 ? values : ["net_ex_vat"] })}
          ariaLabel={t("salesReports.builder.metrics")}
        />
      </div>
      <SegmentedControl
        size="sm"
        aria-label={`${t("salesReports.explorer.top")} / ${t("salesReports.explorer.bottom")}`}
        value={topBottom}
        onChange={(v) => page.patch({ dir: v })}
        options={[
          {
            value: "top",
            label: (
              <span className="inline-flex items-center">
                <ArrowUpWideNarrow className="h-4 w-4" aria-hidden="true" />
                <span className="sr-only">{t("salesReports.explorer.top")}</span>
              </span>
            ),
          },
          {
            value: "bottom",
            label: (
              <span className="inline-flex items-center">
                <ArrowDownWideNarrow className="h-4 w-4" aria-hidden="true" />
                <span className="sr-only">{t("salesReports.explorer.bottom")}</span>
              </span>
            ),
          },
        ]}
      />
      <SegmentedControl
        size="sm"
        aria-label={t("salesReports.explorer.topN")}
        value={String(limit)}
        onChange={(v) => page.patch({ n: v })}
        options={N_OPTIONS.map((n) => ({ value: n, label: formatNumber(Number(n)) }))}
      />
    </div>
  );

  if (rows.length === 0) {
    return (
      <section className="space-y-4" data-testid="page-explorer">
        {controls}
        <EmptyState title={t("salesReports.states.empty")} />
      </section>
    );
  }

  const kpiIds = metricIds.slice(0, 4);

  return (
    <section className="space-y-4" data-testid="page-explorer">
      <CompletenessNotice meta={query.data?.meta} />
      {controls}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="kpi-row">
        {kpiIds.map((id, i) => {
          const v = totalValue(query.data, id);
          return (
            <MetricCard
              key={id}
              label={t(`salesReports.metrics.${id}`)}
              value={v == null ? "—" : formatterFor(registry.data, id)(v)}
              icon={KPI_ICONS[i] ?? Coins}
              tone={KPI_TONES[i] ?? "teal"}
              explain={metricExplain(t, registry.data, id)}
            />
          );
        })}
      </div>

      <Suspense fallback={<Skeleton className="h-80" />}>
        <ChartKit>
          {({ R, ChartCard }) => (
            <ChartCard
              title={t(`salesReports.metrics.${sortMetric}`)}
              subtitle={t(`salesReports.dims.${by}`)}
              isEmpty={chartRows.length === 0}
              emptyLabel={t("salesReports.charts.empty")}
              tableLabel={t("salesReports.charts.showTable")}
              tableCaption={`${t(`salesReports.metrics.${sortMetric}`)} — ${t(`salesReports.dims.${by}`)}`}
              tableColumns={[
                { key: "label", label: t(`salesReports.dims.${by}`) },
                { key: "valueText", label: t(`salesReports.metrics.${sortMetric}`) },
              ]}
              tableRows={chartRows.map((r) => ({
                label: r.label,
                valueText: r.value == null ? "—" : formatterFor(registry.data, sortMetric)(r.value),
              }))}
            >
              <R.BarChart data={chartRows} margin={{ top: 8, left: 8, right: 8 }}>
                <R.CartesianGrid stroke={palette.grid} vertical={false} />
                <R.XAxis dataKey="label" reversed={rtl.xAxisReversed} tick={{ fontSize: 11, fill: palette.axis }} />
                <R.YAxis tick={{ fontSize: 11, fill: palette.axis }} tickFormatter={rtl.tickFormatterNumber} width={64} />
                <R.Tooltip contentStyle={rtl.tooltipStyle} formatter={(value) => rtl.tickFormatterNumber(value)} />
                <R.Bar dataKey="value" name={t(`salesReports.metrics.${sortMetric}`)} fill={palette.series[0]} radius={[6, 6, 0, 0]} />
              </R.BarChart>
            </ChartCard>
          )}
        </ChartKit>
      </Suspense>

      <PivotTable
        rows={rows}
        subtotals={query.data?.subtotals}
        rowDims={dims}
        rowDimLabels={dims.map((d) => t(`salesReports.dims.${d}`))}
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
        onRowClick={onRowClick}
      />
    </section>
  );
}
