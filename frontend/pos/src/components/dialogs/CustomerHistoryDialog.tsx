/**
 * CustomerHistoryDialog — سجل العميل (close/b2-pos-daily).
 *
 * Legacy contract: public/pos/app.js posOpenCustomerHistoryModal :1395 fed by
 * _posCustomerLoadSummary :1347 → GET /api/erp/customers/:id/summary. Same
 * content, live-fetched (react-query) instead of the legacy state cache:
 *   • KPI strip — إجمالي المشتريات / عدد الفواتير / متوسط الفاتورة / آخر زيارة
 *   • meta line — phone · first visit · customer type
 *   • last 50 invoices with the legacy status badges (ملغاة / مرتجع / تعديل /
 *     مرتجع جزئياً / مكتملة — :1444-1456)
 * English digits throughout (fmt2/fmtInt); totals exclude reversed documents
 * SERVER-side (the summary endpoint's aggregation rules).
 */
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Coins, Phone, ReceiptText, Tag } from "lucide-react";
import { getCustomerSummary } from "@/lib/api";
import { fmt2, fmtInt } from "@/lib/format";
import { Dialog } from "../Dialog";
import { EmptyState, ErrorBanner, Money, Skeleton, cn } from "../ui";

/** Local date-only (matches legacy _posFormatDateOnly :1330). */
function dateOnly(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Legacy badge logic (app.js:1444-1456), verbatim mapping. */
export function invoiceBadge(r: { zatcaType: string; hasCreditNote: boolean }): { label: string; tone: string } {
  if (r.zatcaType === "cancellation") return { label: "ملغاة", tone: "border-red-200 bg-red-50 text-red-700" };
  if (r.zatcaType === "credit_note") return { label: "مرتجع", tone: "border-purple-200 bg-purple-50 text-purple-700" };
  if (r.zatcaType === "debit_note") return { label: "تعديل", tone: "border-purple-200 bg-purple-50 text-purple-700" };
  if (r.hasCreditNote) return { label: "مرتجع جزئياً", tone: "border-purple-200 bg-purple-50 text-purple-700" };
  return { label: "مكتملة", tone: "border-teal-200 bg-teal-50 text-teal-700" };
}

function Kpi({ icon, label, value, unit }: { icon: React.ReactNode; label: string; value: string; unit?: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 p-3 text-center">
      <div className="mx-auto mb-1 grid h-8 w-8 place-items-center rounded-xl bg-violet-50 text-violet-600">{icon}</div>
      <p className="num text-lg font-extrabold text-ink">{value}</p>
      {unit ? <p className="text-[10px] font-bold text-slate-400">{unit}</p> : null}
      <p className="text-[11px] font-extrabold text-slate-500">{label}</p>
    </div>
  );
}

export function CustomerHistoryDialog({
  open,
  onClose,
  customer,
}: {
  open: boolean;
  onClose: () => void;
  customer: { id: string; name: string | null; phone: string | null } | null;
}) {
  const query = useQuery({
    queryKey: ["cust-summary", customer?.id],
    queryFn: () => getCustomerSummary(customer!.id),
    enabled: open && !!customer?.id,
    staleTime: 30_000,
  });
  const s = query.data;

  return (
    <Dialog open={open} onClose={onClose} title={`سجل العميل${customer?.name ? ` — ${customer.name}` : ""}`} widthClass="max-w-3xl">
      {query.isLoading ? (
        <div>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
          <Skeleton className="h-40 w-full" />
        </div>
      ) : query.isError ? (
        <ErrorBanner message={(query.error as Error).message || "فشل تحميل السجل"} onRetry={() => void query.refetch()} />
      ) : s ? (
        <div>
          {/* KPI strip — the legacy 4 cards (:1415-1421) */}
          <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Kpi icon={<Coins className="h-4 w-4" aria-hidden />} label="إجمالي المشتريات" value={fmt2(s.kpi.totalSpent)} unit="ر.س" />
            <Kpi icon={<ReceiptText className="h-4 w-4" aria-hidden />} label="عدد الفواتير" value={fmtInt(s.kpi.orderCount)} unit="فاتورة" />
            <Kpi icon={<Coins className="h-4 w-4" aria-hidden />} label="متوسط الفاتورة" value={fmt2(s.kpi.avgInvoice)} unit="ر.س" />
            <Kpi icon={<CalendarDays className="h-4 w-4" aria-hidden />} label="آخر زيارة" value={dateOnly(s.kpi.lastVisit)} />
          </div>

          {/* Meta line (:1423-1430) */}
          <p className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-bold text-slate-500">
            {s.customer.phone ? (
              <span className="flex items-center gap-1">
                <Phone className="h-3 w-3" aria-hidden /> <span dir="ltr" className="num">{s.customer.phone}</span>
              </span>
            ) : null}
            {s.kpi.firstVisit ? (
              <span className="flex items-center gap-1">
                <CalendarDays className="h-3 w-3" aria-hidden /> أول زيارة: <span className="num">{dateOnly(s.kpi.firstVisit)}</span>
              </span>
            ) : null}
            {s.customer.customerType ? (
              <span className="flex items-center gap-1">
                <Tag className="h-3 w-3" aria-hidden /> {s.customer.customerType}
              </span>
            ) : null}
          </p>

          {/* Recent purchases table (:1441-1486) */}
          {s.recentInvoices.length === 0 ? (
            <EmptyState
              icon={<ReceiptText className="h-10 w-10" />}
              title="لا توجد فواتير سابقة لهذا العميل"
              hint="أكمل بيعاً الآن لتسجيل أول فاتورة."
            />
          ) : (
            <div className="scrollbar-thin max-h-[45vh] overflow-y-auto rounded-xl border border-slate-200">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-slate-50 text-[11px] font-extrabold text-slate-500">
                  <tr>
                    <th className="p-2 text-start">التاريخ</th>
                    <th className="p-2 text-start">رقم الفاتورة</th>
                    <th className="p-2 text-start">الإجمالي</th>
                    <th className="p-2 text-start">الدفع</th>
                    <th className="p-2 text-start">الحالة</th>
                  </tr>
                </thead>
                <tbody>
                  {s.recentInvoices.map((r) => {
                    const badge = invoiceBadge(r);
                    const reversed = r.zatcaType === "cancellation" || r.zatcaType === "credit_note";
                    return (
                      <tr key={r.id} className={cn("border-t border-slate-100", reversed && "opacity-60")}>
                        <td className="num p-2 text-slate-500">{dateOnly(r.date)}</td>
                        <td className="p-2">
                          <span className="num font-extrabold text-ink">{r.invoiceNumber ?? r.id}</span>
                          {r.voidSerial ? <div className="num text-[10px] text-red-700">{r.voidSerial}</div> : null}
                          {r.returnSerial ? <div className="num text-[10px] text-purple-700">{r.returnSerial}</div> : null}
                        </td>
                        <td className="p-2">
                          <Money value={fmt2(r.total)} className="font-extrabold text-ink" />
                        </td>
                        <td className="p-2 font-bold text-slate-600">{r.payment || "—"}</td>
                        <td className="p-2">
                          <span className={cn("chip px-2 py-0.5 text-[10px] font-extrabold", badge.tone)}>{badge.label}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
    </Dialog>
  );
}
