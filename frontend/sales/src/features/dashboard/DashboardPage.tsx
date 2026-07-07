import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { TrendingUp, CalendarRange, Wallet, AlertTriangle, FileText, HandCoins, Users } from "lucide-react";
import { o2cApi } from "@/lib/api";
import { qk } from "@/lib/query-keys";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/metric-card/MetricCard";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { LoadingState, ErrorState } from "@/components/states/States";
import { Money } from "@/features/_shared/ui";

export function DashboardPage() {
  const q = useQuery({
    queryKey: qk.dashboard(),
    queryFn: ({ signal }) => o2cApi.dashboard(signal).then((r) => r.data),
  });

  if (q.isLoading) return <LoadingState rows={6} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;

  return (
    <div>
      <PageHeader eyebrow="Order-to-Cash" title="لوحة المبيعات والذمم" subtitle="مؤشرات المبيعات والتحصيل والتعرّض الائتماني لحظيًا." />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="مبيعات اليوم" value={<Money value={d.today.total} />} note={`${d.today.count} فاتورة`} icon={TrendingUp} tone="teal" />
        <MetricCard label="مبيعات الشهر" value={<Money value={d.monthToDate.total} />} icon={CalendarRange} tone="blue" />
        <MetricCard label="إجمالي الذمم المفتوحة" value={<Money value={d.openAr.total} />} note={`${d.openAr.count} فاتورة`} icon={Wallet} tone="violet" />
        <MetricCard label="متأخرات التحصيل" value={<Money value={d.overdueAr.total} />} note={`${d.overdueAr.count} فاتورة متأخرة`} icon={AlertTriangle} tone="rose" />
        <MetricCard label="تحصيلات اليوم" value={<Money value={0} />} note="راجع سجل التحصيلات" icon={HandCoins} tone="teal" />
        <MetricCard label="الفواتير المفتوحة" value={String(d.openAr.count)} icon={FileText} tone="blue" />
        <MetricCard label="دفعات غير مخصّصة" value={<Money value={d.unallocatedPayments.total} />} note={`${d.unallocatedPayments.count} دفعة`} icon={HandCoins} tone="amber" />
        <MetricCard label="عملاء فوق الحد" value={String(d.topExposure.length)} icon={Users} tone="rose" />
      </div>

      <Card className="mt-6">
        <CardHeader className="flex items-center justify-between">
          <CardTitle>أعلى تعرّض ائتماني</CardTitle>
          <Link to="/reports/credit-exposure" className="text-sm font-bold text-teal-700 hover:underline">عرض التقرير</Link>
        </CardHeader>
        <CardBody>
          {d.topExposure.length === 0 ? (
            <p className="py-6 text-center text-sm font-medium text-slate-400">لا يوجد عملاء عليهم ذمم مفتوحة.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {d.topExposure.map((c) => (
                <li key={c.customerId ?? c.customerName} className="flex items-center justify-between py-3">
                  <Link to={c.customerId ? `/customers/${c.customerId}` : "#"} className="text-sm font-bold text-slate-800 hover:text-teal-700">
                    {c.customerName || "—"}
                  </Link>
                  <Money value={c.balance} className="text-sm font-extrabold text-slate-900" />
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
