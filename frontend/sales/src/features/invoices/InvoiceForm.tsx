import { useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Plus, Trash2, FileText } from "lucide-react";
import { o2cApi } from "@/lib/api";
import { qk } from "@/lib/query-keys";
import { Drawer } from "@/components/drawer/Drawer";
import { Button } from "@/components/ui/button";
import { Field } from "@/features/_shared/ui";
import { CustomerPicker } from "@/features/_shared/pickers";
import { safeUserMessage } from "@/components/states/States";
import type { Customer } from "@/lib/types";

interface LineForm { description: string; enteredQty: number; unitPrice: number; discount: number; vatCategory: "S" | "Z" | "E" | "O" }
interface Values { issueDate: string; lines: LineForm[] }

const today = new Date().toISOString().slice(0, 10);

export function InvoiceForm({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
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
      if (id) nav(`/invoices/${id}`);
    },
  });

  return (
    <Drawer
      open={open} onClose={onClose} icon={FileText} eyebrow="فاتورة جديدة" title="إنشاء فاتورة عميل"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>إلغاء</Button>
          <Button onClick={handleSubmit((v) => mutation.mutate(v))} disabled={mutation.isPending}>
            {mutation.isPending ? "جارٍ الحفظ…" : "حفظ كمسودة"}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {mutation.isError && <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">{safeUserMessage(mutation.error)}</div>}
        <Field label="العميل" hint="اختياري للفاتورة النقدية؛ مطلوب للبيع الآجل"><CustomerPicker value={customer} onChange={setCustomer} /></Field>
        <Field label="تاريخ الإصدار" required><input dir="ltr" type="date" className="field w-full tabular-nums" {...register("issueDate")} /></Field>

        <div className="rounded-2xl border border-slate-200">
          <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
            <span className="text-sm font-extrabold text-slate-700">الأسطر</span>
            <Button size="sm" variant="secondary" onClick={() => append({ description: "", enteredQty: 1, unitPrice: 0, discount: 0, vatCategory: "S" })}>
              <Plus className="ml-1 h-4 w-4" /> سطر
            </Button>
          </div>
          <div className="flex flex-col gap-3 p-3">
            {fields.map((f, i) => (
              <div key={f.id} className="grid grid-cols-12 items-end gap-2">
                <div className="col-span-12 sm:col-span-4">
                  <label className="mb-1 block text-[11px] font-bold text-slate-500">الوصف</label>
                  <input className="field w-full" {...register(`lines.${i}.description` as const, { required: true })} />
                </div>
                <div className="col-span-3 sm:col-span-2">
                  <label className="mb-1 block text-[11px] font-bold text-slate-500">الكمية</label>
                  <input dir="ltr" type="number" step="0.01" className="field w-full tabular-nums" {...register(`lines.${i}.enteredQty` as const, { valueAsNumber: true })} />
                </div>
                <div className="col-span-3 sm:col-span-2">
                  <label className="mb-1 block text-[11px] font-bold text-slate-500">السعر</label>
                  <input dir="ltr" type="number" step="0.01" className="field w-full tabular-nums" {...register(`lines.${i}.unitPrice` as const, { valueAsNumber: true })} />
                </div>
                <div className="col-span-3 sm:col-span-2">
                  <label className="mb-1 block text-[11px] font-bold text-slate-500">الخصم</label>
                  <input dir="ltr" type="number" step="0.01" className="field w-full tabular-nums" {...register(`lines.${i}.discount` as const, { valueAsNumber: true })} />
                </div>
                <div className="col-span-2 sm:col-span-1">
                  <label className="mb-1 block text-[11px] font-bold text-slate-500">الضريبة</label>
                  <select className="field w-full px-1" {...register(`lines.${i}.vatCategory` as const)}>
                    <option value="S">15%</option><option value="Z">0%</option><option value="E">معفى</option><option value="O">خارج</option>
                  </select>
                </div>
                <div className="col-span-1 flex justify-center">
                  <button type="button" onClick={() => fields.length > 1 && remove(i)} className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-30" disabled={fields.length <= 1} aria-label="حذف السطر">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
        <p className="text-[11px] font-semibold text-slate-400">الإجماليات والضريبة تُحتسب في الخادم عند الحفظ (لا يُوثَق بحساب المتصفح).</p>
        {errors.lines && <p className="text-[11px] font-bold text-rose-600">تأكد من تعبئة وصف كل سطر.</p>}
      </div>
    </Drawer>
  );
}
