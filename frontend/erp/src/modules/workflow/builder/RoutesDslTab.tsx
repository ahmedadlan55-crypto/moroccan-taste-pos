import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
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

const FIELD_OPTIONS = [
  { value: "amount", label: "المبلغ" },
  { value: "branchId", label: "الفرع" },
  { value: "deptId", label: "الإدارة" },
  { value: "importance", label: "الأولوية" },
];

const OPERATOR_OPTIONS = [
  { value: ">", label: "أكبر من" },
  { value: ">=", label: "أكبر من أو يساوي" },
  { value: "<", label: "أقل من" },
  { value: "<=", label: "أقل من أو يساوي" },
  { value: "==", label: "يساوي" },
  { value: "!=", label: "لا يساوي" },
];

function newStep(index: number): VisualStep {
  return {
    id: `s${index + 1}`,
    name: index === 0 ? "المراجعة الأولى" : `الخطوة ${index + 1}`,
    requiredPositionId: "",
    isTerminal: false,
    conditionField: "",
    conditionOperator: ">",
    conditionValue: "",
    conditionNextId: "",
  };
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "JSON غير صالح" };
  }
}

function parseCondition(expression: unknown) {
  if (typeof expression !== "string") return null;
  const match = expression.match(/^\s*([a-zA-Z_]\w*)\s*(<=|>=|<|>|==|!=)\s*(.+?)\s*$/);
  return match ? { field: match[1], operator: match[2] as Operator, value: match[3].replace(/^["']|["']$/g, "") } : null;
}

function toVisualSteps(raw: unknown): VisualStep[] {
  if (!Array.isArray(raw) || raw.length === 0) return [newStep(0), { ...newStep(1), name: "الاعتماد النهائي", isTerminal: true }];
  return raw.map((value, index) => {
    const step = (value ?? {}) as Record<string, unknown>;
    const branch = Array.isArray(step.branches) ? (step.branches[0] as Record<string, unknown> | undefined) : undefined;
    const condition = parseCondition(branch?.if);
    return {
      id: String(step.id || `s${index + 1}`),
      name: String(step.name || `الخطوة ${index + 1}`),
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
    return (id: string | null) => (id ? map.get(id) || id : "كل الأنواع");
  }, [types.data]);
  const positionName = useMemo(() => {
    const map = new Map((positions.data ?? []).map((position) => [position.id, position.name]));
    return (id: string | null) => (id ? map.get(id) || id : "كل المناصب");
  }, [positions.data]);
  const typeOptions = useMemo(() => (types.data ?? []).map((type) => ({ value: type.id, label: type.name })), [types.data]);
  const positionOptions = useMemo(() => (positions.data ?? []).map((position) => ({ value: position.id, label: position.name })), [positions.data]);

  function openNew() {
    const visualSteps = [newStep(0), { ...newStep(1), name: "الاعتماد النهائي", isTerminal: true }];
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
      visualSteps: toVisualSteps(route.steps),
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
    const parsed = parseJson(form.stepsText || "[]");
    if (!parsed.ok || !Array.isArray(parsed.value) || parsed.value.length === 0) {
      setFormError("تعذّر الرجوع للوضع المرئي: صحح JSON الخطوات أولًا.");
      return;
    }
    setForm({ ...form, mode, visualSteps: toVisualSteps(parsed.value) });
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
      setFormError("اسم القاعدة مطلوب.");
      return;
    }
    let conditions: unknown = {};
    let steps: unknown;
    if (form.mode === "advanced") {
      const parsedConditions = parseJson(form.conditionsText || "{}");
      if (!parsedConditions.ok) {
        setFormError(`الإعدادات المتقدمة: ${parsedConditions.error}`);
        return;
      }
      const parsedSteps = parseJson(form.stepsText || "[]");
      if (!parsedSteps.ok || !Array.isArray(parsedSteps.value) || parsedSteps.value.length === 0) {
        setFormError(parsedSteps.ok ? "الخطوات يجب أن تكون مصفوفة غير فارغة." : `JSON الخطوات: ${parsedSteps.error}`);
        return;
      }
      conditions = parsedConditions.value;
      steps = parsedSteps.value;
    } else {
      const duplicateIds = new Set<string>();
      const ids = new Set<string>();
      for (const [index, step] of form.visualSteps.entries()) {
        if (!step.id.trim() || !step.name.trim()) {
          setFormError(`أكمل اسم ومعرّف الخطوة رقم ${index + 1}.`);
          return;
        }
        if (ids.has(step.id)) duplicateIds.add(step.id);
        ids.add(step.id);
      }
      if (duplicateIds.size) {
        setFormError(`معرّفات الخطوات يجب أن تكون فريدة: ${Array.from(duplicateIds).join(", ")}`);
        return;
      }
      const invalidTarget = form.visualSteps.find((step) => step.conditionNextId && !ids.has(step.conditionNextId));
      if (invalidTarget) {
        setFormError(`الوجهة الشرطية في «${invalidTarget.name}» غير موجودة.`);
        return;
      }
      steps = toDslSteps(form.visualSteps);
    }

    const onSuccess = (label: string) => (result: { success?: boolean; error?: string } | undefined) => {
      if (result?.success === false) {
        setFormError(result.error || "تعذّر حفظ القاعدة.");
        return;
      }
      toast({ title: label, tone: "success" });
      setForm(null);
    };
    const onError = (error: unknown) => setFormError(error instanceof Error ? error.message : "تعذّر حفظ القاعدة.");
    if (form.id) {
      update.mutate(
        { id: form.id, routeName: form.routeName.trim(), isDefault: form.isDefault, conditions, steps },
        { onSuccess: onSuccess("تم تحديث قاعدة التوجيه"), onError },
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
        { onSuccess: onSuccess("تم إنشاء قاعدة التوجيه"), onError },
      );
    }
  }

  function confirmDelete() {
    if (!toDelete) return;
    setDeleteError(null);
    del.mutate(toDelete.id, {
      onSuccess: (result) => {
        if (result?.success === false) {
          setDeleteError(result.error || "تعذّر حذف القاعدة.");
          return;
        }
        toast({ title: "تم حذف القاعدة", tone: "success" });
        setToDelete(null);
      },
      onError: (error) => setDeleteError(error instanceof Error ? error.message : "تعذّر حذف القاعدة."),
    });
  }

  const columns: ColumnDef<WorkflowRoute>[] = [
    {
      id: "routeName",
      header: "القاعدة",
      accessor: (route) => route.routeName,
      cell: (route) => (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-bold text-slate-800">{route.routeName}</span>
          {route.isDefault && <Badge tone="info">افتراضي</Badge>}
          {!route.isActive && <Badge tone="neutral">متوقف</Badge>}
        </div>
      ),
    },
    { id: "type", header: "نوع المعاملة", accessor: (route) => typeName(route.transactionTypeId) },
    { id: "position", header: "منصب المنشئ", accessor: (route) => positionName(route.initiatorPositionId) },
    { id: "steps", header: "الخطوات", accessor: (route) => Array.isArray(route.steps) ? route.steps.length : 0, numeric: true },
  ];

  if (list.isLoading) return <LoadingState rows={4} />;
  if (list.isError) return <ErrorState error={list.error} onRetry={() => list.refetch()} />;
  const saving = save.isPending || update.isPending;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-extrabold text-slate-900">
            <GitBranch className="h-4 w-4 text-teal-600" aria-hidden="true" /> قواعد المسارات الشرطية
          </div>
          <p className="mt-1 text-xs font-medium text-slate-500">صمّم الخطوات والشروط بصريًا، ثم اختبر النتيجة دون التأثير في المعاملات.</p>
        </div>
        <Button variant="primary" onClick={openNew} className="w-full sm:w-auto">
          <Plus className="h-4 w-4" aria-hidden="true" /> قاعدة جديدة
        </Button>
      </div>

      <DataTable
        columns={columns}
        rows={list.data ?? []}
        getRowId={(route) => route.id}
        searchable
        searchPlaceholder="بحث بالاسم…"
        tableId="wf-routes"
        emptyTitle="لا توجد قواعد توجيه"
        emptyBody="أنشئ قاعدة مرئية لتحديد خطوات القرار والحالات الاستثنائية."
        rowActions={(route) => (
          <div className="flex flex-wrap items-center gap-1">
            <Button variant="ghost" size="sm" aria-label="اختبار" onClick={() => setTesting(route)}>
              <FlaskConical className="h-4 w-4" aria-hidden="true" /> اختبار
            </Button>
            <Button variant="ghost" size="sm" aria-label="تعديل" onClick={() => openEdit(route)}>
              <Pencil className="h-4 w-4" aria-hidden="true" /> تعديل
            </Button>
            <IconButton aria-label="حذف" size="sm" variant="danger" onClick={() => setToDelete(route)}>
              <Trash2 className="h-4 w-4" />
            </IconButton>
          </div>
        )}
      />

      <Dialog
        open={!!form}
        onClose={() => setForm(null)}
        size="xl"
        title={form?.id ? "تعديل قاعدة التوجيه" : "قاعدة توجيه جديدة"}
        footer={
          <>
            <Button variant="secondary" onClick={() => setForm(null)} disabled={saving}>إلغاء</Button>
            <Button variant="primary" onClick={submit} loading={saving}>حفظ</Button>
          </>
        }
      >
        {form && (
          <div className="space-y-5">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="اسم القاعدة" required className="md:col-span-2">
                <Input value={form.routeName} onChange={(event) => setForm({ ...form, routeName: event.target.value })} placeholder="مثال: صرف يتجاوز 50 ألف" />
              </Field>
              <Field label="نوع المعاملة" hint={form.id ? "ثابت بعد الإنشاء." : "فارغ = جميع الأنواع."}>
                <Select value={form.transactionTypeId} placeholder="كل الأنواع" options={typeOptions} disabled={!!form.id} onChange={(event) => setForm({ ...form, transactionTypeId: event.target.value })} />
              </Field>
              <Field label="منصب المنشئ" hint={form.id ? "ثابت بعد الإنشاء." : "فارغ = جميع المناصب."}>
                <Select value={form.initiatorPositionId} placeholder="كل المناصب" options={positionOptions} disabled={!!form.id} onChange={(event) => setForm({ ...form, initiatorPositionId: event.target.value })} />
              </Field>
            </div>
            <Checkbox label="استخدامها كقاعدة افتراضية لهذا النوع والمنصب" checked={form.isDefault} onChange={(event) => setForm({ ...form, isDefault: event.target.checked })} />

            <div className="flex flex-wrap items-center justify-between gap-2 border-y border-slate-100 py-3">
              <div>
                <div className="text-sm font-extrabold text-slate-800">تصميم المسار</div>
                <div className="mt-0.5 text-xs font-medium text-slate-500">الوضع المرئي هو الافتراضي الآمن. JSON مخصص للخبراء فقط.</div>
              </div>
              <div className="flex rounded-xl border border-slate-200 bg-slate-50 p-1" role="group" aria-label="وضع تحرير المسار">
                <Button variant={form.mode === "visual" ? "subtle" : "ghost"} size="sm" onClick={() => setEditorMode("visual")}>
                  <GitBranch className="h-4 w-4" aria-hidden="true" /> مرئي
                </Button>
                <Button variant={form.mode === "advanced" ? "subtle" : "ghost"} size="sm" onClick={() => setEditorMode("advanced")}>
                  <Braces className="h-4 w-4" aria-hidden="true" /> وضع متقدم
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
                onAdd={() => setForm({ ...form, visualSteps: [...form.visualSteps, newStep(form.visualSteps.length)] })}
              />
            ) : (
              <div className="space-y-4 rounded-xl border border-amber-200 bg-amber-50/40 p-4">
                <div className="flex items-start gap-2 text-xs font-bold leading-5 text-amber-800">
                  <Braces className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  التعديل هنا يغيّر بنية المسار مباشرة. استخدمه فقط عندما لا تمثل الواجهة المرئية القاعدة المطلوبة.
                </div>
                <Field label="إعدادات عامة — JSON">
                  <textarea dir="ltr" rows={4} className="field py-2 font-mono text-xs" value={form.conditionsText} onChange={(event) => setForm({ ...form, conditionsText: event.target.value })} />
                </Field>
                <Field label="بنية الخطوات — JSON">
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
        title="حذف قاعدة التوجيه"
        description={toDelete ? `سيتم حذف قاعدة «${toDelete.routeName}».` : ""}
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
                <span className="text-sm font-extrabold text-slate-800">{step.name || `الخطوة ${index + 1}`}</span>
                {step.isTerminal && <Badge tone="success">نهائية</Badge>}
              </div>
              <div className="flex items-center gap-1">
                <IconButton aria-label="تحريك لأعلى" size="sm" disabled={index === 0} onClick={() => onMove(index, -1)}><ArrowUp className="h-4 w-4" /></IconButton>
                <IconButton aria-label="تحريك لأسفل" size="sm" disabled={index === steps.length - 1} onClick={() => onMove(index, 1)}><ArrowDown className="h-4 w-4" /></IconButton>
                <IconButton aria-label="حذف الخطوة" size="sm" variant="danger" disabled={steps.length <= 1} onClick={() => onRemove(index)}><Trash2 className="h-4 w-4" /></IconButton>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="اسم الخطوة" required>
                <Input value={step.name} onChange={(event) => onUpdate(index, { name: event.target.value })} placeholder="مراجعة المدير" />
              </Field>
              <Field label="المعرّف" required hint="فريد داخل المسار.">
                <Input dir="ltr" value={step.id} onChange={(event) => onUpdate(index, { id: event.target.value.replace(/\s+/g, "-") })} />
              </Field>
              <Field label="المنصب المسؤول">
                <Select value={step.requiredPositionId} placeholder="تعيين تلقائي" options={positions} onChange={(event) => onUpdate(index, { requiredPositionId: event.target.value })} />
              </Field>
            </div>
            <div className="mt-3">
              <Checkbox label="هذه آخر خطوة في المسار" checked={step.isTerminal} onChange={(event) => onUpdate(index, { isTerminal: event.target.checked })} />
            </div>
            {!step.isTerminal && (
              <details className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                <summary className="cursor-pointer text-xs font-extrabold text-slate-700">إضافة تحويل شرطي من هذه الخطوة</summary>
                <div className="mt-3 grid gap-3 md:grid-cols-4">
                  <Field label="الحقل">
                    <Select value={step.conditionField} placeholder="بدون شرط" options={FIELD_OPTIONS} onChange={(event) => onUpdate(index, { conditionField: event.target.value })} />
                  </Field>
                  <Field label="المعامل">
                    <Select value={step.conditionOperator} options={OPERATOR_OPTIONS} onChange={(event) => onUpdate(index, { conditionOperator: event.target.value as Operator })} />
                  </Field>
                  <Field label="القيمة">
                    <Input value={step.conditionValue} onChange={(event) => onUpdate(index, { conditionValue: event.target.value })} placeholder="50000" />
                  </Field>
                  <Field label="انتقل إلى">
                    <Select value={step.conditionNextId} placeholder="اختر الخطوة" options={targets.filter((target) => target.value !== step.id)} onChange={(event) => onUpdate(index, { conditionNextId: event.target.value })} />
                  </Field>
                </div>
              </details>
            )}
          </li>
        ))}
      </ol>
      <Button variant="secondary" onClick={onAdd} className="w-full border-dashed">
        <Plus className="h-4 w-4" aria-hidden="true" /> إضافة خطوة إلى المسار
      </Button>
    </div>
  );
}

function RouteTester({ route, onClose }: { route: WorkflowRoute; onClose: () => void }) {
  const test = useTestWorkflowRoute();
  const [amount, setAmount] = useState("60000");
  const [branchId, setBranchId] = useState("");
  const [importance, setImportance] = useState("medium");
  const [error, setError] = useState<string | null>(null);
  const [path, setPath] = useState<RouteTestStep[] | null>(null);

  function run() {
    setError(null);
    setPath(null);
    test.mutate(
      { id: route.id, txn: { amount: Number(amount || 0), branchId, importance } },
      {
        onSuccess: (result) => {
          if (!result || result.success === false) {
            setError(result?.error || "تعذّر تنفيذ الاختبار.");
            return;
          }
          setPath(result.path ?? []);
        },
        onError: (reason) => setError(reason instanceof Error ? reason.message : "تعذّر تنفيذ الاختبار."),
      },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`محاكاة المسار: ${route.routeName}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>إغلاق</Button>
          <Button variant="primary" onClick={run} loading={test.isPending}><FlaskConical className="h-4 w-4" /> اختبار (dry-run)</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="المبلغ"><Input type="number" dir="ltr" value={amount} onChange={(event) => setAmount(event.target.value)} /></Field>
          <Field label="الفرع"><Input dir="ltr" value={branchId} onChange={(event) => setBranchId(event.target.value)} placeholder="BR-001" /></Field>
          <Field label="الأولوية">
            <Select value={importance} onChange={(event) => setImportance(event.target.value)} options={[
              { value: "low", label: "منخفضة" },
              { value: "medium", label: "متوسطة" },
              { value: "high", label: "عالية" },
              { value: "critical", label: "حرجة" },
            ]} />
          </Field>
        </div>
        {error && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{error}</div>}
        {path && (
          <div>
            <div className="mb-2 text-xs font-bold text-slate-600">المسار الناتج</div>
            {path.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-xs font-semibold text-slate-400">لم يُحسم مسار لهذه المدخلات.</div>
            ) : (
              <ol className="flex flex-wrap items-center gap-2">
                {path.map((step, index) => (
                  <li key={`${step.id}-${index}`} className="flex items-center gap-2">
                    <span className="chip border-teal-200 bg-teal-50 text-teal-700"><span dir="ltr">{index + 1}</span>{step.name}</span>
                    {index < path.length - 1 && <ArrowLeft className="h-4 w-4 text-slate-300" aria-hidden="true" />}
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
