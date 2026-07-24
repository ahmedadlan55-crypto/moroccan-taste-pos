// Sales Analytics Hub — "reconciliation" page (v1: client-side three-way).
//
// Three PARALLEL analytics queries per day — sales (invoice_total/orders),
// collections (payments_in/refunds_out) and till (expected/counted) — merged
// client-side into one row per day with two deltas:
//   collectDelta = net collections − invoice total   (money in vs billed)
//   tillDelta    = counted − expected                 (drawer over/short)
// Any |delta| > EPS marks an exception day (negative tone). Loading waits for
// all three; ANY error fails the page (a partial reconciliation would lie).
//
// TODO(sales-hub): a server-side three-way reconciliation endpoint with an
// exception drill (day → the offending documents) lands next wave; this page
// then swaps its merge for that contract.
import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Legend, Tooltip as RechartsTooltip, XAxis, YAxis } from "recharts";
import { AlertTriangle, Scale, Wallet, type LucideIcon } from "lucide-react";
import { Badge, EmptyState, ErrorState, ExplainNumber, LoadingState, MetricCard, type MetricTone } from "@/shared/ui";
import { ChartCard, useChartPalette, useChartsRtl } from "@/shared/charts";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatCurrency, formatNumber } from "@/shared/lib";
import { useT } from "@/i18n";
import { useUrlFilters } from "@/shared/hooks/useUrlFilters";
import { analyticsFilterCodec } from "../lib/filters";
import { buildFiltersBody, displayMetric, type AnalyticsQueryBody, type AnalyticsResultRow } from "../lib/api";
import { useAnalyticsQuery } from "../lib/useAnalyticsQuery";

/** |delta| above this is an exception (money is exact to the halala). */
const EPS = 0.01;

interface DayRow {
  key: string;
  label: string;
  sales: number | null;
  orders: number | null;
  collections: number | null;
  tillExpected: number | null;
  tillCounted: number | null;
  collectDelta: number | null;
  tillDelta: number | null;
}

/** a − b, null-safe: null when BOTH inputs are null (never a fake 0). */
function sub(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) - (b ?? 0);
}

function upsert(map: Map<string, DayRow>, r: AnalyticsResultRow): DayRow {
  const key = String(r.keys[0] ?? "");
  const found = map.get(key);
  if (found) return found;
  const fresh: DayRow = {
    key,
    label: r.labels[0] ?? key,
    sales: null,
    orders: null,
    collections: null,
    tillExpected: null,
    tillCounted: null,
    collectDelta: null,
    tillDelta: null,
  };
  map.set(key, fresh);
  return fresh;
}

export default function Reconciliation() {
  const t = useT();
  const { filters } = useUrlFilters(analyticsFilterCodec);
  const palette = useChartPalette();
  const rtl = useChartsRtl();
  const base = useMemo(() => buildFiltersBody(filters), [filters]);
  const dayDim = filters.businessDay ? "business_day" : "calendar_day";

  const ordersBody = useMemo<AnalyticsQueryBody>(
    () => ({ metrics: ["invoice_total", "orders"], dimensions: [dayDim], sort: [{ by: dayDim, dir: "asc" }], ...base }),
    [base, dayDim],
  );
  const paymentsBody = useMemo<AnalyticsQueryBody>(
    () => ({ metrics: ["payments_in", "refunds_out"], dimensions: [dayDim], sort: [{ by: dayDim, dir: "asc" }], ...base }),
    [base, dayDim],
  );
  const tillBody = useMemo<AnalyticsQueryBody>(
    () => ({ metrics: ["till_expected_cash", "till_counted"], dimensions: [dayDim], sort: [{ by: dayDim, dir: "asc" }], ...base }),
    [base, dayDim],
  );

  const qOrders = useAnalyticsQuery("reconciliation-orders", ordersBody);
  const qPayments = useAnalyticsQuery("reconciliation-payments", paymentsBody);
  const qTill = useAnalyticsQuery("reconciliation-till", tillBody);

  // Loading = ALL three; error = ANY (a partial three-way merge would mislead).
  if (qOrders.isPending || qPayments.isPending || qTill.isPending) return <LoadingState />;
  const failed = [qOrders, qPayments, qTill].find((q) => q.isError);
  if (failed) return <ErrorState error={failed.error} onRetry={() => [qOrders, qPayments, qTill].forEach((q) => q.refetch())} />;

  // ── merge into one row per day ──
  const byDay = new Map<string, DayRow>();
  for (const r of qOrders.data?.rows ?? []) {
    const row = upsert(byDay, r);
    row.sales = displayMetric(r, "invoice_total");
    row.orders = displayMetric(r, "orders");
  }
  for (const r of qPayments.data?.rows ?? []) {
    const row = upsert(byDay, r);
    const paymentsIn = displayMetric(r, "payments_in");
    const refundsOut = displayMetric(r, "refunds_out");
    row.collections = sub(paymentsIn, refundsOut);
  }
  for (const r of qTill.data?.rows ?? []) {
    const row = upsert(byDay, r);
    row.tillExpected = displayMetric(r, "till_expected_cash");
    row.tillCounted = displayMetric(r, "till_counted");
  }
  const rows = [...byDay.values()]
    .map((r) => ({
      ...r,
      collectDelta: sub(r.collections, r.sales),
      tillDelta: sub(r.tillCounted, r.tillExpected),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  if (rows.length === 0) return <EmptyState title={t("salesReports.states.empty")} />;

  const isException = (v: number | null) => v != null && Math.abs(v) > EPS;
  const exceptionDays = rows.filter((r) => isException(r.collectDelta) || isException(r.tillDelta)).length;
  const totalCollectDelta = rows.reduce<number | null>((acc, r) => (r.collectDelta == null ? acc : (acc ?? 0) + r.collectDelta), null);
  const totalTillDelta = rows.reduce<number | null>((acc, r) => (r.tillDelta == null ? acc : (acc ?? 0) + r.tillDelta), null);

  const incomplete = [qOrders, qPayments, qTill].some((q) => q.data?.meta?.completeness?.complete === false);

  const kpiCards: Array<{ id: string; label: string; value: number | null; fmt: (v: number) => string; eq: string; icon: LucideIcon; tone: MetricTone }> = [
    { id: "collect-delta", label: `${t("salesReports.metrics.net_collections")} − ${t("salesReports.metrics.invoice_total")}`, value: totalCollectDelta, fmt: formatCurrency, eq: "netCollections", icon: Wallet, tone: "teal" },
    { id: "till-delta", label: t("salesReports.metrics.till_variance"), value: totalTillDelta, fmt: formatCurrency, eq: "tillVariance", icon: Scale, tone: "blue" },
    // No exception-days key exists yet (wanted: salesReports.reconciliation.exceptionDays);
    // composed from the day dimension label + Δ until it lands.
    { id: "exception-days", label: `${t(`salesReports.dims.${dayDim}`)} (Δ > ${EPS})`, value: exceptionDays, fmt: formatNumber, eq: "count", icon: AlertTriangle, tone: exceptionDays > 0 ? "rose" : "teal" },
  ];

  const money = (v: number | null) => (v == null ? "—" : formatCurrency(v));
  const columns: ColumnDef<DayRow>[] = [
    { id: "day", header: t(`salesReports.dims.${dayDim}`), accessor: (r) => r.label, pinStart: true, width: 140 },
    { id: "sales", header: t("salesReports.metrics.invoice_total"), accessor: (r) => r.sales, cell: (r) => money(r.sales), numeric: true, sortable: true },
    { id: "orders", header: t("salesReports.metrics.orders"), accessor: (r) => r.orders, cell: (r) => (r.orders == null ? "—" : formatNumber(r.orders)), numeric: true, sortable: true },
    { id: "collections", header: t("salesReports.metrics.net_collections"), accessor: (r) => r.collections, cell: (r) => money(r.collections), numeric: true, sortable: true },
    {
      id: "collectDelta",
      header: `Δ ${t("salesReports.metrics.net_collections")}`,
      accessor: (r) => r.collectDelta,
      cell: (r) => money(r.collectDelta),
      numeric: true,
      sortable: true,
      cellTone: (r) => (isException(r.collectDelta) ? "negative" : undefined),
    },
    { id: "tillExpected", header: t("salesReports.metrics.till_expected_cash"), accessor: (r) => r.tillExpected, cell: (r) => money(r.tillExpected), numeric: true, sortable: true },
    { id: "tillCounted", header: t("salesReports.metrics.till_counted"), accessor: (r) => r.tillCounted, cell: (r) => money(r.tillCounted), numeric: true, sortable: true },
    {
      id: "tillDelta",
      header: `Δ ${t("salesReports.metrics.till_variance")}`,
      accessor: (r) => r.tillDelta,
      cell: (r) => money(r.tillDelta),
      numeric: true,
      sortable: true,
      cellTone: (r) => (isException(r.tillDelta) ? "negative" : undefined),
    },
  ];

  const chartRows = rows.map((r) => ({
    label: r.label,
    sales: r.sales,
    collections: r.collections,
    tillCounted: r.tillCounted,
  }));

  return (
    <section aria-labelledby="sales-hub-page-reconciliation" className="space-y-4">
      <div>
        <h2 id="sales-hub-page-reconciliation" className="text-lg font-extrabold text-slate-900">
          {t("salesReports.pages.reconciliation.title")}
        </h2>
        <p className="mt-0.5 text-sm font-medium text-slate-500">{t("salesReports.pages.reconciliation.subtitle")}</p>
      </div>

      {incomplete && (
        <div data-testid="completeness-notice">
          <Badge tone="warning">{t("salesReports.states.notAvailableHistorically")}</Badge>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        {kpiCards.map((k) => (
          <div key={k.id} data-testid={`kpi-${k.id}`}>
            <MetricCard
              label={k.label}
              value={k.value == null ? "—" : k.fmt(k.value)}
              icon={k.icon}
              tone={k.tone}
              explain={
                <ExplainNumber title={k.label} formula={t(`salesReports.explain.${k.eq}`)} triggerLabel={k.label} />
              }
            />
          </div>
        ))}
      </div>

      <ChartCard
        title={t("salesReports.pages.reconciliation.title")}
        tableLabel={t(`salesReports.dims.${dayDim}`)}
        tableColumns={[
          { key: "label", label: t(`salesReports.dims.${dayDim}`) },
          { key: "sales", label: t("salesReports.metrics.invoice_total") },
          { key: "collections", label: t("salesReports.metrics.net_collections") },
          { key: "tillCounted", label: t("salesReports.metrics.till_counted") },
        ]}
        tableRows={chartRows.map((r) => ({
          label: r.label,
          sales: r.sales == null ? "—" : formatCurrency(r.sales),
          collections: r.collections == null ? "—" : formatCurrency(r.collections),
          tillCounted: r.tillCounted == null ? "—" : formatCurrency(r.tillCounted),
        }))}
      >
        <BarChart data={chartRows}>
          <CartesianGrid stroke={palette.grid} vertical={false} />
          <XAxis dataKey="label" reversed={rtl.xAxisReversed} stroke={palette.axis} tick={{ fontSize: 11 }} />
          <YAxis orientation={rtl.dir === "rtl" ? "right" : "left"} stroke={palette.axis} tickFormatter={rtl.tickFormatterNumber} tick={{ fontSize: 11 }} />
          <RechartsTooltip contentStyle={rtl.tooltipStyle} formatter={(v) => rtl.tickFormatterCurrency(v)} />
          <Legend />
          <Bar dataKey="sales" name={t("salesReports.metrics.invoice_total")} fill={palette.series[0]} radius={[4, 4, 0, 0]} />
          <Bar dataKey="collections" name={t("salesReports.metrics.net_collections")} fill={palette.series[1]} radius={[4, 4, 0, 0]} />
          <Bar dataKey="tillCounted" name={t("salesReports.metrics.till_counted")} fill={palette.series[2]} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ChartCard>

      <DataTable<DayRow>
        columns={columns}
        rows={rows}
        getRowId={(r) => r.key || r.label}
        paginate={false}
        columnMenu={false}
        emptyTitle={t("salesReports.states.empty")}
        mobileTitle={(r) => r.label}
      />
    </section>
  );
}
