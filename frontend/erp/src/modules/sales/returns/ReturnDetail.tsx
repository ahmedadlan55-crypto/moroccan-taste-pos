import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, PackageCheck, PackageX, Printer, Send, Undo2, XCircle } from "lucide-react";
import { Button, PageHeader, PanelTitle, LoadingState, ErrorState, StatusBadge, safeUserMessage, useToast } from "@/shared/ui";
import { useTx } from "@/shared/ui/i18n";
import { useCan } from "@/app/providers";
import { o2cApi, qk, SalesStatus, Money, Num, DateCell, Info } from "@/modules/sales/lib";
import { buildCreditNoteHtml, printHtml } from "../../../../../shared/invoiceTemplate";
import { toCreditNoteOptions } from "./creditNoteAdapter";

const REFUND_KEYS = new Set(["ar_reduction", "cash", "bank", "customer_deposit"]);
const ZATCA_KEYS = new Set(["pending", "submitted", "accepted", "rejected", "not_required"]);

export function ReturnDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const t = useTx();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { toast } = useToast();
  const canApprove = useCan("returns.approve");
  const canPost = useCan("returns.post");
  const canReverse = useCan("returns.reverse");
  const canCancel = useCan("returns.cancel");

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
      <button type="button" onClick={onBack} className="mb-3 inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-bold text-slate-500 hover:bg-slate-100 hover:text-teal-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"><ArrowRight className="h-4 w-4 rotate-180 rtl:rotate-0" /> {t("sales.returns.detail.back")}</button>
      <PageHeader
        eyebrow={t("sales.returns.detail.eyebrow")}
        title={r.return_number}
        subtitle={r.customer_name || undefined}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {r.status === "draft" && canApprove && <Button onClick={() => approve.mutate()} disabled={busy}><CheckCircle2 className="h-4 w-4" /> {t("sales.actions.approve")}</Button>}
            {r.status === "approved" && canPost && <Button onClick={() => post.mutate()} disabled={busy}><Send className="h-4 w-4" /> {t("sales.actions.post")}</Button>}
            {r.status === "posted" && canReverse && <Button variant="danger" onClick={() => reverse.mutate()} disabled={busy}><Undo2 className="h-4 w-4" /> {t("sales.actions.reverse")}</Button>}
            {(r.status === "draft" || r.status === "approved") && canCancel && <Button variant="ghost" onClick={() => cancel.mutate()} disabled={busy}><XCircle className="h-4 w-4" /> {t("common.cancel")}</Button>}
          </div>
        }
      />
      {anyErr && <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">{safeUserMessage(anyErr)}</div>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Info label={t("common.status")} value={<SalesStatus status={r.status} />} />
        <Info label={t("sales.col.date")} value={<DateCell value={r.return_date} />} />
        <Info label={t("sales.returns.detail.subtotal")} value={<Money value={r.subtotal} />} />
        <Info label={t("sales.col.vat")} value={<Money value={r.vat_amount} />} />
        <Info label={t("sales.col.total")} value={<Money value={r.total_amount} />} />
        <Info label={t("sales.returns.col.refund")} value={REFUND_KEYS.has(r.refund_method) ? t(`sales.returns.refund.${r.refund_method}`) : r.refund_method} />
        <Info label={t("sales.returns.detail.originalInvoice")} value={r.original_ar_document_id ? <button type="button" onClick={() => nav(`/sales/invoices?doc=${r.original_ar_document_id}`)} className="text-xs text-teal-700 hover:underline">{t("sales.actions.view")}</button> : "—"} />
        <Info label={t("sales.returns.detail.creditNote")} value={r.creditNote?.document_number ? <span dir="ltr" className="text-xs tabular-nums">{r.creditNote.document_number}</span> : "—"} />
      </div>

      {/* Printing now goes through the SHARED credit-note renderer (buildCreditNote
          Html → printHtml): a self-contained مرتجع / إشعار دائن document — seller
          block, buyer, lines, totals, ZATCA QR — written into its own print window,
          identical to what the POS emits. The seller stays DECODED FROM THE
          PERSISTED TLV (frozen at stamp time); re-reading live settings at print
          time would drift after a rename, the exact defect the sales side
          eliminated at issue. The on-screen section below is display only. */}
      {r.creditNote && (
        <section className="section surface mt-4">
          <div className="no-print float-left">
            <Button variant="secondary" onClick={() => {
              const ok = printHtml(buildCreditNoteHtml(toCreditNoteOptions(r, t)));
              if (!ok) toast({ title: t("sales.print.blockedTitle"), description: t("sales.print.blockedBody"), tone: "error" });
            }} disabled={!r.creditNote.zatca_qr_data_url && !r.creditNote.zatca_uuid}>
              <Printer className="h-4 w-4" /> {t("sales.actions.printCreditNote")}
            </Button>
          </div>
          <PanelTitle title={t("sales.returns.detail.creditNoteTitle")} subtitle={t("sales.returns.detail.creditNoteSubtitle")} />

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Info label={t("sales.returns.detail.number")} value={<span dir="ltr" className="tabular-nums">{r.creditNote.document_number}</span>} />
            <Info label={t("sales.col.date")} value={<DateCell value={r.creditNote.issue_date} />} />
            <Info label={t("sales.returns.detail.originalInvoice")} value={r.creditNote.original_document_number ? <span dir="ltr" className="tabular-nums">{r.creditNote.original_document_number}</span> : "—"} />
            <Info label={t("sales.returns.detail.zatcaStatus")} value={<StatusBadge dot>{ZATCA_KEYS.has(r.creditNote.zatca_status) ? t(`sales.returns.zatca.${r.creditNote.zatca_status}`) : r.creditNote.zatca_status}</StatusBadge>} />
            <Info label={t("sales.returns.detail.seller")} value={r.creditNote.seller?.sellerName || "—"} />
            <Info label={t("sales.returns.detail.vatNumber")} value={r.creditNote.seller?.vatNumber ? <span dir="ltr" className="tabular-nums">{r.creditNote.seller.vatNumber}</span> : "—"} />
            <Info label={t("sales.col.customer")} value={r.creditNote.customer_name || t("sales.returns.detail.cashCustomer")} />
            <Info label={t("sales.returns.detail.zatcaId")} value={r.creditNote.zatca_uuid ? <span dir="ltr" className="text-[10px] tabular-nums">{r.creditNote.zatca_uuid}</span> : "—"} />
          </div>

          <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Info label={t("sales.col.net")} value={<Money value={r.creditNote.subtotal ?? r.subtotal} />} />
              <Info label={t("sales.col.vat")} value={<Money value={r.creditNote.vat_amount ?? r.vat_amount} />} />
              <Info label={t("sales.col.total")} value={<Money value={r.creditNote.total_amount} />} />
            </div>
            {r.creditNote.zatca_qr_data_url ? (
              <figure className="text-center">
                <img src={r.creditNote.zatca_qr_data_url} alt="ZATCA QR" width={120} height={120} className="rounded bg-white p-1 ring-1 ring-slate-200" />
                <figcaption className="mt-1 text-[10px] font-semibold text-slate-400">{t("sales.returns.detail.stampedIcv", { icv: r.creditNote.zatca_icv ?? "—" })}</figcaption>
              </figure>
            ) : (
              <p className="text-xs font-semibold text-amber-700">{t("sales.returns.detail.noStamp")}</p>
            )}
          </div>
        </section>
      )}

      {/* Lines were never rendered at all. Without them the user cannot see WHAT
          was returned, and — the point of this screen — what went back on the shelf. */}
      <section className="section surface mt-4">
        <PanelTitle title={t("sales.returns.detail.linesTitle")} subtitle={t("sales.returns.detail.linesSubtitle")} />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-start text-xs font-extrabold text-slate-500">
                <th className="py-2">{t("sales.returns.detail.itemCol")}</th>
                <th className="py-2">{t("sales.returns.detail.sold")}</th>
                <th className="py-2">{t("sales.returns.detail.returned")}</th>
                <th className="py-2">{t("sales.col.net")}</th>
                <th className="py-2">{t("sales.col.vat")}</th>
                <th className="py-2">{t("sales.returns.detail.stock")}</th>
              </tr>
            </thead>
            <tbody>
              {(r.lines ?? []).map((l) => {
                const restock = Number(l.restock) === 1;
                return (
                  <tr key={l.id} className="border-b border-slate-100 align-top">
                    <td className="py-2 font-bold text-slate-700">
                      {l.description || "—"}
                      {/* A menu line names a burger; the shelf saw bun + patty. */}
                      {restock && (l.components?.length ?? 0) > 0 && (
                        <ul className="mt-1 space-y-0.5">
                          {l.components!.map((c) => (
                            <li key={c.id} className="text-[11px] font-semibold text-slate-400">
                              ↳ {c.inv_item_name || c.inv_item_id} — <Num value={c.restored_base_qty} /> {c.unit_code || ""}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className="py-2 tabular-nums text-slate-500"><Num value={l.sold_qty} /></td>
                    <td className="py-2 tabular-nums font-bold text-slate-700"><Num value={l.return_qty} /></td>
                    <td className="py-2 tabular-nums text-slate-600"><Money value={l.net_amount} /></td>
                    <td className="py-2 tabular-nums text-slate-600"><Money value={l.vat_amount} /></td>
                    <td className="py-2">
                      {restock ? (
                        <span className="inline-flex items-center gap-1 text-xs font-bold text-teal-700"><PackageCheck className="h-3.5 w-3.5" /> {t("sales.returns.detail.restocks")}</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs font-bold text-slate-400"><PackageX className="h-3.5 w-3.5" /> {t("sales.returns.detail.noRestock")}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs font-semibold text-slate-400">
          {t("sales.returns.detail.costPre")} <Money value={r.cost_total} /> {t("sales.returns.detail.costPost")}
        </p>
      </section>

      <p className="mt-3 text-end text-xs font-semibold text-slate-400">{t("sales.version")}: <Num value={r.version} /></p>
    </div>
  );
}
