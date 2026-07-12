import { useState } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { Button, IconButton, Dialog, Input, ConfirmDialog, PageHeader } from "@/shared/ui";
import { Field } from "@/shared/forms";
import { DataTable, type ColumnDef } from "@/shared/tables";
import {
  useBankAccounts,
  useSaveBankAccount,
  useDeleteBankAccount,
  type BankAccount,
  type BankAccountInput,
} from "../api";
import { Money, GlLinkSection, mapError } from "../components";

interface FormState {
  id?: string;
  bankName: string;
  accountName: string;
  accountNumber: string;
  iban: string;
  currency: string;
  glAccountId: string;
  glAccountCode: string;
}
const EMPTY: FormState = {
  bankName: "",
  accountName: "",
  accountNumber: "",
  iban: "",
  currency: "SAR",
  glAccountId: "",
  glAccountCode: "",
};

export function BankAccountsPage() {
  const listQuery = useBankAccounts();
  const save = useSaveBankAccount();
  const del = useDeleteBankAccount();

  const [form, setForm] = useState<FormState | null>(null);
  const [glParentId, setGlParentId] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<BankAccount | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const rows = listQuery.data ?? [];
  const isNew = !form?.id;

  function openNew() {
    setNameError(null);
    setFormError(null);
    setGlParentId("");
    setForm({ ...EMPTY });
  }
  function openEdit(b: BankAccount) {
    setNameError(null);
    setFormError(null);
    setForm({
      id: b.id,
      bankName: b.bankName,
      accountName: b.accountName ?? "",
      accountNumber: b.accountNumber ?? "",
      iban: b.iban ?? "",
      currency: b.currency ?? "SAR",
      glAccountId: b.glAccountId ?? "",
      glAccountCode: b.glAccountCode ?? "",
    });
  }

  function submit() {
    if (!form) return;
    if (!form.bankName.trim()) {
      setNameError("اسم البنك مطلوب.");
      return;
    }
    setFormError(null);
    const input: BankAccountInput = {
      id: form.id,
      bankName: form.bankName,
      accountName: form.accountName,
      accountNumber: form.accountNumber,
      iban: form.iban,
      currency: form.currency || "SAR",
    };
    if (form.id) {
      input.glAccountId = form.glAccountId || undefined;
    } else if (glParentId) {
      input.parentGlId = glParentId;
    }
    save.mutate(input, {
      onSuccess: (res) => {
        if (res && res.success === false) return setFormError(mapError(new Error(res.error)));
        setForm(null);
      },
      onError: (e) => setFormError(mapError(e)),
    });
  }

  function confirmDelete(reason: string) {
    void reason;
    if (!toDelete) return;
    setDeleteError(null);
    del.mutate(toDelete.id, {
      onSuccess: (res) => {
        if (res && res.success === false) return setDeleteError(mapError(new Error(res.error)));
        setToDelete(null);
      },
      onError: (e) => setDeleteError(mapError(e)),
    });
  }

  const columns: ColumnDef<BankAccount>[] = [
    { id: "bankName", header: "البنك", accessor: (r) => r.bankName, sortable: true },
    { id: "accountName", header: "اسم الحساب", accessor: (r) => r.accountName || "—" },
    { id: "accountNumber", header: "رقم الحساب", accessor: (r) => r.accountNumber || "—" },
    { id: "iban", header: "الآيبان", accessor: (r) => r.iban || "—", defaultHidden: true },
    { id: "gl", header: "حساب الأستاذ", accessor: (r) => r.glAccountCode || "—" },
    {
      id: "balance",
      header: "الرصيد",
      numeric: true,
      accessor: (r) => r.balance,
      cell: (r) => <Money value={r.balance} currency={r.currency} tone="text-sky-700" />,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="النقد والبنوك"
        title="الحسابات البنكية"
        subtitle="إدارة الحسابات البنكية وربطها بحسابات الأستاذ العام تحت البنوك (1102)."
        action={
          <Button variant="primary" onClick={openNew}>
            <Plus className="h-4 w-4" /> حساب بنكي جديد
          </Button>
        }
      />

      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        loading={listQuery.isLoading}
        error={listQuery.error}
        onRetry={() => listQuery.refetch()}
        searchable
        searchPlaceholder="بحث عن حساب بنكي…"
        emptyTitle="لا توجد حسابات بنكية"
        emptyBody="أضف أول حساب بنكي للبدء."
        rowActions={(r) => (
          <div className="flex items-center gap-1">
            <IconButton aria-label="تعديل" size="sm" onClick={() => openEdit(r)}>
              <Pencil className="h-4 w-4" />
            </IconButton>
            <IconButton aria-label="حذف" size="sm" onClick={() => { setDeleteError(null); setToDelete(r); }}>
              <Trash2 className="h-4 w-4 text-rose-600" />
            </IconButton>
          </div>
        )}
      />

      <Dialog
        open={!!form}
        onClose={() => setForm(null)}
        title={isNew ? "حساب بنكي جديد" : "تعديل الحساب البنكي"}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setForm(null)} disabled={save.isPending}>
              إلغاء
            </Button>
            <Button variant="primary" onClick={submit} loading={save.isPending}>
              حفظ
            </Button>
          </>
        }
      >
        {form && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="اسم البنك" required error={nameError ?? undefined}>
                <Input
                  value={form.bankName}
                  invalid={!!nameError}
                  onChange={(e) => {
                    setNameError(null);
                    setForm({ ...form, bankName: e.target.value });
                  }}
                />
              </Field>
              <Field label="اسم الحساب">
                <Input value={form.accountName} onChange={(e) => setForm({ ...form, accountName: e.target.value })} />
              </Field>
              <Field label="رقم الحساب">
                <Input value={form.accountNumber} onChange={(e) => setForm({ ...form, accountNumber: e.target.value })} />
              </Field>
              <Field label="الآيبان (IBAN)">
                <Input value={form.iban} onChange={(e) => setForm({ ...form, iban: e.target.value })} dir="ltr" />
              </Field>
              <Field label="العملة">
                <Input value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} />
              </Field>
            </div>

            {isNew ? (
              <GlLinkSection root="1102" rootLabel="البنوك (1102)" parentId={glParentId} onParentChange={setGlParentId} />
            ) : (
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-500">
                حساب الأستاذ المرتبط: <code className="text-teal-700">{form.glAccountCode || "—"}</code> — لا يتغيّر عند التعديل.
              </div>
            )}

            {formError && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
                {formError}
              </div>
            )}
          </div>
        )}
      </Dialog>

      <ConfirmDialog
        open={!!toDelete}
        title="حذف الحساب البنكي"
        description={toDelete ? `سيتم تعطيل الحساب «${toDelete.bankName}».` : ""}
        tone="danger"
        confirmLabel="حذف"
        processing={del.isPending}
        error={deleteError}
        onConfirm={confirmDelete}
        onClose={() => setToDelete(null)}
      />
    </div>
  );
}
