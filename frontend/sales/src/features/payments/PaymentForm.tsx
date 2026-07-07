import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { HandCoins, Plus, Trash2 } from "lucide-react";
import { o2cApi } from "@/lib/api";
import { qk } from "@/lib/query-keys";
import { Drawer } from "@/components/drawer/Drawer";
import { Button } from "@/components/ui/button";
import { Field, Money } from "@/features/_shared/ui";
import { CustomerPicker, OpenInvoicePicker } from "@/features/_shared/pickers";
import { safeUserMessage } from "@/components/states/States";
import { formatCurrency } from "@/lib/formatters";
import type { Customer, Invoice } from "@/lib/types";

interface AllocRow { invoice: Invoice | null; amount: number }
const today = new Date().toISOString().slice(0, 10);

export function PaymentForm({ open, onClose, presetCustomerId }: { open: boolean; onClose: () => void; presetCustomerId?: string }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [amount, setAmount] = useState<number>(0);
  const [method, setMethod] = useState("cash");
  const [dest, setDest] = useState<"cash" | "bank">("cash");
  const [date, setDate] = useState(today);
  const [reference, setReference] = useState("");
  const [allocs, setAllocs] = useState<AllocRow[]>([]);

  const allocated = allocs.reduce((s, a) => s + (Number(a.amount) || 0), 0);
  const unapplied = Math.max(0, (Number(amount) || 0) - allocated);
  const over = allocated - (Number(amount) || 0) > 0.01;

  const mutation = useMutation({
    mutationFn: () => o2cApi.createPayment({
      customerId: customer?.id, customerName: customer?.name,
      amount: Number(amount), paymentDate: date, paymentMethod: method, destinationType: dest,
      reference: reference || undefined,
      allocations: allocs.filter((a) => a.invoice && Number(a.amount) > 0).map((a) => ({ arDocumentId: a.invoice!.id, amount: Number(a.amount) })),
    }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: qk.all });
      onClose();
      const id = (res.data as { id?: string } | undefined)?.id;
      if (id) nav(`/payments/${id}`);
    },
  });

  const canSubmit = !!customer && Number(amount) > 0 && !over && !mutation.isPending;

  return (
    <Drawer
      open={open} onClose={onClose} icon={HandCoins} eyebrow="سند قبض" title="تسجيل تحصيل"
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-bold text-slate-500">غير مخصّص: <span dir="ltr" className="tabular-nums">{formatCurrency(unapplied)}</span></span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>إلغاء</Button>
            <Button onClick={() => mutation.mutate()} disabled={!canSubmit}>{mutation.isPending ? "جارٍ الحفظ…" : "حفظ كمسودة"}</Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {mutation.isError && <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">{safeUserMessage(mutation.error)}</div>}
        <Field label="العميل" required><CustomerPicker value={customer} onChange={(c) => { setCustomer(c); setAllocs([]); }} disabled={!!presetCustomerId && !!customer} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="المبلغ" required><input dir="ltr" type="number" step="0.01" className="field w-full tabular-nums" value={amount || ""} onChange={(e) => setAmount(Number(e.target.value))} /></Field>
          <Field label="التاريخ" required><input dir="ltr" type="date" className="field w-full tabular-nums" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="طريقة الدفع">
            <select className="field w-full" value={method} onChange={(e) => { setMethod(e.target.value); setDest(e.target.value === "bank" || e.target.value === "transfer" || e.target.value === "card" ? "bank" : "cash"); }}>
              <option value="cash">نقدًا</option>
              <option value="bank">تحويل بنكي</option>
              <option value="card">بطاقة</option>
              <option value="transfer">حوالة</option>
            </select>
          </Field>
          <Field label="الوجهة">
            <select className="field w-full" value={dest} onChange={(e) => setDest(e.target.value as "cash" | "bank")}>
              <option value="cash">صندوق نقدي</option>
              <option value="bank">حساب بنكي</option>
            </select>
          </Field>
        </div>
        <Field label="مرجع"><input className="field w-full" value={reference} onChange={(e) => setReference(e.target.value)} /></Field>

        <div className="rounded-2xl border border-slate-200">
          <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
            <span className="text-sm font-extrabold text-slate-700">تخصيص على الفواتير</span>
            <Button size="sm" variant="secondary" disabled={!customer} onClick={() => setAllocs((a) => [...a, { invoice: null, amount: 0 }])}>
              <Plus className="ml-1 h-4 w-4" /> فاتورة
            </Button>
          </div>
          <div className="flex flex-col gap-3 p-3">
            {allocs.length === 0 && <p className="text-xs font-semibold text-slate-400">اترك التخصيص فارغًا لتسجيل دفعة مقدمة، أو أضف فواتير.</p>}
            {allocs.map((row, i) => (
              <div key={i} className="grid grid-cols-12 items-end gap-2">
                <div className="col-span-8">
                  <label className="mb-1 block text-[11px] font-bold text-slate-500">الفاتورة</label>
                  <OpenInvoicePicker customerId={customer?.id} value={row.invoice} onChange={(inv) => setAllocs((a) => a.map((r, j) => j === i ? { invoice: inv, amount: inv ? Number(inv.balance_amount) : r.amount } : r))} />
                </div>
                <div className="col-span-3">
                  <label className="mb-1 block text-[11px] font-bold text-slate-500">المبلغ</label>
                  <input dir="ltr" type="number" step="0.01" className="field w-full tabular-nums" value={row.amount || ""} onChange={(e) => setAllocs((a) => a.map((r, j) => j === i ? { ...r, amount: Number(e.target.value) } : r))} />
                </div>
                <div className="col-span-1 flex justify-center">
                  <button type="button" onClick={() => setAllocs((a) => a.filter((_, j) => j !== i))} className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600" aria-label="حذف">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
        {over && <p className="text-sm font-bold text-rose-600">مجموع التخصيص (<Money value={allocated} />) يتجاوز مبلغ السند.</p>}
      </div>
    </Drawer>
  );
}
