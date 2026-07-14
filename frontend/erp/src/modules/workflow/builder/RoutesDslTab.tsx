import { useMemo, useState } from "react";
import { Plus, Pencil, Trash2, FlaskConical, ArrowLeft } from "lucide-react";
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
  usePositions,
  useTransactionTypes,
  useWorkflowRoutes,
  useSaveWorkflowRoute,
  useUpdateWorkflowRoute,
  useDeleteWorkflowRoute,
  useTestWorkflowRoute,
  type WorkflowRoute,
  type RouteTestStep,
} from "../lib/api";

// قواعد التوجيه — the JSON-DSL routes: a linear resolver walks `steps[]`, taking a
// step's `branches[].if` condition (e.g. "amount > 50000") or its `next.default`.
// Authoring is raw JSON (admin territory) with a dry-run tester that posts a
// sample txn and renders the resolved path — the honest surface, not a faked GUI.

const SAMPLE_STEPS = `[
  {
    "id": "s1",
    "name": "المحاسب",
    "required_position_id": "",
    "branches": [{ "if": "amount > 50000", "next": "s2" }],
    "next": { "default": "s2" }
  },
  { "id": "s2", "name": "المدير المالي", "is_terminal": true }
]`;

interface RouteForm {
  id?: string;
  routeName: string;
  transactionTypeId: string;
  initiatorPositionId: string;
  isDefault: boolean;
  conditionsText: string;
  stepsText: string;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "JSON غير صالح" };
  }
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
    const m = new Map((types.data ?? []).map((t) => [t.id, t.name]));
    return (id: string | null) => (id ? m.get(id) || id : "كل الأنواع");
  }, [types.data]);
  const posName = useMemo(() => {
    const m = new Map((positions.data ?? []).map((p) => [p.id, p.name]));
    return (id: string | null) => (id ? m.get(id) || id : "كل المناصب");
  }, [positions.data]);

  const typeOptions = useMemo(
    () => (types.data ?? []).map((t) => ({ value: t.id, label: t.name })),
    [types.data],
  );
  const positionOptions = useMemo(
    () => (positions.data ?? []).map((p) => ({ value: p.id, label: p.name })),
    [positions.data],
  );

  function openNew() {
    setFormError(null);
    setForm({
      routeName: "",
      transactionTypeId: "",
      initiatorPositionId: "",
      isDefault: false,
      conditionsText: "{}",
      stepsText: SAMPLE_STEPS,
    });
  }
  function openEdit(r: WorkflowRoute) {
    setFormError(null);
    setForm({
      id: r.id,
      routeName: r.routeName,
      transactionTypeId: r.transactionTypeId ?? "",
      initiatorPositionId: r.initiatorPositionId ?? "",
      isDefault: r.isDefault,
      conditionsText: JSON.stringify(r.conditions ?? {}, null, 2),
      stepsText: JSON.stringify(r.steps ?? [], null, 2),
    });
  }

  function submit() {
    if (!form) return;
    if (!form.routeName.trim()) {
      setFormError("اسم القاعدة مطلوب.");
      return;
    }
    const cond = parseJson(form.conditionsText || "{}");
    if (!cond.ok) {
      setFormError("الشروط (conditions): JSON غير صالح — " + cond.error);
      return;
    }
    const st = parseJson(form.stepsText || "[]");
    if (!st.ok) {
      setFormError("الخطوات (steps): JSON غير صالح — " + st.error);
      return;
    }
    if (!Array.isArray(st.value) || !st.value.length) {
      setFormError("الخطوات يجب أن تكون مصفوفة غير فارغة.");
      return;
    }
    for (const [i, s] of (st.value as Record<string, unknown>[]).entries()) {
      if (!s || !s.id || !s.name) {
        setFormError(`الخطوة رقم ${i + 1} يجب أن تحتوي على id و name.`);
        return;
      }
    }
    setFormError(null);

    const onDone = (label: string) => (res: { success?: boolean; error?: string } | undefined) => {
      if (res && res.success === false) {
        setFormError(res.error || "تعذّر حفظ القاعدة.");
        return;
      }
      toast({ title: label, tone: "success" });
      setForm(null);
    };
    const onErr = (e: unknown) =>
      setFormError(e instanceof Error ? e.message : "تعذّر حفظ القاعدة.");

    if (form.id) {
      update.mutate(
        {
          id: form.id,
          routeName: form.routeName.trim(),
          isDefault: form.isDefault,
          conditions: cond.value,
          steps: st.value,
        },
        { onSuccess: onDone("تم تحديث القاعدة"), onError: onErr },
      );
    } else {
      save.mutate(
        {
          transactionTypeId: form.transactionTypeId || null,
          initiatorPositionId: form.initiatorPositionId || null,
          routeName: form.routeName.trim(),
          isDefault: form.isDefault,
          conditions: cond.value,
          steps: st.value,
        },
        { onSuccess: onDone("تم إنشاء القاعدة"), onError: onErr },
      );
    }
  }

  function confirmDelete() {
    if (!toDelete) return;
    setDeleteError(null);
    del.mutate(toDelete.id, {
      onSuccess: (res) => {
        if (res && res.success === false) {
          setDeleteError(res.error || "تعذّر حذف القاعدة.");
          return;
        }
        toast({ title: "تم حذف القاعدة", tone: "success" });
        setToDelete(null);
      },
      onError: (e) => setDeleteError(e instanceof Error ? e.message : "تعذّر حذف القاعدة."),
    });
  }

  const columns: ColumnDef<WorkflowRoute>[] = [
    {
      id: "routeName",
      header: "القاعدة",
      accessor: (r) => r.routeName,
      cell: (r) => (
        <div className="flex items-center gap-2">
          <span className="font-bold text-slate-800">{r.routeName}</span>
          {r.isDefault && <Badge tone="info">افتراضي</Badge>}
          {!r.isActive && <Badge tone="neutral">متوقّف</Badge>}
        </div>
      ),
    },
    { id: "type", header: "النوع", accessor: (r) => typeName(r.transactionTypeId) },
    { id: "position", header: "المنصب البادئ", accessor: (r) => posName(r.initiatorPositionId) },
    {
      id: "steps",
      header: "الخطوات",
      accessor: (r) => (Array.isArray(r.steps) ? r.steps.length : 0),
      numeric: true,
      cell: (r) => (
        <span dir="ltr" className="tabular-nums">
          {Array.isArray(r.steps) ? r.steps.length : 0}
        </span>
      ),
    },
  ];

  if (list.isLoading) return <LoadingState rows={4} />;
  if (list.isError) return <ErrorState error={list.error} onRetry={() => list.refetch()} />;

  const saving = save.isPending || update.isPending;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button variant="primary" onClick={openNew}>
          <Plus className="h-4 w-4" /> قاعدة جديدة
        </Button>
      </div>

      <DataTable
        columns={columns}
        rows={list.data ?? []}
        getRowId={(r) => r.id}
        searchable
        searchPlaceholder="بحث بالاسم…"
        tableId="wf-routes"
        emptyTitle="لا توجد قواعد توجيه"
        emptyBody="أضف قاعدة توجيه بصيغة JSON لتعريف مسار مشروط."
        rowActions={(r) => (
          <div className="flex items-center gap-1">
            <IconButton aria-label="اختبار" size="sm" onClick={() => setTesting(r)}>
              <FlaskConical className="h-4 w-4" />
            </IconButton>
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

      {/* Create / edit route */}
      <Dialog
        open={!!form}
        onClose={() => setForm(null)}
        size="xl"
        title={form?.id ? "تعديل قاعدة التوجيه" : "قاعدة توجيه جديدة"}
        footer={
          <>
            <Button variant="secondary" onClick={() => setForm(null)} disabled={saving}>
              إلغاء
            </Button>
            <Button variant="primary" onClick={submit} loading={saving}>
              حفظ
            </Button>
          </>
        }
      >
        {form && (
          <div className="space-y-4">
            <Field label="اسم القاعدة" required>
              <Input
                value={form.routeName}
                onChange={(e) => setForm({ ...form, routeName: e.target.value })}
                placeholder="مثال: صرف يتجاوز 50 ألف"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="نوع المعاملة"
                hint={form.id ? "لا يُعدّل بعد الإنشاء." : "اتركه فارغًا لكل الأنواع."}
              >
                <Select
                  value={form.transactionTypeId}
                  placeholder="— كل الأنواع —"
                  options={typeOptions}
                  disabled={!!form.id}
                  onChange={(e) => setForm({ ...form, transactionTypeId: e.target.value })}
                />
              </Field>
              <Field
                label="المنصب البادئ"
                hint={form.id ? "لا يُعدّل بعد الإنشاء." : "اتركه فارغًا لكل المناصب."}
              >
                <Select
                  value={form.initiatorPositionId}
                  placeholder="— كل المناصب —"
                  options={positionOptions}
                  disabled={!!form.id}
                  onChange={(e) => setForm({ ...form, initiatorPositionId: e.target.value })}
                />
              </Field>
            </div>
            <Checkbox
              label="القاعدة الافتراضية لهذا النوع/المنصب"
              checked={form.isDefault}
              onChange={(e) => setForm({ ...form, isDefault: e.target.checked })}
            />
            <Field label="الشروط (conditions) — JSON">
              <textarea
                dir="ltr"
                rows={4}
                className="field py-2 font-mono text-xs"
                value={form.conditionsText}
                onChange={(e) => setForm({ ...form, conditionsText: e.target.value })}
              />
            </Field>
            <Field
              label="الخطوات (steps) — JSON"
              hint="كل خطوة: id + name، وينتقل عبر branches[].if أو next.default؛ is_terminal ينهي المسار."
            >
              <textarea
                dir="ltr"
                rows={9}
                className="field py-2 font-mono text-xs"
                value={form.stepsText}
                onChange={(e) => setForm({ ...form, stepsText: e.target.value })}
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

// ── Dry-run tester ───────────────────────────────────────────────────────────
function RouteTester({ route, onClose }: { route: WorkflowRoute; onClose: () => void }) {
  const test = useTestWorkflowRoute();
  const [txnText, setTxnText] = useState('{\n  "amount": 60000\n}');
  const [error, setError] = useState<string | null>(null);
  const [path, setPath] = useState<RouteTestStep[] | null>(null);

  function run() {
    setError(null);
    setPath(null);
    const parsed = parseJson(txnText || "{}");
    if (!parsed.ok) {
      setError("بيانات المعاملة: JSON غير صالح — " + parsed.error);
      return;
    }
    test.mutate(
      { id: route.id, txn: parsed.value as Record<string, unknown> },
      {
        onSuccess: (res) => {
          if (!res || res.success === false) {
            setError(res?.error || "تعذّر تنفيذ الاختبار.");
            return;
          }
          setPath(res.path ?? []);
        },
        onError: (e) => setError(e instanceof Error ? e.message : "تعذّر تنفيذ الاختبار."),
      },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`اختبار (dry-run): ${route.routeName}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            إغلاق
          </Button>
          <Button variant="primary" onClick={run} loading={test.isPending}>
            <FlaskConical className="h-4 w-4" /> اختبار (dry-run)
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="بيانات معاملة تجريبية (txn) — JSON"
          hint="الحقول التي تُقيّم عليها الشروط، مثل amount أو branchId."
        >
          <textarea
            dir="ltr"
            rows={5}
            className="field py-2 font-mono text-xs"
            value={txnText}
            onChange={(e) => setTxnText(e.target.value)}
          />
        </Field>

        {error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
            {error}
          </div>
        )}

        {path && (
          <div>
            <div className="mb-2 text-xs font-bold text-slate-600">المسار الناتج</div>
            {path.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-xs font-semibold text-slate-400">
                لم يُحسم أي مسار لهذه المدخلات.
              </div>
            ) : (
              <ol className="flex flex-wrap items-center gap-2">
                {path.map((s, i) => (
                  <li key={s.id + i} className="flex items-center gap-2">
                    <span className="chip border-teal-200 bg-teal-50 text-teal-700">
                      <span dir="ltr" className="tabular-nums">
                        {i + 1}
                      </span>
                      {s.name}
                    </span>
                    {i < path.length - 1 && <ArrowLeft className="h-4 w-4 text-slate-300" />}
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
