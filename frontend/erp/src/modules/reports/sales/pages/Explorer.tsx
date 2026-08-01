// Sales Analytics Hub — "explorer" page.
//
// Free exploration over a CURATED primary dimension (`by` URL param, page-local
// codec — the shared filters.ts codec is untouched), an optional second
// dimension, a metric multi-pick (any registry metric), and a top/bottom-N
// control. Renders the API rows in a flat DataTable — reports are
// decision tables, so the visual summary lives on the dashboard, not here.
// Leaf row clicks drill: the clicked key becomes a shared-codec
// filter (wave 4 covers payment_method / hour / menu_item / cashier too) and
// `by` advances along the chain branch → business_day → hour → cashier → the
// orders segment (the cashier hand-off pins `cashierId` on the composed URL).
import { useEffect, useMemo } from "react";
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
  type MetricTone,
} from "@/shared/ui";
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
import { DataTable } from "@/shared/tables";
import { ReportTotals } from "../components/ReportTotals";
import { buildResultColumns, toResultRows, type ResultTableRow } from "../lib/resultTable";
import { GroupByControl, MAX_GROUP_DIMS } from "../components/GroupByControl";
import { metricConflicts, reconcile, voidPopulationConflicts, wouldContaminate } from "../lib/grouping";
import { useListSeparator } from "../lib/listSeparator";

const SEGMENT = "explorer";

/**
 * Dimensions that PIN a shared filter when their row is clicked. This is the
 * drill map, NOT the grouping menu — grouping is open to every groupable
 * dimension the registry exposes (GroupByControl), and a dimension absent here
 * simply groups without drilling.
 */
const DRILL_PARAM: Record<string, (key: string) => Record<string, string>> = {
  branch: (k) => ({ branchId: k }),
  business_day: (k) => ({ from: k, to: k, preset: "custom" }),
  channel: (k) => ({ channel: k }),
  order_type: (k) => ({ orderType: k }),
  payment_method: (k) => ({ paymentMethod: k }),
  hour: (k) => ({ hour: k }),
  menu_item: (k) => ({ menuItemId: k }),
};

/** The drill chain; a leaf click on the LAST link navigates to orders. */
const DRILL_CHAIN = ["branch", "business_day", "hour", "cashier"];

const N_OPTIONS = ["10", "20", "50"] as const;

/**
 * Page-local URL codec — coexists with the shared codec on the same URL.
 *
 * `g` is the grouping: up to MAX_GROUP_DIMS ids, outermost first. It REPLACES
 * the old `by` + `second` pair, which are still read once (below) so that a
 * bookmark, a saved view or a browser-history entry created before Group By
 * still opens on the grouping its author meant.
 */
const explorerCodec = makeCodec({
  g: csvParam(["branch"]),
  by: stringParam(""),
  second: stringParam(""),
  m: csvParam(["net_ex_vat", "orders"]),
  n: stringParam("10"),
  dir: stringParam("top"),
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

/**
 * Merge extra params over the CURRENT search and render a hub segment URL.
 * An EMPTY value deletes the param rather than writing `k=` — the drill uses
 * that to retire the legacy `by`/`second` pair, and a URL carrying empty keys
 * is one a user cannot read.
 */
function segmentHref(search: string, segment: string, extra: Record<string, string>): string {
  const sp = new URLSearchParams(search);
  for (const [k, v] of Object.entries(extra)) {
    if (v === "") sp.delete(k);
    else sp.set(k, v);
  }
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
  const listSeparator = useListSeparator();
  const navigate = useNavigate();
  const location = useLocation();
  const { filters } = useUrlFilters(analyticsFilterCodec);
  const page = useUrlFilters(explorerCodec);
  const registry = useAnalyticsRegistry();

  const metricIds = page.filters.m.length > 0 ? page.filters.m : ["net_ex_vat"];
  const topBottom = page.filters.dir === "bottom" ? "bottom" : "top";
  const limit = (N_OPTIONS as readonly string[]).includes(page.filters.n) ? Number(page.filters.n) : 10;

  // Legacy `by`/`second` win when present — an old link carries them and no
  // `g`, and silently rewriting such a link to the default grouping would open
  // a DIFFERENT report than the one its author shared.
  //
  // `by` DEFAULTED TO "branch" in the old codec, so a URL grouped Branch >
  // Business day serialised as `?second=business_day` with NO `by` at all —
  // writing the default is exactly what a codec omits. Reading a missing `by`
  // as "no primary level" therefore dropped Branch from every pre-Group-By
  // bookmark and saved view, turning "Branch > Business day" into a flat
  // by-day report. So a `second` with no `by` restores the old default.
  const legacySecond = page.filters.second;
  const legacyBy = page.filters.by || (legacySecond ? "branch" : "");
  const legacyDims = [legacyBy, legacySecond].filter(Boolean);
  const requestedDims = (legacyDims.length ? legacyDims : page.filters.g).slice(0, MAX_GROUP_DIMS);

  // A grouping can arrive that the CURRENT metric set cannot support (a saved
  // view, a shared link, Back after changing metrics). Submitting it would 422
  // the entire request, so the illegal levels are dropped and named instead.
  const { dimensions: dims, dropped } = useMemo(
    () => reconcile(registry.data, metricIds, requestedDims),
    [registry.data, metricIds.join("|"), requestedDims.join("|")],
  );
  const by = dims[0] ?? "";
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

  // Legality runs in BOTH directions. GroupByControl disables the dimensions
  // the chosen metrics cannot express; this disables the metrics the chosen
  // GROUPING cannot express — otherwise adding `cogs` to a report grouped by
  // payment method 422s the whole screen, and the user's most natural reading
  // is that the cost data is missing rather than that the pair is impossible.
  const conflicts = useMemo(
    () => metricConflicts(registry.data, registry.data?.metrics?.map((m) => m.id) ?? [], dims),
    [registry.data, dims.join("|")],
  );

  // The void-population trap, enforced where the user actually picks metrics.
  // The Executive statement avoids it by hand (its groups are pinned by
  // voidPopulation.test.ts); the Explorer cannot, because the user picks any
  // twelve metrics they like — and `voids_value` beside `orders` silently makes
  // `avg_ticket` a void-excluded numerator over a void-included denominator.
  const contaminated = useMemo(
    () => voidPopulationConflicts(registry.data, metricIds),
    [registry.data, metricIds.join("|")],
  );

  const metricOptions = useMemo(() => {
    const ids = registry.data?.metrics?.map?.((m) => m.id) ?? [...METRIC_CODES];
    return ids.map((id) => {
      const blocking = conflicts[id];
      const voidBlock = wouldContaminate(registry.data, metricIds, id);
      const already = metricIds.includes(id);
      let sublabel: string | undefined;
      if (blocking) {
        sublabel = `${t("salesReports.groupBy.blockedBy")} ${blocking
          .map((d) => t(`salesReports.dims.${d}`))
          .join(listSeparator)}`;
      } else if (voidBlock.length) {
        sublabel = t("salesReports.groupBy.voidPopulation");
      }
      return {
        value: id,
        label: t(`salesReports.metrics.${id}`),
        // Never disable a metric the user has ALREADY chosen: it would be
        // stuck in the report with no way to take it out.
        disabled: (!!blocking || voidBlock.length > 0) && !already,
        sublabel,
      };
    });
  }, [registry.data, conflicts, metricIds.join("|"), listSeparator, t]);

  // The flat table: one column per grouping dimension (from row.labels[i]),
  // then one per metric. Grouping stays a QUERY control that decides which
  // leading columns exist — the render is flat, as every other report here.
  const columns = useMemo(
    () =>
      buildResultColumns({
        dimensions: dims,
        metricIds,
        t,
        registry: registry.data,
        maskedMetrics: query.data?.meta.maskedMetrics,
        periodValue: `${filters.from} — ${filters.to}`,
      }),
    [dims.join("|"), metricIds.join("|"), registry.data, query.data?.meta.maskedMetrics, filters.from, filters.to, t],
  );

  const rows = query.data?.rows ?? [];
  const tableRows = useMemo(() => toResultRows(rows), [rows]);

  const drillLeaf = (row: ResultTableRow) => {
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
    const pin = DRILL_PARAM[by];
    if (!pin) return; // groupable but not drillable — grouping still works
    const extra: Record<string, string> = { ...pin(key) };
    // Advance the OUTERMOST grouping level along the chain (levels below it are
    // preserved). Dimensions outside the chain only pin their filter.
    const at = DRILL_CHAIN.indexOf(by);
    if (at !== -1 && at < DRILL_CHAIN.length - 1) {
      const next = DRILL_CHAIN[at + 1];
      // De-duplicate. Grouping Branch > Business day and drilling a branch
      // advances the outer level to business_day — which the INNER level
      // already is, so a naive [next, ...dims.slice(1)] emits
      // `g=business_day,business_day`: a wasted GROUP BY level, a pivot nested
      // inside itself, and one of the two slots gone from a hard limit of
      // three. The old two-Select control could not express this at all (it
      // filtered the chosen primary out of the secondary list); opening the
      // grouping made it reachable, so the guard has to be explicit.
      extra.g = [next, ...dims.slice(1).filter((d) => d !== next)].join(",");
      // The legacy pair must not survive the drill: it is read in preference
      // to `g`, so leaving it behind would pin the pre-drill grouping forever.
      extra.by = "";
      extra.second = "";
    }
    navigate(segmentHref(location.search, "explorer", extra));
  };

  // Every row is a leaf now: the flat table has no groups to expand, so a
  // click always drills. The old isSubtotal branch died with the pivot.
  const onRowClick = (row: ResultTableRow) => drillLeaf(row);

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


  // A level was dropped because the CURRENT metrics cannot express it. Naming
  // both sides matters: "grouping removed" alone reads as a bug, while "removed
  // X because Y asks for it" tells the user which one to change.
  // The picker blocks the pair going forward, but a URL — a saved view, a
  // shared link, the Back button — can still arrive carrying it. Removing the
  // user's metric silently would be worse than showing the number; naming
  // exactly which figures are affected lets them decide.
  const contaminatedNotice = Object.keys(contaminated).length > 0 && (
    <div
      data-testid="void-population-notice"
      className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-bold text-amber-800"
    >
      <span>
        {t("salesReports.groupBy.voidPopulationNotice", {
          metrics: Object.keys(contaminated)
            .map((m) => t(`salesReports.metrics.${m}`))
            .join(listSeparator),
        })}
      </span>
    </div>
  );

  // The engine reports which COLUMNS it could not measure on every row: each
  // fact statement fetches its own bounded slice, and past that bound a fact
  // simply did not look. Those cells read "—" rather than a fabricated 0, and
  // without this line the reader has no way to tell an unmeasured cell from a
  // genuinely empty one.
  const truncatedMetrics = query.data?.page?.truncatedMetrics ?? [];
  const truncatedNotice = truncatedMetrics.length > 0 && (
    <div
      data-testid="truncated-metrics-notice"
      className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-bold text-amber-800"
    >
      <span>
        {t("salesReports.groupBy.truncatedNotice", {
          metrics: truncatedMetrics.map((m) => t(`salesReports.metrics.${m}`)).join(listSeparator),
        })}
      </span>
    </div>
  );

  const droppedNotice = dropped.length > 0 && (
    <div
      data-testid="grouping-dropped-notice"
      className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-bold text-amber-800"
    >
      <span>
        {t("salesReports.groupBy.droppedNotice", {
          dims: dropped.map((d) => t(`salesReports.dims.${d}`)).join(listSeparator),
        })}
      </span>
    </div>
  );

  const controls = (
    <div className="surface flex flex-wrap items-end gap-3 p-4" data-testid="explorer-controls">
      <GroupByControl
        registry={registry.data}
        metricIds={metricIds}
        value={dims}
        // Writing `g` also RETIRES the legacy pair, which is read in preference
        // to it — without the reset, every grouping change on a legacy URL
        // would be silently ignored.
        onChange={(next) => page.patch({ g: next.length ? next : ["branch"], by: "", second: "" })}
      />
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
        {truncatedNotice}
      {contaminatedNotice}
      {droppedNotice}
        {controls}
        <EmptyState title={t("salesReports.states.empty")} />
      </section>
    );
  }

  const kpiIds = metricIds.slice(0, 4);

  return (
    <section className="space-y-4" data-testid="page-explorer">
      <CompletenessNotice meta={query.data?.meta} />
      {truncatedNotice}
      {contaminatedNotice}
      {droppedNotice}
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

      {/* The server ROLLUP over the WHOLE period — ABOVE the table. A top or
          bottom N is almost always active here, so the on-screen rows do NOT
          sum to the period; only this figure reconciles. Above rather than a
          footer because a total after N rows is a total nobody reads. */}
      <ReportTotals
        totals={query.data?.totals}
        metricIds={metricIds}
        registry={registry.data}
        maskedMetrics={query.data?.meta.maskedMetrics}
      />

      {/* The server returned the top/bottom N by ITS sort metric. A header
          click re-sorts only those N in memory — it does NOT fetch the true
          top N by the clicked column, and without saying so the table reads
          as "the top 10 by orders" when it is the top 10 by net, reordered. */}
      {rows.length >= limit && (
        <p data-testid="sliced-notice" className="text-xs font-bold text-amber-700">
          {t("salesReports.report.slicedNotice", {
            count: limit,
            metric: t(`salesReports.metrics.${sortMetric}`),
          })}
        </p>
      )}

      <DataTable<ResultTableRow>
        columns={columns}
        rows={tableRows}
        getRowId={(r) => r.id}
        tableId="sales-hub-explorer"
        initialSort={{ columnId: sortMetric, dir: topBottom === "top" ? "desc" : "asc" }}
        initialPageSize={25}
        onRowClick={onRowClick}
        emptyTitle={t("salesReports.states.empty")}
        mobileTitle={(r) => r.labels[0] ?? ""}
      />
    </section>
  );
}
