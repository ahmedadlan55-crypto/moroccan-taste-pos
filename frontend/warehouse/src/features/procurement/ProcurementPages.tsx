// Procurement feature pages — dashboard, suppliers (+detail), orders (+detail),
// receipts, invoices, payments, returns, reports. Reuse the shared UI primitives
// and the useProcurement hooks. All money/qty rendered via formatters (English
// digits). Backend enforces permissions; useCan hides obviously-forbidden buttons.
import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ShoppingBag, ClipboardList, AlarmClock, PackageCheck, FileWarning, Wallet, TriangleAlert, ArrowLeftRight,
} from "lucide-react";
import { PageHeader, PanelTitle } from "@/components/PageHeader";
import { MetricCard } from "@/components/metric-card/MetricCard";
import { StatusBadge } from "@/components/status-badge/StatusBadge";
import { Button } from "@/components/ui/button";
import { LoadingState, ErrorState, EmptyState } from "@/components/states/States";
import { formatCurrency, formatDate } from "@/lib/formatters";
import { useCan } from "@/app/permission-provider";
import {
  useProcurementDashboard, useSuppliers, useSupplier, useSupplierStatement, useSupplierAging,
  useOrders, useOrder, useReceipts, useInvoices, usePayments, useReturns, useProcurementReport,
  useDocAction, useCreateSupplier, type ListParams,
} from "@/lib/hooks/useProcurement";
import type { ApiError } from "@/lib/api-error";

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

// ── Suppliers ─────────────────────────────────────────────────────────────
export function SuppliersPage() {
  const [params, patch] = useListState();
  const { data, isLoading, isError, error, refetch } = useSuppliers(params);
  const canManage = useCan("procurement.manage");
  const create = useCreateSupplier();
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState("");
  const [vat, setVat] = useState("");

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input className="field w-64" placeholder="بحث بالاسم / الضريبي / الهاتف…" value={params.q ?? ""} onChange={(e) => patch({ q: e.target.value, page: 1 })} />
        <div className="grow" />
        {canManage && <Button onClick={() => setShowNew((s) => !s)}>{showNew ? "إغلاق" : "+ مورد جديد"}</Button>}
      </div>
      {showNew && canManage && (
        <div className="surface mb-4 p-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <input className="field" placeholder="اسم المورد" value={name} onChange={(e) => setName(e.target.value)} />
            <input className="field" placeholder="الرقم الضريبي (اختياري)" value={vat} onChange={(e) => setVat(e.target.value)} />
            <Button disabled={create.isPending || name.trim().length < 2} onClick={() => create.mutate({ name, vatNumber: vat }, { onSuccess: () => { setName(""); setVat(""); setShowNew(false); refetch(); } })}>
              {create.isPending ? "جارٍ الحفظ…" : "حفظ"}
            </Button>
          </div>
          {create.isError && <p className="mt-2 text-sm font-semibold text-rose-600">{(create.error as ApiError)?.message}</p>}
        </div>
      )}
      {isLoading ? <LoadingState /> : isError ? <ErrorState error={error} onRetry={() => refetch()} /> : !data || data.rows.length === 0 ? (
        <EmptyState title="لا موردين" body="ابدأ بإضافة مورد." />
      ) : (
        <div className="surface overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead className="bg-slate-50"><tr><Th>المورد</Th><Th>الرقم الضريبي</Th><Th>المدينة</Th><Th>شروط الدفع</Th><Th className="text-left">الرصيد المستحق</Th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {data.rows.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50">
                    <Td><Link className="font-bold text-teal-700 hover:underline" to={`/purchasing/suppliers/${s.id}`}>{s.name}</Link></Td>
                    <Td className="tabular-nums text-slate-500" >{s.vatNumber || "—"}</Td>
                    <Td>{s.city || "—"}</Td>
                    <Td>{s.paymentTerms}</Td>
                    <Td className="text-left font-bold tabular-nums">{formatCurrency(s.apBalance)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {data && <Pager page={data.page} totalPages={data.totalPages} onPage={(p) => patch({ page: p })} />}
    </div>
  );
}

export function SupplierDetailPage() {
  const { id = "" } = useParams();
  const { data, isLoading, isError, error, refetch } = useSupplier(id);
  const statement = useSupplierStatement(id, {});
  const aging = useSupplierAging(id);
  if (isLoading) return <LoadingState />;
  if (isError || !data) return <ErrorState error={error} onRetry={() => refetch()} />;
  const s = data as Record<string, unknown>;
  const rows = (statement.data?.data ?? []) as Array<{ date: string; type: string; ref: string; debit: number; credit: number; balance: number }>;
  return (
    <div className="grid gap-6">
      <Link to="/purchasing/suppliers" className="text-sm font-bold text-teal-700 hover:underline">← الموردون</Link>
      <PageHeader eyebrow="مورد" title={String(s.name)} subtitle={String(s.vat_number || "")} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="الرصيد المستحق" value={formatCurrency(Number(s.apBalance) || 0)} icon={Wallet} tone="violet" />
        <MetricCard label="إجمالي الفواتير" value={formatCurrency(Number(s.invoicedTotal) || 0)} icon={ShoppingBag} tone="teal" />
        <MetricCard label="المسدد" value={formatCurrency(Number(s.paidTotal) || 0)} icon={PackageCheck} tone="blue" />
        <MetricCard label="الأعمار (الإجمالي)" value={formatCurrency(aging.data?.total ?? 0)} icon={AlarmClock} tone="amber" />
      </div>
      <section className="surface overflow-hidden">
        <PanelTitle title="كشف الحساب" subtitle={`الرصيد الختامي: ${formatCurrency(statement.data?.closingBalance ?? 0)}`} />
        {statement.isLoading ? <div className="p-6"><LoadingState rows={2} /></div> : rows.length === 0 ? (
          <div className="p-6"><EmptyState title="لا حركات" /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead className="bg-slate-50"><tr><Th>التاريخ</Th><Th>النوع</Th><Th>المرجع</Th><Th className="text-left">مدين</Th><Th className="text-left">دائن</Th><Th className="text-left">الرصيد</Th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r, i) => (
                  <tr key={i}>
                    <Td className="tabular-nums">{formatDate(r.date)}</Td><Td>{r.type === "invoice" ? "فاتورة" : "سداد"}</Td><Td>{r.ref}</Td>
                    <Td className="text-left tabular-nums">{r.debit ? formatCurrency(r.debit) : "—"}</Td>
                    <Td className="text-left tabular-nums">{r.credit ? formatCurrency(r.credit) : "—"}</Td>
                    <Td className="text-left font-bold tabular-nums">{formatCurrency(r.balance)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
        {canCreate && <Link to="/purchasing/orders/new"><Button>+ أمر شراء</Button></Link>}
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
                  <Td><Link className="font-bold text-teal-700 hover:underline" to={`/purchasing/orders/${o.id}`}>{o.poNumber}</Link></Td>
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

export function OrderDetailPage() {
  const { id = "" } = useParams();
  const { data, isLoading, isError, error, refetch } = useOrder(id);
  const action = useDocAction("orders");
  const canApprove = useCan("procurement.approve");
  const canManage = useCan("procurement.manage");
  if (isLoading) return <LoadingState />;
  if (isError || !data) return <ErrorState error={error} onRetry={() => refetch()} />;
  const o = data as Record<string, unknown>;
  const lines = (o.lines ?? []) as Record<string, unknown>[];
  const status = String(o.status);
  const version = Number(o.version) || 1;
  const run = (act: string) => action.mutate({ id, action: act, expectedVersion: version }, { onSuccess: () => refetch() });
  return (
    <div className="grid gap-6">
      <Link to="/purchasing/orders" className="text-sm font-bold text-teal-700 hover:underline">← أوامر الشراء</Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader eyebrow="أمر شراء" title={String(o.po_number)} subtitle={String(o.supplier_name)} />
        <StatusBadge>{st(status)}</StatusBadge>
      </div>
      {action.isError && <p className="text-sm font-semibold text-rose-600">{(action.error as ApiError)?.message}</p>}
      <div className="flex flex-wrap gap-2">
        {canManage && status === "draft" && <Button onClick={() => run("submit")}>تقديم</Button>}
        {canApprove && status === "submitted" && <Button onClick={() => run("approve")}>اعتماد</Button>}
        {canApprove && status === "approved" && <Button variant="secondary" onClick={() => run("send")}>إرسال للمورد</Button>}
        {canApprove && ["approved", "sent", "fully_received"].includes(status) && <Button variant="secondary" onClick={() => run("close")}>إغلاق</Button>}
        {canApprove && ["draft", "submitted", "approved"].includes(status) && <Button variant="danger" onClick={() => run("cancel")}>إلغاء</Button>}
      </div>
      <section className="surface overflow-hidden">
        <PanelTitle title="السطور" />
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead className="bg-slate-50"><tr><Th>المادة</Th><Th className="text-left">الكمية المدخلة</Th><Th className="text-left">الكمية الأساسية</Th><Th className="text-left">المستلم</Th><Th className="text-left">السعر</Th><Th className="text-left">الإجمالي</Th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {lines.map((l, i) => (
                <tr key={i}>
                  <Td>{String(l.item_name)}</Td>
                  <Td className="text-left tabular-nums">{Number(l.entered_qty)} {String(l.entered_unit_code || "")}</Td>
                  <Td className="text-left tabular-nums">{Number(l.base_qty)}</Td>
                  <Td className="text-left tabular-nums">{Number(l.base_received_qty)}</Td>
                  <Td className="text-left tabular-nums">{formatCurrency(Number(l.unit_price))}</Td>
                  <Td className="text-left font-bold tabular-nums">{formatCurrency(Number(l.total))}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
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
        { h: "الرقم", c: (r) => r.receiptNumber }, { h: "المورد", c: (r) => r.supplierName },
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
        { h: "الرقم", c: (r) => r.invoiceNo || r.code }, { h: "المورد", c: (r) => r.supplierName },
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
        { h: "الرقم", c: (r) => r.paymentNumber }, { h: "الطريقة", c: (r) => r.method },
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
        { h: "الرقم", c: (r) => r.returnNumber }, { h: "المرحلة", c: (r) => (r.phase === "after_invoice" ? "بعد الفاتورة" : "قبل الفاتورة") },
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
      {isLoading ? <LoadingState /> : isError ? <ErrorState error={error} onRetry={() => refetch()} /> : rows.length === 0 ? (
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
