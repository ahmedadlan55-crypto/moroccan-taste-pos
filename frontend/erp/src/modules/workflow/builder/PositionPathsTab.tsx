import { useEffect, useMemo, useState } from "react";
import { Plus, Pencil, Trash2, X } from "lucide-react";
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
  usePositionWorkflowsSummary,
  usePositionWorkflowPaths,
  usePositionWorkflow,
  useSavePositionWorkflow,
  useDeletePositionWorkflow,
  type PositionWorkflowPath,
  type PositionWorkflowBulkStep,
  type AssignmentStrategy,
} from "../lib/api";
import { DEFAULT_FLAGS, FLAG_DEFS, STRATEGY_OPTIONS } from "./flags";

// مسارات المناصب — per-initiator approval chains. Choose the position that STARTS
// a transaction, then define one or more named paths (path_key) for it. Each path
// is a full step chain saved atomically via the bulk replace endpoint.
type EditorStep = PositionWorkflowBulkStep;

function newStep(): EditorStep {
  return {
    positionId: null,
    stepName: "",
    assignmentStrategy: "least_busy",
    isFinal: false,
    ...DEFAULT_FLAGS,
  };
}

export function PositionPathsTab() {
  const t = useTx();
  const summary = usePositionWorkflowsSummary();
  const positions = usePositions();
  const [initiatorId, setInitiatorId] = useState<string>("");
  const paths = usePositionWorkflowPaths(initiatorId || null);
  const del = useDeletePositionWorkflow();
  const { toast } = useToast();

  const [editor, setEditor] = useState<PositionWorkflowPath | "new" | null>(null);
  const [toDelete, setToDelete] = useState<PositionWorkflowPath | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const initiatorOptions = useMemo(
    () =>
      (summary.data ?? []).map((p) => ({
        value: p.id,
        label: p.stepCount ? t("workflow.paths.initiatorOption", { name: p.name, count: p.stepCount }) : p.name,
      })),
    [summary.data, t],
  );
  const positionOptions = useMemo(
    () => (positions.data ?? []).map((p) => ({ value: p.id, label: p.name })),
    [positions.data],
  );

  function confirmDelete() {
    if (!toDelete || !initiatorId) return;
    setDeleteError(null);
    del.mutate(
      { initiatorPositionId: initiatorId, pathKey: toDelete.pathKey },
      {
        onSuccess: (res) => {
          if (res && res.success === false) {
            setDeleteError(res.error || t("workflow.paths.deleteFailed"));
            return;
          }
          toast({ title: t("workflow.paths.toastDeleted"), tone: "success" });
          setToDelete(null);
        },
        onError: (e) => setDeleteError(e instanceof Error ? e.message : t("workflow.paths.deleteFailed")),
      },
    );
  }

  const columns: ColumnDef<PositionWorkflowPath>[] = [
    {
      id: "pathName",
      header: t("workflow.paths.colPath"),
      accessor: (r) => r.pathName,
      cell: (r) => (
        <div className="min-w-0">
          <div className="truncate font-bold text-slate-800">{r.pathName}</div>
          <div dir="ltr" className="truncate text-[11px] text-slate-400">
            {r.pathKey}
          </div>
        </div>
      ),
    },
    {
      id: "stepCount",
      header: t("workflow.paths.colSteps"),
      accessor: (r) => r.stepCount,
      numeric: true,
      sortable: true,
      cell: (r) => (
        <Badge tone="teal">
          <span dir="ltr" className="tabular-nums">
            {r.stepCount}
          </span>
        </Badge>
      ),
    },
    { id: "description", header: t("workflow.paths.colDescription"), accessor: (r) => r.description || "—" },
  ];

  return (
    <div className="space-y-4">
      <Field label={t("workflow.paths.initiatorLabel")} hint={t("workflow.paths.initiatorHint")}>
        <Select
          value={initiatorId}
          placeholder={t("workflow.paths.initiatorPlaceholder")}
          options={initiatorOptions}
          onChange={(e) => setInitiatorId(e.target.value)}
          disabled={summary.isLoading}
        />
      </Field>

      {summary.isError && <ErrorState error={summary.error} onRetry={() => summary.refetch()} />}

      {!initiatorId ? (
        <EmptyState
          title={t("workflow.paths.emptyNoInitiatorTitle")}
          body={t("workflow.paths.emptyNoInitiatorBody")}
        />
      ) : paths.isLoading ? (
        <LoadingState rows={4} />
      ) : paths.isError ? (
        <ErrorState error={paths.error} onRetry={() => paths.refetch()} />
      ) : (
        <>
          <div className="flex justify-end">
            <Button variant="primary" onClick={() => setEditor("new")}>
              <Plus className="h-4 w-4" /> {t("workflow.paths.newBtn")}
            </Button>
          </div>
          <DataTable
            columns={columns}
            rows={paths.data ?? []}
            getRowId={(r) => r.pathKey}
            tableId="wf-position-paths"
            emptyTitle={t("workflow.paths.emptyTitle")}
            emptyBody={t("workflow.paths.emptyBody")}
            rowActions={(r) => (
              <div className="flex items-center gap-1">
                <IconButton aria-label={t("common.edit")} size="sm" onClick={() => setEditor(r)}>
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

      {editor && initiatorId && (
        <PathEditor
          initiatorPositionId={initiatorId}
          existing={editor === "new" ? null : editor}
          positionOptions={positionOptions}
          onClose={() => setEditor(null)}
        />
      )}

      <ConfirmDialog
        open={!!toDelete}
        title={t("workflow.paths.confirmDeleteTitle")}
        description={toDelete ? t("workflow.paths.confirmDeleteDesc", { name: toDelete.pathName }) : ""}
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

// ── Chain editor (create OR edit one path) ───────────────────────────────────
function PathEditor({
  initiatorPositionId,
  existing,
  positionOptions,
  onClose,
}: {
  initiatorPositionId: string;
  existing: PositionWorkflowPath | null;
  positionOptions: { value: string; label: string }[];
  onClose: () => void;
}) {
  const t = useTx();
  const isEdit = !!existing;
  const loaded = usePositionWorkflow(initiatorPositionId, existing?.pathKey ?? "default", isEdit);
  const save = useSavePositionWorkflow();
  const { toast } = useToast();

  const [pathKey, setPathKey] = useState(existing?.pathKey ?? "");
  const [pathName, setPathName] = useState(existing?.pathName ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [steps, setSteps] = useState<EditorStep[]>(existing ? [] : [newStep()]);
  const [error, setError] = useState<string | null>(null);
  const [seeded, setSeeded] = useState(!isEdit);
  const strategyOptions = useMemo(
    () => STRATEGY_OPTIONS.map((o) => ({ value: o.value, label: t(`workflow.strategy.${o.value}`) })),
    [t],
  );

  // Seed the step list from the loaded chain exactly once when editing.
  useEffect(() => {
    if (seeded || !isEdit || !loaded.data) return;
    setSteps(
      loaded.data
        .slice()
        .sort((a, b) => a.stepOrder - b.stepOrder)
        .map((s) => ({
          positionId: s.positionId,
          stepName: s.stepName || "",
          assignmentStrategy: (s.assignmentStrategy as AssignmentStrategy) || "least_busy",
          isFinal: s.isFinal,
          canApprove: s.canApprove,
          canReject: s.canReject,
          canReturn: s.canReturn,
          canEdit: s.canEdit,
          canEditAmount: s.canEditAmount,
          requireSameBranch: s.requireSameBranch,
          requireSameDepartment: s.requireSameDepartment,
        })),
    );
    setSeeded(true);
  }, [seeded, isEdit, loaded.data]);

  function patchStep(i: number, patch: Partial<EditorStep>) {
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }
  function removeStep(i: number) {
    setSteps((prev) => prev.filter((_, idx) => idx !== i));
  }

  function submit() {
    setError(null);
    const key = pathKey.trim();
    if (!isEdit && !key) {
      setError(t("workflow.paths.keyRequired"));
      return;
    }
    if (!steps.length) {
      setError(t("workflow.paths.oneStepRequired"));
      return;
    }
    if (steps.some((s) => !s.positionId)) {
      setError(t("workflow.paths.stepPositionRequired"));
      return;
    }
    save.mutate(
      {
        initiatorPositionId,
        pathKey: key || existing?.pathKey || "default",
        pathName: pathName.trim() || t("workflow.paths.namePlaceholder"),
        description: description.trim(),
        steps: steps.map((s, i) => ({ ...s, stepOrder: i + 1 })),
      },
      {
        onSuccess: (res) => {
          if (res && res.success === false) {
            setError(res.error || t("workflow.paths.saveFailed"));
            return;
          }
          toast({ title: isEdit ? t("workflow.paths.toastUpdated") : t("workflow.paths.toastCreated"), tone: "success" });
          onClose();
        },
        onError: (e) => setError(e instanceof Error ? e.message : t("workflow.paths.saveFailed")),
      },
    );
  }

  const busy = isEdit && loaded.isLoading;

  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title={isEdit ? t("workflow.paths.editorEditTitle", { name: existing?.pathName ?? "" }) : t("workflow.paths.editorNewTitle")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={submit} loading={save.isPending} disabled={busy}>
            {t("workflow.paths.saveBtn")}
          </Button>
        </>
      }
    >
      {busy ? (
        <LoadingState rows={4} />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t("workflow.paths.keyLabel")} hint={t("workflow.paths.keyHint")}>
              <Input
                dir="ltr"
                value={pathKey}
                disabled={isEdit}
                onChange={(e) => setPathKey(e.target.value)}
                placeholder="default"
              />
            </Field>
            <Field label={t("workflow.paths.nameLabel")}>
              <Input
                value={pathName}
                onChange={(e) => setPathName(e.target.value)}
                placeholder={t("workflow.paths.namePlaceholder")}
              />
            </Field>
          </div>
          <Field label={t("workflow.paths.descLabel")}>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("workflow.paths.descPlaceholder")}
            />
          </Field>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-xs font-bold text-slate-600">{t("workflow.paths.stepsHeading")}</div>
              <Button variant="secondary" size="sm" onClick={() => setSteps((p) => [...p, newStep()])}>
                <Plus className="h-4 w-4" /> {t("workflow.paths.addStep")}
              </Button>
            </div>

            {steps.length === 0 && (
              <div className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-xs font-semibold text-slate-400">
                {t("workflow.paths.noSteps")}
              </div>
            )}

            {steps.map((s, i) => (
              <div key={i} className="rounded-xl border border-slate-200 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="chip border-slate-200 bg-slate-50 text-slate-600">
                    {t("workflow.paths.stepLabel")} <span dir="ltr">{i + 1}</span>
                  </span>
                  <IconButton
                    aria-label={t("workflow.paths.removeStepAria")}
                    size="sm"
                    variant="danger"
                    onClick={() => removeStep(i)}
                  >
                    <X className="h-4 w-4" />
                  </IconButton>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Field label={t("workflow.paths.stepPositionLabel")}>
                    <Select
                      value={s.positionId ?? ""}
                      placeholder={t("workflow.paths.stepPositionPlaceholder")}
                      options={positionOptions}
                      onChange={(e) => patchStep(i, { positionId: e.target.value || null })}
                    />
                  </Field>
                  <Field label={t("workflow.paths.stepAssignLabel")}>
                    <Select
                      value={s.assignmentStrategy}
                      options={strategyOptions}
                      onChange={(e) =>
                        patchStep(i, {
                          assignmentStrategy: e.target.value as AssignmentStrategy,
                        })
                      }
                    />
                  </Field>
                </div>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {FLAG_DEFS.map((f) => (
                    <Checkbox
                      key={f.key}
                      label={t(`workflow.flag.${f.key}`)}
                      checked={s[f.key]}
                      onChange={(e) => patchStep(i, { [f.key]: e.target.checked })}
                    />
                  ))}
                  <Checkbox
                    label={t("workflow.paths.finalCheckbox")}
                    checked={s.isFinal}
                    onChange={(e) => patchStep(i, { isFinal: e.target.checked })}
                  />
                </div>
              </div>
            ))}
          </div>

          {error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
              {error}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
