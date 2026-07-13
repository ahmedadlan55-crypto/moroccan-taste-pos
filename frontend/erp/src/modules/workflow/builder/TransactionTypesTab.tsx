import { useState } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { Badge, Button, ConfirmDialog, Dialog, IconButton, Input, useToast } from "@/shared/ui";
import { Field } from "@/shared/forms";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { ErrorState, LoadingState } from "@/shared/ui";
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
  function openEdit(t: WfTransactionType) {
    setErrors({});
    setFormError(null);
    setEditing({ id: t.id, name: t.name ?? "", code: t.code ?? "" });
  }

  function submit() {
    if (!editing) return;
    const next: { name?: string; code?: string } = {};
    if (!editing.name.trim()) next.name = "الاسم مطلوب.";
    if (!editing.code.trim()) next.code = "الرمز مطلوب.";
    if (next.name || next.code) {
      setErrors(next);
      return;
    }
    setFormError(null);
    save.mutate(editing, {
      onSuccess: (res) => {
        if (res && res.success === false) {
          setFormError(res.error || "تعذّر حفظ النوع.");
          return;
        }
        toast({ title: editing.id ? "تم تحديث النوع" : "تم إضافة النوع", tone: "success" });
        setEditing(null);
      },
      onError: (e) => setFormError(e instanceof Error ? e.message : "تعذّر حفظ النوع."),
    });
  }

  function confirmDelete() {
    if (!toDelete) return;
    setDeleteError(null);
    del.mutate(toDelete.id, {
      onSuccess: (res) => {
        if (res && res.success === false) {
          setDeleteError(res.error || "تعذّر حذف النوع.");
          return;
        }
        toast({ title: "تم حذف النوع", tone: "success" });
        setToDelete(null);
      },
      onError: (e) => setDeleteError(e instanceof Error ? e.message : "تعذّر حذف النوع."),
    });
  }

  const columns: ColumnDef<WfTransactionType>[] = [
    { id: "name", header: "النوع", accessor: (r) => r.name, sortable: true },
    {
      id: "code",
      header: "الرمز",
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
      header: "الحالة",
      accessor: (r) => (r.isActive === false ? "متوقّف" : "نشط"),
      cell: (r) => (
        <Badge tone={r.isActive === false ? "neutral" : "success"}>
          {r.isActive === false ? "متوقّف" : "نشط"}
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
          <Plus className="h-4 w-4" /> نوع جديد
        </Button>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        searchable
        searchPlaceholder="بحث بالاسم أو الرمز…"
        tableId="wf-txn-types"
        emptyTitle="لا توجد أنواع معاملات"
        emptyBody="أضف نوع معاملة لبدء تعريف خطوات اعتماده."
        rowActions={(r) => (
          <div className="flex items-center gap-1">
            <IconButton aria-label="تعديل" size="sm" onClick={() => openEdit(r)}>
              <Pencil className="h-4 w-4" />
            </IconButton>
            <IconButton
              aria-label="حذف"
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
        title={editing?.id ? "تعديل نوع المعاملة" : "نوع معاملة جديد"}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)} disabled={save.isPending}>
              إلغاء
            </Button>
            <Button variant="primary" onClick={submit} loading={save.isPending}>
              حفظ
            </Button>
          </>
        }
      >
        {editing && (
          <div className="space-y-4">
            <Field label="اسم النوع" required error={errors.name}>
              <Input
                value={editing.name}
                invalid={!!errors.name}
                onChange={(e) => {
                  setErrors((s) => ({ ...s, name: undefined }));
                  setEditing({ ...editing, name: e.target.value });
                }}
                placeholder="مثال: طلب صرف"
              />
            </Field>
            <Field label="الرمز" required error={errors.code} hint="حروف/أرقام إنجليزية — يُستخدم في ترقيم المعاملة.">
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
        title="حذف نوع المعاملة"
        description={toDelete ? `سيتم حذف «${toDelete.name}». قد تتأثر خطوات الاعتماد المعرّفة له.` : ""}
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
