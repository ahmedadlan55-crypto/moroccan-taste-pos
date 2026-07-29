// Sales Analytics Hub — "reconciliation" page (server-side three-way).
//
// v2: the client-composed three-query merge was replaced by the dedicated
// GET /api/analytics/reconciliation contract (ReconciliationService.threeWay):
// one row per business day × branch carrying sales vs payments vs till plus
// the two deltas AND the exception drills (payments-without-order /
// orders-without-payment, id lists capped server-side at 200 with true
// totals). The page renders that contract verbatim — no client re-merge.
//
// Capability: analytics.reconciliation.view (the backend 403s without it; the
// page renders PermissionDenied up front instead of a doomed fetch).
import { Fragment } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Scale, Wallet, type LucideIcon } from "lucide-react";
import {
  Badge,
  EmptyState,
  ErrorState,
  ExplainNumber,
  LoadingState,
  MetricCard,
  PermissionDenied,
  type MetricTone,
} from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatCurrency, formatNumber } from "@/shared/lib";
import { useT } from "@/i18n";
import { useCan } from "@/shared/permissions";
import { useUrlFilters } from "@/shared/hooks/useUrlFilters";
import { analyticsFilterCodec } from "../lib/filters";
import { fetchReconciliation, type ReconciliationRow } from "../lib/api";
import { CashChain } from "../components/CashChain";

/** |delta| above this is an exception (money is exact to the halala). */
const EPS = 0.01;

/** How many drill ids render inline before the "+N more" tail. */
const ID_RENDER_CAP = 10;

const isException = (v: number | null) => v != null && Math.abs(v) > EPS;

export default function Reconciliation() {
  const t = useT();
  const canView = useCan("analytics.reconciliation.view");
  const { filters } = useUrlFilters(analyticsFilterCodec);

  const query = useQuery({
    queryKey: ["analytics", "reconciliation", filters.from, filters.to, filters.branchId],
    enabled: canView,
    queryFn: ({ signal }) =>
      fetchReconciliation(
        { from: filters.from, to: filters.to, branchIds: filters.branchId },
        signal,
      ),
  });

  if (!canView) return <PermissionDenied />;
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;

  const data = query.data;
  const rows = data?.rows ?? [];
  if (rows.length === 0) return <EmptyState title={t("salesReports.states.empty")} />;

  const totals = data?.totals;
  const exceptionDays = rows.filter(
    (r) =>
      isException(r.deltas.salesVsPayments) ||
      isException(r.deltas.cashExpectedVsCounted) ||
      r.exceptions.paymentsWithoutOrder.count > 0 ||
      r.exceptions.ordersWithoutPayment.count > 0,
  ).length;
  const exceptionRows = rows.filter(
    (r) => r.exceptions.paymentsWithoutOrder.count > 0 || r.exceptions.ordersWithoutPayment.count > 0,
  );

  const kpiCards: Array<{ id: string; label: string; value: number | null; fmt: (v: number) => string; eq: string; icon: LucideIcon; tone: MetricTone }> = [
    { id: "salesVsPayments", label: t("salesReports.reconciliation.salesVsPayments"), value: totals?.salesVsPayments ?? null, fmt: formatCurrency, eq: "netCollections", icon: Wallet, tone: isException(totals?.salesVsPayments ?? null) ? "rose" : "teal" },
    { id: "cashExpectedVsCounted", label: t("salesReports.reconciliation.cashExpectedVsCounted"), value: totals?.cashExpectedVsCounted ?? null, fmt: formatCurrency, eq: "tillVariance", icon: Scale, tone: isException(totals?.cashExpectedVsCounted ?? null) ? "rose" : "blue" },
    { id: "exception-days", label: t("salesReports.reconciliation.exceptionDays"), value: exceptionDays, fmt: formatNumber, eq: "count", icon: AlertTriangle, tone: exceptionDays > 0 ? "rose" : "teal" },
  ];

  const money = (v: number | null | undefined) => (v == null ? "—" : formatCurrency(v));
  const columns: ColumnDef<ReconciliationRow>[] = [
    { id: "day", header: t("salesReports.dims.business_day"), accessor: (r) => r.business_day, pinStart: true, width: 120, sortable: true },
    { id: "branch", header: t("salesReports.dims.branch"), accessor: (r) => r.branch_id, sortable: true },
    { id: "sales", header: t("salesReports.metrics.invoice_total"), accessor: (r) => r.sales.invoice_total, cell: (r) => money(r.sales.invoice_total), numeric: true, sortable: true },
    { id: "orders", header: t("salesReports.metrics.orders"), accessor: (r) => r.sales.orders, cell: (r) => formatNumber(r.sales.orders), numeric: true, sortable: true },
    { id: "paymentsIn", header: t("salesReports.metrics.payments_in"), accessor: (r) => r.payments.in, cell: (r) => money(r.payments.in), numeric: true, sortable: true },
    { id: "paymentsOut", header: t("salesReports.metrics.refunds_out"), accessor: (r) => r.payments.out, cell: (r) => money(r.payments.out), numeric: true, sortable: true },
    { id: "paymentsNet", header: t("salesReports.metrics.net_collections"), accessor: (r) => r.payments.net, cell: (r) => money(r.payments.net), numeric: true, sortable: true },
    {
      id: "salesVsPayments",
      header: `Δ ${t("salesReports.reconciliation.salesVsPayments")}`,
      accessor: (r) => r.deltas.salesVsPayments,
      cell: (r) => money(r.deltas.salesVsPayments),
      numeric: true,
      sortable: true,
      cellTone: (r) => (isException(r.deltas.salesVsPayments) ? "negative" : undefined),
    },
    { id: "tillExpected", header: t("salesReports.metrics.till_expected_cash"), accessor: (r) => r.till.expected_cash, cell: (r) => money(r.till.expected_cash), numeric: true, sortable: true },
    { id: "tillCounted", header: t("salesReports.metrics.till_counted"), accessor: (r) => r.till.counted, cell: (r) => money(r.till.counted), numeric: true, sortable: true },
    {
      id: "cashExpectedVsCounted",
      header: `Δ ${t("salesReports.reconciliation.cashExpectedVsCounted")}`,
      accessor: (r) => r.deltas.cashExpectedVsCounted,
      cell: (r) => money(r.deltas.cashExpectedVsCounted),
      numeric: true,
      sortable: true,
      cellTone: (r) => (isException(r.deltas.cashExpectedVsCounted) ? "negative" : undefined),
    },
  ];

  /** Capped inline id list; order ids link into the operational invoices screen. */
  const idList = (ids: Array<string | number>, total: number, linkOrders: boolean) => (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {ids.slice(0, ID_RENDER_CAP).map((id) =>
        linkOrders ? (
          <Link
            key={String(id)}
            to={`/sales/invoices?doc=${encodeURIComponent(String(id))}`}
            className="rounded-lg bg-slate-100 px-2 py-0.5 text-xs font-bold text-teal-700 hover:bg-teal-50"
            dir="ltr"
          >
            {String(id)}
          </Link>
        ) : (
          <span key={String(id)} className="rounded-lg bg-slate-100 px-2 py-0.5 text-xs font-bold text-slate-600" dir="ltr">
            {String(id)}
          </span>
        ),
      )}
      {total > Math.min(ids.length, ID_RENDER_CAP) && (
        <span className="text-xs font-bold text-slate-400">
          {t("salesReports.reconciliation.moreIds", { count: total - Math.min(ids.length, ID_RENDER_CAP) })}
        </span>
      )}
    </span>
  );

  return (
    <section aria-labelledby="sales-hub-page-reconciliation" className="space-y-4">
      <div>
        <h2 id="sales-hub-page-reconciliation" className="text-lg font-extrabold text-slate-900">
          {t("salesReports.pages.reconciliation.title")}
        </h2>
        <p className="mt-0.5 text-sm font-medium text-slate-500">{t("salesReports.pages.reconciliation.subtitle")}</p>
      </div>

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

      {/* The chain reads the SAME period totals the grid below is built from,
          summed server-side — so it can never disagree with the detail. It
          leads because "I billed X, where did it end up?" is the question, and
          the eleven-column grid is where you go once you know which link
          leaked. */}
      <CashChain totals={totals} />

      <DataTable<ReconciliationRow>
        columns={columns}
        rows={rows}
        getRowId={(r) => `${r.business_day}:${r.branch_id}`}
        paginate={false}
        columnMenu={false}
        emptyTitle={t("salesReports.states.empty")}
        mobileTitle={(r) => r.business_day}
      />

      {/* ── exception drill: the offending documents/facts per day ── */}
      {exceptionRows.length > 0 && (
        <div className="surface space-y-3 p-4" data-testid="reconciliation-exceptions">
          <h3 className="text-sm font-extrabold text-slate-900">
            {t("salesReports.reconciliation.exceptionsTitle")}
          </h3>
          <dl className="space-y-2">
            {exceptionRows.map((r) => (
              <Fragment key={`${r.business_day}:${r.branch_id}`}>
                {r.exceptions.ordersWithoutPayment.count > 0 && (
                  <div className="flex flex-wrap items-center gap-2" data-testid="exception-orders-without-payment">
                    <dt className="flex items-center gap-2 text-xs font-bold text-slate-500">
                      <span dir="ltr" className="tabular-nums">{r.business_day}</span>
                      <Badge tone="danger">
                        {t("salesReports.reconciliation.ordersWithoutPayment")}: {formatNumber(r.exceptions.ordersWithoutPayment.count)}
                      </Badge>
                    </dt>
                    <dd>{idList(r.exceptions.ordersWithoutPayment.documentIds, r.exceptions.ordersWithoutPayment.count, true)}</dd>
                  </div>
                )}
                {r.exceptions.paymentsWithoutOrder.count > 0 && (
                  <div className="flex flex-wrap items-center gap-2" data-testid="exception-payments-without-order">
                    <dt className="flex items-center gap-2 text-xs font-bold text-slate-500">
                      <span dir="ltr" className="tabular-nums">{r.business_day}</span>
                      <Badge tone="warning">
                        {t("salesReports.reconciliation.paymentsWithoutOrder")}: {formatNumber(r.exceptions.paymentsWithoutOrder.count)}
                      </Badge>
                    </dt>
                    <dd>{idList(r.exceptions.paymentsWithoutOrder.factIds, r.exceptions.paymentsWithoutOrder.count, false)}</dd>
                  </div>
                )}
              </Fragment>
            ))}
          </dl>
        </div>
      )}
    </section>
  );
}
