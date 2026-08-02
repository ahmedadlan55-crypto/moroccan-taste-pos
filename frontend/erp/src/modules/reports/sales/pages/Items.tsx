// Sales Analytics Hub — "items", the MERGED item report.
//
// WHAT WAS MERGED, AND WHY
//   Two reports read the same line fact. "items" did category → item with a
//   contribution share; "item-sales" did day × item × branch with the per-line
//   discount, returns and — for a holder of analytics.cost.view — cost, profit
//   and margin. Nobody could answer "which items, and when" without opening
//   both and reconciling two tables by eye, and the two disagreed by
//   construction: one carried returns, the other did not.
//
//   This is ONE report with three breakdowns and the UNION of both column sets.
//   The cost columns are present on every breakdown, not hidden on one of them
//   — a merge that dropped half the columns would be a deletion wearing a
//   merge's name.
//
// THE ONE HONEST ASYMMETRY
//   `returns_net` lives on the RETURN fact, and the return fact cannot express
//   `category` (menu.category is a free-text snapshot written on the LINE). So
//   the category breakdown carries no returns column. That is declared in
//   lib/reportRegistry — where reportRegistry.test.ts plans it against the real
//   planner — rather than discovered as a red 422 screen.
//
// No chart lives here: reports are decision tables, charts belong on the
// dashboard.
import { useEffect, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Coins, Package, Receipt } from "lucide-react";
import { Badge, EmptyState, ErrorState, ExplainNumber, LoadingState, MetricCard } from "@/shared/ui";
import { useCan } from "@/shared/permissions";
import { useUrlFilters } from "@/shared/hooks/useUrlFilters";
import { computeCompareRange } from "@/shared/ui/date-range-picker";
import { formatCurrency, formatNumber } from "@/shared/lib";
import { useT, type TFunction } from "@/i18n";
import {
  analyticsFilterCodec,
  makeCodec,
  stringParam,
  type AnalyticsFilters,
} from "../lib/filters";
import {
  buildFiltersBody,
  reportQuerySpec,
  setPageExportRequest,
  type AnalyticsCompareSpec,
  type AnalyticsQueryBody,
  type AnalyticsRegistry,
  type AnalyticsResult,
} from "../lib/api";
import { REPORT_BY_ID, queryMetrics, reportQuery, resolveDimensions } from "../lib/reportRegistry";
import { useAnalyticsQuery, useAnalyticsRegistry } from "../lib/useAnalyticsQuery";
import { DataTable } from "@/shared/tables";
import { ReportTotals } from "../components/ReportTotals";
import { ViewSwitcher } from "../components/ViewSwitcher";
import { buildResultColumns, toResultRows, type ResultTableRow } from "../lib/resultTable";
import { isCostUndefined } from "../lib/cost";

const SEGMENT = "items";
const CAP_COST = "analytics.cost.view";
const REPORT = REPORT_BY_ID[SEGMENT];

/** The three breakdowns, in switcher order. `byCategory` is the default. */
const BREAKDOWNS = ["byCategory", "byItem", "byDay"] as const;
type Breakdown = (typeof BREAKDOWNS)[number];
const DEFAULT_BREAKDOWN: Breakdown = "byCategory";

/** Page-local URL param — composes with the shared codec on the same URL. */
const breakdownCodec = makeCodec({ ib: stringParam(DEFAULT_BREAKDOWN) });

function readBreakdown(raw: string): Breakdown {
  return (BREAKDOWNS as readonly string[]).includes(raw) ? (raw as Breakdown) : DEFAULT_BREAKDOWN;
}

/**
 * The export mirrors the OPEN breakdown and this viewer's capability — a capless
 * viewer must not pull the cost columns out through the export menu either.
 * Registered at module scope so the menu never falls back to the generic
 * default before this component has rendered once.
 */
function registerExport(breakdown: Breakdown, withCost: boolean) {
  setPageExportRequest(SEGMENT, (filters) => {
    const q = reportQuery(REPORT, breakdown)!;
    const basis = filters.businessDay ? "business_day" : "calendar_day";
    return {
      metrics: queryMetrics(q, withCost),
      dimensions: resolveDimensions(q.dimensions, basis),
      sort: [{ by: "net_ex_vat", dir: "desc" }],
      ...(q.limit != null ? { limit: q.limit } : {}),
    };
  });
}
registerExport(DEFAULT_BREAKDOWN, false);

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

function totalValue(result: AnalyticsResult | undefined, id: string): number | null {
  if (!result || result.meta.maskedMetrics.includes(id)) return null;
  const v = result.totals?.[id];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export default function Items() {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const canCost = useCan(CAP_COST);
  const { filters } = useUrlFilters(analyticsFilterCodec);
  const { filters: local, patch: patchLocal } = useUrlFilters(breakdownCodec);
  const breakdown = readBreakdown(local.ib);
  const registry = useAnalyticsRegistry();

  useEffect(() => {
    registerExport(breakdown, canCost);
  }, [breakdown, canCost]);

  const spec = reportQuerySpec(SEGMENT, breakdown, filters, { hasOptionalCap: canCost });
  const base = buildFiltersBody(filters);
  const compare = compareSpec(filters);
  const body: AnalyticsQueryBody = {
    ...base,
    ...spec,
    sort: [{ by: "net_ex_vat", dir: "desc" }],
    ...(compare ? { compare } : {}),
  };

  // Data queries wait for a VALID metric catalog: without one there is nothing
  // to label or explain, and a disabled query never fires a doomed request.
  const catalogReady = registry.data != null && Array.isArray(registry.data.metrics);
  const query = useAnalyticsQuery(SEGMENT, body, { enabled: catalogReady });

  // One column per grouping dimension (read from row.labels[i]) then one per
  // metric. Grouping stays a QUERY control: it decides which columns exist.
  const columns = useMemo(
    () =>
      buildResultColumns({
        dimensions: spec.dimensions,
        metricIds: spec.metrics,
        t,
        registry: registry.data,
        maskedMetrics: query.data?.meta.maskedMetrics,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spec.dimensions.join(","), spec.metrics.join(","), registry.data, query.data?.meta.maskedMetrics, t],
  );

  const switcher = (
    <ViewSwitcher
      className="mb-1"
      ariaLabel={t("salesReports.items.breakdownAria")}
      value={breakdown}
      onChange={(id) => patchLocal({ ib: id })}
      options={BREAKDOWNS.map((id) => ({ id, label: t(`salesReports.items.breakdowns.${id}`) }))}
    />
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

  const rows = query.data?.rows ?? [];
  const tableRows = toResultRows(rows);
  if (rows.length === 0) {
    return (
      <section className="space-y-4" data-testid="page-items">
        {switcher}
        <EmptyState title={t("salesReports.states.empty")} />
      </section>
    );
  }

  /** Which result column holds the menu item, per breakdown. */
  const itemIndex = spec.dimensions.indexOf("menu_item");

  const onRowClick = (row: ResultTableRow) => {
    // Drilling an item stays INSIDE this report: it pins the item and opens the
    // day × item × branch breakdown, which is the "and when" half of the merge.
    // It used to navigate to the orders report, whose order-fact metrics cannot
    // express `menu_item` at all — that drill 422'd every time.
    if (itemIndex < 0) return;
    const itemId = String(row.keys[itemIndex] ?? "");
    if (itemId === "") return;
    const sp = new URLSearchParams(location.search);
    sp.set("menuItemId", itemId);
    sp.set("ib", "byDay");
    navigate({ pathname: location.pathname, search: `?${sp.toString()}` });
  };

  const kpis = [
    { id: "qty_sold", icon: Package, tone: "violet" as const, format: formatNumber },
    { id: "gross_product_sales", icon: Receipt, tone: "blue" as const, format: formatCurrency },
    { id: "net_ex_vat", icon: Coins, tone: "teal" as const, format: formatCurrency },
  ];

  // The row sold something and carries NO defined cost — a warning, never a
  // zero: a zero cost reads as "free to make", which no data supports.
  const uncostedRows = canCost
    ? rows.filter((r) => isCostUndefined(r.values.qty_sold ?? null, r.values.cogs ?? null)).length
    : 0;

  const page = query.data?.page;
  const truncated = page?.rowCountCapped ?? false;

  return (
    <section className="space-y-4" data-testid="page-items">
      {switcher}
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

      {uncostedRows > 0 && (
        <div
          data-testid="uncosted-notice"
          className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-bold text-amber-800"
        >
          <span>{t("salesReports.itemSales.costUndefinedCount", { count: formatNumber(uncostedRows) })}</span>
          <span className="font-medium">{t("salesReports.itemSales.costUndefinedHint")}</span>
        </div>
      )}

      {truncated && (
        <div
          data-testid="row-limit-notice"
          className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs font-bold text-slate-600"
        >
          {t("salesReports.itemSales.rowLimit", { count: formatNumber(spec.limit ?? 0) })}
        </div>
      )}

      {/* Period totals from the server ROLLUP — above the table, never a sum
          of the rows on screen. */}
      <ReportTotals
        totals={query.data?.totals}
        metricIds={spec.metrics}
        registry={registry.data}
        maskedMetrics={query.data?.meta.maskedMetrics}
      />

      <DataTable<ResultTableRow>
        columns={columns}
        rows={tableRows}
        getRowId={(r) => r.id}
        tableId={`sales-hub-items-${breakdown}`}
        onRowClick={itemIndex >= 0 ? onRowClick : undefined}
        searchable
        emptyTitle={t("salesReports.states.empty")}
        mobileTitle={(r) => r.labels[0] ?? ""}
      />
    </section>
  );
}
