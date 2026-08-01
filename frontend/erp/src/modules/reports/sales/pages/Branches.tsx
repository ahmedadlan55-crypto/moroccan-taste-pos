// Sales Analytics Hub — "branches" page.
//
// Brand → branch pivot (API subtotals win) over net / orders — plus the growth
// metric column when a compare mode is on. A BRANCH (leaf) row click drills
// OUT: it navigates to the explorer segment with branchId set and
// by=business_day, preserving every current filter param (the navigate itself
// is the history push). Brand rows toggle their group.
//
// No chart lives here: a report is a decision table, so the branch bar was
// removed — charts belong on the dashboard.
import { useMemo } from "react";
import { Coins, ShoppingBag } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { Badge, EmptyState, ErrorState, ExplainNumber, LoadingState, MetricCard } from "@/shared/ui";
import { useUrlFilters } from "@/shared/hooks/useUrlFilters";
import { computeCompareRange } from "@/shared/ui/date-range-picker";
import { formatCurrency, formatNumber } from "@/shared/lib";
import { useT, type TFunction } from "@/i18n";
import { analyticsFilterCodec, type AnalyticsFilters } from "../lib/filters";
import {
  buildFiltersBody,
  reportQuerySpec,
  type AnalyticsCompareSpec,
  type AnalyticsQueryBody,
  type AnalyticsRegistry,
  type AnalyticsResult,
} from "../lib/api";
import { useAnalyticsQuery, useAnalyticsRegistry } from "../lib/useAnalyticsQuery";
import { hubHref } from "../lib/reportRegistry";
import { DataTable } from "@/shared/tables";
import { ReportTotals } from "../components/ReportTotals";
import { buildResultColumns, toResultRows, type ResultTableRow } from "../lib/resultTable";

const SEGMENT = "branches";
// Metrics and dimensions come from lib/reportRegistry — the same declaration
// the ExportMenu reads for this report's file and the cross-product test plans
// against the real server planner. A page-local copy could drift from either.
//
// E2E-wave fix, still true: `growth` is a PARAMETERIZED registry metric —
// requesting it plainly is a planner VALIDATION_ERROR (422), so with a compare
// mode on this page errored on load. The growth column derives client-side from
// the compare envelope's per-row delta (see the `rows` mapping below), which is
// why it is added to the COLUMN list and never to the request.

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

/** The canonical URL of another hub report — lib/reportRegistry owns the
 *  centre a report lives in, so a drill never hand-builds a retired path. */
function segmentHref(search: string, segment: string, extra: Record<string, string>): string {
  return hubHref(segment, search, extra);
}


export default function Branches() {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const { filters } = useUrlFilters(analyticsFilterCodec);
  const registry = useAnalyticsRegistry();

  const hasCompare = filters.compare !== "none";

  const base = buildFiltersBody(filters);
  const spec = reportQuerySpec(SEGMENT, "byBranch", filters);
  const compare = compareSpec(filters);
  const body: AnalyticsQueryBody = {
    ...base,
    // The registry carries the row limit too: DEFAULT_LIMIT is 50, and a chain
    // with more than fifty pairs was silently showing fifty rows with nothing
    // to say so (page.rowCountCapped stayed false because the FACT never hit
    // its own cap).
    ...spec,
    sort: [{ by: "net_ex_vat", dir: "desc" }],
    ...(compare ? { compare } : {}),
  };
  const METRICS = spec.metrics;
  const DIMS = spec.dimensions;

  // Data queries wait for a VALID metric catalog: without one there is nothing
  // to label or explain, and a disabled query never fires a doomed request.
  const catalogReady = registry.data != null && Array.isArray(registry.data.metrics);
  const query = useAnalyticsQuery(SEGMENT, body, { enabled: catalogReady });

  // One column per grouping dimension (read from row.labels[i]) then one per
  // metric — the same flat shape the other thirteen report pages build by
  // hand. Grouping stays a QUERY control: it decides which columns exist.
  const columns = useMemo(
    () =>
      buildResultColumns({
        dimensions: DIMS,
        metricIds: hasCompare ? [...METRICS, "growth"] : METRICS,
        t,
        registry: registry.data,
        maskedMetrics: query.data?.meta.maskedMetrics,
      }),
    [hasCompare, registry.data, query.data?.meta.maskedMetrics, t],
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

  const srcRows = query.data?.rows ?? [];
  if (srcRows.length === 0) return <EmptyState title={t("salesReports.states.empty")} />;
  // Client-derived growth column (see the METRICS note): the compare envelope
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

  const tableRows = toResultRows(rows);

  // Every row is a leaf: a flat table has no groups to expand, so a click
  // always drills.
  const onRowClick = (row: ResultTableRow) => {
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

      {/* Period totals from the server ROLLUP — above the table, never a sum
          of the rows on screen. */}
      <ReportTotals
        totals={query.data?.totals}
        metricIds={hasCompare ? [...METRICS, "growth"] : METRICS}
        registry={registry.data}
        maskedMetrics={query.data?.meta.maskedMetrics}
      />

      <DataTable<ResultTableRow>
        columns={columns}
        rows={tableRows}
        getRowId={(r) => r.id}
        tableId="sales-hub-branches"
        onRowClick={onRowClick}
        emptyTitle={t("salesReports.states.empty")}
        mobileTitle={(r) => r.labels[0] ?? ""}
      />
    </section>
  );
}
