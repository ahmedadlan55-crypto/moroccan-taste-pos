import { useEffect, useMemo, useState } from "react";
import { Warehouse as WarehouseIcon } from "lucide-react";
import { Button, FullPageFlow, Spinner } from "@/shared/ui";
import { useT } from "@/i18n";
import { warehouseTypeLabel } from "./WarehousesPage";
import { ApiError } from "@/shared/api";
import {
  useCreateWarehouse,
  useUpdateWarehouse,
  useWarehouseFormOptions,
  type WarehouseFormInput,
} from "@/modules/inventory/lib/hooks/useWarehouseAdmin";
import type { WarehouseAdmin } from "@/modules/inventory/lib/adapters/warehouse-admin.adapter";

// Create + edit workspace for a warehouse (Phase W6). Validates name/code inline,
// surfaces the backend's 409 DUPLICATE_CODE / 422 messages next to the form,
// and never double-submits (buttons disabled while pending).

const TYPE_OPTIONS = ["branch", "main", "production", "waste", "raw", "finished"];
const CODE_RE = /^[A-Za-z0-9_.-]+$/;

interface FormState {
  name: string;
  nameEn: string;
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
    nameEn: w?.nameEn ?? "",
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
  const t = useT();
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
    if (!form.name.trim()) e.name = t("inventoryRest.warehouses.form.nameRequired");
    // B3 — English name is required for NEW warehouses (bilingual master data).
    if (!isEdit && !form.nameEn.trim()) e.nameEn = t("inventoryRest.warehouses.form.nameEnRequired");
    if (!form.code.trim()) e.code = t("inventoryRest.warehouses.form.codeRequired");
    else if (!CODE_RE.test(form.code.trim())) e.code = t("inventoryRest.warehouses.form.codePattern");
    return e;
  }, [form, t, isEdit]);
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
      nameEn: form.nameEn.trim() || null,
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
    <FullPageFlow
      open={open}
      onClose={onClose}
      title={isEdit ? t("inventoryRest.warehouses.form.editTitle", { name: warehouse!.name }) : t("inventoryRest.warehouses.form.newTitle")}
      description={
        isEdit
          ? t("inventoryRest.warehouses.form.editDesc")
          : t("inventoryRest.warehouses.form.newDesc")
      }
      eyebrow={t("inventoryRest.warehouses.form.eyebrow")}
      icon={WarehouseIcon}
      size="md"
      dismissable={!pending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            {t("common.cancel")}
          </Button>
          <Button onClick={submit} disabled={pending || (touched && !valid)}>
            {pending ? (
              <>
                <Spinner className="h-4 w-4" /> {t("inventoryRest.ui.saving")}
              </>
            ) : isEdit ? (
              t("inventoryRest.warehouses.form.saveEdits")
            ) : (
              t("inventoryRest.warehouses.form.createWarehouse")
            )}
          </Button>
        </>
      }
    >
      <section className="surface p-5 sm:p-6 lg:p-8">
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <label className="sm:col-span-2">
                <span className={labelCls}>
                  {t("inventoryRest.warehouses.form.nameLabel")} <span className="text-rose-600">*</span>
                </span>
                <input
                  className={fieldCls}
                  value={form.name}
                  disabled={pending}
                  placeholder={t("inventoryRest.warehouses.form.namePlaceholder")}
                  onChange={(e) => set("name", e.target.value)}
                />
                {touched && errors.name && (
                  <span className="mt-1 block text-xs font-bold text-rose-600">{errors.name}</span>
                )}
              </label>

              <label className="sm:col-span-2">
                <span className={labelCls}>
                  {t("inventoryRest.warehouses.form.nameEnLabel")}{!isEdit && <span className="text-rose-600"> *</span>}
                </span>
                <input
                  className={fieldCls}
                  dir="ltr"
                  value={form.nameEn}
                  disabled={pending}
                  placeholder={t("inventoryRest.warehouses.form.nameEnPlaceholder")}
                  onChange={(e) => set("nameEn", e.target.value)}
                />
                {touched && errors.nameEn && (
                  <span className="mt-1 block text-xs font-bold text-rose-600">{errors.nameEn}</span>
                )}
              </label>

              <label>
                <span className={labelCls}>
                  {t("inventoryRest.warehouses.form.codeLabel")} <span className="text-rose-600">*</span>
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
                <span className={labelCls}>{t("inventoryRest.warehouses.form.typeLabel")}</span>
                <select
                  className={fieldCls}
                  value={form.type}
                  disabled={pending}
                  onChange={(e) => set("type", e.target.value)}
                >
                  {TYPE_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>
                      {warehouseTypeLabel(t, opt)}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span className={labelCls}>{t("inventoryRest.warehouses.form.brandLabel")}</span>
                <select
                  className={fieldCls}
                  value={form.brandId}
                  disabled={pending || options.isLoading}
                  onChange={(e) => set("brandId", e.target.value)}
                >
                  <option value="">{t("inventoryRest.warehouses.form.none")}</option>
                  {(options.data?.brands ?? []).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span className={labelCls}>{t("inventoryRest.warehouses.form.branchLabel")}</span>
                <select
                  className={fieldCls}
                  value={form.branchId}
                  disabled={pending || options.isLoading}
                  onChange={(e) => set("branchId", e.target.value)}
                >
                  <option value="">{t("inventoryRest.warehouses.form.none")}</option>
                  {(options.data?.branches ?? []).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span className={labelCls}>{t("inventoryRest.warehouses.form.locationLabel")}</span>
                <input
                  className={fieldCls}
                  value={form.location}
                  disabled={pending}
                  placeholder={t("inventoryRest.warehouses.form.locationPlaceholder")}
                  onChange={(e) => set("location", e.target.value)}
                />
              </label>

              <label>
                <span className={labelCls}>{t("inventoryRest.warehouses.form.managerLabel")}</span>
                <input
                  className={fieldCls}
                  value={form.manager}
                  disabled={pending}
                  placeholder={t("inventoryRest.warehouses.form.managerPlaceholder")}
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
                <span className="text-sm font-bold text-slate-700">{t("inventoryRest.warehouses.form.isMain")}</span>
                <span className="text-xs font-medium text-slate-400">
                  {t("inventoryRest.warehouses.form.isMainHint")}
                </span>
              </label>
            </div>

        {serverMsg && (
          <div className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">
            {serverMsg}
          </div>
        )}
      </section>
    </FullPageFlow>
  );
}
