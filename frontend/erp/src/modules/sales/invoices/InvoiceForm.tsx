import { useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, FileText } from "lucide-react";
import { Drawer, Button, safeUserMessage } from "@/shared/ui";
import { useTx } from "@/shared/ui/i18n";
import { Field } from "@/shared/forms";
import { o2cApi, qk, CustomerPicker, type Customer } from "@/modules/sales/lib";

interface LineForm { description: string; enteredQty: number; unitPrice: number; discount: number; vatCategory: "S" | "Z" | "E" | "O" }
interface Values { issueDate: string; lines: LineForm[] }
const today = new Date().toISOString().slice(0, 10);

export function InvoiceForm({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated?: (id: string) => void }) {
  const t = useTx();
  const qc = useQueryClient();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const { register, control, handleSubmit, formState: { errors } } = useForm<Values>({
    defaultValues: { issueDate: today, lines: [{ description: "", enteredQty: 1, unitPrice: 0, discount: 0, vatCategory: "S" }] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: "lines" });

  const mutation = useMutation({
    mutationFn: (v: Values) => o2cApi.createInvoice({
      documentType: "invoice", sourceType: "manual",
      customerId: customer?.id, customerName: customer?.name,
      issueDate: v.issueDate,
      lines: v.lines.map((l) => ({ description: l.description, enteredQty: Number(l.enteredQty), unitPrice: Number(l.unitPrice), discount: Number(l.discount), vatCategory: l.vatCategory })),
    }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: qk.all });
      onClose();
      const id = (res.data as { id?: string } | undefined)?.id;
      if (id) onCreated?.(id);
    },
  });

  return (
    <Drawer
      open={open} onClose={onClose} icon={FileText} eyebrow={t("sales.invoices.form.eyebrow")} title={t("sales.invoices.form.title")}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
          <Button loading={mutation.isPending} onClick={handleSubmit((v) => mutation.mutate(v))}>{t("sales.actions.saveDraft")}</Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {mutation.isError && <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">{safeUserMessage(mutation.error)}</div>}
        <Field label={t("sales.col.customer")} hint={t("sales.invoices.form.customerHint")}><CustomerPicker value={customer} onChange={setCustomer} /></Field>
        <Field label={t("sales.invoices.form.issueDate")} required><input dir="ltr" type="date" className="field w-full tabular-nums" {...register("issueDate")} /></Field>

        <div className="rounded-2xl border border-slate-200">
          <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
            <span className="text-sm font-extrabold text-slate-700">{t("sales.lines")}</span>
            <Button size="sm" variant="secondary" onClick={() => append({ description: "", enteredQty: 1, unitPrice: 0, discount: 0, vatCategory: "S" })}>
              <Plus className="h-4 w-4" /> {t("sales.actions.addLine")}
            </Button>
          </div>
          <div className="flex flex-col gap-3 p-3">
            {fields.map((f, i) => (
              <div key={f.id} className="grid grid-cols-12 items-end gap-2">
                <div className="col-span-12 sm:col-span-4">
                  <label className="mb-1 block text-[11px] font-bold text-slate-500">{t("sales.col.desc")}</label>
                  <input className="field w-full" aria-label={t("sales.invoices.form.lineDescAria", { n: i + 1 })} {...register(`lines.${i}.description` as const, { required: true })} />
                </div>
                <div className="col-span-3 sm:col-span-2">
                  <label className="mb-1 block text-[11px] font-bold text-slate-500">{t("sales.col.qty")}</label>
                  <input dir="ltr" type="number" step="0.01" className="field w-full tabular-nums" aria-label={t("sales.invoices.form.lineQtyAria", { n: i + 1 })} {...register(`lines.${i}.enteredQty` as const, { valueAsNumber: true })} />
                </div>
                <div className="col-span-3 sm:col-span-2">
                  <label className="mb-1 block text-[11px] font-bold text-slate-500">{t("sales.col.price")}</label>
                  <input dir="ltr" type="number" step="0.01" className="field w-full tabular-nums" aria-label={t("sales.invoices.form.linePriceAria", { n: i + 1 })} {...register(`lines.${i}.unitPrice` as const, { valueAsNumber: true })} />
                </div>
                <div className="col-span-3 sm:col-span-2">
                  <label className="mb-1 block text-[11px] font-bold text-slate-500">{t("sales.col.discount")}</label>
                  <input dir="ltr" type="number" step="0.01" className="field w-full tabular-nums" {...register(`lines.${i}.discount` as const, { valueAsNumber: true })} />
                </div>
                <div className="col-span-2 sm:col-span-1">
                  <label className="mb-1 block text-[11px] font-bold text-slate-500">{t("sales.col.vat")}</label>
                  <select className="field w-full px-1" {...register(`lines.${i}.vatCategory` as const)}>
                    <option value="S">{t("sales.vatShort.S")}</option><option value="Z">{t("sales.vatShort.Z")}</option><option value="E">{t("sales.vatShort.E")}</option><option value="O">{t("sales.vatShort.O")}</option>
                  </select>
                </div>
                <div className="col-span-1 flex justify-center">
                  <button type="button" onClick={() => fields.length > 1 && remove(i)} className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-30" disabled={fields.length <= 1} aria-label={t("sales.actions.deleteLine")}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
        <p className="text-[11px] font-semibold text-slate-400">{t("sales.invoices.form.serverCalcNote")}</p>
        {errors.lines && <p className="text-[11px] font-bold text-rose-600">{t("sales.form.lineDescRequired")}</p>}
      </div>
    </Drawer>
  );
}
