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
import { useT } from "@/i18n";
import { st } from "./labels";
import {
  useProcurementDashboard, useOrders, useReceipts, useInvoices, usePayments,
  useReturns, useProcurementReport, type ListParams,
} from "@/modules/inventory/lib/hooks/useProcurement";

// ── shared bits ──────────────────────────────────────────────────────────────
function Th({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <th className={`px-3 py-2 text-right text-[11px] font-extrabold uppercase tracking-wide text-slate-400 ${className}`}>{children}</th>;
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
      <span className="tabular-nums text-slate-500">{page} / {totalPages}</span>
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
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
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
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input className="field w-56" placeholder={t("purchasing.orders.searchPlaceholder")} value={params.q ?? ""} onChange={(e) => patch({ q: e.target.value, page: 1 })} />
        <StatusFilter value={params.status} onChange={(v) => patch({ status: v, page: 1 })} options={["draft", "submitted", "approved", "sent", "partially_received", "fully_received", "closed", "cancelled"]} />
        <div className="grow" />
        {canCreate && <Link to="/purchasing/orders?new=1"><Button>+ {t("purchasing.orders.addOrder")}</Button></Link>}
      </div>
      {isLoading ? <LoadingState /> : isError ? <ErrorState error={error} onRetry={() => refetch()} /> : !data || data.rows.length === 0 ? (
        <EmptyState title={t("purchasing.orders.emptyTitle")} body={t("purchasing.orders.emptyBody")} />
      ) : (
        <div className="surface overflow-hidden"><div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead className="bg-slate-50"><tr><Th>{t("purchasing.col.number")}</Th><Th>{t("purchasing.col.supplier")}</Th><Th>{t("purchasing.col.date")}</Th><Th>{t("common.status")}</Th><Th className="text-left">{t("purchasing.col.total")}</Th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {data.rows.map((o) => (
                <tr key={o.id} className="hover:bg-slate-50">
                  <Td><Link className="font-bold text-teal-700 hover:underline" to={`/purchasing/orders?doc=${o.id}`}>{o.poNumber}</Link></Td>
                  <Td>{o.supplierName}</Td><Td className="tabular-nums">{formatDate(o.poDate)}</Td>
                  <Td><StatusBadge>{st(t, o.status)}</StatusBadge></Td>
                  <Td className="text-left font-bold tabular-nums">{formatCurrency(o.total)}</Td>
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
  return (
    <SimpleList title={t("purchasing.receipts.title")} isLoading={isLoading} isError={isError} error={error} onRetry={refetch}
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
}) {
  const { title, isLoading, isError, error, onRetry, empty, rows, columns, page, totalPages, onPage } = props;
  return (
    <div>
      <h2 className="mb-3 text-lg font-extrabold text-slate-800">{title}</h2>
      {isLoading ? <LoadingState /> : isError ? <ErrorState error={error} onRetry={onRetry} /> : rows.length === 0 ? (
        <EmptyState title={empty} />
      ) : (
        <div className="surface overflow-hidden"><div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead className="bg-slate-50"><tr>{columns.map((c) => <Th key={c.h} className={c.left ? "text-left" : ""}>{c.h}</Th>)}</tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  {columns.map((c) => <Td key={c.h} className={c.left ? "text-left font-bold tabular-nums" : ""}>{c.c(r)}</Td>)}
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
const REPORTS = [
  { key: "ap-aging", labelKey: "purchasing.reports.apAging" },
  { key: "open-orders", labelKey: "purchasing.reports.openOrders" },
  { key: "three-way-match", labelKey: "purchasing.reports.threeWayMatch" },
  { key: "price-variance", labelKey: "purchasing.reports.priceVariance" },
  { key: "purchase-analysis", labelKey: "purchasing.reports.purchaseAnalysis" },
  { key: "tax", labelKey: "purchasing.reports.inputTax" },
  { key: "data-quality", labelKey: "purchasing.reports.dataQuality" },
];
export function ProcurementReportsPage() {
  const t = useT();
  const [type, setType] = useState("ap-aging");
  const { data, isLoading, isError, error, refetch } = useProcurementReport(type, {});
  const rows = Array.isArray((data as { data?: unknown })?.data) ? ((data as { data: Record<string, unknown>[] }).data) : [];
  const cols = rows.length ? Object.keys(rows[0]) : [];
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2">
        {REPORTS.map((r) => (
          <button key={r.key} onClick={() => setType(r.key)} className={`rounded-xl px-3 py-1.5 text-sm font-bold transition ${type === r.key ? "bg-teal-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>{t(r.labelKey)}</button>
        ))}
      </div>
      {isLoading ? <LoadingState /> : isError ? (
        <ErrorState error={error} onRetry={() => refetch()} title={t("purchasing.reports.errorTitle")} body={t("purchasing.reports.errorBody")} />
      ) : rows.length === 0 ? (
        <EmptyState title={t("purchasing.reports.emptyTitle")} body={t("purchasing.reports.emptyBody")} />
      ) : (
        <div className="surface overflow-hidden"><div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead className="bg-slate-50"><tr>{cols.map((c) => <Th key={c}>{c}</Th>)}</tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row, i) => <tr key={i}>{cols.map((c) => <Td key={c} className="tabular-nums">{String(row[c] ?? "")}</Td>)}</tr>)}
            </tbody>
          </table>
        </div></div>
      )}
    </div>
  );
}
