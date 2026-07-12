import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Undo2 } from "lucide-react";
import { Drawer, Button, LoadingState, safeUserMessage } from "@/shared/ui";
import { Field } from "@/shared/forms";
import { o2cApi, qk, OpenInvoicePicker, Num, Money, type Invoice } from "@/modules/sales/lib";

const today = new Date().toISOString().slice(0, 10);

export function ReturnForm({ open, onClose, onCreated, presetInvoiceId }: { open: boolean; onClose: () => void; onCreated?: (id: string) => void; presetInvoiceId?: string }) {
  const qc = useQueryClient();
  const [picked, setPicked] = useState<Invoice | null>(null);
  const [date, setDate] = useState(today);
  const [refund, setRefund] = useState("ar_reduction");
  const [reason, setReason] = useState("");
  const [qtys, setQtys] = useState<Record<string, number>>({});

  const invoiceId = presetInvoiceId || picked?.id;
  const detail = useQuery({
    queryKey: qk.invoice(invoiceId ?? ""),
    queryFn: ({ signal }) => o2cApi.invoice(invoiceId!, signal).then((r) => r.data),
    enabled: !!invoiceId,
  });

  const lines = detail.data?.lines ?? [];
  const selected = lines.filter((l) => (qtys[l.id] ?? 0) > 0);

  const mutation = useMutation({
    mutationFn: () => o2cApi.createReturn({
      originalArDocumentId: invoiceId,
      returnDate: date, refundMethod: refund, reason: reason || undefined,
      lines: selected.map((l) => ({ originalLineId: l.id, returnQty: qtys[l.id] })),
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
      open={open} onClose={onClose} icon={Undo2} eyebrow="مرتجع جديد" title="إنشاء مرتجع بيع"
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>إلغاء</Button>
          <Button loading={mutation.isPending} disabled={!canSubmit} onClick={() => mutation.mutate()}>حفظ كمسودة</Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {mutation.isError && <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">{safeUserMessage(mutation.error)}</div>}
        {!presetInvoiceId && <Field label="الفاتورة الأصلية" required><OpenInvoicePicker value={picked} onChange={setPicked} /></Field>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="تاريخ المرتجع" required><input dir="ltr" type="date" className="field w-full tabular-nums" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="طريقة الرد">
            <select className="field w-full" value={refund} onChange={(e) => setRefund(e.target.value)}>
              <option value="ar_reduction">تخفيض الذمم</option>
              <option value="cash">رد نقدي</option>
              <option value="bank">رد بنكي</option>
              <option value="customer_deposit">رصيد دائن للعميل</option>
            </select>
          </Field>
        </div>
        <Field label="السبب"><input className="field w-full" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>

        <div className="rounded-2xl border border-slate-200">
          <div className="border-b border-slate-100 px-3 py-2 text-sm font-extrabold text-slate-700">أسطر المرتجع</div>
          <div className="p-3">
            {!invoiceId ? (
              <p className="text-xs font-semibold text-slate-400">اختر فاتورة لعرض أسطرها.</p>
            ) : detail.isLoading ? (
              <LoadingState rows={3} />
            ) : lines.length === 0 ? (
              <p className="text-xs font-semibold text-slate-400">لا توجد أسطر.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {lines.map((l) => (
                  <div key={l.id} className="grid grid-cols-12 items-center gap-2 rounded-xl bg-slate-50 px-3 py-2">
                    <span className="col-span-6 truncate text-sm font-bold text-slate-700">{l.description || "—"}</span>
                    <span className="col-span-2 text-xs text-slate-500">مباع: <Num value={l.entered_qty} /></span>
                    <span className="col-span-2 text-xs text-slate-500"><Money value={l.unit_price} /></span>
                    <input
                      dir="ltr" type="number" step="0.01" min={0} max={Number(l.entered_qty)}
                      className="field col-span-2 w-full tabular-nums"
                      placeholder="كمية"
                      aria-label={`كمية إرجاع ${l.description || l.id}`}
                      value={qtys[l.id] || ""}
                      onChange={(e) => {
                        const v = Math.max(0, Math.min(Number(e.target.value) || 0, Number(l.entered_qty)));
                        setQtys((s) => ({ ...s, [l.id]: v }));
                      }}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <p className="text-[11px] font-semibold text-slate-400">القيم تُحتسب تناسبيًا في الخادم من الفاتورة الأصلية (سعر/ضريبة/تكلفة).</p>
      </div>
    </Drawer>
  );
}
