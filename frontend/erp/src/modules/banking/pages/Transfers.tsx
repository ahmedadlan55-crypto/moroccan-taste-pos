import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Button, Dialog, Select, DatePicker, CurrencyInput, PageHeader } from "@/shared/ui";
import { Field } from "@/shared/forms";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatDate } from "@/shared/lib";
import {
  useTransfers,
  useCreateTransfer,
  useCashBoxes,
  useBankAccounts,
  todayISO,
  type Transfer,
  type TransferInput,
} from "../api";
import { Money, mapError } from "../components";

interface Endpoint {
  key: string; // "cash:ID" | "bank:ID"
  label: string;
}

interface FormState {
  date: string;
  from: string;
  to: string;
  amount: number | null;
  description: string;
}
const EMPTY: FormState = { date: todayISO(), from: "", to: "", amount: null, description: "" };

export function TransfersPage() {
  const listQuery = useTransfers();
  const boxes = useCashBoxes();
  const banks = useBankAccounts();
  const create = useCreateTransfer();

  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const nameOf = useMemo(() => {
    const m = new Map<string, string>();
    (boxes.data ?? []).forEach((b) => m.set(`cash:${b.id}`, b.name));
    (banks.data ?? []).forEach((b) => m.set(`bank:${b.id}`, b.bankName));
    return m;
  }, [boxes.data, banks.data]);

  const endpoints: { cash: Endpoint[]; bank: Endpoint[] } = useMemo(
    () => ({
      cash: (boxes.data ?? []).map((b) => ({ key: `cash:${b.id}`, label: b.name })),
      bank: (banks.data ?? []).map((b) => ({ key: `bank:${b.id}`, label: b.bankName })),
    }),
    [boxes.data, banks.data],
  );

  function resolve(type: string, id: string): string {
    return nameOf.get(`${type}:${id}`) ?? id;
  }

  function submit() {
    if (!form) return;
    if (!form.amount || form.amount <= 0) return setFormError("المبلغ مطلوب ويجب أن يكون أكبر من صفر.");
    if (!form.from || !form.to) return setFormError("اختر مصدر التحويل ووجهته.");
    if (form.from === form.to) return setFormError("لا يمكن التحويل إلى نفس الحساب.");
    setFormError(null);
    const [fromType, fromId] = form.from.split(":");
    const [toType, toId] = form.to.split(":");
    const input: TransferInput = {
      transferDate: form.date,
      fromType,
      fromId,
      toType,
      toId,
      amount: form.amount,
      description: form.description,
    };
    create.mutate(input, {
      onSuccess: (res) => {
        if (res && res.success === false) return setFormError(mapError(new Error(res.error)));
        setForm(null);
      },
      onError: (e) => setFormError(mapError(e)),
    });
  }

  const columns: ColumnDef<Transfer>[] = [
    { id: "number", header: "الرقم", accessor: (r) => r.transfer_number, sortable: true },
    {
      id: "date",
      header: "التاريخ",
      accessor: (r) => r.transfer_date,
      cell: (r) => <span dir="ltr" className="tabular-nums text-slate-600">{formatDate(r.transfer_date)}</span>,
    },
    {
      id: "from",
      header: "من",
      accessor: (r) => resolve(r.from_type, r.from_id),
      cell: (r) => (
        <span>
          <span className="font-semibold text-slate-800">{resolve(r.from_type, r.from_id)}</span>{" "}
          <span className="text-[11px] text-slate-400">({r.from_type === "cash" ? "صندوق" : "بنك"})</span>
        </span>
      ),
    },
    {
      id: "to",
      header: "إلى",
      accessor: (r) => resolve(r.to_type, r.to_id),
      cell: (r) => (
        <span>
          <span className="font-semibold text-slate-800">{resolve(r.to_type, r.to_id)}</span>{" "}
          <span className="text-[11px] text-slate-400">({r.to_type === "cash" ? "صندوق" : "بنك"})</span>
        </span>
      ),
    },
    {
      id: "amount",
      header: "المبلغ",
      numeric: true,
      accessor: (r) => r.amount,
      cell: (r) => <Money value={r.amount} tone="text-teal-700" />,
    },
    { id: "description", header: "الوصف", accessor: (r) => r.description || "—" },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="النقد والبنوك"
        title="التحويلات النقدية"
        subtitle="تحويل الأموال بين الصناديق والحسابات البنكية مع ترحيل القيد المحاسبي تلقائيًا."
        action={
          <Button variant="primary" onClick={() => { setFormError(null); setForm({ ...EMPTY }); }}>
            <Plus className="h-4 w-4" /> تحويل جديد
          </Button>
        }
      />

      <DataTable
        columns={columns}
        rows={listQuery.data ?? []}
        getRowId={(r) => r.transfer_number}
        loading={listQuery.isLoading}
        error={listQuery.error}
        onRetry={() => listQuery.refetch()}
        searchable
        searchPlaceholder="بحث في التحويلات…"
        initialSort={{ columnId: "number", dir: "desc" }}
        emptyTitle="لا توجد تحويلات"
        emptyBody="أنشئ أول تحويل بين الصناديق والبنوك."
      />

      <Dialog
        open={!!form}
        onClose={() => setForm(null)}
        title="تحويل نقدي جديد"
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setForm(null)} disabled={create.isPending}>
              إلغاء
            </Button>
            <Button variant="primary" onClick={submit} loading={create.isPending}>
              حفظ التحويل
            </Button>
          </>
        }
      >
        {form && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="التاريخ" required>
                <DatePicker value={form.date} onChange={(date) => setForm({ ...form, date })} />
              </Field>
              <Field label="المبلغ" required>
                <CurrencyInput value={form.amount} onChange={(amount) => setForm({ ...form, amount })} />
              </Field>
              <Field label="من">
                <Select value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })}>
                  <option value="">— اختر —</option>
                  <optgroup label="الصناديق">
                    {endpoints.cash.map((o) => (
                      <option key={o.key} value={o.key}>{o.label}</option>
                    ))}
                  </optgroup>
                  <optgroup label="الحسابات البنكية">
                    {endpoints.bank.map((o) => (
                      <option key={o.key} value={o.key}>{o.label}</option>
                    ))}
                  </optgroup>
                </Select>
              </Field>
              <Field label="إلى">
                <Select value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })}>
                  <option value="">— اختر —</option>
                  <optgroup label="الصناديق">
                    {endpoints.cash.map((o) => (
                      <option key={o.key} value={o.key}>{o.label}</option>
                    ))}
                  </optgroup>
                  <optgroup label="الحسابات البنكية">
                    {endpoints.bank.map((o) => (
                      <option key={o.key} value={o.key}>{o.label}</option>
                    ))}
                  </optgroup>
                </Select>
              </Field>
            </div>
            <Field label="الوصف">
              <textarea
                className="field min-h-20 w-full resize-y py-2"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </Field>
            {formError && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
                {formError}
              </div>
            )}
          </div>
        )}
      </Dialog>
    </div>
  );
}
