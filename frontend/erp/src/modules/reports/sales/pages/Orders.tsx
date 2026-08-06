// Sales Analytics Hub — "orders" page: the drill terminus.
//
// A SERVER-mode DataTable of real invoices for the active period, reusing the
// operational O2C invoices list API (GET /order-to-cash/invoices — the same
// endpoint modules/sales/invoices/InvoicesList.tsx queries via o2cApi.invoices).
// Param mapping (see services/order-to-cash/InvoiceService.list):
//   table search → q · paging → page/pageSize · sort → sort(number|issueDate|total)+dir
//   hub range/basis → from/to/businessDay
//   hub scope       → branchId/channel/orderType
// Row click → /sales/invoices?doc=<id> — the canonical full detail page
// (lines / payments / audit) via the sales module's ?doc pattern (use-nav.ts).
// KPI row comes from the SAME filtered invoice population as the table for
// invoice viewers. Aggregate-only viewers retain the analytics KPI where the
// planner can represent the active filters without widening the population.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Coins, Receipt, ShoppingCart, type LucideIcon } from "lucide-react";
import { ExplainNumber, MetricCard, PermissionDenied, type MetricTone } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatCurrency, formatDateTime, formatNumber } from "@/shared/lib";
import { useCan } from "@/shared/permissions";
import { useLang, useT } from "@/i18n";
import { useUrlFilters } from "@/shared/hooks/useUrlFilters";
import { o2cApi } from "@/modules/sales/lib/api";
import { qk } from "@/modules/sales/lib/query-keys";
import type { Invoice } from "@/modules/sales/lib/types";
import { analyticsFilterCodec, filterSignature } from "../lib/filters";
import {
  buildFiltersBody,
  displayMetric,
  reportQuerySpec,
  type AnalyticsQueryBody,
  type AnalyticsResult,
} from "../lib/api";
import { useAnalyticsQuery } from "../lib/useAnalyticsQuery";

const SEGMENT = "orders";
// The KPI query — and the ExportMenu's file — come from lib/reportRegistry.

/** Optional enrichment columns the O2C list may grow later (today they read "—"). */
type HubInvoiceRow = Invoice & {
  branch_name?: string | null;
  branch_name_en?: string | null;
  cashier_name?: string | null;
  channel?: string | null;
};

/** DataTable column id → InvoiceService.list SORTABLE key. */
const SORT_MAP: Record<string, string> = {
  document_number: "number",
  issue_date: "issueDate",
  total: "total",
};

interface TableState {
  page: number;
  pageSize: number;
  search: string;
  sort: { columnId: string; dir: "asc" | "desc" } | null;
}

/** Totals of a dimensionless KPI query: totals first, else the single row. */
function kpiValue(result: AnalyticsResult | undefined, id: string): number | null {
  if (!result) return null;
  const v = result.totals?.[id];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const row = result.rows[0];
  return row ? displayMetric(row, id) : null;
}

function totalsValue(totals: Record<string, number | null> | undefined, id: string): number | null {
  const v = totals?.[id];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const KPIS: Array<{ id: string; eq: string; fmt: (v: number) => string; icon: LucideIcon; tone: MetricTone }> = [
  { id: "orders", eq: "count", fmt: formatNumber, icon: ShoppingCart, tone: "teal" },
  { id: "invoice_total", eq: "invoiceTotal", fmt: formatCurrency, icon: Receipt, tone: "blue" },
  { id: "avg_ticket", eq: "avgTicket", fmt: formatCurrency, icon: Coins, tone: "violet" },
];

export default function Orders() {
  const t = useT();
  const lang = useLang();
  const navigate = useNavigate();
  const canViewInvoices = useCan("invoices.view");
  const { filters } = useUrlFilters(analyticsFilterCodec);
  const analyticsOnlyFilters = useMemo(
    () => ({
      ...filters,
      // The planner cannot put order metrics beside a line-only or
      // payment-only dimension. Invoice viewers use InvoiceService's exact
      // aggregate below; aggregate-only viewers keep the analytics KPI only
      // for combinations the planner can honestly express.
      brandId: [],
      paymentMethod: [],
      menuItemId: [],
      categoryId: [],
    }),
    [filters],
  );
  const hasRelationalDrill =
    filters.paymentMethod.length > 0 ||
    filters.menuItemId.length > 0 ||
    filters.categoryId.length > 0;

  // ── KPI row (analytics API) ──
  // Hour and cashier are native order-fact filters. Line/payment filters use
  // the O2C list aggregate instead; asking the analytics planner to combine
  // them with order metrics would correctly return 422.
  const kpiBody = useMemo<AnalyticsQueryBody>(
    () => ({
      ...reportQuerySpec(SEGMENT, "kpis", analyticsOnlyFilters),
      ...buildFiltersBody(analyticsOnlyFilters),
    }),
    [analyticsOnlyFilters],
  );
  const kpis = useAnalyticsQuery("orders-kpis", kpiBody, {
    enabled: !canViewInvoices && !hasRelationalDrill,
  });

  // ── invoices list (operational O2C API, mirrored locally) ──
  const [ts, setTs] = useState<TableState>({ page: 1, pageSize: 25, search: "", sort: null });
  const committedScope = filterSignature(filters);
  useEffect(() => {
    // A narrower scope may have fewer pages. Returning to page one prevents a
    // stale page number from producing a convincing but false empty state.
    setTs((prev) => (prev.page === 1 ? prev : { ...prev, page: 1 }));
  }, [committedScope]);

  const listParams = useMemo(
    () => ({
      page: ts.page,
      pageSize: ts.pageSize,
      analyticsPopulation: true,
      ...(ts.search ? { q: ts.search } : {}),
      ...(ts.sort && SORT_MAP[ts.sort.columnId]
        ? { sort: SORT_MAP[ts.sort.columnId], dir: ts.sort.dir.toUpperCase() }
        : {}),
      // These are exact list filters over the frozen order/line/payment facts.
      // Multi-values are comma-separated because apiClient params are scalar;
      // InvoiceService._multi and SalesScope.requestedBranchIds both accept
      // that representation. brand/customer remain absent because this list
      // has no proven predicate for them; silently forwarding them would make
      // the URL look filtered while leaving the population unchanged.
      from: filters.from,
      to: filters.to,
      businessDay: filters.businessDay,
      ...(filters.branchId.length > 0 ? { branchId: filters.branchId.join(",") } : {}),
      ...(filters.channel.length > 0 ? { channel: filters.channel.join(",") } : {}),
      ...(filters.orderType.length > 0 ? { orderType: filters.orderType.join(",") } : {}),
      ...(filters.paymentMethod.length > 0 ? { paymentMethod: filters.paymentMethod.join(",") } : {}),
      ...(filters.hour !== "" ? { hour: filters.hour } : {}),
      ...(filters.menuItemId.length > 0 ? { menuItemId: filters.menuItemId.join(",") } : {}),
      ...(filters.categoryId.length > 0 ? { categoryId: filters.categoryId.join(",") } : {}),
      ...(filters.cashierId.length > 0 ? { cashierId: filters.cashierId.join(",") } : {}),
    }),
    [
      ts,
      filters.from,
      filters.to,
      filters.businessDay,
      filters.branchId,
      filters.channel,
      filters.orderType,
      filters.paymentMethod,
      filters.hour,
      filters.menuItemId,
      filters.categoryId,
      filters.cashierId,
    ],
  );

  const list = useQuery({
    queryKey: qk.invoices({ hub: "sales-analytics", ...listParams }),
    queryFn: ({ signal }) => o2cApi.invoices(listParams, signal),
    // analytics.view is sufficient for the decision KPIs, but invoice rows
    // are a separate operational permission. Do not issue a request that is
    // guaranteed to 403 for auditors; keep the useful aggregate view visible
    // and explain why the detail stops here.
    enabled: canViewInvoices,
  });

  const onStateChange = useCallback(
    (s: { page: number; pageSize: number; sort: { columnId: string; dir: "asc" | "desc" } | null; search: string }) =>
      setTs((prev) =>
        prev.page === s.page && prev.pageSize === s.pageSize && prev.search === s.search && prev.sort === s.sort
          ? prev
          : { page: s.page, pageSize: s.pageSize, search: s.search, sort: s.sort },
      ),
    [],
  );

  const columns = useMemo<ColumnDef<HubInvoiceRow>[]>(
    () => [
      {
        id: "document_number",
        header: t("salesReports.orders.colInvoice"),
        accessor: (r) => r.document_number,
        cell: (r) => <span className="font-bold text-teal-700">{r.document_number}</span>,
        sortable: true,
        pinStart: true, hideable: false,
        width: 140,
      },
      {
        id: "issue_date",
        header: t("salesReports.dims.business_day"),
        accessor: (r) => r.issue_date,
        cell: (r) => formatDateTime(r.issue_date),
        sortable: true,
      },
      {
        id: "branch",
        header: t("salesReports.dims.branch"),
        accessor: (r) =>
          lang === "en"
            ? (r.branch_name_en || r.branch_name || null)
            : (r.branch_name || r.branch_name_en || null),
      },
      {
        id: "cashier",
        header: t("salesReports.dims.cashier"),
        accessor: (r) => r.cashier_name ?? null,
      },
      {
        id: "channel",
        header: t("salesReports.dims.channel"),
        // The list rows carry no channel yet; source_type ("pos"/"manual") is
        // the closest stored signal until the endpoint projects a channel.
        accessor: (r) => r.channel ?? r.source_type ?? null,
      },
      {
        id: "total",
        header: t("salesReports.metrics.invoice_total"),
        accessor: (r) => r.total_amount,
        cell: (r) => formatCurrency(r.total_amount),
        sortable: true,
        numeric: true,
      },
    ],
    [lang, t],
  );

  return (
    <section aria-labelledby="sales-hub-page-orders">
      <div className="mb-4">
        <h2 id="sales-hub-page-orders" className="text-lg font-extrabold text-slate-900">
          {t("salesReports.pages.orders.title")}
        </h2>
        <p className="mt-0.5 text-sm font-medium text-slate-500">{t("salesReports.pages.orders.subtitle")}</p>
      </div>

      <div className="mb-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {KPIS.map((k) => {
          const label = t(`salesReports.metrics.${k.id}`);
          const v = canViewInvoices
            ? totalsValue(list.data?.totals as Record<string, number | null> | undefined, k.id)
            : kpiValue(kpis.data, k.id);
          return (
            <div key={k.id} data-testid={`kpi-${k.id}`}>
              <MetricCard
                label={label}
                value={v == null ? "—" : k.fmt(v)}
                icon={k.icon}
                tone={k.tone}
                explain={
                  <ExplainNumber
                    title={label}
                    formula={t(`salesReports.explain.${k.eq}`)}
                    triggerLabel={label}
                  />
                }
              />
            </div>
          );
        })}
      </div>

      {canViewInvoices ? (
        <DataTable<HubInvoiceRow>
          mode="server"
          columns={columns}
          rows={(list.data?.data ?? []) as HubInvoiceRow[]}
          rowCount={list.data?.pagination?.total ?? 0}
          getRowId={(r) => r.id}
          loading={list.isLoading}
          error={list.isError ? list.error : undefined}
          onRetry={() => list.refetch()}
          onStateChange={onStateChange}
          // Drill terminus: the canonical operational detail (lines/payments/audit).
          onRowClick={(r) => navigate(`/sales/invoices?doc=${r.id}`)}
          initialPageSize={25}
          searchable
          emptyTitle={t("salesReports.states.empty")}
          mobileTitle={(r) => r.document_number}
          tableId="sales-hub-orders"
        />
      ) : (
        <PermissionDenied />
      )}
    </section>
  );
}
