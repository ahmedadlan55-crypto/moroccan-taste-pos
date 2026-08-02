// Sales Analytics Hub — "discounts" page.
//
// KPI row (dimensionless analytics query) + three decision tables: discounts by
// day (click-to-filter drill onto that day), by NAMED DISCOUNT, and by cashier
// (drill → the cashiers report, preserving the current search params).
//
// The reason table used to be an apology:  was a reserved id
// in the contract with no projector behind it, so this page carried a banner
// saying the dimension did not exist. analytics_order_facts.discount_reason now
// carries the snapshot ProjectionService writes from sales.discount_name, so
// the question "which named discounts are costing us this" has a table instead.
import { useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { BadgePercent, Percent, ShoppingCart, TicketPercent, type LucideIcon } from "lucide-react";
import { Badge, EmptyState, ErrorState, ExplainNumber, LoadingState, MetricCard, type MetricTone } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatCurrency, formatNumber } from "@/shared/lib";
import { useT } from "@/i18n";
import { useUrlFilters } from "@/shared/hooks/useUrlFilters";
import { analyticsFilterCodec } from "../lib/filters";
import {
  buildFiltersBody,
  displayMetric,
  reportQuerySpec,
  type AnalyticsQueryBody,
  type AnalyticsResult,
} from "../lib/api";
import { useAnalyticsQuery } from "../lib/useAnalyticsQuery";

const SEGMENT = "discounts";
// Metrics, groupings and the export shape all come from lib/reportRegistry. The
// day dimension there is the `"day"` placeholder, resolved against the active
// date basis, so the table and the exported file group by the day they filter
// on rather than by a hardcoded business_day.

/** discount_pct at/above this (percent points) reads as a warning tone. */
const HIGH_DISCOUNT_PCT = 10;

const fmtPct = (v: number) => `${formatNumber(v)}%`;

function kpiValue(result: AnalyticsResult | undefined, id: string): number | null {
  if (!result) return null;
  const v = result.totals?.[id];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const row = result.rows[0];
  return row ? displayMetric(row, id) : null;
}

interface DimRow {
  key: string;
  label: string;
  discounts_total: number | null;
  discount_pct: number | null;
  discounted_orders: number | null;
  orders: number | null;
}

function toDimRows(result: AnalyticsResult | undefined): DimRow[] {
  return (result?.rows ?? []).map((r) => ({
    key: String(r.keys[0] ?? ""),
    label: r.labels[0] ?? String(r.keys[0] ?? "—"),
    discounts_total: displayMetric(r, "discounts_total"),
    discount_pct: displayMetric(r, "discount_pct"),
    discounted_orders: displayMetric(r, "discounted_orders"),
    orders: displayMetric(r, "orders"),
  }));
}

const KPIS: Array<{ id: string; eq: string; fmt: (v: number) => string; icon: LucideIcon; tone: MetricTone }> = [
  { id: "discounts_total", eq: "sum", fmt: formatCurrency, icon: BadgePercent, tone: "rose" },
  { id: "discount_pct", eq: "discountPct", fmt: fmtPct, icon: Percent, tone: "amber" },
  { id: "discounted_orders", eq: "count", fmt: formatNumber, icon: TicketPercent, tone: "violet" },
  { id: "orders", eq: "count", fmt: formatNumber, icon: ShoppingCart, tone: "teal" },
];

export default function Discounts() {
  const t = useT();
  const navigate = useNavigate();
  const { search } = useLocation();
  const { filters, patch } = useUrlFilters(analyticsFilterCodec);

  const dayDim = filters.businessDay ? "business_day" : "calendar_day";
  const base = useMemo(() => buildFiltersBody(filters), [filters]);

  const kpiBody = useMemo<AnalyticsQueryBody>(
    () => ({ ...reportQuerySpec(SEGMENT, "kpis", filters), ...base }),
    [base, filters],
  );
  const dayBody = useMemo<AnalyticsQueryBody>(
    () => ({ ...reportQuerySpec(SEGMENT, "byDay", filters), sort: [{ by: dayDim, dir: "asc" }], ...base }),
    [base, dayDim, filters],
  );
  const cashierBody = useMemo<AnalyticsQueryBody>(
    () => ({
      ...reportQuerySpec(SEGMENT, "byCashier", filters),
      sort: [{ by: "discounts_total", dir: "desc" }],
      limit: 25,
      ...base,
    }),
    [base, filters],
  );

  const reasonBody = useMemo<AnalyticsQueryBody>(
    () => ({
      ...reportQuerySpec(SEGMENT, "byReason", filters),
      sort: [{ by: "discounts_total", dir: "desc" }],
      ...base,
    }),
    [base, filters],
  );

  const kpis = useAnalyticsQuery("discounts-kpis", kpiBody);
  const byDay = useAnalyticsQuery("discounts-day", dayBody);
  const byCashier = useAnalyticsQuery("discounts-cashier", cashierBody);
  const byReason = useAnalyticsQuery("discounts-reason", reasonBody);

  // Page-level states follow the PRIMARY (by-day) query.
  if (byDay.isPending) return <LoadingState />;
  if (byDay.isError) return <ErrorState error={byDay.error} onRetry={() => byDay.refetch()} />;

  const dayRows = toDimRows(byDay.data);
  const cashierRows = toDimRows(byCashier.data);
  // A NULL reason is a real bucket (a sale with no named discount), so it is
  // labelled rather than dropped — the reasons must add up to the period.
  const reasonRows = toDimRows(byReason.data).map((r) =>
    r.key === "" ? { ...r, label: t("salesReports.discounts.noReason") } : r,
  );
  if (dayRows.length === 0) return <EmptyState title={t("salesReports.states.empty")} />;

  const incomplete = byDay.data?.meta?.completeness?.complete === false;

  const dimCol = (header: string): ColumnDef<DimRow> => ({
    id: "label",
    header,
    accessor: (r) => r.label,
    pinStart: true, hideable: false,
    width: 160,
  });
  const metricCols: ColumnDef<DimRow>[] = [
    {
      id: "discounts_total",
      header: t("salesReports.metrics.discounts_total"),
      accessor: (r) => r.discounts_total,
      cell: (r) => (r.discounts_total == null ? "—" : formatCurrency(r.discounts_total)),
      numeric: true,
      sortable: true,
    },
    {
      id: "discount_pct",
      header: t("salesReports.metrics.discount_pct"),
      accessor: (r) => r.discount_pct,
      cell: (r) => (r.discount_pct == null ? "—" : fmtPct(r.discount_pct)),
      numeric: true,
      sortable: true,
      cellTone: (r) => (r.discount_pct != null && r.discount_pct >= HIGH_DISCOUNT_PCT ? "warning" : undefined),
    },
    {
      id: "discounted_orders",
      header: t("salesReports.metrics.discounted_orders"),
      accessor: (r) => r.discounted_orders,
      cell: (r) => (r.discounted_orders == null ? "—" : formatNumber(r.discounted_orders)),
      numeric: true,
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
  ];

  return (
    <section aria-labelledby="sales-hub-page-discounts" className="space-y-4">
      <div>
        <h2 id="sales-hub-page-discounts" className="text-lg font-extrabold text-slate-900">
          {t("salesReports.pages.discounts.title")}
        </h2>
        <p className="mt-0.5 text-sm font-medium text-slate-500">{t("salesReports.pages.discounts.subtitle")}</p>
      </div>

      {incomplete && (
        <div data-testid="completeness-notice">
          <Badge tone="warning">{t("salesReports.states.notAvailableHistorically")}</Badge>
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

      {/* Reports are decision tables; the charted view of these same rows lives
          on the dashboard. */}
      <DataTable<DimRow>
        columns={[dimCol(t(`salesReports.dims.${dayDim}`)), ...metricCols]}
        rows={dayRows}
        getRowId={(r) => r.key || r.label}
        tableId="sales-hub-discounts-by-day"
        paginate={false}
        emptyTitle={t("salesReports.states.empty")}
        mobileTitle={(r) => r.label}
        onRowClick={(r) => r.key && patch({ from: r.key, to: r.key, preset: "custom" }, { push: true })}
      />

      {/* BY NAMED DISCOUNT. NULL is a real bucket — a sale that carried no
          named discount — so it is labelled rather than dropped: hiding it
          would make the reasons look like they add up to the period total when
          they do not. */}
      {byReason.isError ? (
        <ErrorState error={byReason.error} onRetry={() => byReason.refetch()} />
      ) : (
        reasonRows.length > 0 && (
          <DataTable<DimRow>
            // No discount_pct column: the reason lives on the ORDER fact and
            // the rate's denominator (gross_product_sales) lives on the LINE
            // fact, so the figure is not computable at this grain. An em-dash
            // column would read as "we could not measure it here", which is a
            // weaker claim than "it does not exist at this grain".
            columns={[
              dimCol(t("salesReports.dims.discount_reason")),
              ...metricCols.filter((c) => c.id !== "discount_pct"),
            ]}
            rows={reasonRows}
            getRowId={(r) => r.key || r.label}
            tableId="sales-hub-discounts-by-reason"
            paginate={false}
            emptyTitle={t("salesReports.states.empty")}
            mobileTitle={(r) => r.label}
          />
        )
      )}

      {byCashier.isError ? (
        <ErrorState error={byCashier.error} onRetry={() => byCashier.refetch()} />
      ) : (
        cashierRows.length > 0 && (
          <DataTable<DimRow>
            columns={[dimCol(t("salesReports.dims.cashier")), ...metricCols]}
            rows={cashierRows}
            getRowId={(r) => r.key || r.label}
            tableId="sales-hub-discounts-by-cashier"
            paginate={false}
            emptyTitle={t("salesReports.states.empty")}
            mobileTitle={(r) => r.label}
            onRowClick={() => navigate(`/reports/sales/cashiers${search}`)}
          />
        )
      )}
    </section>
  );
}
