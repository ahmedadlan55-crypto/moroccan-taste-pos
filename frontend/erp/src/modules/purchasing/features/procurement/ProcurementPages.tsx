// Procurement feature pages — dashboard, suppliers (+detail), orders (+detail),
// receipts, invoices, payments, returns, reports. Reuse the shared UI primitives
// and the useProcurement hooks. All money/qty rendered via formatters (English
// digits). Backend enforces permissions; useCan hides obviously-forbidden buttons.
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ShoppingBag, ClipboardList, AlarmClock, PackageCheck, FileWarning, Wallet, TriangleAlert, ArrowLeftRight,
} from "lucide-react";
import { PanelTitle } from "@/shared/ui";
import { MetricCard } from "@/modules/inventory/lib/MetricCard";
import { StatusBadge } from "@/shared/ui";
import { Button } from "@/shared/ui";
import { LoadingState, ErrorState, EmptyState } from "@/shared/ui";
import { formatCurrency, formatDate } from "@/shared/lib";
import { useCan } from "@/modules/inventory/lib/permission-provider";
import { useBranchOptions } from "@/modules/administration/users/pickers";
import { useT } from "@/i18n";
import { st } from "./labels";
import { PageCounter } from "@/shared/tables";
import { PurchasingReportPage } from "@/modules/reports/purchasing/PurchasingReportPage";
import {
  PURCHASING_REPORT_IDS,
  getPurchasingReport,
  type PurchasingReportId,
} from "@/modules/reports/purchasing/registry";
import {
  useProcurementDashboard, useOrders, useReceipts, useInvoices, usePayments,
  useReturns, type ListParams,
} from "@/modules/inventory/lib/hooks/useProcurement";

// ── shared bits ──────────────────────────────────────────────────────────────
function Th({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <th className={`px-3 py-2 text-start text-[11px] font-extrabold uppercase tracking-wide text-slate-400 ${className}`}>{children}</th>;
}
function Td({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <td className={`px-3 py-2.5 text-sm text-slate-700 ${className}`}>{children}</td>;
}

function useListState(): [ListParams, (p: Partial<ListParams>) => void] {
  const [params, setParams] = useState<ListParams>({ page: 1, pageSize: 25 });
  return [params, (p) => setParams((prev) => ({ ...prev, ...p }))];
}

function StatusFilter({ value, onChange, options }: { value?: string; onChange: (v: string) => void; options: string[] }) {
  const t = useT();
  return (
    <select className="field w-44" value={value ?? ""} onChange={(e) => onChange(e.target.value)} aria-label={t("purchasing.common.filterStatusAria")}>
      <option value="">{t("purchasing.common.allStatuses")}</option>
      {options.map((o) => <option key={o} value={o}>{st(t, o)}</option>)}
    </select>
  );
}

function Pager({ page, totalPages, onPage }: { page: number; totalPages: number; onPage: (p: number) => void }) {
  const t = useT();
  if (totalPages <= 1) return null;
  return (
    <div className="mt-3 flex items-center justify-end gap-2 text-sm">
      <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>{t("purchasing.pager.prev")}</Button>
      <PageCounter page={page} pageCount={totalPages} className="text-slate-500" />
      <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>{t("purchasing.pager.next")}</Button>
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────
export function ProcurementDashboard() {
  const t = useT();
  const { data, isLoading, isError, error, refetch } = useProcurementDashboard();
  if (isLoading) return <LoadingState />;
  if (isError || !data) return <ErrorState error={error} onRetry={() => refetch()} />;
  const cards = [
    { label: t("purchasing.dashboard.purchaseValue"), value: formatCurrency(data.purchaseValue), icon: ShoppingBag, tone: "teal" as const },
    // First, because it is first in the cycle: a branch is waiting on it.
    { label: t("purchasing.dashboard.requisitionsPending"), value: String(data.requisitionsPending), icon: ClipboardList, tone: "amber" as const },
    // The cashier's own queue (shortage_requests) — a different table from the
    // requisitions above, and until now counted nowhere in the back office.
    { label: t("purchasing.dashboard.branchRequestsPending"), value: String(data.branchRequestsPending), icon: ClipboardList, tone: "amber" as const },
    { label: t("purchasing.dashboard.ordersPendingApproval"), value: String(data.ordersPendingApproval), icon: ClipboardList, tone: "amber" as const },
    { label: t("purchasing.dashboard.ordersOverdue"), value: String(data.ordersOverdue), icon: AlarmClock, tone: "rose" as const },
    { label: t("purchasing.dashboard.partialReceipts"), value: String(data.partialReceipts), icon: PackageCheck, tone: "blue" as const },
    { label: t("purchasing.dashboard.unmatchedInvoices"), value: String(data.unmatchedInvoices), icon: FileWarning, tone: "amber" as const },
    { label: t("purchasing.dashboard.apDue"), value: formatCurrency(data.apDue), icon: Wallet, tone: "violet" as const },
    { label: t("purchasing.dashboard.apOverdue"), value: formatCurrency(data.apOverdue), icon: TriangleAlert, tone: "rose" as const },
    { label: t("purchasing.dashboard.variances"), value: String(data.variances), icon: ArrowLeftRight, tone: "blue" as const },
  ];
  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => <MetricCard key={c.label} label={c.label} value={c.value} icon={c.icon} tone={c.tone} />)}
      </div>
      <section className="surface">
        <PanelTitle icon={ClipboardList} title={t("purchasing.dashboard.recentActivity")} />
        <div className="divide-y divide-slate-100">
          {data.recentActivity.length === 0 ? (
            <div className="p-6"><EmptyState title={t("purchasing.dashboard.emptyTitle")} body={t("purchasing.dashboard.emptyBody")} /></div>
          ) : data.recentActivity.map((a, i) => (
            <div key={i} className="flex items-center justify-between px-5 py-3 text-sm">
              <span className="font-semibold text-slate-700">{a.documentType} · {a.action}</span>
              <span className="flex items-center gap-3 text-slate-400">
                <StatusBadge>{st(t, a.toStatus)}</StatusBadge>
                <span className="tabular-nums text-[11px]">{formatDate(a.createdAt)}</span>
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

// ── Orders ────────────────────────────────────────────────────────────────
export function OrdersPage() {
  const t = useT();
  const [params, patch] = useListState();
  const { data, isLoading, isError, error, refetch } = useOrders(params);
  const canCreate = useCan("procurement.manage");
  const branches = useBranchOptions(true);
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input className="field w-56" placeholder={t("purchasing.orders.searchPlaceholder")} value={params.q ?? ""} onChange={(e) => patch({ q: e.target.value, page: 1 })} />
        <StatusFilter value={params.status} onChange={(v) => patch({ status: v, page: 1 })} options={["draft", "submitted", "approved", "sent", "partially_received", "fully_received", "closed", "cancelled"]} />
        <select className="field w-44" value={params.branchId ?? ""} onChange={(e) => patch({ branchId: e.target.value, page: 1 })} aria-label={t("purchasing.requisitions.filterBranchAria")}>
          <option value="">{t("purchasing.requisitions.allBranches")}</option>
          {(branches.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <div className="grow" />
        {canCreate && <Link to="/purchasing/orders?new=1"><Button>+ {t("purchasing.orders.addOrder")}</Button></Link>}
      </div>
      {isLoading ? <LoadingState /> : isError ? <ErrorState error={error} onRetry={() => refetch()} /> : !data || data.rows.length === 0 ? (
        <EmptyState title={t("purchasing.orders.emptyTitle")} body={t("purchasing.orders.emptyBody")} />
      ) : (
        <div className="surface overflow-hidden"><div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead className="bg-slate-50"><tr><Th>{t("purchasing.col.number")}</Th><Th>{t("purchasing.col.supplier")}</Th><Th>{t("purchasing.requisitions.branch")}</Th><Th>{t("purchasing.col.date")}</Th><Th>{t("common.status")}</Th><Th className="text-end">{t("purchasing.col.total")}</Th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {data.rows.map((o) => (
                <tr key={o.id} className="hover:bg-slate-50">
                  <Td><Link className="font-bold text-teal-700 hover:underline" to={`/purchasing/orders?doc=${o.id}`}>{o.poNumber}</Link></Td>
                  <Td>{o.supplierName}</Td>
                  <Td>{o.branchName || o.warehouseName || "—"}{o.requisitionNumber ? <span className="ms-2 text-[11px] font-bold text-slate-400">{o.requisitionNumber}</span> : null}</Td>
                  <Td className="tabular-nums">{formatDate(o.poDate)}</Td>
                  <Td><StatusBadge>{st(t, o.status)}</StatusBadge></Td>
                  <Td className="text-end font-bold tabular-nums">{formatCurrency(o.total)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div></div>
      )}
      {data && <Pager page={data.page} totalPages={data.totalPages} onPage={(p) => patch({ page: p })} />}
    </div>
  );
}

// ── generic list pages (receipts / invoices / payments / returns) ────────────
export function ReceiptsListPage() {
  const t = useT();
  const [params, patch] = useListState();
  const { data, isLoading, isError, error, refetch } = useReceipts(params);
  const canCreate = useCan("procurement.manage");
  return (
    <SimpleList title={t("purchasing.receipts.title")} isLoading={isLoading} isError={isError} error={error} onRetry={refetch}
      // Receiving must be reachable from the screen a user looks at when they
      // want to receive — not only from a purchase order's detail page.
      action={canCreate ? <Link to="/purchasing/receiving?new=1"><Button>+ {t("purchasing.receive.action")}</Button></Link> : null}
      empty={t("purchasing.receipts.empty")} rows={data?.rows ?? []} page={data?.page ?? 1} totalPages={data?.totalPages ?? 1} onPage={(p) => patch({ page: p })}
      columns={[
        { h: t("purchasing.col.number"), c: (r) => <Link className="font-bold text-teal-700 hover:underline" to={`/purchasing/receiving?doc=${r.id}`}>{r.receiptNumber}</Link> }, { h: t("purchasing.col.supplier"), c: (r) => r.supplierName },
        { h: t("purchasing.col.date"), c: (r) => formatDate(r.receiptDate) }, { h: t("common.status"), c: (r) => <StatusBadge>{st(t, r.status)}</StatusBadge> },
        { h: t("purchasing.col.total"), c: (r) => formatCurrency(r.total), left: true },
      ]} />
  );
}
export function InvoicesListPage() {
  const t = useT();
  const [params, patch] = useListState();
  const { data, isLoading, isError, error, refetch } = useInvoices(params);
  return (
    <SimpleList title={t("purchasing.invoices.title")} isLoading={isLoading} isError={isError} error={error} onRetry={refetch}
      empty={t("purchasing.invoices.empty")} rows={data?.rows ?? []} page={data?.page ?? 1} totalPages={data?.totalPages ?? 1} onPage={(p) => patch({ page: p })}
      columns={[
        { h: t("purchasing.col.number"), c: (r) => <Link className="font-bold text-teal-700 hover:underline" to={`/purchasing/invoices?doc=${r.id}`}>{r.invoiceNo || r.code}</Link> }, { h: t("purchasing.col.supplier"), c: (r) => r.supplierName },
        { h: t("purchasing.invoices.colMatching"), c: (r) => st(t, r.matchingStatus) }, { h: t("common.status"), c: (r) => <StatusBadge>{st(t, r.status)}</StatusBadge> },
        { h: t("purchasing.invoices.colBalance"), c: (r) => formatCurrency(r.balance), left: true },
      ]} />
  );
}
export function PaymentsListPage() {
  const t = useT();
  const [params, patch] = useListState();
  const { data, isLoading, isError, error, refetch } = usePayments(params);
  return (
    <SimpleList title={t("purchasing.payments.title")} isLoading={isLoading} isError={isError} error={error} onRetry={refetch}
      empty={t("purchasing.payments.empty")} rows={data?.rows ?? []} page={data?.page ?? 1} totalPages={data?.totalPages ?? 1} onPage={(p) => patch({ page: p })}
      columns={[
        { h: t("purchasing.col.number"), c: (r) => <Link className="font-bold text-teal-700 hover:underline" to={`/purchasing/payments?doc=${r.id}`}>{r.paymentNumber}</Link> }, { h: t("purchasing.payments.colMethod"), c: (r) => r.method },
        { h: t("common.status"), c: (r) => <StatusBadge>{st(t, r.status)}</StatusBadge> }, { h: t("purchasing.payments.colAmount"), c: (r) => formatCurrency(r.amount), left: true },
      ]} />
  );
}
export function ReturnsPage() {
  const t = useT();
  const [params, patch] = useListState();
  const { data, isLoading, isError, error, refetch } = useReturns(params);
  return (
    <SimpleList title={t("purchasing.returns.title")} isLoading={isLoading} isError={isError} error={error} onRetry={refetch}
      empty={t("purchasing.returns.empty")} rows={data?.rows ?? []} page={data?.page ?? 1} totalPages={data?.totalPages ?? 1} onPage={(p) => patch({ page: p })}
      columns={[
        { h: t("purchasing.col.number"), c: (r) => <Link className="font-bold text-teal-700 hover:underline" to={`/purchasing/returns?doc=${r.id}`}>{r.returnNumber}</Link> }, { h: t("purchasing.returns.colPhase"), c: (r) => (r.phase === "after_invoice" ? t("purchasing.status.after_invoice") : t("purchasing.status.before_invoice")) },
        { h: t("common.status"), c: (r) => <StatusBadge>{st(t, r.status)}</StatusBadge> }, { h: t("purchasing.col.total"), c: (r) => formatCurrency(r.total), left: true },
      ]} />
  );
}

interface Col<T> { h: string; c: (r: T) => ReactNode; left?: boolean }
function SimpleList<T extends { id: string }>(props: {
  title: string; isLoading: boolean; isError: boolean; error: unknown; onRetry: () => void;
  empty: string; rows: T[]; columns: Col<T>[]; page: number; totalPages: number; onPage: (p: number) => void;
  action?: ReactNode;
}) {
  const { title, isLoading, isError, error, onRetry, empty, rows, columns, page, totalPages, onPage, action } = props;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-extrabold text-slate-800">{title}</h2>
        <div className="grow" />
        {action}
      </div>
      {isLoading ? <LoadingState /> : isError ? <ErrorState error={error} onRetry={onRetry} /> : rows.length === 0 ? (
        <EmptyState title={empty} />
      ) : (
        <div className="surface overflow-hidden"><div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead className="bg-slate-50"><tr>{columns.map((c) => <Th key={c.h} className={c.left ? "text-end" : ""}>{c.h}</Th>)}</tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  {columns.map((c) => <Td key={c.h} className={c.left ? "text-end font-bold tabular-nums" : ""}>{c.c(r)}</Td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div></div>
      )}
      <Pager page={page} totalPages={totalPages} onPage={onPage} />
    </div>
  );
}

// ── Reports ───────────────────────────────────────────────────────────────
/**
 * Compatibility entry for the old in-module reports screen.
 *
 * Purchasing reports now have one authoritative renderer under
 * `/reports/purchasing/:id`.  It owns the typed report registry, declared
 * columns, server-supported filters, data-quality object normalisation,
 * formatting, full-result print sheet and CSV behaviour. Keeping a second
 * renderer here was the reason this screen exposed raw database keys and
 * falsely called data-quality empty. This switcher deliberately delegates to
 * that same renderer, so the compatibility screen cannot drift again.
 */
const REPORTS = PURCHASING_REPORT_IDS.map((id) => {
  const report = getPurchasingReport(id);
  if (!report) throw new Error(`Missing purchasing report definition: ${id}`);
  return report;
});

export function ProcurementReportsPage() {
  const t = useT();
  const [type, setType] = useState<PurchasingReportId>("ap-aging");
  return (
    <div className="grid min-w-0 gap-5" data-testid="procurement-reports-compat">
      <nav
        className="no-print -mx-1 min-w-0 overflow-x-auto px-1 pb-1"
        aria-label={t("purchasing.layout.tabsAria")}
      >
        <div className="flex min-w-max gap-2">
          {REPORTS.map((report) => (
            <Button
              key={report.id}
              type="button"
              data-report-id={report.id}
              variant={type === report.id ? "primary" : "secondary"}
              aria-pressed={type === report.id}
              onClick={() => setType(report.id)}
            >
              {t(report.labelKey)}
            </Button>
          ))}
        </div>
      </nav>

      <PurchasingReportPage reportId={type} />
    </div>
  );
}
