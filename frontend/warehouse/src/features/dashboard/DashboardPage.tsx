import { useNavigate } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Boxes,
  CircleDollarSign,
  Gauge,
  Hourglass,
  PackageMinus,
  PackageX,
  RefreshCw,
  Truck,
  Warehouse as WarehouseIcon,
} from "lucide-react";
import { PageHeader, PanelTitle } from "@/components/PageHeader";
import { MetricCard } from "@/components/metric-card/MetricCard";
import { StatusBadge } from "@/components/status-badge/StatusBadge";
import { Button } from "@/components/ui/button";
import { LoadingState, ErrorState } from "@/components/states/States";
import { Spinner } from "@/components/ui/spinner";
import { formatCurrency, formatNumber, formatDateTime } from "@/lib/formatters";
import { useWarehouseScope, ALL_WAREHOUSES } from "@/app/warehouse-scope-provider";
import { useWarehouseDashboard } from "@/lib/hooks/useDashboard";
import { warehouseHealth, alertCount } from "@/lib/status-labels";

// Read-only command center wired to GET /api/inventory/dashboard-summary.
// Honors the warehouse scope (?wh) — "all" shows the company aggregate, a
// warehouse id narrows to it. Changing scope aborts the previous request.
export function DashboardPage() {
  const navigate = useNavigate();
  const { scope } = useWarehouseScope();
  const { data, isLoading, isError, error, refetch, isFetching } = useWarehouseDashboard(scope);

  const subtitle =
    scope === ALL_WAREHOUSES
      ? "صورة موحّدة لكل المستودعات والحركة والمهام التي تحتاج قرارًا اليوم."
      : "بيانات المستودع المحدّد فقط — غيّر النطاق من الشريط العلوي لعرض الكل.";

  const header = (
    <PageHeader
      eyebrow="لوحة القيادة"
      title="مركز قيادة المستودعات"
      subtitle={subtitle}
      action={
        <Button variant="secondary" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className="h-4 w-4" /> تحديث
        </Button>
      }
    />
  );

  if (isLoading) {
    return (
      <>
        {header}
        <LoadingState />
      </>
    );
  }
  if (isError || !data) {
    return (
      <>
        {header}
        <ErrorState error={error} onRetry={() => refetch()} />
      </>
    );
  }

  const k = data.kpis;
  const warehouses = data.warehouses;

  return (
    <>
      {header}

      {/* Background-refresh hint (data already shown). */}
      {isFetching && (
        <div className="mb-3 flex items-center gap-2 text-xs font-bold text-slate-400" aria-live="polite">
          <Spinner className="h-3.5 w-3.5" /> جارٍ تحديث البيانات…
        </div>
      )}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="قيمة المخزون" value={formatCurrency(k.inventoryValue)} note="بمتوسط تكلفة المستودع (WAC)" icon={CircleDollarSign} />
        <MetricCard label="الأصناف المسجلة" value={formatNumber(k.itemCount)} note="أصناف لها رصيد في النطاق" icon={Boxes} tone="blue" onClick={() => navigate("/inventory")} />
        <MetricCard label="أصناف منخفضة" value={formatNumber(k.lowCount)} note="عند حد إعادة الطلب أو دونه" icon={PackageMinus} tone="amber" onClick={() => navigate("/inventory?status=low")} />
        <MetricCard label="أصناف نافدة" value={formatNumber(k.outCount)} note="رصيد صفري" icon={PackageX} tone="rose" onClick={() => navigate("/inventory?status=out")} />
      </section>

      <section className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="تحويلات معلّقة" value={formatNumber(data.transfers.pending)} note="مسودة / بانتظار الاعتماد" icon={Truck} tone="amber" onClick={() => navigate("/transfers")} />
        <MetricCard label="تحويلات قيد النقل" value={formatNumber(data.transfers.inTransit)} note="مصروفة لم تُستلَم بالكامل" icon={Truck} tone="blue" onClick={() => navigate("/transfers")} />
        <MetricCard label="مستودعات نشطة" value={formatNumber(k.activeWarehouses)} note={`${formatNumber(warehouses.length)} مستودع ضمن النطاق`} icon={WarehouseIcon} onClick={() => navigate("/warehouses")} />
        <MetricCard
          label="دفعات قاربت الصلاحية"
          value={data.expiry.available ? formatNumber(data.expiry.count) : "غير متاح"}
          note={data.expiry.available ? `تقديري · قيمة معرّضة ${formatCurrency(data.expiry.atRiskValue)} خلال ${data.expiry.days} يومًا` : "بيانات الدفعات غير متوفرة"}
          icon={Hourglass}
          tone="violet"
          onClick={data.expiry.available ? () => navigate("/analytics") : undefined}
        />
      </section>

      <section className="mt-4 grid gap-4 xl:grid-cols-[1.2fr_.8fr]">
        <article className="surface overflow-hidden">
          <PanelTitle
            icon={Gauge}
            title="صحة المستودعات"
            subtitle="القيمة، الكمية، والتنبيهات المفتوحة لكل مستودع"
            action={<Button variant="ghost" onClick={() => navigate("/warehouses")}>عرض الكل</Button>}
          />
          {warehouses.length === 0 ? (
            <div className="p-10 text-center text-sm font-bold text-slate-400">لا توجد مستودعات ضمن هذا النطاق.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[620px] text-right">
                <thead className="bg-slate-50 text-[11px] font-extrabold text-slate-400">
                  <tr>
                    <th className="px-5 py-3">المستودع</th>
                    <th className="px-4 py-3">القيمة</th>
                    <th className="px-4 py-3">الكمية</th>
                    <th className="px-4 py-3">تنبيهات</th>
                    <th className="px-5 py-3">الحالة</th>
                  </tr>
                </thead>
                <tbody>
                  {warehouses.map((w) => {
                    const alerts = alertCount(w);
                    return (
                      <tr key={w.id} className="table-row cursor-pointer" onClick={() => navigate("/warehouses")}>
                        <td className="px-5 py-4">
                          <div className="font-extrabold text-slate-800">{w.name}</div>
                          <div className="mt-1 text-xs font-bold text-slate-400">{w.code}</div>
                        </td>
                        <td className="px-4 py-4 text-sm font-extrabold text-slate-700 tabular-nums">{formatCurrency(w.totalValue)}</td>
                        <td className="px-4 py-4 text-sm font-bold text-slate-600 tabular-nums">{formatNumber(w.totalQty)}</td>
                        <td className="px-4 py-4">
                          <span className={`font-extrabold ${alerts > 0 ? "text-rose-600" : "text-slate-400"}`}>{formatNumber(alerts)}</span>
                        </td>
                        <td className="px-5 py-4"><StatusBadge>{warehouseHealth(w)}</StatusBadge></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </article>

        <article className="surface overflow-hidden">
          <PanelTitle icon={Activity} title="آخر الحركات" subtitle="مرجع واحد لكل حركة مع أثرها" />
          <div className="p-5">
            {data.recentMovements.length === 0 ? (
              <div className="py-8 text-center text-sm font-bold text-slate-400">لا توجد حركات حديثة ضمن هذا النطاق.</div>
            ) : (
              data.recentMovements.map((m, index) => {
                const positive = m.type === "in";
                return (
                  <div key={m.id} className="relative flex gap-3 pb-5 last:pb-0">
                    {index < data.recentMovements.length - 1 && <span className="absolute right-[17px] top-9 h-[calc(100%-26px)] w-px bg-slate-200" />}
                    <span className={`z-10 grid h-9 w-9 shrink-0 place-items-center rounded-full border-4 border-white ${positive ? "bg-emerald-100 text-emerald-700" : "bg-sky-100 text-sky-700"}`}>
                      {positive ? <ArrowDownLeft className="h-4 w-4" /> : <ArrowUpRight className="h-4 w-4" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex justify-between gap-3">
                        <span className="truncate text-sm font-extrabold text-slate-800">{m.itemName || m.reason || m.itemId}</span>
                        <span className="shrink-0 text-xs font-bold text-slate-400">{formatDateTime(m.date)}</span>
                      </div>
                      <div className="mt-1 flex justify-between gap-3 text-xs">
                        <span className="truncate font-bold text-slate-400">{m.reason}{m.warehouseName ? ` · ${m.warehouseName}` : ""}</span>
                        <span className={`shrink-0 font-extrabold tabular-nums ${positive ? "text-emerald-600" : "text-sky-600"}`}>
                          {positive ? "+" : "−"}{formatNumber(m.qty)}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </article>
      </section>

      {data.kpis.negativeCount > 0 && (
        <div className="surface mt-4 flex items-center gap-3 border-rose-200 bg-rose-50/60 p-4 text-sm font-bold text-rose-700">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          يوجد {formatNumber(data.kpis.negativeCount)} صنف برصيد سالب — راجع المخزون لتصحيح العجز.
        </div>
      )}
    </>
  );
}
