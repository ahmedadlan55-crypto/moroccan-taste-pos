import { useState } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { Badge, Button, ConfirmDialog, Dialog, IconButton, Input, useToast } from "@/shared/ui";
import { Field } from "@/shared/forms";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { ErrorState, LoadingState } from "@/shared/ui";
import {
  usePositions,
  useSavePosition,
  useDeletePosition,
  type Position,
  type PositionInput,
} from "../lib/api";

const EMPTY: PositionInput = { name: "", level: 1 };

// المناصب — the org positions the approval steps route to (least-busy holder of
// the position is auto-assigned). `level` orders seniority (higher = more senior).
export function PositionsTab() {
  const list = usePositions();
  const save = useSavePosition();
  const del = useDeletePosition();
  const { toast } = useToast();

  const [editing, setEditing] = useState<PositionInput | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<Position | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const rows = list.data ?? [];

  function openNew() {
    setNameError(null);
    setFormError(null);
    setEditing({ ...EMPTY });
  }
  function openEdit(p: Position) {
    setNameError(null);
    setFormError(null);
    setEditing({ id: p.id, name: p.name ?? "", level: Number(p.level) || 0 });
  }

  function submit() {
    if (!editing) return;
    if (!editing.name.trim()) {
      setNameError("اسم المنصب مطلوب.");
      return;
    }
    setFormError(null);
    save.mutate(editing, {
      onSuccess: (res) => {
        if (res && res.success === false) {
          setFormError(res.error || "تعذّر حفظ المنصب.");
          return;
        }
        toast({ title: editing.id ? "تم تحديث المنصب" : "تم إضافة المنصب", tone: "success" });
        setEditing(null);
      },
      onError: (e) => setFormError(e instanceof Error ? e.message : "تعذّر حفظ المنصب."),
    });
  }

  function confirmDelete() {
    if (!toDelete) return;
    setDeleteError(null);
    del.mutate(toDelete.id, {
      onSuccess: (res) => {
        if (res && res.success === false) {
          setDeleteError(res.error || "تعذّر حذف المنصب.");
          return;
        }
        toast({ title: "تم حذف المنصب", tone: "success" });
        setToDelete(null);
      },
      onError: (e) => setDeleteError(e instanceof Error ? e.message : "تعذّر حذف المنصب."),
    });
  }

  const columns: ColumnDef<Position>[] = [
    { id: "name", header: "المنصب", accessor: (r) => r.name, sortable: true },
    {
      id: "level",
      header: "المستوى",
      accessor: (r) => r.level,
      sortable: true,
      numeric: true,
      cell: (r) => (
        <span dir="ltr" className="tabular-nums">
          {r.level}
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
          <Plus className="h-4 w-4" /> منصب جديد
        </Button>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        searchable
        searchPlaceholder="بحث بالاسم…"
        tableId="wf-positions"
        emptyTitle="لا توجد مناصب"
        emptyBody="أضف أول منصب لبناء مسارات الاعتماد."
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
        title={editing?.id ? "تعديل المنصب" : "منصب جديد"}
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
            <Field label="اسم المنصب" required error={nameError ?? undefined}>
              <Input
                value={editing.name}
                invalid={!!nameError}
                onChange={(e) => {
                  setNameError(null);
                  setEditing({ ...editing, name: e.target.value });
                }}
                placeholder="مثال: مدير مالي"
              />
            </Field>
            <Field label="المستوى" hint="رقم يرتّب الأقدمية — كلما زاد كان المنصب أعلى.">
              <Input
                type="number"
                min={0}
                value={editing.level}
                onChange={(e) => setEditing({ ...editing, level: Number(e.target.value) || 0 })}
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
        title="حذف المنصب"
        description={toDelete ? `سيتم حذف «${toDelete.name}». قد تتأثر خطوات الاعتماد المرتبطة به.` : ""}
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
