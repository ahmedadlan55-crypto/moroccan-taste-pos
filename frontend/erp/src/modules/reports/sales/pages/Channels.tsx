// Sales Analytics Hub — "channels", new in the five-centre reorganisation.
//
// `channel` was a filter you could apply but never a breakdown you could read.
// "How much of July came through delivery, and was the ticket bigger or
// smaller than dine-in?" needed the Explorer and a hand-built pivot — an
// everyday operations question behind an analyst tool.
//
// Metrics come from the registry (lib/reportRegistry, report `channels`), so
// what this page asks for is the same declaration the cross-product test plans
// against the real planner.
import { useMemo } from "react";
import { Coins, Receipt, ShoppingBag } from "lucide-react";
import { EmptyState, ErrorState, ExplainNumber, LoadingState, MetricCard } from "@/shared/ui";
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
import { DataTable } from "@/shared/tables";
import { ReportTotals } from "../components/ReportTotals";
import { buildResultColumns, toResultRows, type ResultTableRow } from "../lib/resultTable";

const SEGMENT = "channels";

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

function totalValue(result: AnalyticsResult | undefined, id: string): number | null {
  if (!result || result.meta.maskedMetrics.includes(id)) return null;
  const v = result.totals?.[id];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export default function Channels() {
  const t = useT();
  const { filters } = useUrlFilters(analyticsFilterCodec);
  const registry = useAnalyticsRegistry();

  const spec = reportQuerySpec(SEGMENT, "byChannel", filters);
  const compare = compareSpec(filters);
  const body: AnalyticsQueryBody = {
    ...buildFiltersBody(filters),
    ...spec,
    sort: [{ by: "net_ex_vat", dir: "desc" }],
    ...(compare ? { compare } : {}),
  };

  const catalogReady = registry.data != null && Array.isArray(registry.data.metrics);
  const query = useAnalyticsQuery(SEGMENT, body, { enabled: catalogReady });

  const hasCompare = filters.compare !== "none";
  const metricIds = hasCompare ? [...spec.metrics, "growth"] : spec.metrics;

  const columns = useMemo(
    () =>
      buildResultColumns({
        dimensions: spec.dimensions,
        metricIds,
        t,
        registry: registry.data,
        maskedMetrics: query.data?.meta.maskedMetrics,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spec.dimensions.join(","), metricIds.join(","), registry.data, query.data?.meta.maskedMetrics, t],
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

  // `growth` is a PARAMETERIZED registry metric — requesting it plainly is a
  // planner VALIDATION_ERROR. The column derives client-side from the compare
  // envelope's per-row delta instead.
  const rows = hasCompare
    ? srcRows.map((r) => ({
        ...r,
        values: {
          ...r.values,
          growth: typeof r.delta?.net_ex_vat === "number" ? r.delta.net_ex_vat : null,
        },
      }))
    : srcRows;

  const kpis = [
    { id: "net_ex_vat", icon: Coins, tone: "teal" as const, format: formatCurrency },
    { id: "orders", icon: ShoppingBag, tone: "violet" as const, format: formatNumber },
    { id: "avg_ticket", icon: Receipt, tone: "blue" as const, format: formatCurrency },
  ];

  return (
    <section className="space-y-4" data-testid="page-channels">
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

      <ReportTotals
        totals={query.data?.totals}
        metricIds={metricIds}
        registry={registry.data}
        maskedMetrics={query.data?.meta.maskedMetrics}
      />

      <DataTable<ResultTableRow>
        columns={columns}
        rows={toResultRows(rows)}
        getRowId={(r) => r.id}
        tableId="sales-hub-channels"
        emptyTitle={t("salesReports.states.empty")}
        mobileTitle={(r) => r.labels[0] ?? ""}
      />
    </section>
  );
}
