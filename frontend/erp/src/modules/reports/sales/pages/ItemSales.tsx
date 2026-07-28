// Sales Analytics Hub — "item-sales" page (مبيعات الأصناف).
//
// The day × item × branch decision table: quantity, gross, the per-LINE
// discount, returns, net — and, only for a holder of analytics.cost.view, cost
// / gross profit / margin. No chart lives here: reports are decision tables,
// charts belong on the dashboard.
//
// discounts_line (NOT discounts_total) is what makes an item-level discount
// column possible at all: discounts_total sits on the `order` fact, so the
// planner 422'd ANALYTICS_UNSUPPORTED_COMBINATION the moment menu_item was in
// play. discounts_line allocates the same money per line (d.discount_amount).
import { useEffect, useMemo } from "react";
import { Badge, EmptyState, ErrorState, LoadingState } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatCurrency, formatNumber } from "@/shared/lib";
import { useT } from "@/i18n";
import { useCan } from "@/shared/permissions";
import { useUrlFilters } from "@/shared/hooks/useUrlFilters";
import { analyticsFilterCodec } from "../lib/filters";
import {
  buildFiltersBody,
  displayMetric,
  setPageExportRequest,
  type AnalyticsQueryBody,
  type PageExportSpec,
} from "../lib/api";
import { useAnalyticsQuery } from "../lib/useAnalyticsQuery";
import { isCostUndefined } from "../lib/cost";

const SEGMENT = "item-sales";
const CAP_COST = "analytics.cost.view";

/** Metrics every viewer of the hub gets. */
const BASE_METRICS = [
  "qty_sold",
  "gross_product_sales",
  "discounts_line",
  "returns_net",
  "net_ex_vat",
] as const;
/** Metrics behind analytics.cost.view — never requested without the cap. */
const COST_METRICS = ["cogs", "gross_profit", "margin_pct"] as const;

/**
 * Three dimensions is the planner's hard ceiling (lib/analytics/planner.js
 * MAX_DIMENSIONS), so day × item × branch uses the whole budget: one row per
 * item per branch per day multiplies fast. Ask for the planner's MAX_LIMIT and
 * SAY SO when the server reports it capped, rather than showing a silently
 * truncated table that reads like the whole period.
 */
const ROW_LIMIT = 500;

/** The day dimension must follow the top bar's date-basis toggle, or the report
 *  groups by a different day than the one it filters on. */
function dayDimension(businessDay: boolean): string {
  return businessDay ? "business_day" : "calendar_day";
}

function exportSpec(businessDay: boolean, withCost: boolean): PageExportSpec {
  const dayDim = dayDimension(businessDay);
  return {
    metrics: [...BASE_METRICS, ...(withCost ? COST_METRICS : [])],
    dimensions: [dayDim, "menu_item", "branch"],
    sort: [
      { by: dayDim, dir: "asc" },
      { by: "net_ex_vat", dir: "desc" },
    ],
    limit: ROW_LIMIT,
  };
}

// The TopBar ExportMenu asks this page's registry entry for its export shape;
// registering at module scope means the menu never falls back to the generic
// DEFAULT_EXPORT_SPEC, even before this component has rendered once.
setPageExportRequest(SEGMENT, (filters) => exportSpec(filters.businessDay, true));

interface ItemSalesRow {
  key: string;
  day: string;
  dayLabel: string;
  item: string;
  branch: string;
  qty: number | null;
  gross: number | null;
  discount: number | null;
  returns: number | null;
  net: number | null;
  cogs: number | null;
  profit: number | null;
  margin: number | null;
  /** The row sold something but carries NO defined cost — see `costUndefined`. */
  costUndefined: boolean;
}

const money = (v: number | null) => (v == null ? "—" : formatCurrency(v));
const qty = (v: number | null) => (v == null ? "—" : formatNumber(v));
const pct = (v: number | null) => (v == null ? "—" : `${formatNumber(v)}%`);

export default function ItemSales() {
  const t = useT();
  const canCost = useCan(CAP_COST);
  const { filters } = useUrlFilters(analyticsFilterCodec);
  const base = useMemo(() => buildFiltersBody(filters), [filters]);
  const dayDim = dayDimension(filters.businessDay);

  // Narrow the registered export to what THIS viewer may actually read: a
  // capless viewer must not pull the cost columns out through the export menu
  // either. The module-scope registration above still owns the pre-render case.
  useEffect(() => {
    setPageExportRequest(SEGMENT, (f) => exportSpec(f.businessDay, canCost));
  }, [canCost]);

  const body = useMemo<AnalyticsQueryBody>(
    () => ({
      metrics: [...BASE_METRICS, ...(canCost ? COST_METRICS : [])],
      dimensions: [dayDim, "menu_item", "branch"],
      sort: [
        { by: dayDim, dir: "asc" },
        { by: "net_ex_vat", dir: "desc" },
      ],
      limit: ROW_LIMIT,
      ...base,
    }),
    [base, dayDim, canCost],
  );

  const query = useAnalyticsQuery(SEGMENT, body);

  const rows = useMemo<ItemSalesRow[]>(
    () =>
      (query.data?.rows ?? []).map((r, i) => {
        const soldQty = displayMetric(r, "qty_sold");
        const cost = canCost ? displayMetric(r, "cogs") : null;
        const unknownCost = canCost && isCostUndefined(soldQty, cost);
        return {
          key: `${String(r.keys[0] ?? "")}|${String(r.keys[1] ?? "")}|${String(r.keys[2] ?? "")}|${i}`,
          day: String(r.keys[0] ?? ""),
          dayLabel: r.labels[0] || String(r.keys[0] ?? "—"),
          item: r.labels[1] || String(r.keys[1] ?? "—"),
          branch: r.labels[2] || String(r.keys[2] ?? "—"),
          qty: soldQty,
          gross: displayMetric(r, "gross_product_sales"),
          discount: displayMetric(r, "discounts_line"),
          returns: displayMetric(r, "returns_net"),
          net: displayMetric(r, "net_ex_vat"),
          cogs: unknownCost ? null : cost,
          profit: unknownCost ? null : canCost ? displayMetric(r, "gross_profit") : null,
          margin: unknownCost ? null : canCost ? displayMetric(r, "margin_pct") : null,
          costUndefined: unknownCost,
        };
      }),
    [query.data, canCost],
  );

  const columns = useMemo<ColumnDef<ItemSalesRow>[]>(
    () => [
      {
        id: "day",
        header: t(`salesReports.dims.${dayDim}`),
        accessor: (r) => r.day,
        cell: (r) => r.dayLabel,
        pinStart: true,
        width: 120,
        sortable: true,
      },
      {
        id: "item",
        header: t("salesReports.dims.menu_item"),
        accessor: (r) => r.item,
        pinStart: true,
        width: 180,
        ellipsis: true,
        sortable: true,
      },
      {
        id: "branch",
        header: t("salesReports.dims.branch"),
        accessor: (r) => r.branch,
        sortable: true,
      },
      {
        id: "qty_sold",
        header: t("salesReports.metrics.qty_sold"),
        accessor: (r) => r.qty,
        cell: (r) => qty(r.qty),
        numeric: true,
        sortable: true,
      },
      {
        id: "gross_product_sales",
        header: t("salesReports.metrics.gross_product_sales"),
        accessor: (r) => r.gross,
        cell: (r) => money(r.gross),
        numeric: true,
        sortable: true,
      },
      {
        id: "discounts_line",
        header: t("salesReports.metrics.discounts_line"),
        accessor: (r) => r.discount,
        cell: (r) => money(r.discount),
        numeric: true,
        sortable: true,
      },
      {
        id: "returns_net",
        header: t("salesReports.metrics.returns_net"),
        accessor: (r) => r.returns,
        cell: (r) => money(r.returns),
        numeric: true,
        sortable: true,
      },
      {
        id: "net_ex_vat",
        header: t("salesReports.metrics.net_ex_vat"),
        accessor: (r) => r.net,
        cell: (r) => money(r.net),
        numeric: true,
        sortable: true,
      },
      // The three cost columns are dropped ENTIRELY (header, cells, CSV) for a
      // viewer without the cap — an em-dash column would read as "we have no
      // cost data", which is a different claim than "you may not see it".
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
          ) : (
            money(r.cogs)
          ),
        numeric: true,
        sortable: true,
        requireCap: CAP_COST,
      },
      {
        id: "gross_profit",
        header: t("salesReports.metrics.gross_profit"),
        accessor: (r) => r.profit,
        cell: (r) => money(r.profit),
        numeric: true,
        sortable: true,
        requireCap: CAP_COST,
      },
      {
        id: "margin_pct",
        header: t("salesReports.metrics.margin_pct"),
        accessor: (r) => r.margin,
        cell: (r) => pct(r.margin),
        numeric: true,
        sortable: true,
        requireCap: CAP_COST,
        cellTone: (r) => (r.costUndefined ? "warning" : undefined),
      },
    ],
    [t, dayDim],
  );

  if (query.isPending) return <LoadingState rows={6} />;
  if (query.isError) return <ErrorState error={query.error} title={t("salesReports.states.loadFailed")} onRetry={() => void query.refetch()} />;
  if (rows.length === 0) return <EmptyState title={t("salesReports.states.empty")} />;

  const uncostedRows = rows.filter((r) => r.costUndefined).length;
  // The server KNOWS whether a fact hit the cap (QueryService page.rowCountCapped)
  // — trust that over `rows.length >= ROW_LIMIT`, which claims truncation on a
  // period that merely happens to produce exactly 500 rows. Fall back to the
  // length test only when an older server omits the flag.
  const page = query.data?.page;
  const truncated = page?.rowCountCapped ?? (rows.length >= ROW_LIMIT);

  return (
    <section aria-labelledby="sales-hub-page-item-sales" className="space-y-4">
      <div>
        <h2 id="sales-hub-page-item-sales" className="text-lg font-extrabold text-slate-900">
          {t("salesReports.pages.item-sales.title")}
        </h2>
        <p className="mt-0.5 text-sm font-medium text-slate-500">
          {t("salesReports.pages.item-sales.subtitle")}
        </p>
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
          {t("salesReports.itemSales.rowLimit", { count: formatNumber(ROW_LIMIT) })}
        </div>
      )}

      <DataTable<ItemSalesRow>
        columns={columns}
        rows={rows}
        getRowId={(r) => r.key}
        canColumn={(cap) => (cap === CAP_COST ? canCost : true)}
        initialPageSize={25}
        columnMenu={false}
        searchable
        emptyTitle={t("salesReports.states.empty")}
        mobileTitle={(r) => r.item}
      />
    </section>
  );
}
