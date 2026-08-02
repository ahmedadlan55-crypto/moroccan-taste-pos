// Sales Analytics Hub — "modifiers" page.
//
// Modifier performance by modifier_kind: quantity, avg modifiers per item and
// attach rate. The historical-completeness notice renders PROMINENTLY (above
// the KPI row): historical rows carry combo choices only and price_delta is
// null historically, so meta.completeness drives the
// states.notAvailableHistorically banner.
import { useMemo } from "react";
import { Layers, Percent, Sigma } from "lucide-react";
import { Badge, EmptyState, ErrorState, ExplainNumber, LoadingState, MetricCard } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { useUrlFilters } from "@/shared/hooks/useUrlFilters";
import { computeCompareRange } from "@/shared/ui/date-range-picker";
import { formatNumber } from "@/shared/lib";
import { useT, type TFunction } from "@/i18n";
import { analyticsFilterCodec, type AnalyticsFilters } from "../lib/filters";
import {
  buildFiltersBody,
  displayMetric,
  reportQuerySpec,
  type AnalyticsCompareSpec,
  type AnalyticsQueryBody,
  type AnalyticsRegistry,
  type AnalyticsResult,
} from "../lib/api";
import { useAnalyticsQuery, useAnalyticsRegistry } from "../lib/useAnalyticsQuery";

const SEGMENT = "modifiers";
// TWO plannable queries (E2E-wave fix): attach_rate / modifiers_per_item are
// CROSS-FACT derived metrics (modifier fact ÷ line fact `qty_sold`), and the
// planner rightly refuses to group a line-fact statement by modifier_kind
// (ANALYTICS_UNSUPPORTED_COMBINATION 422 — the original single query errored
// on every load). So: the ratios render as OVERALL KPIs (dimensionless — both
// facts can compute grand totals), and the per-kind breakdown carries the
// modifier-fact-only measures (qty + lines).
// Both queries live in lib/reportRegistry as `kpis` and `byKind`; the
// ExportMenu reads `byKind` from the same place, because the per-kind breakdown
// is the exportable grain (the KPI ratios are cross-fact and dimensionless).

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
  lines: number | null;
}

export default function Modifiers() {
  const t = useT();
  const { filters } = useUrlFilters(analyticsFilterCodec);
  const registry = useAnalyticsRegistry();

  const base = buildFiltersBody(filters);
  const compare = compareSpec(filters);
  const kpiSpec = reportQuerySpec(SEGMENT, "kpis", filters);
  const kindSpec = reportQuerySpec(SEGMENT, "byKind", filters);
  const kpiBody: AnalyticsQueryBody = {
    ...base,
    ...kpiSpec,
    ...(compare ? { compare } : {}),
  };
  const kindBody: AnalyticsQueryBody = {
    ...base,
    ...kindSpec,
    sort: [{ by: "modifier_qty", dir: "desc" }],
    ...(compare ? { compare } : {}),
  };

  // Data queries wait for a VALID metric catalog: without one there is nothing
  // to label or explain, and a disabled query never fires a doomed request.
  const catalogReady = registry.data != null && Array.isArray(registry.data.metrics);
  const kpiQuery = useAnalyticsQuery(`${SEGMENT}-kpis`, kpiBody, { enabled: catalogReady });
  const query = useAnalyticsQuery(SEGMENT, kindBody, { enabled: catalogReady });

  const kindRows = useMemo<KindRow[]>(
    () =>
      (query.data?.rows ?? []).map((row) => ({
        key: String(row.keys[0] ?? ""),
        label: row.labels[0] ?? String(row.keys[0] ?? ""),
        qty: displayMetric(row, "modifier_qty"),
        lines: displayMetric(row, "modifier_lines"),
      })),
    [query.data],
  );

  const columns = useMemo<ColumnDef<KindRow>[]>(
    () => [
      {
        id: "kind",
        header: t("salesReports.dims.modifier_kind"),
        accessor: (r) => r.label,
        pinStart: true, hideable: false,
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
        // Per-kind ratios are not computable (cross-fact — see KPI_METRICS
        // note); the honest per-kind measures are qty + line count.
        id: "lines",
        header: t("salesReports.metrics.modifier_lines"),
        accessor: (r) => r.lines,
        cell: (r) => (r.lines == null ? "—" : formatNumber(r.lines)),
        numeric: true,
        sortable: true,
      },
    ],
    [t],
  );

  if (registry.isLoading || kpiQuery.isLoading || query.isLoading) return <LoadingState rows={6} />;
  const loadError = registry.error ?? kpiQuery.error ?? query.error;
  if (loadError) {
    return (
      <ErrorState
        error={loadError}
        title={t("salesReports.states.loadFailed")}
        onRetry={() => {
          void registry.refetch();
          void kpiQuery.refetch();
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
          const v = totalValue(kpiQuery.data, id);
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

      {/* No chart here: reports are decision tables; charts live on the dashboard. */}
      <DataTable<KindRow>
        columns={columns}
        rows={kindRows}
        getRowId={(r) => r.key}
        tableId="sales-hub-modifiers"
        initialSort={{ columnId: "qty", dir: "desc" }}
        emptyTitle={t("salesReports.states.empty")}
      />
    </section>
  );
}
