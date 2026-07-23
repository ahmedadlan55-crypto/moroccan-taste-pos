import { useState } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { Badge, Button, ConfirmDialog, Dialog, IconButton, Input, useToast } from "@/shared/ui";
import { Field } from "@/shared/forms";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { ErrorState, LoadingState } from "@/shared/ui";
import { useTx } from "@/shared/ui/i18n";
import {
  useTransactionTypes,
  useSaveTransactionType,
  useDeleteTransactionType,
  type WfTransactionType,
  type TransactionTypeInput,
} from "../lib/api";

const EMPTY: TransactionTypeInput = { name: "", code: "" };

// أنواع المعاملات — each type owns its own approval-steps chain (خطوات الاعتماد).
// `code` is normalized server-side to A–Z0–9 and used in the txn number prefix.
export function TransactionTypesTab() {
  const t = useTx();
  const list = useTransactionTypes();
  const save = useSaveTransactionType();
  const del = useDeleteTransactionType();
  const { toast } = useToast();

  const [editing, setEditing] = useState<TransactionTypeInput | null>(null);
  const [errors, setErrors] = useState<{ name?: string; code?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<WfTransactionType | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const rows = list.data ?? [];

  function openNew() {
    setErrors({});
    setFormError(null);
    setEditing({ ...EMPTY });
  }
  function openEdit(type: WfTransactionType) {
    setErrors({});
    setFormError(null);
    setEditing({ id: type.id, name: type.name ?? "", code: type.code ?? "" });
  }

  function submit() {
    if (!editing) return;
    const next: { name?: string; code?: string } = {};
    if (!editing.name.trim()) next.name = t("workflow.types.nameRequired");
    if (!editing.code.trim()) next.code = t("workflow.types.codeRequired");
    if (next.name || next.code) {
      setErrors(next);
      return;
    }
    setFormError(null);
    save.mutate(editing, {
      onSuccess: (res) => {
        if (res && res.success === false) {
          setFormError(res.error || t("workflow.types.saveFailed"));
          return;
        }
        toast({ title: editing.id ? t("workflow.types.toastUpdated") : t("workflow.types.toastAdded"), tone: "success" });
        setEditing(null);
      },
      onError: (e) => setFormError(e instanceof Error ? e.message : t("workflow.types.saveFailed")),
    });
  }

  function confirmDelete() {
    if (!toDelete) return;
    setDeleteError(null);
    del.mutate(toDelete.id, {
      onSuccess: (res) => {
        if (res && res.success === false) {
          setDeleteError(res.error || t("workflow.types.deleteFailed"));
          return;
        }
        toast({ title: t("workflow.types.toastDeleted"), tone: "success" });
        setToDelete(null);
      },
      onError: (e) => setDeleteError(e instanceof Error ? e.message : t("workflow.types.deleteFailed")),
    });
  }

  const columns: ColumnDef<WfTransactionType>[] = [
    { id: "name", header: t("workflow.types.colName"), accessor: (r) => r.name, sortable: true },
    {
      id: "code",
      header: t("workflow.types.colCode"),
      accessor: (r) => r.code,
      sortable: true,
      cell: (r) => (
        <span dir="ltr" className="tabular-nums font-bold">
          {r.code || "—"}
        </span>
      ),
    },
    {
      id: "isActive",
      header: t("common.status"),
      accessor: (r) => (r.isActive === false ? t("workflow.term.stopped") : t("common.active")),
      cell: (r) => (
        <Badge tone={r.isActive === false ? "neutral" : "success"}>
          {r.isActive === false ? t("workflow.term.stopped") : t("common.active")}
        </Badge>
      ),
    },
  ];

  if (list.isLoading) return <LoadingState rows={4} />;
  if (list.isError) return <ErrorState error={list.error} onRetry={() => list.refetch()} />;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button variant="primary" onClick={openNew}>
          <Plus className="h-4 w-4" /> {t("workflow.types.newBtn")}
        </Button>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        searchable
        searchPlaceholder={t("workflow.types.searchPlaceholder")}
        tableId="wf-txn-types"
        emptyTitle={t("workflow.types.emptyTitle")}
        emptyBody={t("workflow.types.emptyBody")}
        rowActions={(r) => (
          <div className="flex items-center gap-1">
            <IconButton aria-label={t("common.edit")} size="sm" onClick={() => openEdit(r)}>
              <Pencil className="h-4 w-4" />
            </IconButton>
            <IconButton
              aria-label={t("common.delete")}
              size="sm"
              variant="danger"
              onClick={() => {
                setDeleteError(null);
                setToDelete(r);
              }}
            >
              <Trash2 className="h-4 w-4" />
            </IconButton>
          </div>
        )}
      />

      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? t("workflow.types.dialogEdit") : t("workflow.types.dialogNew")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)} disabled={save.isPending}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" onClick={submit} loading={save.isPending}>
              {t("common.save")}
            </Button>
          </>
        }
      >
        {editing && (
          <div className="space-y-4">
            <Field label={t("workflow.types.nameLabel")} required error={errors.name}>
              <Input
                value={editing.name}
                invalid={!!errors.name}
                onChange={(e) => {
                  setErrors((s) => ({ ...s, name: undefined }));
                  setEditing({ ...editing, name: e.target.value });
                }}
                placeholder={t("workflow.types.namePlaceholder")}
              />
            </Field>
            <Field label={t("workflow.types.codeLabel")} required error={errors.code} hint={t("workflow.types.codeHint")}>
              <Input
                value={editing.code}
                invalid={!!errors.code}
                dir="ltr"
                onChange={(e) => {
                  setErrors((s) => ({ ...s, code: undefined }));
                  setEditing({ ...editing, code: e.target.value });
                }}
                placeholder="EXP"
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

      <ConfirmDialog
        open={!!toDelete}
        title={t("workflow.types.confirmDeleteTitle")}
        description={toDelete ? t("workflow.types.confirmDeleteDesc", { name: toDelete.name }) : ""}
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
