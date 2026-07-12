import { useSearchParams, useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, Search, PackageCheck, Truck, ClipboardList } from "lucide-react";
import { PageHeader } from "@/shared/ui";
import { MetricCard } from "@/modules/inventory/lib/MetricCard";
import { StatusBadge } from "@/shared/ui";
import { Button } from "@/shared/ui";
import { LoadingState, EmptyState, ErrorState } from "@/shared/ui";
import { Progress } from "@/shared/ui";
import { formatCurrency, formatNumber, formatDate, formatQty } from "@/shared/lib";
import { useOpenPurchases } from "@/modules/inventory/lib/hooks/usePurchaseReceiving";

const PAGE_SIZES = [10, 25, 50];
const RECEIVE_STATUS_LABEL: Record<string, string> = { none: "لم يبدأ", partial: "استلام جزئي" };

// The purchase-receiving work queue: legacy purchases still receivable through
// the V2 receipts flow (requested / previously received / remaining per line).
export function PurchaseReceivingPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const q = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = PAGE_SIZES.includes(Number(params.get("pageSize"))) ? Number(params.get("pageSize")) : 25;

  function patch(next: Record<string, string | number | null>, resetPage = true) {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) { if (v === null || v === "") p.delete(k); else p.set(k, String(v)); }
    if (resetPage && !("page" in next)) p.delete("page");
    setParams(p, { replace: true });
  }

  const { data, isLoading, isError, error, refetch, isFetching } = useOpenPurchases({ q, status, page, pageSize });

  const rows = data?.rows ?? [];
  const pg = data?.pagination;
  const totalPages = pg?.totalPages ?? 1;
  const notStarted = rows.filter((r) => r.v2ReceiveStatus === "none").length;
  const partial = rows.filter((r) => r.v2ReceiveStatus === "partial").length;

  return (
    <div>
      <PageHeader
        eyebrow="العمليات"
        title="استلام المشتريات"
        subtitle="قائمة أوامر الشراء المفتوحة — استلم كليًا أو جزئيًا عبر إذن استلام V2 (بدفعات وصلاحية للأصناف المتتبعة). النظام يمنع ازدواج الاستلام مع المسار القديم."
      />

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <MetricCard label="أوامر مفتوحة" value={formatNumber(pg?.total ?? 0)} note="بانتظار استلام كلي أو جزئي" icon={Truck} tone="amber" />
        <MetricCard label="لم يبدأ استلامها" value={formatNumber(notStarted)} note="في هذه الصفحة" icon={ClipboardList} tone="blue" />
        <MetricCard label="استلام جزئي" value={formatNumber(partial)} note="في هذه الصفحة" icon={PackageCheck} tone="teal" />
      </section>

      <section className="surface mt-4 flex flex-col gap-3 p-4 lg:flex-row lg:items-center">
        <label className="relative flex-1">
          <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input className="field w-full pr-10" placeholder="بحث برقم الأمر أو المورد…" defaultValue={q} onChange={(e) => patch({ q: e.target.value })} aria-label="بحث" />
        </label>
        <div className="flex gap-1">
          {[{ value: "", label: "الكل" }, { value: "none", label: "لم يبدأ" }, { value: "partial", label: "جزئي" }].map((o) => (
            <button key={o.value} type="button" onClick={() => patch({ status: o.value })}
              className={`min-h-10 rounded-xl border px-3 text-xs font-extrabold transition ${status === o.value ? "border-teal-600 bg-teal-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>
              {o.label}
            </button>
          ))}
        </div>
      </section>

      <section className="mt-4">
        {isLoading ? <LoadingState /> : isError ? <ErrorState error={error} onRetry={() => refetch()} /> : rows.length === 0 ? (
          <EmptyState title="لا توجد أوامر شراء مفتوحة" body={q || status ? "جرّب تعديل عوامل التصفية." : "كل أوامر الشراء مُستلمة — أنشئ أمر شراء جديدًا من شاشة المشتريات."} />
        ) : (
          <>
            <div className="surface hidden overflow-hidden md:block">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs font-bold text-slate-500">
                  <tr>
                    <th className="px-4 py-3 text-right">أمر الشراء</th>
                    <th className="px-4 py-3 text-right">المورد</th>
                    <th className="px-4 py-3 text-right">المستودع</th>
                    <th className="px-4 py-3 text-right">التاريخ</th>
                    <th className="px-4 py-3 text-right">حالة الاستلام</th>
                    <th className="px-4 py-3 text-right">التقدم</th>
                    <th className="px-4 py-3 text-left">القيمة</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r) => {
                    const pct = r.orderedQty > 0 ? (r.receivedQty / r.orderedQty) * 100 : 0;
                    return (
                      <tr key={r.id} className="cursor-pointer transition hover:bg-slate-50" onClick={() => navigate(`/purchase-receiving/${r.id}`)}>
                        <td className="px-4 py-3">
                          <span className="font-extrabold text-slate-900">{r.id}</span>
                          {r.poId && <span className="mr-2 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">PO</span>}
                        </td>
                        <td className="px-4 py-3 text-slate-600">{r.supplierName || "—"}</td>
                        <td className="px-4 py-3 text-slate-500">{r.warehouseName || "—"}</td>
                        <td className="px-4 py-3 text-slate-500">{formatDate(r.purchaseDate)}</td>
                        <td className="px-4 py-3"><StatusBadge>{RECEIVE_STATUS_LABEL[r.v2ReceiveStatus]}</StatusBadge></td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="w-24"><Progress value={pct} tone={pct >= 100 ? "teal" : "amber"} /></div>
                            <span className="text-xs tabular-nums text-slate-500">{formatQty(r.receivedQty)} / {formatQty(r.orderedQty)}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-left font-bold tabular-nums text-slate-800">{formatCurrency(r.totalPrice)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="space-y-3 md:hidden">
              {rows.map((r) => (
                <button key={r.id} type="button" onClick={() => navigate(`/purchase-receiving/${r.id}`)} className="surface block w-full p-4 text-right">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-extrabold text-slate-900">{r.id}</span>
                    <StatusBadge>{RECEIVE_STATUS_LABEL[r.v2ReceiveStatus]}</StatusBadge>
                  </div>
                  <div className="mt-1 text-sm text-slate-600">{r.supplierName || "—"} · {r.warehouseName || "—"}</div>
                  <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                    <span className="tabular-nums">{formatQty(r.receivedQty)} / {formatQty(r.orderedQty)} · {formatDate(r.purchaseDate)}</span>
                    <span className="font-bold text-slate-800">{formatCurrency(r.totalPrice)}</span>
                  </div>
                </button>
              ))}
            </div>

            <div className="mt-4 flex flex-col items-center justify-between gap-3 sm:flex-row">
              <div className="flex items-center gap-3 text-xs font-medium text-slate-500">
                <span>الإجمالي {formatNumber(pg?.total ?? 0)}</span>
                <select className="field min-h-9 py-1 text-xs" value={pageSize} onChange={(e) => patch({ pageSize: e.target.value })} aria-label="حجم الصفحة">{PAGE_SIZES.map((s) => <option key={s} value={s}>{s} / صفحة</option>)}</select>
                {isFetching && <span className="text-teal-600">تحديث…</span>}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="icon" aria-label="السابق" disabled={page <= 1} onClick={() => patch({ page: page - 1 }, false)}><ChevronRight className="h-4 w-4" /></Button>
                <span className="text-xs font-bold text-slate-600">{formatNumber(page)} / {formatNumber(totalPages)}</span>
                <Button variant="ghost" size="icon" aria-label="التالي" disabled={page >= totalPages} onClick={() => patch({ page: page + 1 }, false)}><ChevronLeft className="h-4 w-4" /></Button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
