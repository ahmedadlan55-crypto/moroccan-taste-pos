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
import {
  useProcurementDashboard, useOrders, useReceipts, useInvoices, usePayments,
  useReturns, useProcurementReport, type ListParams,
} from "@/modules/inventory/lib/hooks/useProcurement";

// ── shared bits ──────────────────────────────────────────────────────────────
const STATUS_AR: Record<string, string> = {
  draft: "مسودة", submitted: "مُقدّم", approved: "معتمد", sent: "مُرسل",
  partially_received: "استلام جزئي", received: "مستلم", fully_received: "مستلم كليًا",
  posted: "مُرحّل", reversed: "معكوس", cancelled: "ملغى", closed: "مغلق",
  pending_review: "قيد المراجعة", pending_approval: "بانتظار الاعتماد",
  partially_paid: "مسدد جزئيًا", paid: "مسدد", overdue: "متأخر", settled: "مُسوّى",
  requested: "مطلوب", authorized: "مُخوّل", unmatched: "غير مطابقة", partial: "جزئية", matched: "مطابقة",
};
const st = (s: string) => STATUS_AR[s] || s;

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
  return (
    <select className="field w-44" value={value ?? ""} onChange={(e) => onChange(e.target.value)} aria-label="تصفية الحالة">
      <option value="">كل الحالات</option>
      {options.map((o) => <option key={o} value={o}>{st(o)}</option>)}
    </select>
  );
}

function Pager({ page, totalPages, onPage }: { page: number; totalPages: number; onPage: (p: number) => void }) {
  if (totalPages <= 1) return null;
  return (
    <div className="mt-3 flex items-center justify-end gap-2 text-sm">
      <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>السابق</Button>
      <span className="tabular-nums text-slate-500">{page} / {totalPages}</span>
      <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>التالي</Button>
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────
export function ProcurementDashboard() {
  const { data, isLoading, isError, error, refetch } = useProcurementDashboard();
  if (isLoading) return <LoadingState />;
  if (isError || !data) return <ErrorState error={error} onRetry={() => refetch()} />;
  const cards = [
    { label: "قيمة المشتريات", value: formatCurrency(data.purchaseValue), icon: ShoppingBag, tone: "teal" as const },
    { label: "أوامر بانتظار الاعتماد", value: String(data.ordersPendingApproval), icon: ClipboardList, tone: "amber" as const },
    { label: "أوامر متأخرة", value: String(data.ordersOverdue), icon: AlarmClock, tone: "rose" as const },
    { label: "استلامات جزئية", value: String(data.partialReceipts), icon: PackageCheck, tone: "blue" as const },
    { label: "فواتير غير مطابقة", value: String(data.unmatchedInvoices), icon: FileWarning, tone: "amber" as const },
    { label: "ذمم مستحقة", value: formatCurrency(data.apDue), icon: Wallet, tone: "violet" as const },
    { label: "ذمم متأخرة", value: formatCurrency(data.apOverdue), icon: TriangleAlert, tone: "rose" as const },
    { label: "فروقات مطابقة", value: String(data.variances), icon: ArrowLeftRight, tone: "blue" as const },
  ];
  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {cards.map((c) => <MetricCard key={c.label} label={c.label} value={c.value} icon={c.icon} tone={c.tone} />)}
      </div>
      <section className="surface">
        <PanelTitle icon={ClipboardList} title="آخر النشاطات" />
        <div className="divide-y divide-slate-100">
          {data.recentActivity.length === 0 ? (
            <div className="p-6"><EmptyState title="لا نشاط بعد" body="ستظهر آخر عمليات المشتريات هنا." /></div>
          ) : data.recentActivity.map((a, i) => (
            <div key={i} className="flex items-center justify-between px-5 py-3 text-sm">
              <span className="font-semibold text-slate-700">{a.documentType} · {a.action}</span>
              <span className="flex items-center gap-3 text-slate-400">
                <StatusBadge>{st(a.toStatus)}</StatusBadge>
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
  const [params, patch] = useListState();
  const { data, isLoading, isError, error, refetch } = useOrders(params);
  const canCreate = useCan("procurement.manage");
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input className="field w-56" placeholder="بحث برقم الأمر / المورد…" value={params.q ?? ""} onChange={(e) => patch({ q: e.target.value, page: 1 })} />
        <StatusFilter value={params.status} onChange={(v) => patch({ status: v, page: 1 })} options={["draft", "submitted", "approved", "sent", "partially_received", "fully_received", "closed", "cancelled"]} />
        <div className="grow" />
        {canCreate && <Link to="/purchasing/orders?new=1"><Button>+ أمر شراء</Button></Link>}
      </div>
      {isLoading ? <LoadingState /> : isError ? <ErrorState error={error} onRetry={() => refetch()} /> : !data || data.rows.length === 0 ? (
        <EmptyState title="لا أوامر شراء" body="أنشئ أول أمر شراء." />
      ) : (
        <div className="surface overflow-hidden"><div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead className="bg-slate-50"><tr><Th>الرقم</Th><Th>المورد</Th><Th>التاريخ</Th><Th>الحالة</Th><Th className="text-left">الإجمالي</Th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {data.rows.map((o) => (
                <tr key={o.id} className="hover:bg-slate-50">
                  <Td><Link className="font-bold text-teal-700 hover:underline" to={`/purchasing/orders?doc=${o.id}`}>{o.poNumber}</Link></Td>
                  <Td>{o.supplierName}</Td><Td className="tabular-nums">{formatDate(o.poDate)}</Td>
                  <Td><StatusBadge>{st(o.status)}</StatusBadge></Td>
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
  const [params, patch] = useListState();
  const { data, isLoading, isError, error, refetch } = useReceipts(params);
  return (
    <SimpleList title="الاستلامات" isLoading={isLoading} isError={isError} error={error} onRetry={refetch}
      empty="لا استلامات" rows={data?.rows ?? []} page={data?.page ?? 1} totalPages={data?.totalPages ?? 1} onPage={(p) => patch({ page: p })}
      columns={[
        { h: "الرقم", c: (r) => <Link className="font-bold text-teal-700 hover:underline" to={`/purchasing/receiving?doc=${r.id}`}>{r.receiptNumber}</Link> }, { h: "المورد", c: (r) => r.supplierName },
        { h: "التاريخ", c: (r) => formatDate(r.receiptDate) }, { h: "الحالة", c: (r) => <StatusBadge>{st(r.status)}</StatusBadge> },
        { h: "الإجمالي", c: (r) => formatCurrency(r.total), left: true },
      ]} />
  );
}
export function InvoicesListPage() {
  const [params, patch] = useListState();
  const { data, isLoading, isError, error, refetch } = useInvoices(params);
  return (
    <SimpleList title="فواتير الموردين" isLoading={isLoading} isError={isError} error={error} onRetry={refetch}
      empty="لا فواتير" rows={data?.rows ?? []} page={data?.page ?? 1} totalPages={data?.totalPages ?? 1} onPage={(p) => patch({ page: p })}
      columns={[
        { h: "الرقم", c: (r) => <Link className="font-bold text-teal-700 hover:underline" to={`/purchasing/invoices?doc=${r.id}`}>{r.invoiceNo || r.code}</Link> }, { h: "المورد", c: (r) => r.supplierName },
        { h: "المطابقة", c: (r) => st(r.matchingStatus) }, { h: "الحالة", c: (r) => <StatusBadge>{st(r.status)}</StatusBadge> },
        { h: "المتبقي", c: (r) => formatCurrency(r.balance), left: true },
      ]} />
  );
}
export function PaymentsListPage() {
  const [params, patch] = useListState();
  const { data, isLoading, isError, error, refetch } = usePayments(params);
  return (
    <SimpleList title="المدفوعات" isLoading={isLoading} isError={isError} error={error} onRetry={refetch}
      empty="لا مدفوعات" rows={data?.rows ?? []} page={data?.page ?? 1} totalPages={data?.totalPages ?? 1} onPage={(p) => patch({ page: p })}
      columns={[
        { h: "الرقم", c: (r) => <Link className="font-bold text-teal-700 hover:underline" to={`/purchasing/payments?doc=${r.id}`}>{r.paymentNumber}</Link> }, { h: "الطريقة", c: (r) => r.method },
        { h: "الحالة", c: (r) => <StatusBadge>{st(r.status)}</StatusBadge> }, { h: "المبلغ", c: (r) => formatCurrency(r.amount), left: true },
      ]} />
  );
}
export function ReturnsPage() {
  const [params, patch] = useListState();
  const { data, isLoading, isError, error, refetch } = useReturns(params);
  return (
    <SimpleList title="مرتجعات الشراء" isLoading={isLoading} isError={isError} error={error} onRetry={refetch}
      empty="لا مرتجعات" rows={data?.rows ?? []} page={data?.page ?? 1} totalPages={data?.totalPages ?? 1} onPage={(p) => patch({ page: p })}
      columns={[
        { h: "الرقم", c: (r) => <Link className="font-bold text-teal-700 hover:underline" to={`/purchasing/returns?doc=${r.id}`}>{r.returnNumber}</Link> }, { h: "المرحلة", c: (r) => (r.phase === "after_invoice" ? "بعد الفاتورة" : "قبل الفاتورة") },
        { h: "الحالة", c: (r) => <StatusBadge>{st(r.status)}</StatusBadge> }, { h: "الإجمالي", c: (r) => formatCurrency(r.total), left: true },
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
  { key: "ap-aging", label: "أعمار الذمم" },
  { key: "open-orders", label: "أوامر مفتوحة" },
  { key: "three-way-match", label: "المطابقة الثلاثية" },
  { key: "price-variance", label: "فروق الأسعار" },
  { key: "purchase-analysis", label: "تحليل المشتريات" },
  { key: "tax", label: "ضريبة المدخلات" },
  { key: "data-quality", label: "جودة البيانات" },
];
export function ProcurementReportsPage() {
  const [type, setType] = useState("ap-aging");
  const { data, isLoading, isError, error, refetch } = useProcurementReport(type, {});
  const rows = Array.isArray((data as { data?: unknown })?.data) ? ((data as { data: Record<string, unknown>[] }).data) : [];
  const cols = rows.length ? Object.keys(rows[0]) : [];
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2">
        {REPORTS.map((r) => (
          <button key={r.key} onClick={() => setType(r.key)} className={`rounded-xl px-3 py-1.5 text-sm font-bold transition ${type === r.key ? "bg-teal-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>{r.label}</button>
        ))}
      </div>
      {isLoading ? <LoadingState /> : isError ? (
        <ErrorState error={error} onRetry={() => refetch()} title="تعذّر تحميل تقرير المشتريات" body="أعد المحاولة، وإن استمرت المشكلة تواصل مع المسؤول." />
      ) : rows.length === 0 ? (
        <EmptyState title="لا بيانات" body="لا توجد صفوف لهذا التقرير." />
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
