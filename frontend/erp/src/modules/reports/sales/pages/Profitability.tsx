// Sales Analytics Hub — "profitability" page (cap-gated by the hub on
// analytics.cost.view; this file renders only when the cap is held).
//
// Per-item cost/profit/margin plus the menu-engineering quadrant: every item is
// classified against the MEDIAN qty_sold and margin_pct as a Star / Plowhorse /
// Puzzle / Dog (labels from salesReports.profitability.quadrants.*) and that
// class is carried as a table column. Reports are decision tables here — the
// quadrant scatter that used to sit above the table belongs on the dashboard.
import { useMemo } from "react";
import { Coins, Percent, TrendingUp, Wallet, type LucideIcon } from "lucide-react";
import { Badge, EmptyState, ErrorState, ExplainNumber, LoadingState, MetricCard, type MetricTone } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatCurrency, formatNumber } from "@/shared/lib";
import { useT } from "@/i18n";
import { useUrlFilters } from "@/shared/hooks/useUrlFilters";
import { analyticsFilterCodec } from "../lib/filters";
import {
  buildFiltersBody,
  displayMetric,
  setPageExportRequest,
  type AnalyticsQueryBody,
  type AnalyticsResult,
} from "../lib/api";
import { useAnalyticsQuery } from "../lib/useAnalyticsQuery";
import { isCostUndefined } from "../lib/cost";

const SEGMENT = "profitability";
const METRICS = ["qty_sold", "net_ex_vat", "cogs", "gross_profit", "margin_pct"] as const;

// The TopBar ExportMenu asks this page's registry entry for its export shape.
setPageExportRequest(SEGMENT, () => ({
  metrics: [...METRICS],
  dimensions: ["menu_item"],
  sort: [{ by: "net_ex_vat", dir: "desc" }],
}));

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
  /** Sold, but with no cost ever defined — see ../lib/cost. */
  costUndefined: boolean;
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
  const { filters } = useUrlFilters(analyticsFilterCodec);
  const base = useMemo(() => buildFiltersBody(filters), [filters]);

  const QUADRANT_LABEL: Record<QuadrantClass, string> = {
    star: t("salesReports.profitability.quadrants.stars"),
    plowhorse: t("salesReports.profitability.quadrants.plowhorses"),
    puzzle: t("salesReports.profitability.quadrants.puzzles"),
    dog: t("salesReports.profitability.quadrants.dogs"),
  };

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

  const raw: ItemRow[] = (byItem.data?.rows ?? []).map((r) => {
    const qtySold = displayMetric(r, "qty_sold");
    const cost = displayMetric(r, "cogs");
    // An item with no recipe and no manual cost snapshots 0.00, which reads as
    // margin 100%. Blank the three cost columns rather than print a number the
    // system cannot stand behind.
    const unknownCost = isCostUndefined(qtySold, cost);
    return {
      key: String(r.keys[0] ?? ""),
      label: r.labels[0] ?? String(r.keys[0] ?? "—"),
      qty: qtySold,
      net: displayMetric(r, "net_ex_vat"),
      cogs: unknownCost ? null : cost,
      profit: unknownCost ? null : displayMetric(r, "gross_profit"),
      margin: unknownCost ? null : displayMetric(r, "margin_pct"),
      cls: null,
      costUndefined: unknownCost,
    };
  });
  if (raw.length === 0) return <EmptyState title={t("salesReports.states.empty")} />;

  // ── quadrant classification at the medians (rows with both inputs only) ──
  // Uncosted rows are excluded TWICE OVER, and both exclusions matter:
  //   1. from the sample — a phantom 100% margin drags the median margin up and
  //      mislabels genuinely good items as Plowhorses;
  //   2. from classification — its own `margin` is null above, so it can never
  //      be crowned a Star. Recommending "push this item" on the strength of a
  //      margin nobody has ever computed is the worst advice this page could
  //      give, and it is exactly what an unguarded zero produces.
  const classifiable = raw.filter((r) => r.qty != null && r.margin != null);
  const medQty = classifiable.length > 0 ? median(classifiable.map((r) => r.qty as number)) : 0;
  const medMargin = classifiable.length > 0 ? median(classifiable.map((r) => r.margin as number)) : 0;
  const items: ItemRow[] = raw.map((r) => {
    if (r.qty == null || r.margin == null) return r;
    const highQty = r.qty >= medQty;
    const highMargin = r.margin >= medMargin;
    const cls: QuadrantClass = highQty ? (highMargin ? "star" : "plowhorse") : highMargin ? "puzzle" : "dog";
    return { ...r, cls };
  });
  const uncostedItems = items.filter((r) => r.costUndefined);

  const meta = byItem.data?.meta;
  // Honest banner: masked/incomplete cost provenance (cogs masked, or the
  // completeness flag) — margins over that window are not fully cost-backed.
  const costCaveat =
    meta?.completeness?.complete === false || (meta?.maskedMetrics ?? []).includes("cogs");

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
      cell: (r) =>
        r.costUndefined ? (
          <span className="inline-flex items-center gap-1.5">
            <span>—</span>
            <Badge tone="warning" title={t("salesReports.itemSales.costUndefinedHint")}>
              {t("salesReports.itemSales.costUndefined")}
            </Badge>
          </span>
        ) : r.cogs == null ? (
          "—"
        ) : (
          formatCurrency(r.cogs)
        ),
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
      cellTone: (r) => (r.costUndefined ? "warning" : r.cls ? QUADRANT_TONE[r.cls] : undefined),
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

      {/* The KPI cards below sum the WHOLE window, so an uncosted item is
          invisible there — its zero cost just reads as profit. Name the count
          explicitly, or the four headline numbers overstate the business by an
          amount nobody can see. */}
      {uncostedItems.length > 0 && (
        <div
          data-testid="uncosted-notice"
          className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-bold text-amber-800"
        >
          <span>
            {t("salesReports.profitability.uncostedItems", {
              count: formatNumber(uncostedItems.length),
            })}
          </span>
          <span className="font-medium">{t("salesReports.itemSales.costUndefinedHint")}</span>
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
