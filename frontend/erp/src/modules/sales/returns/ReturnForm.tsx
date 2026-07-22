import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Undo2 } from "lucide-react";
import { Drawer, Button, LoadingState, safeUserMessage } from "@/shared/ui";
import { useTx } from "@/shared/ui/i18n";
import { Field } from "@/shared/forms";
import { o2cApi, qk, OpenInvoicePicker, Num, Money, type Invoice } from "@/modules/sales/lib";

const today = new Date().toISOString().slice(0, 10);

export function ReturnForm({ open, onClose, onCreated, presetInvoiceId }: { open: boolean; onClose: () => void; onCreated?: (id: string) => void; presetInvoiceId?: string }) {
  const t = useTx();
  const qc = useQueryClient();
  const [picked, setPicked] = useState<Invoice | null>(null);
  const [date, setDate] = useState(today);
  const [refund, setRefund] = useState("ar_reduction");
  const [reason, setReason] = useState("");
  const [qtys, setQtys] = useState<Record<string, number>>({});
  // Off by default, per line. Only the person holding the item knows whether it
  // can be sold again — a sealed drink can, the burger beside it cannot — and the
  // safe default for a food business is that it cannot.
  const [restock, setRestock] = useState<Record<string, boolean>>({});

  const invoiceId = presetInvoiceId || picked?.id;
  const detail = useQuery({
    queryKey: qk.invoice(invoiceId ?? ""),
    queryFn: ({ signal }) => o2cApi.invoice(invoiceId!, signal).then((r) => r.data),
    enabled: !!invoiceId,
  });

  const lines = detail.data?.lines ?? [];
  const selected = lines.filter((l) => (qtys[l.id] ?? 0) > 0);
  // What is actually still returnable. The server enforces this (OVER_RETURN);
  // the form used to cap at the full sold qty, so it invited a request it knew
  // the server would refuse.
  const remainingOf = (l: { entered_qty: number; returned_qty?: number | null }) =>
    Math.max(0, Number(l.entered_qty) - Number(l.returned_qty ?? 0));

  const mutation = useMutation({
    mutationFn: () => o2cApi.createReturn({
      originalArDocumentId: invoiceId,
      returnDate: date, refundMethod: refund, reason: reason || undefined,
      lines: selected.map((l) => ({ originalLineId: l.id, returnQty: qtys[l.id], restock: !!restock[l.id] })),
    }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: qk.all });
      onClose();
      const id = (res.data as { id?: string } | undefined)?.id;
      if (id) onCreated?.(id);
    },
  });

  const canSubmit = !!invoiceId && selected.length > 0 && !mutation.isPending;

  return (
    <Drawer
      open={open} onClose={onClose} icon={Undo2} eyebrow={t("sales.returns.form.eyebrow")} title={t("sales.returns.form.title")}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
          <Button loading={mutation.isPending} disabled={!canSubmit} onClick={() => mutation.mutate()}>{t("sales.actions.saveDraft")}</Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {mutation.isError && <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">{safeUserMessage(mutation.error)}</div>}
        {!presetInvoiceId && <Field label={t("sales.returns.detail.originalInvoice")} required><OpenInvoicePicker value={picked} onChange={setPicked} /></Field>}
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("sales.returns.form.returnDate")} required><input dir="ltr" type="date" className="field w-full tabular-nums" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label={t("sales.returns.col.refund")}>
            <select className="field w-full" value={refund} onChange={(e) => setRefund(e.target.value)}>
              <option value="ar_reduction">{t("sales.returns.refundOpt.ar_reduction")}</option>
              <option value="cash">{t("sales.returns.refundOpt.cash")}</option>
              <option value="bank">{t("sales.returns.refundOpt.bank")}</option>
              <option value="customer_deposit">{t("sales.returns.refundOpt.customer_deposit")}</option>
            </select>
          </Field>
        </div>
        <Field label={t("sales.returns.form.reason")}><input className="field w-full" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>

        <div className="rounded-2xl border border-slate-200">
          <div className="border-b border-slate-100 px-3 py-2 text-sm font-extrabold text-slate-700">{t("sales.returns.detail.linesTitle")}</div>
          <div className="p-3">
            {!invoiceId ? (
              <p className="text-xs font-semibold text-slate-400">{t("sales.returns.form.pickInvoiceFirst")}</p>
            ) : detail.isLoading ? (
              <LoadingState rows={3} />
            ) : lines.length === 0 ? (
              <p className="text-xs font-semibold text-slate-400">{t("sales.returns.form.noLines")}</p>
            ) : (
              <div className="flex flex-col gap-2">
                {lines.map((l) => {
                  const remaining = remainingOf(l);
                  const chosen = qtys[l.id] ?? 0;
                  return (
                    <div key={l.id} className="rounded-xl bg-slate-50 px-3 py-2">
                      <div className="grid grid-cols-12 items-center gap-2">
                        <span className="col-span-6 truncate text-sm font-bold text-slate-700">{l.description || "—"}</span>
                        <span className="col-span-2 text-xs text-slate-500">{t("sales.returns.form.available")}: <Num value={remaining} /></span>
                        <span className="col-span-2 text-xs text-slate-500"><Money value={l.unit_price} /></span>
                        <input
                          dir="ltr" type="number" step="0.01" min={0} max={remaining}
                          disabled={remaining <= 0}
                          className="field col-span-2 w-full tabular-nums"
                          placeholder={t("sales.returns.form.qtyPlaceholder")}
                          aria-label={t("sales.returns.form.returnQtyAria", { name: l.description || l.id })}
                          value={qtys[l.id] || ""}
                          onChange={(e) => {
                            const v = Math.max(0, Math.min(Number(e.target.value) || 0, remaining));
                            setQtys((s) => ({ ...s, [l.id]: v }));
                          }}
                        />
                      </div>
                      {chosen > 0 && (
                        <label className="mt-2 flex cursor-pointer items-center gap-2">
                          <input
                            type="checkbox"
                            checked={!!restock[l.id]}
                            onChange={(e) => setRestock((s) => ({ ...s, [l.id]: e.target.checked }))}
                            aria-label={t("sales.returns.form.restockAria", { name: l.description || l.id })}
                          />
                          <span className="text-xs font-bold text-slate-600">{t("sales.returns.form.restock")}</span>
                          <span className="text-[11px] font-semibold text-slate-400">
                            {restock[l.id]
                              ? t("sales.returns.form.restockOn")
                              : t("sales.returns.form.restockOff")}
                          </span>
                        </label>
                      )}
                      {remaining <= 0 && <p className="mt-1 text-[11px] font-semibold text-slate-400">{t("sales.returns.form.fullyReturned")}</p>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <p className="text-[11px] font-semibold text-slate-400">{t("sales.returns.form.serverCalcNote")}</p>
      </div>
    </Drawer>
  );
}
