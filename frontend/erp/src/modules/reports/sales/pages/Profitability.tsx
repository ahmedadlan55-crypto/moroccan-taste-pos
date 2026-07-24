// Sales Analytics Hub — "profitability" page (cap-gated by the hub on
// analytics.cost.view; this file renders only when the cap is held).
//
// Per-item cost/profit/margin plus the menu-engineering quadrant: a scatter of
// qty_sold × margin_pct with ReferenceLines at the MEDIANS, classifying items
// as Stars / Plowhorses / Puzzles / Dogs. No salesReports keys exist for the
// quadrant names yet (wanted: salesReports.profitability.quadrants.*), so the
// labels are inlined per-language via useLang.
import { useMemo } from "react";
import {
  CartesianGrid,
  ReferenceLine,
  Scatter,
  ScatterChart,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Coins, Percent, TrendingUp, Wallet, type LucideIcon } from "lucide-react";
import { Badge, EmptyState, ErrorState, ExplainNumber, LoadingState, MetricCard, type MetricTone } from "@/shared/ui";
import { ChartCard, useChartPalette, useChartsRtl } from "@/shared/charts";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatCurrency, formatNumber } from "@/shared/lib";
import { useLang, useT } from "@/i18n";
import { useUrlFilters } from "@/shared/hooks/useUrlFilters";
import { analyticsFilterCodec } from "../lib/filters";
import { buildFiltersBody, displayMetric, type AnalyticsQueryBody, type AnalyticsResult } from "../lib/api";
import { useAnalyticsQuery } from "../lib/useAnalyticsQuery";

const METRICS = ["qty_sold", "net_ex_vat", "cogs", "gross_profit", "margin_pct"] as const;

const fmtPct = (v: number) => `${formatNumber(v)}%`;

function kpiValue(result: AnalyticsResult | undefined, id: string): number | null {
  if (!result) return null;
  const v = result.totals?.[id];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const row = result.rows[0];
  return row ? displayMetric(row, id) : null;
}

const KPIS: Array<{ id: string; eq: string; fmt: (v: number) => string; icon: LucideIcon; tone: MetricTone }> = [
  { id: "net_ex_vat", eq: "sum", fmt: formatCurrency, icon: Wallet, tone: "teal" },
  { id: "cogs", eq: "sum", fmt: formatCurrency, icon: Coins, tone: "blue" },
  { id: "gross_profit", eq: "grossProfit", fmt: formatCurrency, icon: TrendingUp, tone: "violet" },
  { id: "margin_pct", eq: "marginPct", fmt: fmtPct, icon: Percent, tone: "amber" },
];

type QuadrantClass = "star" | "plowhorse" | "puzzle" | "dog";

interface ItemRow {
  key: string;
  label: string;
  qty: number | null;
  net: number | null;
  cogs: number | null;
  profit: number | null;
  margin: number | null;
  cls: QuadrantClass | null;
}

/** Median of a non-empty sorted-copy sample. */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const QUADRANT_TONE: Record<QuadrantClass, "positive" | "negative" | "warning" | undefined> = {
  star: "positive",
  plowhorse: "warning",
  puzzle: undefined,
  dog: "negative",
};
const QUADRANT_BADGE: Record<QuadrantClass, "success" | "warning" | "info" | "danger"> = {
  star: "success",
  plowhorse: "warning",
  puzzle: "info",
  dog: "danger",
};

export default function Profitability() {
  const t = useT();
  const lang = useLang();
  const { filters } = useUrlFilters(analyticsFilterCodec);
  const palette = useChartPalette();
  const rtl = useChartsRtl();
  const base = useMemo(() => buildFiltersBody(filters), [filters]);

  // Wanted i18n keys: salesReports.profitability.quadrants.{stars,plowhorses,puzzles,dogs}
  const QUADRANT_LABEL: Record<QuadrantClass, string> =
    lang === "ar"
      ? { star: "نجوم", plowhorse: "أحصنة عمل", puzzle: "ألغاز", dog: "خاسرة" }
      : { star: "Stars", plowhorse: "Plowhorses", puzzle: "Puzzles", dog: "Dogs" };

  const kpiBody = useMemo<AnalyticsQueryBody>(
    () => ({ metrics: ["net_ex_vat", "cogs", "gross_profit", "margin_pct"], dimensions: [], ...base }),
    [base],
  );
  const itemBody = useMemo<AnalyticsQueryBody>(
    () => ({
      metrics: [...METRICS],
      dimensions: ["menu_item"],
      sort: [{ by: "net_ex_vat", dir: "desc" }],
      limit: 200,
      ...base,
    }),
    [base],
  );

  const kpis = useAnalyticsQuery("profitability-kpis", kpiBody);
  const byItem = useAnalyticsQuery("profitability-items", itemBody);

  if (byItem.isPending) return <LoadingState />;
  if (byItem.isError) return <ErrorState error={byItem.error} onRetry={() => byItem.refetch()} />;

  const raw: ItemRow[] = (byItem.data?.rows ?? []).map((r) => ({
    key: String(r.keys[0] ?? ""),
    label: r.labels[0] ?? String(r.keys[0] ?? "—"),
    qty: displayMetric(r, "qty_sold"),
    net: displayMetric(r, "net_ex_vat"),
    cogs: displayMetric(r, "cogs"),
    profit: displayMetric(r, "gross_profit"),
    margin: displayMetric(r, "margin_pct"),
    cls: null,
  }));
  if (raw.length === 0) return <EmptyState title={t("salesReports.states.empty")} />;

  // ── quadrant classification at the medians (plottable points only) ──
  const plottable = raw.filter((r) => r.qty != null && r.margin != null);
  const medQty = plottable.length > 0 ? median(plottable.map((r) => r.qty as number)) : 0;
  const medMargin = plottable.length > 0 ? median(plottable.map((r) => r.margin as number)) : 0;
  const items: ItemRow[] = raw.map((r) => {
    if (r.qty == null || r.margin == null) return r;
    const highQty = r.qty >= medQty;
    const highMargin = r.margin >= medMargin;
    const cls: QuadrantClass = highQty ? (highMargin ? "star" : "plowhorse") : highMargin ? "puzzle" : "dog";
    return { ...r, cls };
  });

  const meta = byItem.data?.meta;
  // Honest banner: masked/incomplete cost provenance (cogs masked, or the
  // completeness flag) — margins over that window are not fully cost-backed.
  const costCaveat =
    meta?.completeness?.complete === false || (meta?.maskedMetrics ?? []).includes("cogs");

  const scatterPoints = items
    .filter((r) => r.qty != null && r.margin != null)
    .map((r) => ({ x: r.qty as number, y: r.margin as number, name: r.label, cls: r.cls }));

  const columns: ColumnDef<ItemRow>[] = [
    { id: "item", header: t("salesReports.dims.menu_item"), accessor: (r) => r.label, pinStart: true, width: 180 },
    {
      id: "qty",
      header: t("salesReports.metrics.qty_sold"),
      accessor: (r) => r.qty,
      cell: (r) => (r.qty == null ? "—" : formatNumber(r.qty)),
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
    {
      id: "cogs",
      header: t("salesReports.metrics.cogs"),
      accessor: (r) => r.cogs,
      cell: (r) => (r.cogs == null ? "—" : formatCurrency(r.cogs)),
      numeric: true,
      sortable: true,
    },
    {
      id: "profit",
      header: t("salesReports.metrics.gross_profit"),
      accessor: (r) => r.profit,
      cell: (r) => (r.profit == null ? "—" : formatCurrency(r.profit)),
      numeric: true,
      sortable: true,
    },
    {
      id: "margin",
      header: t("salesReports.metrics.margin_pct"),
      accessor: (r) => r.margin,
      cell: (r) => (r.margin == null ? "—" : fmtPct(r.margin)),
      numeric: true,
      sortable: true,
      cellTone: (r) => (r.cls ? QUADRANT_TONE[r.cls] : undefined),
    },
    {
      id: "class",
      header: t("salesReports.pages.profitability.title"),
      accessor: (r) => (r.cls ? QUADRANT_LABEL[r.cls] : null),
      cell: (r) => (r.cls ? <Badge tone={QUADRANT_BADGE[r.cls]}>{QUADRANT_LABEL[r.cls]}</Badge> : "—"),
    },
  ];

  return (
    <section aria-labelledby="sales-hub-page-profitability" className="space-y-4">
      <div>
        <h2 id="sales-hub-page-profitability" className="text-lg font-extrabold text-slate-900">
          {t("salesReports.pages.profitability.title")}
        </h2>
        <p className="mt-0.5 text-sm font-medium text-slate-500">{t("salesReports.pages.profitability.subtitle")}</p>
      </div>

      {costCaveat && (
        <div data-testid="cost-provenance-notice">
          <Badge tone="warning">
            {t("salesReports.metrics.cogs")}: {t("salesReports.states.notAvailableHistorically")}
          </Badge>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {KPIS.map((k) => {
          const label = t(`salesReports.metrics.${k.id}`);
          const v = kpiValue(kpis.data, k.id);
          return (
            <div key={k.id} data-testid={`kpi-${k.id}`}>
              <MetricCard
                label={label}
                value={v == null ? "—" : k.fmt(v)}
                icon={k.icon}
                tone={k.tone}
                explain={
                  <ExplainNumber title={label} formula={t(`salesReports.explain.${k.eq}`)} triggerLabel={label} />
                }
              />
            </div>
          );
        })}
      </div>

      {scatterPoints.length > 0 && (
        <ChartCard
          title={`${t("salesReports.metrics.margin_pct")} × ${t("salesReports.metrics.qty_sold")}`}
          subtitle={`${QUADRANT_LABEL.star} / ${QUADRANT_LABEL.plowhorse} / ${QUADRANT_LABEL.puzzle} / ${QUADRANT_LABEL.dog}`}
          height={320}
          tableLabel={t("salesReports.dims.menu_item")}
          tableColumns={[
            { key: "name", label: t("salesReports.dims.menu_item") },
            { key: "x", label: t("salesReports.metrics.qty_sold") },
            { key: "y", label: t("salesReports.metrics.margin_pct") },
            { key: "cls", label: t("salesReports.pages.profitability.title") },
          ]}
          tableRows={scatterPoints.map((p) => ({
            name: p.name,
            x: formatNumber(p.x),
            y: fmtPct(p.y),
            cls: p.cls ? QUADRANT_LABEL[p.cls] : "—",
          }))}
        >
          <ScatterChart margin={{ top: 16, bottom: 8 }}>
            <CartesianGrid stroke={palette.grid} />
            <XAxis
              type="number"
              dataKey="x"
              name={t("salesReports.metrics.qty_sold")}
              reversed={rtl.xAxisReversed}
              stroke={palette.axis}
              tickFormatter={rtl.tickFormatterNumber}
              tick={{ fontSize: 11 }}
            />
            <YAxis
              type="number"
              dataKey="y"
              name={t("salesReports.metrics.margin_pct")}
              orientation={rtl.dir === "rtl" ? "right" : "left"}
              stroke={palette.axis}
              tickFormatter={rtl.tickFormatterNumber}
              tick={{ fontSize: 11 }}
            />
            <RechartsTooltip
              contentStyle={rtl.tooltipStyle}
              cursor={{ strokeDasharray: "3 3" }}
              formatter={(v) => rtl.tickFormatterNumber(v)}
            />
            {/* Median cross-hairs: the quadrant boundaries. */}
            <ReferenceLine x={medQty} stroke={palette.axis} strokeDasharray="4 4" />
            <ReferenceLine y={medMargin} stroke={palette.axis} strokeDasharray="4 4" />
            <Scatter data={scatterPoints} fill={palette.series[0]} />
          </ScatterChart>
        </ChartCard>
      )}

      <DataTable<ItemRow>
        columns={columns}
        rows={items}
        getRowId={(r) => r.key || r.label}
        initialPageSize={25}
        columnMenu={false}
        searchable
        emptyTitle={t("salesReports.states.empty")}
        mobileTitle={(r) => r.label}
      />
    </section>
  );
}
