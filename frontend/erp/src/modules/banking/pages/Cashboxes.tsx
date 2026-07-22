import { useState } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { Button, IconButton, Dialog, Input, Select, ConfirmDialog, PageHeader, Badge } from "@/shared/ui";
import { Field } from "@/shared/forms";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { useT, translateApiError } from "@/i18n";
import {
  useCashBoxes,
  useSaveCashBox,
  useDeleteCashBox,
  type CashBox,
  type CashBoxInput,
} from "../api";
import { Money, GlLinkSection } from "../components";

const TYPE_CODES = ["main", "branch", "petty"] as const;

interface FormState {
  id?: string;
  name: string;
  code: string;
  type: string;
  keeperUsername: string;
  currency: string;
  glAccountId: string;
  glAccountCode: string;
}
const EMPTY: FormState = {
  name: "",
  code: "",
  type: "branch",
  keeperUsername: "",
  currency: "SAR",
  glAccountId: "",
  glAccountCode: "",
};

export function CashboxesPage() {
  const t = useT();
  const listQuery = useCashBoxes();
  const save = useSaveCashBox();
  const del = useDeleteCashBox();
  // main/branch/petty → translated label, unknown codes fall back to the raw value.
  const typeLabel = (type: string) =>
    (TYPE_CODES as readonly string[]).includes(type) ? t(`banking.cashboxes.types.${type}`) : type;

  const [form, setForm] = useState<FormState | null>(null);
  const [glParentId, setGlParentId] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<CashBox | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const rows = listQuery.data ?? [];
  const isNew = !form?.id;

  function openNew() {
    setNameError(null);
    setFormError(null);
    setGlParentId("");
    setForm({ ...EMPTY });
  }
  function openEdit(b: CashBox) {
    setNameError(null);
    setFormError(null);
    setForm({
      id: b.id,
      name: b.name,
      code: b.code ?? "",
      type: b.type ?? "branch",
      keeperUsername: b.keeperUsername ?? "",
      currency: b.currency ?? "SAR",
      glAccountId: b.glAccountId ?? "",
      glAccountCode: b.glAccountCode ?? "",
    });
  }

  function submit() {
    if (!form) return;
    if (!form.name.trim()) {
      setNameError(t("banking.cashboxes.nameRequired"));
      return;
    }
    setFormError(null);
    const input: CashBoxInput = {
      id: form.id,
      name: form.name,
      code: form.code,
      type: form.type,
      keeperUsername: form.keeperUsername,
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

  const columns: ColumnDef<CashBox>[] = [
    { id: "name", header: t("banking.shared.box"), accessor: (r) => r.name, sortable: true },
    { id: "code", header: t("banking.cashboxes.cols.code"), accessor: (r) => r.code || "—" },
    {
      id: "type",
      header: t("banking.shared.type"),
      accessor: (r) => typeLabel(r.type),
      cell: (r) => <Badge tone="teal">{typeLabel(r.type)}</Badge>,
    },
    { id: "branch", header: t("banking.shared.branch"), accessor: (r) => r.branchName || "—" },
    { id: "keeper", header: t("banking.cashboxes.cols.keeper"), accessor: (r) => r.keeperUsername || "—", defaultHidden: true },
    { id: "gl", header: t("banking.shared.ledgerAccount"), accessor: (r) => r.glAccountCode || "—" },
    {
      id: "balance",
      header: t("banking.shared.balance"),
      numeric: true,
      accessor: (r) => r.balance,
      cell: (r) => <Money value={r.balance} currency={r.currency} tone="text-emerald-600" />,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow={t("banking.shared.eyebrow")}
        title={t("banking.cashboxes.title")}
        subtitle={t("banking.cashboxes.subtitle")}
        action={
          <Button variant="primary" onClick={openNew}>
            <Plus className="h-4 w-4" /> {t("banking.cashboxes.newTitle")}
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
        searchPlaceholder={t("banking.cashboxes.searchPlaceholder")}
        emptyTitle={t("banking.cashboxes.emptyTitle")}
        emptyBody={t("banking.cashboxes.emptyBody")}
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
        title={isNew ? t("banking.cashboxes.newTitle") : t("banking.cashboxes.editTitle")}
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
              <Field label={t("banking.cashboxes.fields.name")} required error={nameError ?? undefined}>
                <Input
                  value={form.name}
                  invalid={!!nameError}
                  onChange={(e) => {
                    setNameError(null);
                    setForm({ ...form, name: e.target.value });
                  }}
                />
              </Field>
              <Field label={t("banking.cashboxes.fields.code")}>
                <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
              </Field>
              <Field label={t("banking.shared.type")}>
                <Select
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value })}
                  options={[
                    { value: "main", label: t("banking.cashboxes.types.main") },
                    { value: "branch", label: t("banking.cashboxes.types.branch") },
                    { value: "petty", label: t("banking.cashboxes.types.petty") },
                  ]}
                />
              </Field>
              <Field label={t("banking.cashboxes.fields.keeper")}>
                <Input
                  value={form.keeperUsername}
                  onChange={(e) => setForm({ ...form, keeperUsername: e.target.value })}
                />
              </Field>
              <Field label={t("banking.shared.currency")}>
                <Input value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} />
              </Field>
            </div>

            {isNew ? (
              <GlLinkSection root="1101" rootLabel={t("banking.cashboxes.glRoot")} parentId={glParentId} onParentChange={setGlParentId} />
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
        title={t("banking.cashboxes.deleteTitle")}
        description={toDelete ? t("banking.cashboxes.deleteDesc", { name: toDelete.name }) : ""}
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
