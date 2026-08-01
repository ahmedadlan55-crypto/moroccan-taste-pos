// Sales Analytics Hub — "builder" page (v1 custom report).
//
// Pick metrics (registry-driven, already cap-filtered server-side), a primary
// and optional secondary dimension, top/bottom-N + sort, then RUN — the query
// fires only for the exact configuration that was run (editing anything
// re-arms the Run button instead of auto-refetching). Results render in the
// shared PivotTable — reports are decision tables; charts live on the dashboard.
//
// The builder config persists in PAGE-LOCAL URL params (b_m CSV, b_d1, b_d2,
// b_n) read/written directly via useSearchParams — the shared analytics codec
// (filters.ts) is untouched and its keys coexist on the same URL.
//
// TODO(sales-hub): save-view + schedule wiring lands next wave — the buttons
// render disabled with a "coming soon" tooltip until then.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { CalendarClock, Play, Save, SlidersHorizontal, Table2 } from "lucide-react";
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
  Tooltip,
  type MultiSelectOption,
} from "@/shared/ui";
import { formatCurrency, formatNumber } from "@/shared/lib";
import { useT } from "@/i18n";
import { useUrlFilters } from "@/shared/hooks/useUrlFilters";
import { analyticsFilterCodec } from "../lib/filters";
import {
  buildFiltersBody,
  setPageExportRequest,
  stableStringify,
  type AnalyticsQueryBody,
} from "../lib/api";
import { useAnalyticsQuery, useAnalyticsRegistry } from "../lib/useAnalyticsQuery";
import { PivotTable, type PivotMeasure } from "../components/PivotTable";
import { GroupByControl } from "../components/GroupByControl";
import { metricConflicts, reconcile, voidPopulationConflicts, wouldContaminate } from "../lib/grouping";
import { useListSeparator } from "../lib/listSeparator";

const SEGMENT = "builder";

/** Page-local URL params (NOT part of the shared analytics codec). */
const P_METRICS = "b_m";
const P_DIM1 = "b_d1";
const P_DIM2 = "b_d2";
// The grouping control offers MAX_GROUP_DIMS levels. It only ever had two slots
// to write into, so a third pick was accepted by the control, dropped on the
// way to the URL, and reverted on the next render — a silent no-op.
const P_DIM3 = "b_d3";
const P_N = "b_n";

/**
 * The planner refuses more than this (lib/analytics/planner.js MAX_METRICS).
 * The picker used to offer all 51 and let the server say no: selecting them
 * produced a red "metrics: at most 12 per request" over an empty report, with
 * no hint of which twelve to keep or that a limit existed at all.
 */
export const MAX_METRICS = 12;

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
  const listSeparator = useListSeparator();
  const { filters } = useUrlFilters(analyticsFilterCodec);
  const [searchParams, setSearchParams] = useSearchParams();
  const registry = useAnalyticsRegistry();

  // ── config (URL-backed) ──
  const metricIds = useMemo(
    () =>
      (searchParams.get(P_METRICS) ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        // Clamp on READ, not only on change: a saved link or a hand-edited URL
        // can carry more than the planner accepts, and that request 422s before
        // the user has touched anything.
        .slice(0, MAX_METRICS),
    [searchParams],
  );
  // How many the URL ASKED for — a shared link or a pre-ceiling saved view can
  // carry more, and dropping three columns without saying so leaves the reader
  // comparing a 12-column report against a 15-column one and finding a gap.
  const requestedMetricCount = (searchParams.get(P_METRICS) ?? "").split(",").filter((x) => x.trim()).length;

  const dim1 = searchParams.get(P_DIM1) || DEFAULT_DIM;
  const dim2 = searchParams.get(P_DIM2) || NONE;
  const dim3 = searchParams.get(P_DIM3) || NONE;
  const topN = Math.max(1, Number(searchParams.get(P_N)) || DEFAULT_N);

  /**
   * Patch one or more page params in ONE navigation.
   *
   * Two back-to-back calls do NOT compose. react-router resolves each
   * functional update against the location the calling render captured, so the
   * second call is computed from the PRE-patch params and overwrites the first.
   * The grouping control writes b_d1 and b_d2 together, so with two calls the
   * primary level could never change: picking a new level 1 wrote it, then the
   * level-2 write reinstated the old level 1 and the control snapped back.
   *
   * The identical defect was found and fixed in Explorer's drill (see
   * Explorer.tsx segmentHref) — same cause, same symptom, in a page that had
   * been converted from single-param writes without noticing the difference.
   */
  const patchParams = (patch: Record<string, string | null>) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [key, value] of Object.entries(patch)) {
          if (value == null || value === "") next.delete(key);
          else next.set(key, value);
        }
        return next;
      },
      { replace: true },
    );
  };

  const patchParam = (key: string, value: string | null) => patchParams({ [key]: value });

  // ── config (local: sort) ──
  const [sortMetric, setSortMetric] = useState<string>(NONE);
  const [direction, setDirection] = useState<"top" | "bottom">("top");

  const effectiveSort = sortMetric && metricIds.includes(sortMetric) ? sortMetric : metricIds[0] ?? NONE;

  const knownMetrics = registry.data?.metrics ?? [];

  // De-duplicated: the same dimension twice is a wasted GROUP BY level and a
  // pivot nested inside itself (the defect fixed in Explorer's drill).
  const requestedDims = useMemo(
    () => [dim1, dim2, dim3].filter((d, i, a) => d && a.indexOf(d) === i),
    [dim1, dim2, dim3],
  );

  // Every illegal combination is refused HERE, not by a red box after Run.
  // Three rules, the same ones the Explorer enforces:
  //   1. at most MAX_METRICS — the planner's own ceiling;
  //   2. a metric whose fact cannot express the chosen grouping;
  //   3. a void metric beside an order-population metric (planner.js:356).
  const { dimensions, dropped } = useMemo(
    () => reconcile(registry.data, metricIds, requestedDims),
    [registry.data, metricIds.join("|"), requestedDims.join("|")],
  );

  const dimConflicts = useMemo(
    () => metricConflicts(registry.data, knownMetrics.map((m) => m.id), dimensions),
    [registry.data, knownMetrics.length, dimensions.join("|")],
  );
  const contaminated = useMemo(
    () => voidPopulationConflicts(registry.data, metricIds),
    [registry.data, metricIds.join("|")],
  );
  const atCap = metricIds.length >= MAX_METRICS;

  const metricOptions: MultiSelectOption[] = knownMetrics.map((m) => {
    const already = metricIds.includes(m.id);
    const blockedByDim = dimConflicts[m.id];
    const voidBlock = wouldContaminate(registry.data, metricIds, m.id);
    let sublabel: string | undefined;
    if (blockedByDim) {
      sublabel = `${t("salesReports.groupBy.blockedBy")} ${blockedByDim
        .map((d) => t(`salesReports.dims.${d}`))
        .join(listSeparator)}`;
    } else if (voidBlock.length) {
      sublabel = t("salesReports.groupBy.voidPopulation");
    } else if (atCap && !already) {
      sublabel = t("salesReports.builder.atCap", { max: MAX_METRICS });
    }
    return {
      value: m.id,
      label: t(`salesReports.metrics.${m.id}`),
      // Never disable what is already chosen — it would be stuck in the report.
      disabled: !already && (!!blockedByDim || voidBlock.length > 0 || atCap),
      sublabel,
    };
  });

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

  const result = useAnalyticsQuery(SEGMENT, body, { enabled });

  // Export registration is DYNAMIC here (the shape follows the builder config),
  // so it re-registers whenever the picked metrics/dimensions/sort change.
  useEffect(() => {
    setPageExportRequest(SEGMENT, () => ({
      metrics: metricIds,
      dimensions,
      ...(effectiveSort ? { sort: [{ by: effectiveSort, dir: direction === "top" ? "desc" : "asc" }] } : {}),
      limit: topN,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metricIds.join("|"), dimensions.join("|"), effectiveSort, direction, topN]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const measures: PivotMeasure[] = metricIds.map((id) => {
    const reg = knownMetrics.find((m) => m.id === id);
    return { id, label: t(`salesReports.metrics.${id}`), format: formatterFor(reg?.format ?? "count") };
  });

  const rows = result.data?.rows ?? [];

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
      {/* Config arriving from a saved report or a shared link can be illegal
          against the CURRENT metric set. Say what was adjusted rather than
          running a request that 422s the whole screen. */}
      {(dropped.length > 0 || Object.keys(contaminated).length > 0 || requestedMetricCount > MAX_METRICS) && (
        <div
          data-testid="builder-adjusted-notice"
          className="flex flex-col gap-1 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-bold text-amber-800"
        >
          {requestedMetricCount > MAX_METRICS && (
            <span>{t("salesReports.builder.truncated", { count: requestedMetricCount, max: MAX_METRICS })}</span>
          )}
          {dropped.length > 0 && (
            <span>
              {t("salesReports.groupBy.droppedNotice", {
                dims: dropped.map((d) => t(`salesReports.dims.${d}`)).join(listSeparator),
              })}
            </span>
          )}
          {Object.keys(contaminated).length > 0 && (
            <span>
              {t("salesReports.groupBy.voidPopulationNotice", {
                metrics: Object.keys(contaminated)
                  .map((m) => t(`salesReports.metrics.${m}`))
                  .join(listSeparator),
              })}
            </span>
          )}
        </div>
      )}

      <div className="surface space-y-4 p-4" data-testid="builder-config">
        {/* Names this card "Configuration" so it reads as distinct from the
            AnalyticsTopBar filter card above it — that card carries no header
            of its own, so the two used to blend into one long stack of fields. */}
        <header className="flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4 text-teal-700" aria-hidden="true" />
          <div>
            <h3 className="text-sm font-extrabold text-slate-900">{t("salesReports.builder.configTitle")}</h3>
            <p className="mt-0.5 text-xs font-bold text-slate-500">{t("salesReports.builder.configSubtitle")}</p>
          </div>
        </header>

        {/* Row A — what to measure: the two controls that decide the report's
            shape. items-start (not items-end): GroupByControl now carries its
            own padded box below, so bottom-aligning it against a plain field
            would misalign the two label rows above them. */}
        <div className="flex flex-wrap items-start gap-3">
          {field(
            `${t("salesReports.builder.metrics")} (${metricIds.length}/${MAX_METRICS})`,
            <MultiSelectCombobox
              options={metricOptions}
              values={metricIds}
              // Slice defensively: a URL can carry more than the ceiling.
              onChange={(values) => patchParam(P_METRICS, values.slice(0, MAX_METRICS).join(","))}
              ariaLabel={t("salesReports.builder.metrics")}
            />,
          )}
          {/* The same control the Explorer uses: every groupable dimension,
              up to the planner's three levels, illegal ones disabled with the
              metric that blocks them named. It replaces two native <select>s
              that offered a curated pair and could not say why anything was
              unavailable. Boxed (not `.surface` — no nested cards) so it reads
              as its own multi-slot unit instead of merging into the plain
              fields beside it. */}
          <GroupByControl
            registry={registry.data}
            metricIds={metricIds}
            value={dimensions}
            className="rounded-xl border border-slate-200 bg-slate-50/60 p-3"
            // ONE navigation for all three levels. Three separate patchParam
            // calls would each be computed from the pre-patch params, so only
            // the last would survive — see patchParams above.
            onChange={(next) =>
              patchParams({
                [P_DIM1]: next[0] ?? DEFAULT_DIM,
                [P_DIM2]: next[1] ?? null,
                [P_DIM3]: next[2] ?? null,
              })
            }
          />
        </div>

        {/* Row B — how to shape it: page size and ordering, separate from
            what to measure so the two questions don't compete in one row. */}
        <div className="flex flex-wrap items-end gap-3">
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

        {/* Row C — actions. A thin top rule separates "configuring" from
            "acting", the same divider convention CardHeader uses (border-b),
            flipped to border-t since this sits at the bottom of the card. */}
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
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
        </div>
      </div>

      {/* ── result — its own titled zone, plain (no .surface: PivotTable is
          already one, and a card nested in a card is the one thing this
          design system forbids). Present in every state, so the page always
          reads as two zones: configure above, report below. ── */}
      <div className="space-y-3" data-testid="builder-results">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Table2 className="h-4 w-4 text-teal-700" aria-hidden="true" />
            <h3 className="text-sm font-extrabold text-slate-900">{t("salesReports.builder.resultsTitle")}</h3>
          </div>
          {/* Only shown once there is an actual count — idle/loading/error/empty
              already carry their own one-line message just below, and a second
              "nothing yet" line here would be exactly the clutter this redesign
              removes. */}
          {enabled && !result.isPending && !result.isError && rows.length > 0 && (
            <span className="text-xs font-bold text-slate-500">
              {t("salesReports.builder.resultsCount", { count: rows.length })}
            </span>
          )}
        </div>

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
      </div>
    </section>
  );
}
