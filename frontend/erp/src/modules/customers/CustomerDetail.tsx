import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Printer, Wallet, CreditCard, Gauge, AlertTriangle, type LucideIcon } from "lucide-react";
import {
  Button, Card, CardHeader, CardTitle, CardBody, Dialog, PageHeader, LoadingState, ErrorState,
} from "@/shared/ui";
import { cn, formatCurrency } from "@/shared/lib";
import { o2cApi, qk, SalesStatus, Money, Num, DateCell } from "@/modules/sales/lib";

const AGING_LABELS: Record<string, string> = {
  current: "جاري", d1_30: "1-30", d31_60: "31-60", d61_90: "61-90", d91_120: "91-120", d120_plus: "+120",
};

type MetricTone = "violet" | "blue" | "amber" | "teal" | "rose";
const METRIC_TONE: Record<MetricTone, string> = {
  violet: "bg-violet-50 text-violet-700",
  blue: "bg-sky-50 text-sky-700",
  amber: "bg-amber-50 text-amber-700",
  teal: "bg-teal-50 text-teal-700",
  rose: "bg-rose-50 text-rose-700",
};

function Metric({ label, value, note, icon: Icon, tone }: { label: string; value: ReactNode; note?: string; icon: LucideIcon; tone: MetricTone }) {
  return (
    <div className="surface flex items-center gap-3 p-4">
      <span className={cn("grid h-11 w-11 shrink-0 place-items-center rounded-xl", METRIC_TONE[tone])}>
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <div className="text-[11px] font-bold text-slate-400">{label}</div>
        <div className="text-lg font-extrabold text-slate-900">{value}</div>
        {note && <div className="text-[11px] font-semibold text-slate-400">{note}</div>}
      </div>
    </div>
  );
}

export function CustomerDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const nav = useNavigate();
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
      <button type="button" onClick={onBack} className="mb-3 inline-flex items-center gap-1 text-sm font-bold text-slate-500 hover:text-teal-700 no-print">
        <ArrowRight className="h-4 w-4" /> رجوع للعملاء
      </button>
      <PageHeader
        eyebrow={`عميل ${c.customerType}${c.isActive ? "" : " · معطّل"}`}
        title={c.name}
        subtitle={[c.phone, c.vatNumber, c.city].filter(Boolean).join(" · ") || undefined}
        action={
          <div className="flex flex-wrap items-center gap-2 no-print">
            <Button variant="secondary" onClick={() => setStmtOpen(true)}><Printer className="h-4 w-4" /> كشف حساب</Button>
            <Button variant="secondary" onClick={() => nav(`/sales/payments?customerId=${c.id}&new=1`)}>تسجيل تحصيل</Button>
            <Button onClick={() => nav(`/sales/orders?new=1`)}>أمر بيع</Button>
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
        <Metric label="الرصيد (ذمم)" value={<Money value={d.balance} />} icon={Wallet} tone="violet" />
        <Metric label="حد الائتمان" value={<Money value={ex.creditLimit} />} icon={CreditCard} tone="blue" />
        <Metric label="التعرّض الائتماني" value={<Money value={ex.exposure} />} note={ex.utilizationPct != null ? `${ex.utilizationPct}% مستخدم` : undefined} icon={Gauge} tone="amber" />
        <Metric label="المتاح" value={<Money value={ex.available} />} icon={CreditCard} tone={ex.available < 0 ? "rose" : "teal"} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>الفواتير الأخيرة</CardTitle></CardHeader>
          <CardBody>
            {d.recentSales.length === 0 ? <Empty /> : (
              <div className="overflow-x-auto rounded-2xl border border-slate-200">
                <table className="w-full min-w-[560px] border-collapse text-right text-sm">
                  <thead className="bg-slate-50 text-xs font-bold text-slate-500">
                    <tr>
                      <th className="px-4 py-3 font-bold">الفاتورة</th>
                      <th className="px-4 py-3 font-bold">التاريخ</th>
                      <th className="px-4 py-3 font-bold">الإجمالي</th>
                      <th className="px-4 py-3 font-bold">المتبقّي</th>
                      <th className="px-4 py-3 font-bold">الحالة</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {d.recentSales.map((inv) => (
                      <tr key={inv.id} className="hover:bg-slate-50/60">
                        <td className="px-4 py-3"><button type="button" onClick={() => nav(`/sales/invoices?doc=${inv.id}`)} className="font-bold text-teal-700 hover:underline">{inv.document_number}</button></td>
                        <td className="px-4 py-3 text-slate-700"><DateCell value={inv.issue_date} /></td>
                        <td className="px-4 py-3 text-slate-700"><Money value={inv.total_amount} /></td>
                        <td className="px-4 py-3 text-slate-700"><Money value={inv.balance_amount} /></td>
                        <td className="px-4 py-3"><SalesStatus status={inv.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
          <CardHeader><CardTitle>ملخص</CardTitle></CardHeader>
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

function Stat({ label, value }: { label: string; value: ReactNode }) {
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
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title={`كشف حساب — ${customerName}`}
      footer={
        <>
          <Button variant="secondary" onClick={() => window.print()}><Printer className="h-4 w-4" /> طباعة</Button>
          <Button variant="ghost" onClick={onClose}>إغلاق</Button>
        </>
      }
    >
      {q.isLoading ? <LoadingState rows={4} /> : q.isError ? <ErrorState error={q.error} /> : (
        <>
          <div className="mb-3 flex items-center justify-between rounded-xl bg-slate-50 px-4 py-2 text-sm">
            <span className="font-bold text-slate-600">الرصيد الافتتاحي</span>
            <Money value={q.data!.opening} className="font-extrabold" />
          </div>
          <div className="overflow-x-auto rounded-2xl border border-slate-200">
            <table className="w-full min-w-[560px] border-collapse text-right text-sm">
              <thead className="bg-slate-50 text-xs font-bold text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-bold">التاريخ</th>
                  <th className="px-4 py-3 font-bold">المرجع</th>
                  <th className="px-4 py-3 font-bold">النوع</th>
                  <th className="px-4 py-3 font-bold">الحركة</th>
                  <th className="px-4 py-3 font-bold">الرصيد</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {q.data!.lines.map((l, i) => (
                  <tr key={i}>
                    <td className="px-4 py-3 text-slate-700"><DateCell value={l.date} /></td>
                    <td className="px-4 py-3 font-bold text-slate-700">{l.ref}</td>
                    <td className="px-4 py-3 text-slate-700">{l.kind === "payment" ? "تحصيل" : l.kind === "credit_note" ? "إشعار دائن" : "فاتورة"}</td>
                    <td className="px-4 py-3 text-slate-700"><span dir="ltr" className="tabular-nums">{formatCurrency(l.amount)}</span></td>
                    <td className="px-4 py-3 text-slate-700"><Money value={l.balance} className="font-bold" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-between rounded-xl bg-teal-50 px-4 py-2 text-sm">
            <span className="font-bold text-teal-700">الرصيد الختامي</span>
            <Money value={q.data!.closing} className="font-extrabold text-teal-800" />
          </div>
        </>
      )}
    </Dialog>
  );
}
