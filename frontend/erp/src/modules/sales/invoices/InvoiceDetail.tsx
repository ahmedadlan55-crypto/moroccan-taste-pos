import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Printer, CheckCircle2, XCircle, Undo2, HandCoins } from "lucide-react";
import {
  Button, Card, CardHeader, CardTitle, CardBody, PageHeader, LoadingState, ErrorState, safeUserMessage, useToast,
} from "@/shared/ui";
import { useTx } from "@/shared/ui/i18n";
import { useCan } from "@/app/providers";
import { o2cApi, qk, SalesStatus, Money, Num, DateCell, Info, type InvoiceLine } from "@/modules/sales/lib";
import { buildSaleReceiptHtml, printHtml } from "../../../../../shared/invoiceTemplate";
import { toSaleReceiptOptions } from "./invoiceReceiptAdapter";

const VAT_CATS = new Set(["S", "Z", "E", "O"]);

export function InvoiceDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const t = useTx();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { toast } = useToast();
  const canIssue = useCan("invoices.issue");
  const canCreatePayment = useCan("payments.create");
  const canReturn = useCan("returns.create");

  const q = useQuery({ queryKey: qk.invoice(id), queryFn: ({ signal }) => o2cApi.invoice(id, signal).then((r) => r.data), enabled: !!id });

  const issue = useMutation({ mutationFn: () => o2cApi.issueInvoice(id, q.data?.version), onSuccess: () => qc.invalidateQueries({ queryKey: qk.all }) });
  const cancel = useMutation({ mutationFn: () => o2cApi.cancelInvoice(id, q.data?.version), onSuccess: () => qc.invalidateQueries({ queryKey: qk.all }) });

  if (q.isLoading) return <LoadingState rows={6} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const inv = q.data!;
  const isDraft = inv.status === "draft";
  const lines: InvoiceLine[] = inv.lines ?? [];
  const busy = issue.isPending || cancel.isPending;

  return (
    <div>
      <button type="button" onClick={onBack} className="mb-3 inline-flex items-center gap-1 text-sm font-bold text-slate-500 hover:text-teal-700 no-print"><ArrowRight className="h-4 w-4" /> {t("sales.invoices.detail.back")}</button>
      <PageHeader
        eyebrow={t("sales.invoices.detail.eyebrow", { source: inv.source_type })}
        title={inv.document_number}
        subtitle={inv.customer_name || undefined}
        action={
          <div className="flex flex-wrap items-center gap-2 no-print">
            <Button variant="secondary" onClick={() => {
              const ok = printHtml(buildSaleReceiptHtml(toSaleReceiptOptions(inv, t)));
              if (!ok) toast({ title: t("sales.print.blockedTitle"), description: t("sales.print.blockedBody"), tone: "error" });
            }}><Printer className="h-4 w-4" /> {t("sales.actions.print")}</Button>
            {isDraft && canIssue && <Button onClick={() => issue.mutate()} disabled={busy}><CheckCircle2 className="h-4 w-4" /> {t("sales.actions.issue")}</Button>}
            {isDraft && <Button variant="danger" onClick={() => cancel.mutate()} disabled={busy}><XCircle className="h-4 w-4" /> {t("common.cancel")}</Button>}
            {!isDraft && Number(inv.balance_amount) > 0 && canCreatePayment && <Button variant="secondary" onClick={() => nav(`/sales/payments?customerId=${inv.customer_id ?? ""}&new=1`)}><HandCoins className="h-4 w-4" /> {t("sales.actions.collect")}</Button>}
            {!isDraft && canReturn && <Button variant="secondary" onClick={() => nav(`/sales/returns?invoiceId=${inv.id}&new=1`)}><Undo2 className="h-4 w-4" /> {t("sales.actions.return")}</Button>}
          </div>
        }
      />

      {(issue.isError || cancel.isError) && (
        <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700 no-print">{safeUserMessage(issue.error || cancel.error)}</div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Info label={t("common.status")} value={<SalesStatus status={inv.status} />} />
        <Info label={t("sales.invoices.detail.zatca")} value={<SalesStatus status={inv.zatca_status} />} />
        <Info label={t("sales.invoices.detail.issueDate")} value={<DateCell value={inv.issue_date} />} />
        <Info label={t("sales.invoices.col.due")} value={<DateCell value={inv.due_date} />} />
      </div>

      <Card className="mt-6">
        <CardHeader><CardTitle>{t("sales.lines")}</CardTitle></CardHeader>
        <CardBody>
          <div className="overflow-x-auto rounded-2xl border border-slate-200">
            <table className="w-full min-w-[720px] border-collapse text-right text-sm">
              <thead className="bg-slate-50 text-xs font-bold text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-bold">{t("sales.col.desc")}</th>
                  <th className="px-4 py-3 font-bold">{t("sales.col.qty")}</th>
                  <th className="px-4 py-3 font-bold">{t("sales.col.price")}</th>
                  <th className="px-4 py-3 font-bold">{t("sales.col.discount")}</th>
                  <th className="px-4 py-3 font-bold">{t("sales.col.vat")}</th>
                  <th className="px-4 py-3 font-bold">{t("sales.col.net")}</th>
                  <th className="px-4 py-3 font-bold">{t("sales.col.total")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {lines.map((l) => (
                  <tr key={l.id}>
                    <td className="px-4 py-3 font-bold text-slate-700">{l.description || "—"}</td>
                    <td className="px-4 py-3 text-slate-700"><Num value={l.entered_qty} /></td>
                    <td className="px-4 py-3 text-slate-700"><Num value={l.unit_price} /></td>
                    <td className="px-4 py-3 text-slate-700"><Money value={l.discount_amount} /></td>
                    <td className="px-4 py-3 text-slate-700">{VAT_CATS.has(l.vat_category) ? t(`sales.vatCategory.${l.vat_category}`) : l.vat_category}</td>
                    <td className="px-4 py-3 text-slate-700"><Money value={l.net_amount} /></td>
                    <td className="px-4 py-3 text-slate-700"><Money value={l.gross_amount} className="font-bold" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
            {/* The ZATCA stamp block: QR image rendered server-side from the
                persisted TLV (clients never encode QRs), seller decoded from
                the same TLV — the identity frozen at issue, immune to a later
                company rename. Printed pages carried NO QR before this. */}
            {inv.zatca_qr_data_url ? (
              <figure className="text-center">
                <img src={inv.zatca_qr_data_url} alt="ZATCA QR" width={120} height={120} className="rounded bg-white p-1 ring-1 ring-slate-200" />
                <figcaption className="mt-1 text-[10px] font-semibold text-slate-400">
                  {inv.seller?.sellerName || ""}{inv.seller?.vatNumber ? ` — ${t("sales.taxNoShort")} ${inv.seller.vatNumber}` : ""}
                </figcaption>
              </figure>
            ) : <span />}
            <dl className="w-full max-w-xs space-y-1.5 text-sm">
              <Row label={t("sales.invoices.detail.subtotal")} value={<Money value={inv.subtotal} />} />
              <Row label={t("sales.col.vat")} value={<Money value={inv.vat_amount} />} />
              <Row label={t("sales.col.total")} value={<Money value={inv.total_amount} className="font-extrabold" />} strong />
              <Row label={t("sales.invoices.detail.paid")} value={<Money value={inv.paid_amount} />} />
              <Row label={t("sales.col.remaining")} value={<Money value={inv.balance_amount} className="font-extrabold text-teal-700" />} strong />
            </dl>
          </div>
        </CardBody>
      </Card>

      <Card className="mt-6 no-print">
        <CardHeader><CardTitle>{t("sales.invoices.detail.accountingRef")}</CardTitle></CardHeader>
        <CardBody className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Info label={t("sales.glEntry")} value={<span dir="ltr" className="text-xs tabular-nums">{inv.gl_journal_id || "—"}</span>} />
          <Info label={t("sales.invoices.detail.zatcaUuid")} value={<span dir="ltr" className="truncate text-xs tabular-nums">{inv.zatca_uuid || "—"}</span>} />
          <Info label={t("sales.version")} value={<Num value={inv.version} />} />
        </CardBody>
      </Card>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: ReactNode; strong?: boolean }) {
  return (
    <div className={`flex items-center justify-between ${strong ? "border-t border-slate-100 pt-1.5" : ""}`}>
      <dt className="font-bold text-slate-500">{label}</dt>
      <dd className="text-slate-800">{value}</dd>
    </div>
  );
}
