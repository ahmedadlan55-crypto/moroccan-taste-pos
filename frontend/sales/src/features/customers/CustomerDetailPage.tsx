import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Printer, Wallet, CreditCard, Gauge, AlertTriangle } from "lucide-react";
import { o2cApi } from "@/lib/api";
import { qk } from "@/lib/query-keys";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { MetricCard } from "@/components/metric-card/MetricCard";
import { Button } from "@/components/ui/button";
import { LoadingState, ErrorState } from "@/components/states/States";
import { Money, Num, DateCell, StatusPill, TableShell, Th, Td } from "@/features/_shared/ui";
import { formatCurrency } from "@/lib/formatters";

const AGING_LABELS: Record<string, string> = {
  current: "جاري", d1_30: "1-30", d31_60: "31-60", d61_90: "61-90", d91_120: "91-120", d120_plus: "+120",
};

export function CustomerDetailPage() {
  const { id = "" } = useParams();
  const [stmtOpen, setStmtOpen] = useState(false);

  const q = useQuery({
    queryKey: qk.customer360(id),
    queryFn: ({ signal }) => o2cApi.customer360(id, signal).then((r) => r.data),
    enabled: !!id,
  });

  if (q.isLoading) return <LoadingState rows={6} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const c = d.customer;
  const ex = d.creditExposure;

  return (
    <div>
      <Link to="/customers" className="mb-3 inline-flex items-center gap-1 text-sm font-bold text-slate-500 hover:text-teal-700 no-print">
        <ArrowRight className="h-4 w-4" /> رجوع للعملاء
      </Link>
      <PageHeader
        eyebrow={`عميل ${c.customerType}${c.isActive ? "" : " · معطّل"}`}
        title={c.name}
        subtitle={[c.phone, c.vatNumber, c.city].filter(Boolean).join(" · ") || undefined}
        action={
          <div className="flex flex-wrap items-center gap-2 no-print">
            <Button variant="secondary" onClick={() => { setStmtOpen(true); }}><Printer className="ml-1 h-4 w-4" /> كشف حساب</Button>
            <Link to={`/payments?customerId=${c.id}`}><Button variant="secondary">تسجيل تحصيل</Button></Link>
            <Link to={`/orders?customerId=${c.id}`}><Button>أمر بيع</Button></Link>
          </div>
        }
      />

      {d.warnings.length > 0 && (
        <div className="mb-4 flex flex-col gap-1 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 no-print">
          {d.warnings.map((w, i) => (
            <span key={i} className="flex items-center gap-2 text-sm font-bold text-amber-800"><AlertTriangle className="h-4 w-4" /> {w}</span>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="الرصيد (ذمم)" value={<Money value={d.balance} />} icon={Wallet} tone="violet" />
        <MetricCard label="حد الائتمان" value={<Money value={ex.creditLimit} />} icon={CreditCard} tone="blue" />
        <MetricCard label="التعرّض الائتماني" value={<Money value={ex.exposure} />} note={ex.utilizationPct != null ? `${ex.utilizationPct}% مستخدم` : undefined} icon={Gauge} tone="amber" />
        <MetricCard label="المتاح" value={<Money value={ex.available} />} icon={CreditCard} tone={ex.available < 0 ? "rose" : "teal"} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>الفواتير الأخيرة</CardTitle></CardHeader>
          <CardBody>
            {d.recentSales.length === 0 ? <Empty /> : (
              <TableShell head={<tr><Th>الفاتورة</Th><Th>التاريخ</Th><Th>الإجمالي</Th><Th>المتبقّي</Th><Th>الحالة</Th></tr>}>
                {d.recentSales.map((inv) => (
                  <tr key={inv.id} className="hover:bg-slate-50/60">
                    <Td><Link to={`/invoices/${inv.id}`} className="font-bold text-teal-700 hover:underline">{inv.document_number}</Link></Td>
                    <Td><DateCell value={inv.issue_date} /></Td>
                    <Td><Money value={inv.total_amount} /></Td>
                    <Td><Money value={inv.balance_amount} /></Td>
                    <Td><StatusPill status={inv.status} /></Td>
                  </tr>
                ))}
              </TableShell>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>أعمار الذمم (حسب الاستحقاق)</CardTitle></CardHeader>
          <CardBody>
            <ul className="flex flex-col gap-2">
              {Object.entries(AGING_LABELS).map(([k, label]) => (
                <li key={k} className="flex items-center justify-between text-sm">
                  <span className="font-bold text-slate-600">{label}</span>
                  <Money value={d.aging.buckets[k] ?? 0} className="font-bold" />
                </li>
              ))}
              <li className="mt-1 flex items-center justify-between border-t border-slate-100 pt-2 text-sm">
                <span className="font-extrabold text-slate-800">الإجمالي</span>
                <Money value={d.aging.total} className="font-extrabold text-slate-900" />
              </li>
            </ul>
          </CardBody>
        </Card>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex items-center justify-between"><CardTitle>ملخص</CardTitle></CardHeader>
          <CardBody>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <Stat label="فواتير مفتوحة" value={<span dir="ltr" className="tabular-nums">{d.openInvoices.count}</span>} />
              <Stat label="رصيد مفتوح" value={<Money value={d.openInvoices.balance} />} />
              <Stat label="عدد التحصيلات" value={<span dir="ltr" className="tabular-nums">{d.collections.count}</span>} />
              <Stat label="إجمالي التحصيلات" value={<Money value={d.collections.total} />} />
              <Stat label="رصيد دائن غير مخصّص" value={<Money value={d.unappliedCredit} />} />
              <Stat label="شروط السداد" value={`${ex.paymentTerms} · ${ex.creditDays} يوم`} />
              <Stat label="أول تعامل" value={<DateCell value={d.firstDeal} />} />
              <Stat label="آخر تعامل" value={<DateCell value={d.lastDeal} />} />
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>أعلى المنتجات (بعد المرتجعات)</CardTitle></CardHeader>
          <CardBody>
            {d.topProducts.length === 0 ? <Empty /> : (
              <ul className="divide-y divide-slate-100">
                {d.topProducts.map((p, i) => (
                  <li key={i} className="flex items-center justify-between py-2 text-sm">
                    <span className="truncate font-bold text-slate-700">{p.description || "—"}</span>
                    <span className="flex items-center gap-3">
                      <Num value={p.qty} className="text-slate-400" />
                      <Money value={p.net} className="font-bold" />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      {stmtOpen && <StatementDialog customerId={c.id} customerName={c.name} onClose={() => setStmtOpen(false)} />}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-2">
      <dt className="text-[11px] font-bold text-slate-400">{label}</dt>
      <dd className="mt-0.5 text-sm font-extrabold text-slate-800">{value}</dd>
    </div>
  );
}
function Empty() {
  return <p className="py-6 text-center text-sm font-medium text-slate-400">لا توجد بيانات.</p>;
}

function StatementDialog({ customerId, customerName, onClose }: { customerId: string; customerName: string; onClose: () => void }) {
  const q = useQuery({
    queryKey: qk.customerStatement(customerId),
    queryFn: ({ signal }) => o2cApi.customerStatement(customerId, {}, signal).then((r) => r.data),
  });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" dir="rtl" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-2xl bg-white p-6 shadow-2xl print:max-h-none print:shadow-none" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between no-print">
          <h2 className="text-lg font-extrabold text-slate-900">كشف حساب — {customerName}</h2>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => window.print()}><Printer className="ml-1 h-4 w-4" /> طباعة</Button>
            <Button variant="ghost" onClick={onClose}>إغلاق</Button>
          </div>
        </div>
        <div className="hidden print:mb-4 print:block">
          <h2 className="text-xl font-extrabold">كشف حساب — {customerName}</h2>
        </div>
        {q.isLoading ? <LoadingState rows={4} /> : q.isError ? <ErrorState error={q.error} /> : (
          <>
            <div className="mb-3 flex items-center justify-between rounded-xl bg-slate-50 px-4 py-2 text-sm">
              <span className="font-bold text-slate-600">الرصيد الافتتاحي</span>
              <Money value={q.data!.opening} className="font-extrabold" />
            </div>
            <TableShell head={<tr><Th>التاريخ</Th><Th>المرجع</Th><Th>النوع</Th><Th>الحركة</Th><Th>الرصيد</Th></tr>}>
              {(q.data!.lines as { date: string; ref: string; kind: string; amount: number; balance: number }[]).map((l, i) => (
                <tr key={i}>
                  <Td><DateCell value={l.date} /></Td>
                  <Td className="font-bold">{l.ref}</Td>
                  <Td>{l.kind === "payment" ? "تحصيل" : l.kind === "credit_note" ? "إشعار دائن" : "فاتورة"}</Td>
                  <Td><span dir="ltr" className="tabular-nums">{formatCurrency(l.amount)}</span></Td>
                  <Td><Money value={l.balance} className="font-bold" /></Td>
                </tr>
              ))}
            </TableShell>
            <div className="mt-3 flex items-center justify-between rounded-xl bg-teal-50 px-4 py-2 text-sm">
              <span className="font-bold text-teal-700">الرصيد الختامي</span>
              <Money value={q.data!.closing} className="font-extrabold text-teal-800" />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
