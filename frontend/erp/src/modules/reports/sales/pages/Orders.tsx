// Sales Analytics Hub — "orders" page: the drill terminus.
//
// A SERVER-mode DataTable of real invoices for the active period, reusing the
// operational O2C invoices list API (GET /order-to-cash/invoices — the same
// endpoint modules/sales/invoices/InvoicesList.tsx queries via o2cApi.invoices).
// Param mapping (see services/order-to-cash/InvoiceService.list):
//   table search → q · paging → page/pageSize · sort → sort(number|issueDate|total)+dir
//   hub from/to  → passed as from/to but IGNORED server-side today (the list
//                  endpoint has no date-range filter yet — forward-compatible)
//   hub branch/channel/orderType → NOT accepted by the endpoint (gap, reported)
// Row click → /sales/invoices?doc=<id> — the canonical full detail page
// (lines / payments / audit) via the sales module's ?doc pattern (use-nav.ts).
// KPI row comes from the analytics API: orders, invoice_total, avg_ticket.
import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Coins, Receipt, ShoppingCart, type LucideIcon } from "lucide-react";
import { ExplainNumber, MetricCard, type MetricTone } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatCurrency, formatDateTime, formatNumber } from "@/shared/lib";
import { useT } from "@/i18n";
import { useUrlFilters } from "@/shared/hooks/useUrlFilters";
import { o2cApi } from "@/modules/sales/lib/api";
import { qk } from "@/modules/sales/lib/query-keys";
import type { Invoice } from "@/modules/sales/lib/types";
import { analyticsFilterCodec } from "../lib/filters";
import { buildFiltersBody, displayMetric, type AnalyticsQueryBody, type AnalyticsResult } from "../lib/api";
import { useAnalyticsQuery } from "../lib/useAnalyticsQuery";

/** Optional enrichment columns the O2C list may grow later (today they read "—"). */
type HubInvoiceRow = Invoice & {
  branch_name?: string | null;
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

const KPIS: Array<{ id: string; eq: string; fmt: (v: number) => string; icon: LucideIcon; tone: MetricTone }> = [
  { id: "orders", eq: "count", fmt: formatNumber, icon: ShoppingCart, tone: "teal" },
  { id: "invoice_total", eq: "invoiceTotal", fmt: formatCurrency, icon: Receipt, tone: "blue" },
  { id: "avg_ticket", eq: "avgTicket", fmt: formatCurrency, icon: Coins, tone: "violet" },
];

export default function Orders() {
  const t = useT();
  const navigate = useNavigate();
  const { filters } = useUrlFilters(analyticsFilterCodec);

  // ── KPI row (analytics API) ──
  const kpiBody = useMemo<AnalyticsQueryBody>(
    () => ({
      metrics: ["orders", "invoice_total", "avg_ticket"],
      dimensions: [],
      ...buildFiltersBody(filters),
    }),
    [filters],
  );
  const kpis = useAnalyticsQuery("orders-kpis", kpiBody);

  // ── invoices list (operational O2C API, mirrored locally) ──
  const [ts, setTs] = useState<TableState>({ page: 1, pageSize: 25, search: "", sort: null });

  const listParams = useMemo(
    () => ({
      page: ts.page,
      pageSize: ts.pageSize,
      ...(ts.search ? { q: ts.search } : {}),
      ...(ts.sort && SORT_MAP[ts.sort.columnId]
        ? { sort: SORT_MAP[ts.sort.columnId], dir: ts.sort.dir.toUpperCase() }
        : {}),
      // Forward-compatible: the list endpoint ignores from/to today (no range
      // filter in InvoiceService.list) — carried so the page starts honoring
      // the hub period the day the endpoint learns it. branch/channel/orderType
      // have no mapping at all (reported gap).
      from: filters.from,
      to: filters.to,
    }),
    [ts, filters.from, filters.to],
  );

  const list = useQuery({
    queryKey: qk.invoices({ hub: "sales-analytics", ...listParams }),
    queryFn: ({ signal }) => o2cApi.invoices(listParams, signal),
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
        // Reuses the operational sales dictionary ("Invoice no.") — the hub
        // namespace has no invoice-number key (wanted: salesReports.orders.colInvoice).
        header: t("sales.invoices.col.number"),
        accessor: (r) => r.document_number,
        cell: (r) => <span className="font-bold text-teal-700">{r.document_number}</span>,
        sortable: true,
        pinStart: true,
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
        accessor: (r) => r.branch_name ?? null,
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
    [t],
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
          const v = kpiValue(kpis.data, k.id);
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
        columnMenu={false}
        emptyTitle={t("salesReports.states.empty")}
        mobileTitle={(r) => r.document_number}
        tableId="sales-hub-orders"
      />
    </section>
  );
}
