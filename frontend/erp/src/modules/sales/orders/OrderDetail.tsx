import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, PackageCheck, FileText, XCircle } from "lucide-react";
import {
  Button, Card, CardHeader, CardTitle, CardBody, PageHeader, LoadingState, ErrorState, safeUserMessage,
} from "@/shared/ui";
import { useCan } from "@/app/providers";
import { formatDateTime } from "@/shared/lib";
import { o2cApi, qk, statusMeta, SalesStatus, Money, DateCell, Info, type TimelineEvent } from "@/modules/sales/lib";

const STEPS = ["draft", "confirmed", "fulfilled", "invoiced", "closed"];

export function OrderDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const canConfirm = useCan("sales_orders.confirm");
  const canFulfill = useCan("sales_orders.fulfill");
  const canInvoice = useCan("invoices.issue");

  const q = useQuery({ queryKey: qk.order(id), queryFn: ({ signal }) => o2cApi.order(id, signal).then((r) => r.data), enabled: !!id });
  const version = q.data?.version;
  const wrap = (fn: () => Promise<unknown>) => ({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: qk.all }) });
  const confirm = useMutation(wrap(() => o2cApi.confirmOrder(id, version)));
  const fulfill = useMutation(wrap(() => o2cApi.fulfillOrder(id, version)));
  const invoice = useMutation(wrap(() => o2cApi.invoiceOrder(id, version)));
  const cancel = useMutation(wrap(() => o2cApi.cancelOrder(id, version)));

  if (q.isLoading) return <LoadingState rows={6} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const o = q.data!;
  const busy = confirm.isPending || fulfill.isPending || invoice.isPending || cancel.isPending;
  const anyErr = confirm.error || fulfill.error || invoice.error || cancel.error;
  const stepIdx = STEPS.indexOf(o.status);
  const timeline: TimelineEvent[] = o.timeline ?? [];

  return (
    <div>
      <button type="button" onClick={onBack} className="mb-3 inline-flex items-center gap-1 text-sm font-bold text-slate-500 hover:text-teal-700"><ArrowRight className="h-4 w-4" /> رجوع للأوامر</button>
      <PageHeader
        eyebrow={o.is_credit_sale ? "أمر بيع آجل" : "أمر بيع نقدي"}
        title={o.order_number}
        subtitle={o.customer_name || undefined}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {o.status === "draft" && canConfirm && <Button onClick={() => confirm.mutate()} disabled={busy}><CheckCircle2 className="h-4 w-4" /> تأكيد</Button>}
            {o.status === "confirmed" && canFulfill && <Button onClick={() => fulfill.mutate()} disabled={busy}><PackageCheck className="h-4 w-4" /> تنفيذ</Button>}
            {o.status === "fulfilled" && canInvoice && <Button onClick={() => invoice.mutate()} disabled={busy}><FileText className="h-4 w-4" /> تفويتر</Button>}
            {o.status === "invoiced" && o.invoice_id && <Button variant="secondary" onClick={() => nav(`/sales/invoices?doc=${o.invoice_id}`)}>عرض الفاتورة</Button>}
            {(o.status === "draft" || o.status === "confirmed") && <Button variant="ghost" onClick={() => cancel.mutate()} disabled={busy}><XCircle className="h-4 w-4" /> إلغاء</Button>}
          </div>
        }
      />
      {anyErr && <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">{safeUserMessage(anyErr)}</div>}

      {o.status !== "cancelled" && (
        <ol className="mb-6 flex items-center gap-2 overflow-x-auto">
          {STEPS.map((s, i) => (
            <li key={s} className="flex items-center gap-2">
              <span className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-bold ${i <= stepIdx ? "bg-teal-600 text-white" : "bg-slate-100 text-slate-400"}`}>{statusMeta(s).label}</span>
              {i < STEPS.length - 1 && <span className={`h-0.5 w-6 ${i < stepIdx ? "bg-teal-500" : "bg-slate-200"}`} />}
            </li>
          ))}
        </ol>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Info label="الحالة" value={<SalesStatus status={o.status} />} />
        <Info label="التاريخ" value={<DateCell value={o.order_date} />} />
        <Info label="الإجمالي" value={<Money value={o.total_amount} />} />
        <Info label="الفاتورة" value={o.invoice_id ? <button type="button" onClick={() => nav(`/sales/invoices?doc=${o.invoice_id}`)} className="text-xs text-teal-700 hover:underline">عرض</button> : "—"} />
      </div>

      {timeline.length > 0 && (
        <Card className="mt-6">
          <CardHeader><CardTitle>السجل الزمني</CardTitle></CardHeader>
          <CardBody>
            <ul className="flex flex-col gap-2">
              {timeline.map((e, i) => (
                <li key={i} className="flex items-center justify-between text-sm">
                  <span className="font-bold text-slate-700">{statusMeta(e.to_status).label || e.event_type}</span>
                  <span className="flex items-center gap-3">
                    <span className="text-xs text-slate-400">{e.actor_username || "—"}</span>
                    <span dir="ltr" className="text-xs tabular-nums text-slate-400">{formatDateTime(e.created_at)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
