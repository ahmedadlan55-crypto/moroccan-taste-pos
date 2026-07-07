import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Send, Undo2, XCircle } from "lucide-react";
import { o2cApi } from "@/lib/api";
import { qk } from "@/lib/query-keys";
import { useCan } from "@/app/permission-provider";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoadingState, ErrorState, safeUserMessage } from "@/components/states/States";
import { Money, DateCell, Num, StatusPill, TableShell, Th, Td } from "@/features/_shared/ui";

export function PaymentDetailPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const canApprove = useCan("payments.approve");
  const canPost = useCan("payments.post");
  const canReverse = useCan("payments.reverse");

  const q = useQuery({ queryKey: qk.payment(id), queryFn: ({ signal }) => o2cApi.payment(id, signal).then((r) => r.data), enabled: !!id });

  const version = q.data?.version;
  const inv = (fn: () => Promise<unknown>) => ({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: qk.all }) });
  const approve = useMutation(inv(() => o2cApi.approvePayment(id, version)));
  const post = useMutation(inv(() => o2cApi.postPayment(id, version)));
  const reverse = useMutation(inv(() => o2cApi.reversePayment(id, version)));
  const cancel = useMutation(inv(() => o2cApi.cancelPayment(id, version)));

  if (q.isLoading) return <LoadingState rows={6} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const p = q.data!;
  const busy = approve.isPending || post.isPending || reverse.isPending || cancel.isPending;
  const anyErr = approve.error || post.error || reverse.error || cancel.error;

  return (
    <div>
      <Link to="/payments" className="mb-3 inline-flex items-center gap-1 text-sm font-bold text-slate-500 hover:text-teal-700"><ArrowRight className="h-4 w-4" /> رجوع للتحصيلات</Link>
      <PageHeader
        eyebrow={p.is_advance ? "دفعة مقدمة" : "سند قبض"}
        title={p.payment_number}
        subtitle={p.customer_name || undefined}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {p.status === "draft" && canApprove && <Button onClick={() => approve.mutate()} disabled={busy}><CheckCircle2 className="ml-1 h-4 w-4" /> اعتماد</Button>}
            {p.status === "approved" && canPost && <Button onClick={() => post.mutate()} disabled={busy}><Send className="ml-1 h-4 w-4" /> ترحيل</Button>}
            {p.status === "posted" && canReverse && <Button variant="danger" onClick={() => reverse.mutate()} disabled={busy}><Undo2 className="ml-1 h-4 w-4" /> عكس</Button>}
            {(p.status === "draft" || p.status === "approved") && <Button variant="ghost" onClick={() => cancel.mutate()} disabled={busy}><XCircle className="ml-1 h-4 w-4" /> إلغاء</Button>}
          </div>
        }
      />
      {anyErr && <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">{safeUserMessage(anyErr)}</div>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Info label="الحالة" value={<StatusPill status={p.status} />} />
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
            <TableShell head={<tr><Th>الفاتورة</Th><Th>المبلغ المخصّص</Th></tr>}>
              {p.allocations!.map((a) => (
                <tr key={a.id}>
                  <Td><Link to={`/invoices/${a.ar_document_id}`} className="font-bold text-teal-700 hover:underline">{a.ar_document_id}</Link></Td>
                  <Td><Money value={a.allocated_amount} /></Td>
                </tr>
              ))}
            </TableShell>
          )}
        </CardBody>
      </Card>

      <p className="mt-3 text-left text-xs font-semibold text-slate-400">النسخة: <Num value={p.version} /></p>
    </div>
  );
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
      <div className="text-[11px] font-bold text-slate-400">{label}</div>
      <div className="mt-0.5 text-sm font-extrabold text-slate-800">{value}</div>
    </div>
  );
}
