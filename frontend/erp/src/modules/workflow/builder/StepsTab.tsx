import { useMemo, useState } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  IconButton,
  Input,
  LoadingState,
  Select,
  useToast,
} from "@/shared/ui";
import { Field } from "@/shared/forms";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { useTx } from "@/shared/ui/i18n";
import {
  usePositions,
  useTransactionTypes,
  useWorkflowDefinitions,
  useSaveWorkflowDefinition,
  useDeleteWorkflowDefinition,
  type WorkflowDefinition,
  type WorkflowDefinitionInput,
  type AssignmentStrategy,
} from "../lib/api";
import { FLAG_DEFS, STRATEGY_OPTIONS, type StepFlags } from "./flags";

// خطوات الاعتماد — the ordered step chain of ONE transaction type. Pick a type,
// then add/edit/delete its steps (each step routes to a position; the 6 flags say
// what the holder may do). `isFinal` closes the chain. Single-step CRUD on
// /workflow/workflow-definitions — the bulk replace endpoint stays server-side.
function emptyStep(typeId: string): WorkflowDefinitionInput {
  return {
    transactionTypeId: typeId,
    stepOrder: 1,
    stepName: "",
    positionId: null,
    requireSameBranch: true,
    requireSameDepartment: false,
    assignmentStrategy: "least_busy",
    canApprove: true,
    canReject: true,
    canReturn: true,
    canEdit: false,
    canEditAmount: false,
    isFinal: false,
  };
}

export function StepsTab() {
  const t = useTx();
  const types = useTransactionTypes();
  const positions = usePositions();
  const [typeId, setTypeId] = useState<string>("");
  const defs = useWorkflowDefinitions(typeId || null);
  const save = useSaveWorkflowDefinition();
  const del = useDeleteWorkflowDefinition();
  const { toast } = useToast();

  const [editing, setEditing] = useState<WorkflowDefinitionInput | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<WorkflowDefinition | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const typeOptions = useMemo(
    () => (types.data ?? []).map((type) => ({ value: type.id, label: type.name })),
    [types.data],
  );
  const positionOptions = useMemo(
    () => (positions.data ?? []).map((p) => ({ value: p.id, label: p.name })),
    [positions.data],
  );
  const strategyOptions = useMemo(
    () => STRATEGY_OPTIONS.map((o) => ({ value: o.value, label: t(`workflow.strategy.${o.value}`) })),
    [t],
  );
  const rows = defs.data ?? [];
  const nextOrder = rows.length ? Math.max(...rows.map((r) => Number(r.stepOrder) || 0)) + 1 : 1;

  function openNew() {
    setFormError(null);
    setEditing({ ...emptyStep(typeId), stepOrder: nextOrder });
  }
  function openEdit(d: WorkflowDefinition) {
    setFormError(null);
    setEditing({
      id: d.id,
      transactionTypeId: typeId,
      stepOrder: Number(d.stepOrder) || 1,
      stepName: d.stepName ?? "",
      positionId: d.positionId,
      requireSameBranch: d.requireSameBranch,
      requireSameDepartment: d.requireSameDepartment,
      assignmentStrategy: (d.assignmentStrategy as AssignmentStrategy) || "least_busy",
      canApprove: d.canApprove,
      canReject: d.canReject,
      canReturn: d.canReturn,
      canEdit: d.canEdit,
      canEditAmount: d.canEditAmount,
      isFinal: d.isFinal,
    });
  }

  function submit() {
    if (!editing) return;
    setFormError(null);
    save.mutate(editing, {
      onSuccess: (res) => {
        if (res && res.success === false) {
          setFormError(res.error || t("workflow.steps.saveFailed"));
          return;
        }
        toast({ title: editing.id ? t("workflow.steps.toastUpdated") : t("workflow.steps.toastAdded"), tone: "success" });
        setEditing(null);
      },
      onError: (e) => setFormError(e instanceof Error ? e.message : t("workflow.steps.saveFailed")),
    });
  }

  function confirmDelete() {
    if (!toDelete) return;
    setDeleteError(null);
    del.mutate(toDelete.id, {
      onSuccess: (res) => {
        if (res && res.success === false) {
          setDeleteError(res.error || t("workflow.steps.deleteFailed"));
          return;
        }
        toast({ title: t("workflow.steps.toastDeleted"), tone: "success" });
        setToDelete(null);
      },
      onError: (e) => setDeleteError(e instanceof Error ? e.message : t("workflow.steps.deleteFailed")),
    });
  }

  const columns: ColumnDef<WorkflowDefinition>[] = [
    {
      id: "stepOrder",
      header: "#",
      accessor: (r) => r.stepOrder,
      numeric: true,
      sortable: true,
      width: "3rem",
      cell: (r) => (
        <span dir="ltr" className="tabular-nums font-bold">
          {r.stepOrder}
        </span>
      ),
    },
    { id: "stepName", header: t("workflow.steps.colStep"), accessor: (r) => r.stepName || "—" },
    { id: "position", header: t("workflow.steps.colPosition"), accessor: (r) => r.positionName || "—" },
    {
      id: "flags",
      header: t("workflow.steps.colFlags"),
      accessor: () => "",
      cell: (r) => (
        <div className="flex flex-wrap gap-1">
          {FLAG_DEFS.filter((f) => (r as unknown as StepFlags)[f.key]).map((f) => (
            <Badge key={f.key} tone="teal">
              {t(`workflow.flag.${f.key}`)}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      id: "isFinal",
      header: t("workflow.steps.colFinal"),
      accessor: (r) => (r.isFinal ? t("common.yes") : t("common.no")),
      cell: (r) =>
        r.isFinal ? <Badge tone="success">{t("workflow.term.final")}</Badge> : <span className="text-slate-400">—</span>,
    },
  ];

  return (
    <div className="space-y-4">
      <Field label={t("workflow.steps.typeSelectLabel")} hint={t("workflow.steps.typeSelectHint")}>
        <Select
          value={typeId}
          placeholder={t("workflow.steps.typeSelectPlaceholder")}
          options={typeOptions}
          onChange={(e) => setTypeId(e.target.value)}
          disabled={types.isLoading}
        />
      </Field>

      {types.isError && <ErrorState error={types.error} onRetry={() => types.refetch()} />}

      {!typeId ? (
        <EmptyState
          title={t("workflow.steps.emptyNoTypeTitle")}
          body={t("workflow.steps.emptyNoTypeBody")}
        />
      ) : defs.isLoading ? (
        <LoadingState rows={4} />
      ) : defs.isError ? (
        <ErrorState error={defs.error} onRetry={() => defs.refetch()} />
      ) : (
        <>
          <div className="flex justify-end">
            <Button variant="primary" onClick={openNew}>
              <Plus className="h-4 w-4" /> {t("workflow.steps.newBtn")}
            </Button>
          </div>
          <DataTable
            columns={columns}
            rows={rows}
            getRowId={(r) => r.id}
            tableId="wf-steps"
            emptyTitle={t("workflow.steps.emptyTitle")}
            emptyBody={t("workflow.steps.emptyBody")}
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
        </>
      )}

      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? t("workflow.steps.dialogEdit") : t("workflow.steps.dialogNew")}
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
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("workflow.steps.orderLabel")}>
                <Input
                  type="number"
                  min={1}
                  value={editing.stepOrder}
                  onChange={(e) =>
                    setEditing({ ...editing, stepOrder: Number(e.target.value) || 1 })
                  }
                />
              </Field>
              <Field label={t("workflow.steps.strategyLabel")}>
                <Select
                  value={editing.assignmentStrategy}
                  options={strategyOptions}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      assignmentStrategy: e.target.value as AssignmentStrategy,
                    })
                  }
                />
              </Field>
            </div>
            <Field label={t("workflow.steps.positionLabel")} hint={t("workflow.steps.positionHint")}>
              <Select
                value={editing.positionId ?? ""}
                placeholder={t("workflow.steps.positionPlaceholder")}
                options={positionOptions}
                onChange={(e) => setEditing({ ...editing, positionId: e.target.value || null })}
              />
            </Field>
            <Field label={t("workflow.steps.stepNameLabel")} hint={t("workflow.steps.stepNameHint")}>
              <Input
                value={editing.stepName ?? ""}
                onChange={(e) => setEditing({ ...editing, stepName: e.target.value })}
                placeholder={t("workflow.steps.stepNamePlaceholder")}
              />
            </Field>
            <div>
              <div className="mb-2 text-xs font-bold text-slate-600">{t("workflow.steps.permissionsHeading")}</div>
              <div className="grid grid-cols-2 gap-2">
                {FLAG_DEFS.map((f) => (
                  <Checkbox
                    key={f.key}
                    label={t(`workflow.flag.${f.key}`)}
                    checked={editing[f.key]}
                    onChange={(e) => setEditing({ ...editing, [f.key]: e.target.checked })}
                  />
                ))}
                <Checkbox
                  label={t("workflow.steps.finalCheckbox")}
                  checked={editing.isFinal}
                  onChange={(e) => setEditing({ ...editing, isFinal: e.target.checked })}
                />
              </div>
            </div>
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
        title={t("workflow.steps.confirmDeleteTitle")}
        description={toDelete ? t("workflow.steps.confirmDeleteDesc", { name: toDelete.stepName || t("workflow.steps.stepFallback") }) : ""}
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
