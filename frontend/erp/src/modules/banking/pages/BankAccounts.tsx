import { useState } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { Button, IconButton, Dialog, Input, ConfirmDialog, PageHeader } from "@/shared/ui";
import { Field } from "@/shared/forms";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { useT, translateApiError } from "@/i18n";
import {
  useBankAccounts,
  useSaveBankAccount,
  useDeleteBankAccount,
  type BankAccount,
  type BankAccountInput,
} from "../api";
import { Money, GlLinkSection } from "../components";

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
  const t = useT();
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
      setNameError(t("banking.bankAccounts.nameRequired"));
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
        if (res && res.success === false) return setFormError(translateApiError(new Error(res.error), t));
        setForm(null);
      },
      onError: (e) => setFormError(translateApiError(e, t)),
    });
  }

  function confirmDelete(reason: string) {
    void reason;
    if (!toDelete) return;
    setDeleteError(null);
    del.mutate(toDelete.id, {
      onSuccess: (res) => {
        if (res && res.success === false) return setDeleteError(translateApiError(new Error(res.error), t));
        setToDelete(null);
      },
      onError: (e) => setDeleteError(translateApiError(e, t)),
    });
  }

  const columns: ColumnDef<BankAccount>[] = [
    { id: "bankName", header: t("banking.shared.bank"), accessor: (r) => r.bankName, sortable: true },
    { id: "accountName", header: t("banking.bankAccounts.cols.accountName"), accessor: (r) => r.accountName || "—" },
    { id: "accountNumber", header: t("banking.bankAccounts.cols.accountNumber"), accessor: (r) => r.accountNumber || "—" },
    { id: "iban", header: t("banking.bankAccounts.cols.iban"), accessor: (r) => r.iban || "—", defaultHidden: true },
    { id: "gl", header: t("banking.shared.ledgerAccount"), accessor: (r) => r.glAccountCode || "—" },
    {
      id: "balance",
      header: t("banking.shared.balance"),
      numeric: true,
      accessor: (r) => r.balance,
      cell: (r) => <Money value={r.balance} currency={r.currency} tone="text-sky-700" />,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow={t("banking.shared.eyebrow")}
        title={t("banking.bankAccounts.title")}
        subtitle={t("banking.bankAccounts.subtitle")}
        action={
          <Button variant="primary" onClick={openNew}>
            <Plus className="h-4 w-4" /> {t("banking.bankAccounts.newTitle")}
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
        searchPlaceholder={t("banking.bankAccounts.searchPlaceholder")}
        emptyTitle={t("banking.bankAccounts.emptyTitle")}
        emptyBody={t("banking.bankAccounts.emptyBody")}
        rowActions={(r) => (
          <div className="flex items-center gap-1">
            <IconButton aria-label={t("common.edit")} size="sm" onClick={() => openEdit(r)}>
              <Pencil className="h-4 w-4" />
            </IconButton>
            <IconButton aria-label={t("common.delete")} size="sm" onClick={() => { setDeleteError(null); setToDelete(r); }}>
              <Trash2 className="h-4 w-4 text-rose-600" />
            </IconButton>
          </div>
        )}
      />

      <Dialog
        open={!!form}
        onClose={() => setForm(null)}
        title={isNew ? t("banking.bankAccounts.newTitle") : t("banking.bankAccounts.editTitle")}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setForm(null)} disabled={save.isPending}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" onClick={submit} loading={save.isPending}>
              {t("common.save")}
            </Button>
          </>
        }
      >
        {form && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("banking.bankAccounts.fields.bankName")} required error={nameError ?? undefined}>
                <Input
                  value={form.bankName}
                  invalid={!!nameError}
                  onChange={(e) => {
                    setNameError(null);
                    setForm({ ...form, bankName: e.target.value });
                  }}
                />
              </Field>
              <Field label={t("banking.bankAccounts.fields.accountName")}>
                <Input value={form.accountName} onChange={(e) => setForm({ ...form, accountName: e.target.value })} />
              </Field>
              <Field label={t("banking.bankAccounts.fields.accountNumber")}>
                <Input value={form.accountNumber} onChange={(e) => setForm({ ...form, accountNumber: e.target.value })} />
              </Field>
              <Field label={t("banking.bankAccounts.fields.iban")}>
                <Input value={form.iban} onChange={(e) => setForm({ ...form, iban: e.target.value })} dir="ltr" />
              </Field>
              <Field label={t("banking.shared.currency")}>
                <Input value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} />
              </Field>
            </div>

            {isNew ? (
              <GlLinkSection root="1102" rootLabel={t("banking.bankAccounts.glRoot")} parentId={glParentId} onParentChange={setGlParentId} />
            ) : (
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-500">
                {t("banking.shared.linkedLedgerPrefix")} <code className="text-teal-700">{form.glAccountCode || "—"}</code> {t("banking.shared.linkedLedgerSuffix")}
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
        title={t("banking.bankAccounts.deleteTitle")}
        description={toDelete ? t("banking.bankAccounts.deleteDesc", { name: toDelete.bankName }) : ""}
        tone="danger"
        confirmLabel={t("common.delete")}
        processing={del.isPending}
        error={deleteError}
        onConfirm={confirmDelete}
        onClose={() => setToDelete(null)}
      />
    </div>
  );
}
