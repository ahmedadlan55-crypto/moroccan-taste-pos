import { useState } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import {
  Button,
  IconButton,
  Dialog,
  Input,
  Select,
  Toggle,
  Badge,
  ConfirmDialog,
} from "@/shared/ui";
import { Field } from "@/shared/forms";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { PageHeader } from "@/shared/ui";
import { useT, type TFunction } from "@/i18n";
import {
  useCostCenters,
  useSaveCostCenter,
  useDeleteCostCenter,
  type CostCenter,
  type CostCenterInput,
} from "../api";

const EMPTY: CostCenterInput = {
  code: "",
  nameAr: "",
  nameEn: "",
  parentId: null,
  isActive: true,
  notes: "",
};

// Server error codes (409/400) → localized messages via the caller-supplied `t`.
function mapError(t: TFunction, error: unknown): string {
  const raw = error instanceof Error ? error.message : "";
  if (/duplicate-code/.test(raw)) return t("accounting.costCenters.errors.dupCode");
  if (/name-required/.test(raw)) return t("accounting.costCenters.errors.nameRequired");
  if (/has-children/.test(raw)) return t("accounting.costCenters.errors.hasChildren");
  if (/not-found/.test(raw)) return t("accounting.costCenters.errors.notFound");
  return raw || t("accounting.costCenters.errors.generic");
}

export function CostCentersPage() {
  const t = useT();
  const listQuery = useCostCenters("");
  const save = useSaveCostCenter();
  const del = useDeleteCostCenter();

  const [editing, setEditing] = useState<CostCenterInput | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<CostCenter | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const rows = listQuery.data ?? [];
  const parentOptions = rows.filter((r) => r.id !== editing?.id);

  function openNew() {
    setFormError(null);
    setNameError(null);
    setEditing({ ...EMPTY });
  }
  function openEdit(cc: CostCenter) {
    setFormError(null);
    setNameError(null);
    setEditing({
      id: cc.id,
      code: cc.code ?? "",
      nameAr: cc.nameAr ?? "",
      nameEn: cc.nameEn ?? "",
      parentId: cc.parentId || null,
      isActive: cc.isActive,
      notes: cc.notes ?? "",
    });
  }

  function submit() {
    if (!editing) return;
    if (!editing.nameAr.trim()) {
      setNameError(t("accounting.costCenters.errors.nameRequired"));
      return;
    }
    setFormError(null);
    save.mutate(editing, {
      onSuccess: (res) => {
        if (res && res.success === false) {
          setFormError(mapError(t, new Error(res.error)));
          return;
        }
        setEditing(null);
      },
      onError: (e) => setFormError(mapError(t, e)),
    });
  }

  function confirmDelete(reason: string) {
    void reason;
    if (!toDelete) return;
    setDeleteError(null);
    del.mutate(toDelete.id, {
      onSuccess: (res) => {
        if (res && res.success === false) {
          setDeleteError(mapError(t, new Error(res.error)));
          return;
        }
        setToDelete(null);
      },
      onError: (e) => setDeleteError(mapError(t, e)),
    });
  }

  const columns: ColumnDef<CostCenter>[] = [
    { id: "code", header: t("accounting.costCenters.col.code"), accessor: (r) => r.code, sortable: true },
    { id: "nameAr", header: t("accounting.costCenters.col.name"), accessor: (r) => r.nameAr, sortable: true },
    { id: "nameEn", header: t("accounting.costCenters.col.nameEn"), accessor: (r) => r.nameEn, defaultHidden: true },
    { id: "parentName", header: t("accounting.costCenters.col.parent"), accessor: (r) => r.parentName || "—" },
    { id: "branchName", header: t("accounting.costCenters.col.branch"), accessor: (r) => r.branchName || "—" },
    {
      id: "isActive",
      header: t("accounting.costCenters.col.status"),
      accessor: (r) => (r.isActive ? t("common.active") : t("accounting.common.suspended")),
      cell: (r) => (
        <Badge tone={r.isActive ? "success" : "neutral"}>{r.isActive ? t("common.active") : t("accounting.common.suspended")}</Badge>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow={t("accounting.eyebrow")}
        title={t("accounting.costCenters.title")}
        subtitle={t("accounting.costCenters.subtitle")}
        action={
          <Button variant="primary" onClick={openNew}>
            <Plus className="h-4 w-4" /> {t("accounting.costCenters.newCenter")}
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
        searchPlaceholder={t("accounting.costCenters.searchPlaceholder")}
        emptyTitle={t("accounting.costCenters.empty.title")}
        emptyBody={t("accounting.costCenters.empty.body")}
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
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? t("accounting.costCenters.editTitle") : t("accounting.costCenters.newTitle")}
        size="lg"
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
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("accounting.costCenters.field.code")}>
                <Input
                  value={editing.code}
                  onChange={(e) => setEditing({ ...editing, code: e.target.value })}
                  placeholder={t("accounting.costCenters.field.codePlaceholder")}
                />
              </Field>
              <Field label={t("accounting.costCenters.field.nameAr")} required error={nameError ?? undefined}>
                <Input
                  value={editing.nameAr}
                  invalid={!!nameError}
                  onChange={(e) => {
                    setNameError(null);
                    setEditing({ ...editing, nameAr: e.target.value });
                  }}
                />
              </Field>
              <Field label={t("accounting.costCenters.field.nameEn")}>
                <Input
                  value={editing.nameEn}
                  onChange={(e) => setEditing({ ...editing, nameEn: e.target.value })}
                />
              </Field>
              <Field label={t("accounting.costCenters.field.parent")}>
                <Select
                  value={editing.parentId ?? ""}
                  onChange={(e) => setEditing({ ...editing, parentId: e.target.value || null })}
                >
                  <option value="">{t("accounting.costCenters.field.noParent")}</option>
                  {parentOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.code ? `${p.code} — ${p.nameAr}` : p.nameAr}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label={t("accounting.costCenters.field.notes")}>
              <textarea
                className="field min-h-20 w-full resize-y py-2"
                value={editing.notes}
                onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
              />
            </Field>
            <label className="flex items-center gap-3">
              <Toggle
                checked={editing.isActive}
                onChange={(v) => setEditing({ ...editing, isActive: v })}
              />
              <span className="text-sm font-bold text-slate-700">{t("common.active")}</span>
            </label>
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
        title={t("accounting.costCenters.deleteTitle")}
        description={toDelete ? t("accounting.costCenters.deleteDesc", { name: toDelete.nameAr }) : ""}
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
