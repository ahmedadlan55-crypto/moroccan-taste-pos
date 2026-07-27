// Sales Analytics Hub — "hours" page.
//
// The peak map: a weekday × hour heatmap of net sales (hour, not half_hour, is
// the v1 grain) and the hour table synced to the same data. Wave 4: a heat cell
// click drills to the orders segment with the clicked hour pinned via the
// shared `hour` codec param (merged into the CURRENT search so every other
// filter is preserved — one history push).
//
// No chart here: reports are decision tables, charts live on the dashboard.
// The heatmap stays — it is a data grid (cells carry values and drill), not a plot.
import { useMemo } from "react";
import { Clock, Coins, ShoppingBag } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { Badge, EmptyState, ErrorState, ExplainNumber, LoadingState, MetricCard } from "@/shared/ui";
// Deep import: the charts barrel would pull ChartCard → recharts eagerly.
import { Heatmap, type HeatmapCell } from "@/shared/charts/Heatmap";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { useUrlFilters } from "@/shared/hooks/useUrlFilters";
import { computeCompareRange } from "@/shared/ui/date-range-picker";
import { formatCurrency, formatNumber } from "@/shared/lib";
import { useT, type TFunction } from "@/i18n";
import { analyticsFilterCodec, type AnalyticsFilters } from "../lib/filters";
import {
  buildFiltersBody,
  displayMetric,
  setPageExportRequest,
  type AnalyticsCompareSpec,
  type AnalyticsQueryBody,
  type AnalyticsRegistry,
  type AnalyticsResult,
} from "../lib/api";
import { useAnalyticsQuery, useAnalyticsRegistry } from "../lib/useAnalyticsQuery";

const SEGMENT = "hours";

// The TopBar ExportMenu asks this page's registry entry for its export shape.
setPageExportRequest(SEGMENT, () => ({
  metrics: ["orders", "net_ex_vat"],
  dimensions: ["hour"],
  sort: [{ by: "hour", dir: "asc" }],
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

/** Merge extra params over the CURRENT search and render a hub segment URL. */
function segmentHref(search: string, segment: string, extra: Record<string, string>): string {
  const sp = new URLSearchParams(search);
  for (const [k, v] of Object.entries(extra)) sp.set(k, v);
  const qs = sp.toString();
  return `/reports/sales/${segment}${qs ? `?${qs}` : ""}`;
}

interface HourRow {
  key: string;
  label: string;
  orders: number | null;
  net: number | null;
}

export default function Hours() {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const { filters } = useUrlFilters(analyticsFilterCodec);
  const registry = useAnalyticsRegistry();

  const base = buildFiltersBody(filters);
  const compare = compareSpec(filters);

  const heatBody: AnalyticsQueryBody = {
    ...base,
    metrics: ["net_ex_vat"],
    dimensions: ["weekday", "hour"],
    sort: [
      { by: "weekday", dir: "asc" },
      { by: "hour", dir: "asc" },
    ],
  };
  const byHourBody: AnalyticsQueryBody = {
    ...base,
    metrics: ["orders", "net_ex_vat"],
    dimensions: ["hour"],
    sort: [{ by: "hour", dir: "asc" }],
    ...(compare ? { compare } : {}),
  };

  // Data queries wait for a VALID metric catalog: without one there is nothing
  // to label or explain, and a disabled query never fires a doomed request.
  const catalogReady = registry.data != null && Array.isArray(registry.data.metrics);
  const heat = useAnalyticsQuery(SEGMENT, heatBody, { enabled: catalogReady });
  const byHour = useAnalyticsQuery(SEGMENT, byHourBody, { enabled: catalogReady });

  const { heatRows, heatCols, heatCells } = useMemo(() => {
    const rows = heat.data?.rows ?? [];
    const weekdays = new Map<string, string>();
    const hours = new Map<string, string>();
    const cells: HeatmapCell[] = [];
    for (const row of rows) {
      const wd = row.keys[0];
      const hr = row.keys[1];
      if (wd == null || hr == null) continue;
      const wdKey = String(wd);
      const hrKey = String(hr);
      if (!weekdays.has(wdKey)) weekdays.set(wdKey, row.labels[0] ?? wdKey);
      if (!hours.has(hrKey)) hours.set(hrKey, row.labels[1] ?? hrKey);
      const v = displayMetric(row, "net_ex_vat");
      if (v != null) cells.push({ row: wdKey, col: hrKey, value: v });
    }
    const numeric = (a: [string, string], b: [string, string]) => Number(a[0]) - Number(b[0]);
    return {
      heatRows: [...weekdays.entries()].sort(numeric).map(([key, label]) => ({ key, label })),
      heatCols: [...hours.entries()].sort(numeric).map(([key, label]) => ({ key, label })),
      heatCells: cells,
    };
  }, [heat.data]);

  const hourRows = useMemo<HourRow[]>(
    () =>
      (byHour.data?.rows ?? []).map((row) => ({
        key: String(row.keys[0] ?? ""),
        label: row.labels[0] ?? String(row.keys[0] ?? ""),
        orders: displayMetric(row, "orders"),
        net: displayMetric(row, "net_ex_vat"),
      })),
    [byHour.data],
  );

  const columns = useMemo<ColumnDef<HourRow>[]>(
    () => [
      {
        id: "hour",
        header: t("salesReports.dims.hour"),
        accessor: (r) => Number(r.key),
        cell: (r) => r.label,
        pinStart: true,
        width: 112,
        sortable: true,
      },
      {
        id: "orders",
        header: t("salesReports.metrics.orders"),
        accessor: (r) => r.orders,
        cell: (r) => (r.orders == null ? "—" : formatNumber(r.orders)),
        numeric: true,
        sortable: true,
      },
      {
        id: "net",
        header: t("salesReports.metrics.net_ex_vat"),
        accessor: (r) => r.net,
        cell: (r) => (r.net == null ? "—" : formatCurrency(r.net)),
        numeric: true,
        sortable: true,
      },
    ],
    [t],
  );

  const isLoading = registry.isLoading || heat.isLoading || byHour.isLoading;
  const error = registry.error ?? heat.error ?? byHour.error;

  if (isLoading) return <LoadingState rows={6} />;
  if (error) {
    return (
      <ErrorState
        error={error}
        title={t("salesReports.states.loadFailed")}
        onRetry={() => {
          void registry.refetch();
          void heat.refetch();
          void byHour.refetch();
        }}
      />
    );
  }
  if (hourRows.length === 0 && heatCells.length === 0) {
    return <EmptyState title={t("salesReports.states.empty")} />;
  }

  // Heat-cell drill: hand off to the orders segment with the CURRENT filters
  // preserved AND the clicked hour pinned (`hour` codec param, wave 4). The
  // param rides the composed URL so it is ONE history push (Back restores).
  const onCellClick = (cell: HeatmapCell) =>
    navigate(segmentHref(location.search, "orders", { hour: cell.col }));

  const kpis = [
    { id: "net_ex_vat", icon: Coins, tone: "teal" as const, format: formatCurrency },
    { id: "orders", icon: ShoppingBag, tone: "violet" as const, format: formatNumber },
  ];

  return (
    <section className="space-y-4" data-testid="page-hours">
      <CompletenessNotice meta={byHour.data?.meta} />

      <div className="grid gap-4 sm:grid-cols-2" data-testid="kpi-row">
        {kpis.map(({ id, icon, tone, format }) => {
          const v = totalValue(byHour.data, id);
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

      <article className="surface p-5">
        <header className="mb-4 flex items-center gap-2">
          <Clock className="h-4 w-4 text-teal-700" aria-hidden="true" />
          <h2 className="text-base font-extrabold text-slate-900">
            {`${t("salesReports.metrics.net_ex_vat")} — ${t("salesReports.dims.weekday")} × ${t("salesReports.dims.hour")}`}
          </h2>
        </header>
        {heatCells.length === 0 ? (
          <div className="grid h-40 place-items-center text-sm font-bold text-slate-400">
            {t("salesReports.charts.empty")}
          </div>
        ) : (
          <Heatmap
            rows={heatRows}
            cols={heatCols}
            cells={heatCells}
            onCellClick={onCellClick}
            ariaLabel={`${t("salesReports.metrics.net_ex_vat")} — ${t("salesReports.dims.weekday")} × ${t("salesReports.dims.hour")}`}
            tableLabel={t("salesReports.charts.showTable")}
            tableCaption={`${t("salesReports.metrics.net_ex_vat")} — ${t("salesReports.dims.weekday")} × ${t("salesReports.dims.hour")}`}
          />
        )}
      </article>

      <DataTable<HourRow>
        columns={columns}
        rows={hourRows}
        getRowId={(r) => r.key}
        initialSort={{ columnId: "hour", dir: "asc" }}
        emptyTitle={t("salesReports.states.empty")}
      />
    </section>
  );
}
