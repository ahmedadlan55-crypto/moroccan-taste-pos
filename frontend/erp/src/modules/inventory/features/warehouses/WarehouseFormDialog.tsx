import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Warehouse as WarehouseIcon } from "lucide-react";
import { Button } from "@/shared/ui";
import { Spinner } from "@/shared/ui";
import { warehouseTypeLabel } from "@/modules/inventory/lib/status-labels";
import { ApiError } from "@/shared/api";
import {
  useCreateWarehouse,
  useUpdateWarehouse,
  useWarehouseFormOptions,
  type WarehouseFormInput,
} from "@/modules/inventory/lib/hooks/useWarehouseAdmin";
import type { WarehouseAdmin } from "@/modules/inventory/lib/adapters/warehouse-admin.adapter";

// Create + edit modal for a warehouse (Phase W6). Validates name/code inline,
// surfaces the backend's 409 DUPLICATE_CODE / 422 messages next to the form,
// and never double-submits (buttons disabled while pending).

const TYPE_OPTIONS = ["branch", "main", "production", "waste", "raw", "finished"];
const CODE_RE = /^[A-Za-z0-9_.-]+$/;

interface FormState {
  name: string;
  code: string;
  type: string;
  brandId: string;
  branchId: string;
  location: string;
  manager: string;
  isMain: boolean;
}

function initialState(w: WarehouseAdmin | null): FormState {
  return {
    name: w?.name ?? "",
    code: w?.code ?? "",
    type: w?.type ?? "branch",
    brandId: w?.brandId ?? "",
    branchId: w?.branchId ?? "",
    location: w?.location ?? "",
    manager: w?.manager ?? "",
    isMain: w?.isMain ?? false,
  };
}

export function WarehouseFormDialog({
  open,
  warehouse,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** null → create mode; a warehouse → edit mode. */
  warehouse: WarehouseAdmin | null;
  onClose: () => void;
  onSaved?: (id: string) => void;
}) {
  const isEdit = !!warehouse;
  const create = useCreateWarehouse();
  const update = useUpdateWarehouse();
  const options = useWarehouseFormOptions(open);
  const [form, setForm] = useState<FormState>(() => initialState(warehouse));
  const [touched, setTouched] = useState(false);

  const pending = create.isPending || update.isPending;

  useEffect(() => {
    if (!open) return;
    setForm(initialState(warehouse));
    setTouched(false);
    create.reset();
    update.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, warehouse?.id]);

  const errors = useMemo(() => {
    const e: Partial<Record<keyof FormState, string>> = {};
    if (!form.name.trim()) e.name = "اسم المستودع مطلوب";
    if (!form.code.trim()) e.code = "كود المستودع مطلوب";
    else if (!CODE_RE.test(form.code.trim())) e.code = "الكود يقبل حروفًا وأرقامًا وشرطات فقط (بدون مسافات)";
    return e;
  }, [form]);
  const valid = Object.keys(errors).length === 0;

  const mutationError = (create.error ?? update.error) as Error | null;
  const apiErr = mutationError instanceof ApiError ? mutationError : null;
  const serverMsg = mutationError ? (apiErr?.message ?? mutationError.message) : null;

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit() {
    setTouched(true);
    if (!valid || pending) return;
    const input: WarehouseFormInput = {
      name: form.name.trim(),
      code: form.code.trim(),
      type: form.type,
      brandId: form.brandId || null,
      branchId: form.branchId || null,
      location: form.location.trim() || null,
      manager: form.manager.trim() || null,
      isMain: form.isMain,
    };
    try {
      const result = isEdit
        ? await update.mutateAsync({ id: warehouse!.id, input })
        : await create.mutateAsync(input);
      onSaved?.(result.id || warehouse?.id || "");
      onClose();
    } catch {
      // The error stays on the mutation and renders inline below the form.
    }
  }

  const fieldCls = "field mt-1 w-full";
  const labelCls = "block text-xs font-bold text-slate-600";

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[70] bg-slate-950/40"
            onClick={() => !pending && onClose()}
            aria-hidden="true"
          />
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            role="dialog"
            aria-modal="true"
            aria-label={isEdit ? "تعديل مستودع" : "مستودع جديد"}
            className="fixed inset-x-3 top-[6vh] z-[80] mx-auto max-h-[88vh] max-w-2xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl"
          >
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-teal-50 text-teal-700">
                <WarehouseIcon className="h-5 w-5" />
              </span>
              <div>
                <h3 className="text-lg font-extrabold text-slate-900">
                  {isEdit ? `تعديل «${warehouse!.name}»` : "مستودع جديد"}
                </h3>
                <p className="text-xs font-medium text-slate-500">
                  {isEdit
                    ? "تعديل البيانات الأساسية — الكود يبقى فريدًا على مستوى النظام."
                    : "أدخل البيانات الأساسية؛ يمكنك ضبط صلاحيات الوصول بعد الإنشاء."}
                </p>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="sm:col-span-2">
                <span className={labelCls}>
                  اسم المستودع <span className="text-rose-600">*</span>
                </span>
                <input
                  className={fieldCls}
                  value={form.name}
                  disabled={pending}
                  placeholder="مثال: مستودع المواد الخام — الرياض"
                  onChange={(e) => set("name", e.target.value)}
                />
                {touched && errors.name && (
                  <span className="mt-1 block text-xs font-bold text-rose-600">{errors.name}</span>
                )}
              </label>

              <label>
                <span className={labelCls}>
                  الكود <span className="text-rose-600">*</span>
                </span>
                <input
                  className={`${fieldCls} font-mono uppercase`}
                  dir="ltr"
                  value={form.code}
                  disabled={pending}
                  placeholder="RAW-RYD-01"
                  onChange={(e) => set("code", e.target.value.toUpperCase())}
                />
                {touched && errors.code && (
                  <span className="mt-1 block text-xs font-bold text-rose-600">{errors.code}</span>
                )}
              </label>

              <label>
                <span className={labelCls}>النوع</span>
                <select
                  className={fieldCls}
                  value={form.type}
                  disabled={pending}
                  onChange={(e) => set("type", e.target.value)}
                >
                  {TYPE_OPTIONS.map((t) => (
                    <option key={t} value={t}>
                      {warehouseTypeLabel(t)}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span className={labelCls}>العلامة التجارية</span>
                <select
                  className={fieldCls}
                  value={form.brandId}
                  disabled={pending || options.isLoading}
                  onChange={(e) => set("brandId", e.target.value)}
                >
                  <option value="">— بدون —</option>
                  {(options.data?.brands ?? []).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span className={labelCls}>الفرع</span>
                <select
                  className={fieldCls}
                  value={form.branchId}
                  disabled={pending || options.isLoading}
                  onChange={(e) => set("branchId", e.target.value)}
                >
                  <option value="">— بدون —</option>
                  {(options.data?.branches ?? []).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span className={labelCls}>الموقع</span>
                <input
                  className={fieldCls}
                  value={form.location}
                  disabled={pending}
                  placeholder="المدينة / الحي"
                  onChange={(e) => set("location", e.target.value)}
                />
              </label>

              <label>
                <span className={labelCls}>المسؤول</span>
                <input
                  className={fieldCls}
                  value={form.manager}
                  disabled={pending}
                  placeholder="اسم أمين المستودع"
                  onChange={(e) => set("manager", e.target.value)}
                />
              </label>

              <label className="flex items-center gap-2 sm:col-span-2">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                  checked={form.isMain}
                  disabled={pending}
                  onChange={(e) => set("isMain", e.target.checked)}
                />
                <span className="text-sm font-bold text-slate-700">مستودع رئيسي</span>
                <span className="text-xs font-medium text-slate-400">
                  (يظهر أولًا في القوائم والتقارير)
                </span>
              </label>
            </div>

            {serverMsg && (
              <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
                {serverMsg}
              </div>
            )}

            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button variant="secondary" onClick={onClose} disabled={pending}>
                إلغاء
              </Button>
              <Button onClick={submit} disabled={pending || (touched && !valid)}>
                {pending ? (
                  <>
                    <Spinner className="h-4 w-4" /> جارٍ الحفظ…
                  </>
                ) : isEdit ? (
                  "حفظ التعديلات"
                ) : (
                  "إنشاء المستودع"
                )}
              </Button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
