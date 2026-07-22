import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Braces,
  FlaskConical,
  GitBranch,
  GripVertical,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
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
import type { TFunction } from "@/i18n";
import {
  useDeleteWorkflowRoute,
  usePositions,
  useSaveWorkflowRoute,
  useTestWorkflowRoute,
  useTransactionTypes,
  useUpdateWorkflowRoute,
  useWorkflowRoutes,
  type RouteTestStep,
  type WorkflowRoute,
} from "../lib/api";

type EditorMode = "visual" | "advanced";
type Operator = ">" | ">=" | "<" | "<=" | "==" | "!=";

interface VisualStep {
  id: string;
  name: string;
  requiredPositionId: string;
  isTerminal: boolean;
  conditionField: string;
  conditionOperator: Operator;
  conditionValue: string;
  conditionNextId: string;
}

interface RouteForm {
  id?: string;
  routeName: string;
  transactionTypeId: string;
  initiatorPositionId: string;
  isDefault: boolean;
  mode: EditorMode;
  visualSteps: VisualStep[];
  conditionsText: string;
  stepsText: string;
}

// The condition FIELD names + OPERATOR symbols are DSL data (persisted verbatim);
// only their human labels are localized here.
function fieldOptions(t: TFunction) {
  return [
    { value: "amount", label: t("workflow.routes.field.amount") },
    { value: "branchId", label: t("workflow.routes.field.branch") },
    { value: "deptId", label: t("workflow.routes.field.dept") },
    { value: "importance", label: t("workflow.routes.field.importance") },
  ];
}

const OPERATOR_KEY: Record<Operator, string> = {
  ">": "gt",
  ">=": "gte",
  "<": "lt",
  "<=": "lte",
  "==": "eq",
  "!=": "neq",
};

function operatorOptions(t: TFunction) {
  return (Object.keys(OPERATOR_KEY) as Operator[]).map((value) => ({
    value,
    label: t(`workflow.routes.operator.${OPERATOR_KEY[value]}`),
  }));
}

function newStep(index: number, t: TFunction): VisualStep {
  return {
    id: `s${index + 1}`,
    name: index === 0 ? t("workflow.routes.firstStepName") : t("workflow.routes.stepNameDefault", { n: index + 1 }),
    requiredPositionId: "",
    isTerminal: false,
    conditionField: "",
    conditionOperator: ">",
    conditionValue: "",
    conditionNextId: "",
  };
}

function parseJson(text: string, t: TFunction): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : t("workflow.routes.invalidJson") };
  }
}

function parseCondition(expression: unknown) {
  if (typeof expression !== "string") return null;
  const match = expression.match(/^\s*([a-zA-Z_]\w*)\s*(<=|>=|<|>|==|!=)\s*(.+?)\s*$/);
  return match ? { field: match[1], operator: match[2] as Operator, value: match[3].replace(/^["']|["']$/g, "") } : null;
}

function toVisualSteps(raw: unknown, t: TFunction): VisualStep[] {
  if (!Array.isArray(raw) || raw.length === 0)
    return [newStep(0, t), { ...newStep(1, t), name: t("workflow.routes.finalStepName"), isTerminal: true }];
  return raw.map((value, index) => {
    const step = (value ?? {}) as Record<string, unknown>;
    const branch = Array.isArray(step.branches) ? (step.branches[0] as Record<string, unknown> | undefined) : undefined;
    const condition = parseCondition(branch?.if);
    return {
      id: String(step.id || `s${index + 1}`),
      name: String(step.name || t("workflow.routes.stepNameDefault", { n: index + 1 })),
      requiredPositionId: String(step.required_position_id || ""),
      isTerminal: Boolean(step.is_terminal),
      conditionField: condition?.field || "",
      conditionOperator: condition?.operator || ">",
      conditionValue: condition?.value || "",
      conditionNextId: String(branch?.next || ""),
    };
  });
}

function toDslSteps(steps: VisualStep[]) {
  return steps.map((step, index) => {
    const nextStep = steps[index + 1];
    const conditionComplete = step.conditionField && step.conditionValue && step.conditionNextId;
    return {
      id: step.id,
      name: step.name.trim(),
      required_position_id: step.requiredPositionId || undefined,
      is_terminal: step.isTerminal || (!nextStep && !conditionComplete),
      branches: conditionComplete
        ? [{
            if: `${step.conditionField} ${step.conditionOperator} ${JSON.stringify(step.conditionValue)}`,
            next: step.conditionNextId,
          }]
        : undefined,
      next: nextStep ? { default: nextStep.id } : undefined,
    };
  });
}

export function RoutesDslTab() {
  const t = useTx();
  const list = useWorkflowRoutes();
  const types = useTransactionTypes();
  const positions = usePositions();
  const save = useSaveWorkflowRoute();
  const update = useUpdateWorkflowRoute();
  const del = useDeleteWorkflowRoute();
  const { toast } = useToast();
  const [form, setForm] = useState<RouteForm | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<WorkflowRoute | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [testing, setTesting] = useState<WorkflowRoute | null>(null);

  const typeName = useMemo(() => {
    const map = new Map((types.data ?? []).map((type) => [type.id, type.name]));
    return (id: string | null) => (id ? map.get(id) || id : t("workflow.routes.allTypes"));
  }, [types.data, t]);
  const positionName = useMemo(() => {
    const map = new Map((positions.data ?? []).map((position) => [position.id, position.name]));
    return (id: string | null) => (id ? map.get(id) || id : t("workflow.routes.allPositions"));
  }, [positions.data, t]);
  const typeOptions = useMemo(() => (types.data ?? []).map((type) => ({ value: type.id, label: type.name })), [types.data]);
  const positionOptions = useMemo(() => (positions.data ?? []).map((position) => ({ value: position.id, label: position.name })), [positions.data]);

  function openNew() {
    const visualSteps = [newStep(0, t), { ...newStep(1, t), name: t("workflow.routes.finalStepName"), isTerminal: true }];
    setFormError(null);
    setForm({
      routeName: "",
      transactionTypeId: "",
      initiatorPositionId: "",
      isDefault: false,
      mode: "visual",
      visualSteps,
      conditionsText: "{}",
      stepsText: JSON.stringify(toDslSteps(visualSteps), null, 2),
    });
  }

  function openEdit(route: WorkflowRoute) {
    setFormError(null);
    setForm({
      id: route.id,
      routeName: route.routeName,
      transactionTypeId: route.transactionTypeId ?? "",
      initiatorPositionId: route.initiatorPositionId ?? "",
      isDefault: route.isDefault,
      mode: "visual",
      visualSteps: toVisualSteps(route.steps, t),
      conditionsText: JSON.stringify(route.conditions ?? {}, null, 2),
      stepsText: JSON.stringify(route.steps ?? [], null, 2),
    });
  }

  function setEditorMode(mode: EditorMode) {
    if (!form || form.mode === mode) return;
    if (mode === "advanced") {
      setForm({ ...form, mode, stepsText: JSON.stringify(toDslSteps(form.visualSteps), null, 2) });
      setFormError(null);
      return;
    }
    const parsed = parseJson(form.stepsText || "[]", t);
    if (!parsed.ok || !Array.isArray(parsed.value) || parsed.value.length === 0) {
      setFormError(t("workflow.routes.visualRevertError"));
      return;
    }
    setForm({ ...form, mode, visualSteps: toVisualSteps(parsed.value, t) });
    setFormError(null);
  }

  function updateStep(index: number, patch: Partial<VisualStep>) {
    if (!form) return;
    setForm({ ...form, visualSteps: form.visualSteps.map((step, stepIndex) => stepIndex === index ? { ...step, ...patch } : step) });
  }

  function moveStep(index: number, direction: -1 | 1) {
    if (!form) return;
    const target = index + direction;
    if (target < 0 || target >= form.visualSteps.length) return;
    const next = [...form.visualSteps];
    [next[index], next[target]] = [next[target], next[index]];
    setForm({ ...form, visualSteps: next });
  }

  function removeStep(index: number) {
    if (!form || form.visualSteps.length <= 1) return;
    setForm({ ...form, visualSteps: form.visualSteps.filter((_, stepIndex) => stepIndex !== index) });
  }

  function submit() {
    if (!form) return;
    if (!form.routeName.trim()) {
      setFormError(t("workflow.routes.routeNameRequired"));
      return;
    }
    let conditions: unknown = {};
    let steps: unknown;
    if (form.mode === "advanced") {
      const parsedConditions = parseJson(form.conditionsText || "{}", t);
      if (!parsedConditions.ok) {
        setFormError(t("workflow.routes.advancedError", { msg: parsedConditions.error }));
        return;
      }
      const parsedSteps = parseJson(form.stepsText || "[]", t);
      if (!parsedSteps.ok || !Array.isArray(parsedSteps.value) || parsedSteps.value.length === 0) {
        setFormError(parsedSteps.ok ? t("workflow.routes.stepsArrayError") : t("workflow.routes.stepsJsonError", { msg: parsedSteps.error }));
        return;
      }
      conditions = parsedConditions.value;
      steps = parsedSteps.value;
    } else {
      const duplicateIds = new Set<string>();
      const ids = new Set<string>();
      for (const [index, step] of form.visualSteps.entries()) {
        if (!step.id.trim() || !step.name.trim()) {
          setFormError(t("workflow.routes.stepIncomplete", { n: index + 1 }));
          return;
        }
        if (ids.has(step.id)) duplicateIds.add(step.id);
        ids.add(step.id);
      }
      if (duplicateIds.size) {
        setFormError(t("workflow.routes.duplicateIds", { ids: Array.from(duplicateIds).join(", ") }));
        return;
      }
      const invalidTarget = form.visualSteps.find((step) => step.conditionNextId && !ids.has(step.conditionNextId));
      if (invalidTarget) {
        setFormError(t("workflow.routes.invalidTarget", { name: invalidTarget.name }));
        return;
      }
      steps = toDslSteps(form.visualSteps);
    }

    const onSuccess = (label: string) => (result: { success?: boolean; error?: string } | undefined) => {
      if (result?.success === false) {
        setFormError(result.error || t("workflow.routes.saveFailed"));
        return;
      }
      toast({ title: label, tone: "success" });
      setForm(null);
    };
    const onError = (error: unknown) => setFormError(error instanceof Error ? error.message : t("workflow.routes.saveFailed"));
    if (form.id) {
      update.mutate(
        { id: form.id, routeName: form.routeName.trim(), isDefault: form.isDefault, conditions, steps },
        { onSuccess: onSuccess(t("workflow.routes.toastUpdated")), onError },
      );
    } else {
      save.mutate(
        {
          transactionTypeId: form.transactionTypeId || null,
          initiatorPositionId: form.initiatorPositionId || null,
          routeName: form.routeName.trim(),
          isDefault: form.isDefault,
          conditions,
          steps,
        },
        { onSuccess: onSuccess(t("workflow.routes.toastCreated")), onError },
      );
    }
  }

  function confirmDelete() {
    if (!toDelete) return;
    setDeleteError(null);
    del.mutate(toDelete.id, {
      onSuccess: (result) => {
        if (result?.success === false) {
          setDeleteError(result.error || t("workflow.routes.deleteFailed"));
          return;
        }
        toast({ title: t("workflow.routes.toastDeleted"), tone: "success" });
        setToDelete(null);
      },
      onError: (error) => setDeleteError(error instanceof Error ? error.message : t("workflow.routes.deleteFailed")),
    });
  }

  const columns: ColumnDef<WorkflowRoute>[] = [
    {
      id: "routeName",
      header: t("workflow.routes.colRoute"),
      accessor: (route) => route.routeName,
      cell: (route) => (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-bold text-slate-800">{route.routeName}</span>
          {route.isDefault && <Badge tone="info">{t("workflow.routes.badgeDefault")}</Badge>}
          {!route.isActive && <Badge tone="neutral">{t("workflow.term.stopped")}</Badge>}
        </div>
      ),
    },
    { id: "type", header: t("workflow.routes.colType"), accessor: (route) => typeName(route.transactionTypeId) },
    { id: "position", header: t("workflow.routes.colPosition"), accessor: (route) => positionName(route.initiatorPositionId) },
    { id: "steps", header: t("workflow.routes.colSteps"), accessor: (route) => Array.isArray(route.steps) ? route.steps.length : 0, numeric: true },
  ];

  if (list.isLoading) return <LoadingState rows={4} />;
  if (list.isError) return <ErrorState error={list.error} onRetry={() => list.refetch()} body={t("workflow.routes.loadError")} />;
  const saving = save.isPending || update.isPending;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-extrabold text-slate-900">
            <GitBranch className="h-4 w-4 text-teal-600" aria-hidden="true" /> {t("workflow.routes.headerTitle")}
          </div>
          <p className="mt-1 text-xs font-medium text-slate-500">{t("workflow.routes.headerSub")}</p>
        </div>
        <Button variant="primary" onClick={openNew} className="w-full sm:w-auto">
          <Plus className="h-4 w-4" aria-hidden="true" /> {t("workflow.routes.newBtn")}
        </Button>
      </div>

      <DataTable
        columns={columns}
        rows={list.data ?? []}
        getRowId={(route) => route.id}
        searchable
        searchPlaceholder={t("workflow.routes.searchPlaceholder")}
        tableId="wf-routes"
        emptyTitle={t("workflow.routes.emptyTitle")}
        emptyBody={t("workflow.routes.emptyBody")}
        rowActions={(route) => (
          <div className="flex flex-wrap items-center gap-1">
            <Button variant="ghost" size="sm" aria-label={t("workflow.routes.test")} onClick={() => setTesting(route)}>
              <FlaskConical className="h-4 w-4" aria-hidden="true" /> {t("workflow.routes.test")}
            </Button>
            <Button variant="ghost" size="sm" aria-label={t("common.edit")} onClick={() => openEdit(route)}>
              <Pencil className="h-4 w-4" aria-hidden="true" /> {t("common.edit")}
            </Button>
            <IconButton aria-label={t("common.delete")} size="sm" variant="danger" onClick={() => setToDelete(route)}>
              <Trash2 className="h-4 w-4" />
            </IconButton>
          </div>
        )}
      />

      <Dialog
        open={!!form}
        onClose={() => setForm(null)}
        size="xl"
        title={form?.id ? t("workflow.routes.dialogEdit") : t("workflow.routes.dialogNew")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setForm(null)} disabled={saving}>{t("common.cancel")}</Button>
            <Button variant="primary" onClick={submit} loading={saving}>{t("common.save")}</Button>
          </>
        }
      >
        {form && (
          <div className="space-y-5">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label={t("workflow.routes.routeNameLabel")} required className="md:col-span-2">
                <Input value={form.routeName} onChange={(event) => setForm({ ...form, routeName: event.target.value })} placeholder={t("workflow.routes.routeNamePlaceholder")} />
              </Field>
              <Field label={t("workflow.routes.typeLabel")} hint={form.id ? t("workflow.routes.hintLocked") : t("workflow.routes.typeHintNew")}>
                <Select value={form.transactionTypeId} placeholder={t("workflow.routes.allTypes")} options={typeOptions} disabled={!!form.id} onChange={(event) => setForm({ ...form, transactionTypeId: event.target.value })} />
              </Field>
              <Field label={t("workflow.routes.positionLabel")} hint={form.id ? t("workflow.routes.hintLocked") : t("workflow.routes.positionHintNew")}>
                <Select value={form.initiatorPositionId} placeholder={t("workflow.routes.allPositions")} options={positionOptions} disabled={!!form.id} onChange={(event) => setForm({ ...form, initiatorPositionId: event.target.value })} />
              </Field>
            </div>
            <Checkbox label={t("workflow.routes.defaultCheckbox")} checked={form.isDefault} onChange={(event) => setForm({ ...form, isDefault: event.target.checked })} />

            <div className="flex flex-wrap items-center justify-between gap-2 border-y border-slate-100 py-3">
              <div>
                <div className="text-sm font-extrabold text-slate-800">{t("workflow.routes.designTitle")}</div>
                <div className="mt-0.5 text-xs font-medium text-slate-500">{t("workflow.routes.designSub")}</div>
              </div>
              <div className="flex rounded-xl border border-slate-200 bg-slate-50 p-1" role="group" aria-label={t("workflow.routes.modeAria")}>
                <Button variant={form.mode === "visual" ? "subtle" : "ghost"} size="sm" onClick={() => setEditorMode("visual")}>
                  <GitBranch className="h-4 w-4" aria-hidden="true" /> {t("workflow.routes.modeVisual")}
                </Button>
                <Button variant={form.mode === "advanced" ? "subtle" : "ghost"} size="sm" onClick={() => setEditorMode("advanced")}>
                  <Braces className="h-4 w-4" aria-hidden="true" /> {t("workflow.routes.modeAdvanced")}
                </Button>
              </div>
            </div>

            {form.mode === "visual" ? (
              <VisualStepsEditor
                steps={form.visualSteps}
                positions={positionOptions}
                onUpdate={updateStep}
                onMove={moveStep}
                onRemove={removeStep}
                onAdd={() => setForm({ ...form, visualSteps: [...form.visualSteps, newStep(form.visualSteps.length, t)] })}
              />
            ) : (
              <div className="space-y-4 rounded-xl border border-amber-200 bg-amber-50/40 p-4">
                <div className="flex items-start gap-2 text-xs font-bold leading-5 text-amber-800">
                  <Braces className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  {t("workflow.routes.advancedWarn")}
                </div>
                <Field label={t("workflow.routes.generalJsonLabel")}>
                  <textarea dir="ltr" rows={4} className="field py-2 font-mono text-xs" value={form.conditionsText} onChange={(event) => setForm({ ...form, conditionsText: event.target.value })} />
                </Field>
                <Field label={t("workflow.routes.stepsJsonLabel")}>
                  <textarea dir="ltr" rows={12} className="field py-2 font-mono text-xs" value={form.stepsText} onChange={(event) => setForm({ ...form, stepsText: event.target.value })} />
                </Field>
              </div>
            )}

            {formError && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{formError}</div>}
          </div>
        )}
      </Dialog>

      {testing && <RouteTester route={testing} onClose={() => setTesting(null)} />}
      <ConfirmDialog
        open={!!toDelete}
        title={t("workflow.routes.confirmDeleteTitle")}
        description={toDelete ? t("workflow.routes.confirmDeleteDesc", { name: toDelete.routeName }) : ""}
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

function VisualStepsEditor({
  steps,
  positions,
  onUpdate,
  onMove,
  onRemove,
  onAdd,
}: {
  steps: VisualStep[];
  positions: Array<{ value: string; label: string }>;
  onUpdate: (index: number, patch: Partial<VisualStep>) => void;
  onMove: (index: number, direction: -1 | 1) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
}) {
  const t = useTx();
  const fields = useMemo(() => fieldOptions(t), [t]);
  const operators = useMemo(() => operatorOptions(t), [t]);
  const targets = steps.map((step) => ({ value: step.id, label: step.name || step.id }));
  return (
    <div className="space-y-3">
      <ol className="space-y-3">
        {steps.map((step, index) => (
          <li key={`${step.id}-${index}`} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <GripVertical className="h-5 w-5 text-slate-300" aria-hidden="true" />
                <span className="grid h-8 w-8 place-items-center rounded-full bg-teal-50 text-xs font-extrabold text-teal-700">{index + 1}</span>
                <span className="text-sm font-extrabold text-slate-800">{step.name || t("workflow.routes.stepNameDefault", { n: index + 1 })}</span>
                {step.isTerminal && <Badge tone="success">{t("workflow.term.final")}</Badge>}
              </div>
              <div className="flex items-center gap-1">
                <IconButton aria-label={t("workflow.routes.moveUpAria")} size="sm" disabled={index === 0} onClick={() => onMove(index, -1)}><ArrowUp className="h-4 w-4" /></IconButton>
                <IconButton aria-label={t("workflow.routes.moveDownAria")} size="sm" disabled={index === steps.length - 1} onClick={() => onMove(index, 1)}><ArrowDown className="h-4 w-4" /></IconButton>
                <IconButton aria-label={t("workflow.routes.removeStepAria")} size="sm" variant="danger" disabled={steps.length <= 1} onClick={() => onRemove(index)}><Trash2 className="h-4 w-4" /></IconButton>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <Field label={t("workflow.routes.stepNameLabel")} required>
                <Input value={step.name} onChange={(event) => onUpdate(index, { name: event.target.value })} placeholder={t("workflow.routes.stepNamePlaceholder")} />
              </Field>
              <Field label={t("workflow.routes.idLabel")} required hint={t("workflow.routes.idHint")}>
                <Input dir="ltr" value={step.id} onChange={(event) => onUpdate(index, { id: event.target.value.replace(/\s+/g, "-") })} />
              </Field>
              <Field label={t("workflow.routes.responsiblePositionLabel")}>
                <Select value={step.requiredPositionId} placeholder={t("workflow.routes.autoAssign")} options={positions} onChange={(event) => onUpdate(index, { requiredPositionId: event.target.value })} />
              </Field>
            </div>
            <div className="mt-3">
              <Checkbox label={t("workflow.routes.lastStepCheckbox")} checked={step.isTerminal} onChange={(event) => onUpdate(index, { isTerminal: event.target.checked })} />
            </div>
            {!step.isTerminal && (
              <details className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                <summary className="cursor-pointer text-xs font-extrabold text-slate-700">{t("workflow.routes.conditionalSummary")}</summary>
                <div className="mt-3 grid gap-3 md:grid-cols-4">
                  <Field label={t("workflow.routes.fieldLabel")}>
                    <Select value={step.conditionField} placeholder={t("workflow.routes.fieldPlaceholderNone")} options={fields} onChange={(event) => onUpdate(index, { conditionField: event.target.value })} />
                  </Field>
                  <Field label={t("workflow.routes.operatorLabel")}>
                    <Select value={step.conditionOperator} options={operators} onChange={(event) => onUpdate(index, { conditionOperator: event.target.value as Operator })} />
                  </Field>
                  <Field label={t("workflow.routes.valueLabel")}>
                    <Input value={step.conditionValue} onChange={(event) => onUpdate(index, { conditionValue: event.target.value })} placeholder="50000" />
                  </Field>
                  <Field label={t("workflow.routes.goToLabel")}>
                    <Select value={step.conditionNextId} placeholder={t("workflow.routes.goToPlaceholder")} options={targets.filter((target) => target.value !== step.id)} onChange={(event) => onUpdate(index, { conditionNextId: event.target.value })} />
                  </Field>
                </div>
              </details>
            )}
          </li>
        ))}
      </ol>
      <Button variant="secondary" onClick={onAdd} className="w-full border-dashed">
        <Plus className="h-4 w-4" aria-hidden="true" /> {t("workflow.routes.addStepToPath")}
      </Button>
    </div>
  );
}

function RouteTester({ route, onClose }: { route: WorkflowRoute; onClose: () => void }) {
  const t = useTx();
  const test = useTestWorkflowRoute();
  const [amount, setAmount] = useState("60000");
  const [branchId, setBranchId] = useState("");
  const [importance, setImportance] = useState("medium");
  const [error, setError] = useState<string | null>(null);
  const [path, setPath] = useState<RouteTestStep[] | null>(null);
  // Flow separator points along the reading direction (start → end). Direction is
  // read from the document (kept in sync by the i18n provider) rather than
  // useLang() so the tab still renders in provider-less unit tests.
  const rtl = typeof document !== "undefined" && document.documentElement.dir === "rtl";
  const FlowIcon = rtl ? ArrowLeft : ArrowRight;

  function run() {
    setError(null);
    setPath(null);
    test.mutate(
      { id: route.id, txn: { amount: Number(amount || 0), branchId, importance } },
      {
        onSuccess: (result) => {
          if (!result || result.success === false) {
            setError(result?.error || t("workflow.routes.testFailed"));
            return;
          }
          setPath(result.path ?? []);
        },
        onError: (reason) => setError(reason instanceof Error ? reason.message : t("workflow.routes.testFailed")),
      },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={t("workflow.routes.testerTitle", { name: route.routeName })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t("common.close")}</Button>
          <Button variant="primary" onClick={run} loading={test.isPending}><FlaskConical className="h-4 w-4" /> {t("workflow.routes.testDryRun")}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t("workflow.routes.field.amount")}><Input type="number" dir="ltr" value={amount} onChange={(event) => setAmount(event.target.value)} /></Field>
          <Field label={t("workflow.routes.field.branch")}><Input dir="ltr" value={branchId} onChange={(event) => setBranchId(event.target.value)} placeholder="BR-001" /></Field>
          <Field label={t("workflow.routes.field.importance")}>
            <Select value={importance} onChange={(event) => setImportance(event.target.value)} options={[
              { value: "low", label: t("workflow.importance.low") },
              { value: "medium", label: t("workflow.importance.medium") },
              { value: "high", label: t("workflow.importance.high") },
              { value: "critical", label: t("workflow.importance.critical") },
            ]} />
          </Field>
        </div>
        {error && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{error}</div>}
        {path && (
          <div>
            <div className="mb-2 text-xs font-bold text-slate-600">{t("workflow.routes.resultPath")}</div>
            {path.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-xs font-semibold text-slate-400">{t("workflow.routes.noPathResolved")}</div>
            ) : (
              <ol className="flex flex-wrap items-center gap-2">
                {path.map((step, index) => (
                  <li key={`${step.id}-${index}`} className="flex items-center gap-2">
                    <span className="chip border-teal-200 bg-teal-50 text-teal-700"><span dir="ltr">{index + 1}</span>{step.name}</span>
                    {index < path.length - 1 && <FlowIcon className="h-4 w-4 text-slate-300" aria-hidden="true" />}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
