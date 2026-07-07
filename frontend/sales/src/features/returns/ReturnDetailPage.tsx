import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Send, Undo2, XCircle } from "lucide-react";
import { o2cApi } from "@/lib/api";
import { qk } from "@/lib/query-keys";
import { useCan } from "@/app/permission-provider";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { LoadingState, ErrorState, safeUserMessage } from "@/components/states/States";
import { Money, DateCell, Num, StatusPill } from "@/features/_shared/ui";

const REFUND_LABEL: Record<string, string> = { ar_reduction: "تخفيض ذمم", cash: "نقدي", bank: "بنكي", customer_deposit: "رصيد دائن للعميل" };

export function ReturnDetailPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const canApprove = useCan("returns.approve");
  const canPost = useCan("returns.post");
  const canReverse = useCan("returns.reverse");

  const q = useQuery({ queryKey: qk.return(id), queryFn: ({ signal }) => o2cApi.salesReturn(id, signal).then((r) => r.data), enabled: !!id });
  const version = q.data?.version;
  const wrap = (fn: () => Promise<unknown>) => ({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: qk.all }) });
  const approve = useMutation(wrap(() => o2cApi.approveReturn(id, version)));
  const post = useMutation(wrap(() => o2cApi.postReturn(id, version)));
  const reverse = useMutation(wrap(() => o2cApi.reverseReturn(id, version)));
  const cancel = useMutation(wrap(() => o2cApi.cancelReturn(id, version)));

  if (q.isLoading) return <LoadingState rows={6} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const r = q.data!;
  const busy = approve.isPending || post.isPending || reverse.isPending || cancel.isPending;
  const anyErr = approve.error || post.error || reverse.error || cancel.error;

  return (
    <div>
      <Link to="/returns" className="mb-3 inline-flex items-center gap-1 text-sm font-bold text-slate-500 hover:text-teal-700"><ArrowRight className="h-4 w-4" /> رجوع للمرتجعات</Link>
      <PageHeader
        eyebrow="مرتجع بيع"
        title={r.return_number}
        subtitle={r.customer_name || undefined}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {r.status === "draft" && canApprove && <Button onClick={() => approve.mutate()} disabled={busy}><CheckCircle2 className="ml-1 h-4 w-4" /> اعتماد</Button>}
            {r.status === "approved" && canPost && <Button onClick={() => post.mutate()} disabled={busy}><Send className="ml-1 h-4 w-4" /> ترحيل</Button>}
            {r.status === "posted" && canReverse && <Button variant="danger" onClick={() => reverse.mutate()} disabled={busy}><Undo2 className="ml-1 h-4 w-4" /> عكس</Button>}
            {(r.status === "draft" || r.status === "approved") && <Button variant="ghost" onClick={() => cancel.mutate()} disabled={busy}><XCircle className="ml-1 h-4 w-4" /> إلغاء</Button>}
          </div>
        }
      />
      {anyErr && <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">{safeUserMessage(anyErr)}</div>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Info label="الحالة" value={<StatusPill status={r.status} />} />
        <Info label="التاريخ" value={<DateCell value={r.return_date} />} />
        <Info label="الإجمالي الفرعي" value={<Money value={r.subtotal} />} />
        <Info label="الضريبة" value={<Money value={r.vat_amount} />} />
        <Info label="الإجمالي" value={<Money value={r.total_amount} />} />
        <Info label="طريقة الرد" value={REFUND_LABEL[r.refund_method] || r.refund_method} />
        <Info label="الفاتورة الأصلية" value={r.original_ar_document_id ? <Link to={`/invoices/${r.original_ar_document_id}`} className="text-xs text-teal-700 hover:underline">عرض</Link> : "—"} />
        <Info label="إشعار دائن" value={r.credit_note_id ? <span dir="ltr" className="text-xs tabular-nums">{r.credit_note_id}</span> : "—"} />
      </div>
      <p className="mt-3 text-left text-xs font-semibold text-slate-400">النسخة: <Num value={r.version} /></p>
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
