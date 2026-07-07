import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Printer, CheckCircle2, XCircle, Undo2, HandCoins } from "lucide-react";
import { o2cApi } from "@/lib/api";
import { qk } from "@/lib/query-keys";
import { useCan } from "@/app/permission-provider";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoadingState, ErrorState, safeUserMessage } from "@/components/states/States";
import { Money, DateCell, Num, StatusPill, TableShell, Th, Td } from "@/features/_shared/ui";
import { VAT_CATEGORY_LABEL } from "@/lib/status-labels";
import type { InvoiceLine } from "@/lib/types";

export function InvoiceDetailPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const canIssue = useCan("invoices.issue");
  const canCreatePayment = useCan("payments.create");
  const canReturn = useCan("returns.create");

  const q = useQuery({ queryKey: qk.invoice(id), queryFn: ({ signal }) => o2cApi.invoice(id, signal).then((r) => r.data), enabled: !!id });

  const issue = useMutation({
    mutationFn: () => o2cApi.issueInvoice(id, q.data?.version),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.all }),
  });
  const cancel = useMutation({
    mutationFn: () => o2cApi.cancelInvoice(id, q.data?.version),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.all }),
  });

  if (q.isLoading) return <LoadingState rows={6} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const inv = q.data!;
  const isDraft = inv.status === "draft";
  const lines: InvoiceLine[] = inv.lines ?? [];
  const busy = issue.isPending || cancel.isPending;

  return (
    <div>
      <Link to="/invoices" className="mb-3 inline-flex items-center gap-1 text-sm font-bold text-slate-500 hover:text-teal-700 no-print"><ArrowRight className="h-4 w-4" /> رجوع للفواتير</Link>
      <PageHeader
        eyebrow={`فاتورة · ${inv.source_type}`}
        title={inv.document_number}
        subtitle={inv.customer_name || undefined}
        action={
          <div className="flex flex-wrap items-center gap-2 no-print">
            <Button variant="secondary" onClick={() => window.print()}><Printer className="ml-1 h-4 w-4" /> طباعة</Button>
            {isDraft && canIssue && <Button onClick={() => issue.mutate()} disabled={busy}><CheckCircle2 className="ml-1 h-4 w-4" /> إصدار</Button>}
            {isDraft && <Button variant="danger" onClick={() => cancel.mutate()} disabled={busy}><XCircle className="ml-1 h-4 w-4" /> إلغاء</Button>}
            {!isDraft && Number(inv.balance_amount) > 0 && canCreatePayment && <Link to={`/payments?customerId=${inv.customer_id ?? ""}`}><Button variant="secondary"><HandCoins className="ml-1 h-4 w-4" /> تحصيل</Button></Link>}
            {!isDraft && canReturn && <Link to={`/returns?invoiceId=${inv.id}`}><Button variant="secondary"><Undo2 className="ml-1 h-4 w-4" /> مرتجع</Button></Link>}
          </div>
        }
      />

      {(issue.isError || cancel.isError) && (
        <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700 no-print">{safeUserMessage(issue.error || cancel.error)}</div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Info label="الحالة" value={<StatusPill status={inv.status} />} />
        <Info label="زاتكا" value={<StatusPill status={inv.zatca_status} />} />
        <Info label="تاريخ الإصدار" value={<DateCell value={inv.issue_date} />} />
        <Info label="الاستحقاق" value={<DateCell value={inv.due_date} />} />
      </div>

      <Card className="mt-6">
        <CardHeader><CardTitle>الأسطر</CardTitle></CardHeader>
        <CardBody>
          <TableShell head={<tr><Th>الوصف</Th><Th>الكمية</Th><Th>السعر</Th><Th>الخصم</Th><Th>الضريبة</Th><Th>الصافي</Th><Th>الإجمالي</Th></tr>}>
            {lines.map((l) => (
              <tr key={l.id}>
                <Td className="font-bold">{l.description || "—"}</Td>
                <Td><Num value={l.entered_qty} /></Td>
                <Td><Num value={l.unit_price} /></Td>
                <Td><Money value={l.discount_amount} /></Td>
                <Td>{VAT_CATEGORY_LABEL[l.vat_category] || l.vat_category}</Td>
                <Td><Money value={l.net_amount} /></Td>
                <Td><Money value={l.gross_amount} className="font-bold" /></Td>
              </tr>
            ))}
          </TableShell>

          <div className="mt-4 flex justify-end">
            <dl className="w-full max-w-xs space-y-1.5 text-sm">
              <Row label="الإجمالي الفرعي" value={<Money value={inv.subtotal} />} />
              <Row label="الضريبة" value={<Money value={inv.vat_amount} />} />
              <Row label="الإجمالي" value={<Money value={inv.total_amount} className="font-extrabold" />} strong />
              <Row label="المدفوع" value={<Money value={inv.paid_amount} />} />
              <Row label="المتبقّي" value={<Money value={inv.balance_amount} className="font-extrabold text-teal-700" />} strong />
            </dl>
          </div>
        </CardBody>
      </Card>

      <Card className="mt-6 no-print">
        <CardHeader><CardTitle>المرجع المحاسبي</CardTitle></CardHeader>
        <CardBody className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Info label="قيد GL" value={<span dir="ltr" className="text-xs tabular-nums">{inv.gl_journal_id || "—"}</span>} />
          <Info label="UUID زاتكا" value={<span dir="ltr" className="truncate text-xs tabular-nums">{inv.zatca_uuid || "—"}</span>} />
          <Info label="النسخة" value={<Num value={inv.version} />} />
        </CardBody>
      </Card>
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
function Row({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className={`flex items-center justify-between ${strong ? "border-t border-slate-100 pt-1.5" : ""}`}>
      <dt className="font-bold text-slate-500">{label}</dt>
      <dd className="text-slate-800">{value}</dd>
    </div>
  );
}
