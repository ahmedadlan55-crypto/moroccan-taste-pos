import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Send, Undo2, XCircle } from "lucide-react";
import {
  Button, Card, CardHeader, CardTitle, CardBody, PageHeader, LoadingState, ErrorState, safeUserMessage,
} from "@/shared/ui";
import { useCan } from "@/app/providers";
import { o2cApi, qk, SalesStatus, Money, Num, DateCell, Info } from "@/modules/sales/lib";

export function PaymentDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const canApprove = useCan("payments.approve");
  const canPost = useCan("payments.post");
  const canReverse = useCan("payments.reverse");

  const q = useQuery({ queryKey: qk.payment(id), queryFn: ({ signal }) => o2cApi.payment(id, signal).then((r) => r.data), enabled: !!id });

  const version = q.data?.version;
  const wrap = (fn: () => Promise<unknown>) => ({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: qk.all }) });
  const approve = useMutation(wrap(() => o2cApi.approvePayment(id, version)));
  const post = useMutation(wrap(() => o2cApi.postPayment(id, version)));
  const reverse = useMutation(wrap(() => o2cApi.reversePayment(id, version)));
  const cancel = useMutation(wrap(() => o2cApi.cancelPayment(id, version)));

  if (q.isLoading) return <LoadingState rows={6} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const p = q.data!;
  const busy = approve.isPending || post.isPending || reverse.isPending || cancel.isPending;
  const anyErr = approve.error || post.error || reverse.error || cancel.error;

  return (
    <div>
      <button type="button" onClick={onBack} className="mb-3 inline-flex items-center gap-1 text-sm font-bold text-slate-500 hover:text-teal-700"><ArrowRight className="h-4 w-4" /> رجوع للتحصيلات</button>
      <PageHeader
        eyebrow={p.is_advance ? "دفعة مقدمة" : "سند قبض"}
        title={p.payment_number}
        subtitle={p.customer_name || undefined}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {p.status === "draft" && canApprove && <Button onClick={() => approve.mutate()} disabled={busy}><CheckCircle2 className="h-4 w-4" /> اعتماد</Button>}
            {p.status === "approved" && canPost && <Button onClick={() => post.mutate()} disabled={busy}><Send className="h-4 w-4" /> ترحيل</Button>}
            {p.status === "posted" && canReverse && <Button variant="danger" onClick={() => reverse.mutate()} disabled={busy}><Undo2 className="h-4 w-4" /> عكس</Button>}
            {(p.status === "draft" || p.status === "approved") && <Button variant="ghost" onClick={() => cancel.mutate()} disabled={busy}><XCircle className="h-4 w-4" /> إلغاء</Button>}
          </div>
        }
      />
      {anyErr && <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">{safeUserMessage(anyErr)}</div>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Info label="الحالة" value={<SalesStatus status={p.status} />} />
        <Info label="المبلغ" value={<Money value={p.amount} />} />
        <Info label="المخصّص" value={<Money value={p.allocated_amount} />} />
        <Info label="غير مخصّص" value={<Money value={p.unapplied_amount} />} />
        <Info label="التاريخ" value={<DateCell value={p.payment_date} />} />
        <Info label="الطريقة" value={p.payment_method} />
        <Info label="الوجهة" value={p.destination_type === "bank" ? "بنك" : "نقدي"} />
        <Info label="قيد GL" value={<span dir="ltr" className="text-xs tabular-nums">{p.journal_id || "—"}</span>} />
      </div>

      <Card className="mt-6">
        <CardHeader><CardTitle>التخصيصات</CardTitle></CardHeader>
        <CardBody>
          {(p.allocations ?? []).length === 0 ? (
            <p className="py-6 text-center text-sm font-medium text-slate-400">لا توجد تخصيصات — دفعة مقدمة غير مخصّصة.</p>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-slate-200">
              <table className="w-full min-w-[480px] border-collapse text-right text-sm">
                <thead className="bg-slate-50 text-xs font-bold text-slate-500">
                  <tr>
                    <th className="px-4 py-3 font-bold">الفاتورة</th>
                    <th className="px-4 py-3 font-bold">المبلغ المخصّص</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {p.allocations!.map((a) => (
                    <tr key={a.id}>
                      <td className="px-4 py-3">
                        <button type="button" onClick={() => nav(`/sales/invoices?doc=${a.ar_document_id}`)} className="font-bold text-teal-700 hover:underline">{a.ar_document_id}</button>
                      </td>
                      <td className="px-4 py-3 text-slate-700"><Money value={a.allocated_amount} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <p className="mt-3 text-left text-xs font-semibold text-slate-400">النسخة: <Num value={p.version} /></p>
    </div>
  );
}
