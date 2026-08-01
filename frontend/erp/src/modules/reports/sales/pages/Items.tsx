// Sales Analytics Hub — "items" page.
//
// Category → item pivot (expandable, API subtotals win) over qty / gross / net
// / contribution, plus a KPI row from the query totals. Wave 4: a leaf
// (menu_item) row drills to the orders segment with the clicked item pinned
// via the shared `menuItemId` codec param; group rows still toggle on click.
// No chart lives here: reports are decision tables, charts belong on the
// dashboard.
import { useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Coins, Package, Receipt } from "lucide-react";
import { Badge, EmptyState, ErrorState, ExplainNumber, LoadingState, MetricCard } from "@/shared/ui";
import { useUrlFilters } from "@/shared/hooks/useUrlFilters";
import { computeCompareRange } from "@/shared/ui/date-range-picker";
import { formatCurrency, formatNumber } from "@/shared/lib";
import { useT, type TFunction } from "@/i18n";
import { analyticsFilterCodec, type AnalyticsFilters } from "../lib/filters";
import {
  buildFiltersBody,
  setPageExportRequest,
  type AnalyticsCompareSpec,
  type AnalyticsQueryBody,
  type AnalyticsRegistry,
  type AnalyticsResult,
} from "../lib/api";
import { useAnalyticsQuery, useAnalyticsRegistry } from "../lib/useAnalyticsQuery";
import { PivotTable, type PivotMeasure } from "../components/PivotTable";
import type { FlatPivotRow } from "../lib/pivot";

const SEGMENT = "items";
const METRICS = ["qty_sold", "gross_product_sales", "net_ex_vat", "item_contribution_pct"] as const;
const DIMS = ["category", "menu_item"] as const;

// The TopBar ExportMenu asks this page's registry entry for its export shape.
setPageExportRequest(SEGMENT, () => ({
  metrics: [...METRICS],
  dimensions: [...DIMS],
  sort: [{ by: "net_ex_vat", dir: "desc" }],
}));

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

const fmtPercent = (v: number) => `${formatNumber(v)}%`;

/** Merge extra params over the CURRENT search and render a hub segment URL. */
function segmentHref(search: string, segment: string, extra: Record<string, string>): string {
  const sp = new URLSearchParams(search);
  for (const [k, v] of Object.entries(extra)) sp.set(k, v);
  const qs = sp.toString();
  return `/reports/sales/${segment}${qs ? `?${qs}` : ""}`;
}

export default function Items() {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const { filters } = useUrlFilters(analyticsFilterCodec);
  const registry = useAnalyticsRegistry();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const base = buildFiltersBody(filters);
  const compare = compareSpec(filters);
  const body: AnalyticsQueryBody = {
    ...base,
    metrics: [...METRICS],
    dimensions: [...DIMS],
    sort: [{ by: "net_ex_vat", dir: "desc" }],
    ...(compare ? { compare } : {}),
  };

  // Data queries wait for a VALID metric catalog: without one there is nothing
  // to label or explain, and a disabled query never fires a doomed request.
  const catalogReady = registry.data != null && Array.isArray(registry.data.metrics);
  const query = useAnalyticsQuery(SEGMENT, body, { enabled: catalogReady });

  const measures = useMemo<PivotMeasure[]>(
    () => [
      { id: "qty_sold", label: t("salesReports.metrics.qty_sold"), format: formatNumber },
      { id: "gross_product_sales", label: t("salesReports.metrics.gross_product_sales"), format: formatCurrency },
      { id: "net_ex_vat", label: t("salesReports.metrics.net_ex_vat"), format: formatCurrency },
      { id: "item_contribution_pct", label: t("salesReports.metrics.item_contribution_pct"), format: fmtPercent },
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

  const rows = query.data?.rows ?? [];
  if (rows.length === 0) return <EmptyState title={t("salesReports.states.empty")} />;

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const onRowClick = (row: FlatPivotRow) => {
    // Groups toggle; a leaf (menu_item) row drills to the orders segment with
    // the item pinned via the shared `menuItemId` codec param (wave 4) — the
    // param rides the composed URL, so it is ONE history push.
    if (row.isSubtotal) {
      toggle(row.key);
      return;
    }
    const itemId = String(row.keys[1] ?? "");
    if (itemId === "") return;
    navigate(segmentHref(location.search, "orders", { menuItemId: itemId }));
  };

  const kpis = [
    { id: "qty_sold", icon: Package, tone: "violet" as const, format: formatNumber },
    { id: "gross_product_sales", icon: Receipt, tone: "blue" as const, format: formatCurrency },
    { id: "net_ex_vat", icon: Coins, tone: "teal" as const, format: formatCurrency },
  ];

  return (
    <section className="space-y-4" data-testid="page-items">
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
