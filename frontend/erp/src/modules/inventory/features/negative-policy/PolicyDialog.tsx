// Phase W2 — full-page workspace for one negative-stock policy row. The
// processing state blocks double-submit and the policy form keeps the `allow`
// option renders ONLY for a developer), maxNegativeQty (controlled only),
// requireReason / isEnabled toggles. Saves via PUT with expectedVersion; a 409
// VERSION_CONFLICT and 403/422 policy errors surface inline.

import { useEffect, useState } from "react";
import { RefreshCw, ShieldAlert } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, FullPageFlow, Spinner } from "@/shared/ui";
import { useAuth } from "@/app/providers";
import { ApiError } from "@/shared/api";
import { queryKeys } from "@/modules/inventory/lib/query-keys";
import { useSavePolicy } from "@/modules/inventory/lib/hooks/useNegativePolicy";
import type { PolicyMode, PolicyRow, PolicyScope } from "@/modules/inventory/lib/adapters/negative-policy.adapter";
import { POLICY_LABELS, SCOPE_LABELS } from "./labels";
import { ToggleField } from "./shared";
import { ItemSearchSelect, type ItemOption } from "./ItemSearchSelect";

export interface PolicyDialogProps {
  open: boolean;
  onClose: () => void;
  scope: PolicyScope;
  /** the row being edited; null/undefined = creating a new row for this scope. */
  row?: PolicyRow | null;
  warehouseOptions: Array<{ id: string; name: string }>;
  /** env gate NEGATIVE_STOCK_ALLOW_ENABLED — shows the degradation hint under `allow`. */
  allowEnabled: boolean;
}

const TITLES: Record<PolicyScope, string> = {
  global: "السياسة العامة للمخزون السالب",
  warehouse: "سياسة مستودع",
  item: "سياسة صنف داخل مستودع",
};

export function PolicyDialog({ open, onClose, scope, row = null, warehouseOptions, allowEnabled }: PolicyDialogProps) {
  const { user } = useAuth();
  const isDeveloper = !!user?.isDeveloper;
  const qc = useQueryClient();
  const save = useSavePolicy();

  const [warehouseId, setWarehouseId] = useState("");
  const [item, setItem] = useState<ItemOption | null>(null);
  const [policy, setPolicy] = useState<PolicyMode>("block");
  const [maxQty, setMaxQty] = useState("0");
  const [requireReason, setRequireReason] = useState(true);
  const [isEnabled, setIsEnabled] = useState(true);
  const [clientError, setClientError] = useState<string | null>(null);

  const editing = !!row;
  const processing = save.isPending;

  // (Re)seed the form each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setWarehouseId(row?.warehouseId ?? "");
    setItem(row?.itemId ? { id: row.itemId, name: row.itemName ?? row.itemId } : null);
    setPolicy(row?.policy ?? "block");
    setMaxQty(String(row?.maxNegativeQty ?? 0));
    setRequireReason(row?.requireReason ?? true);
    setIsEnabled(row?.isEnabled ?? true);
    setClientError(null);
    save.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function submit() {
    setClientError(null);
    if (scope !== "global" && !warehouseId) {
      setClientError("اختر المستودع أولًا.");
      return;
    }
    if (scope === "item" && !item) {
      setClientError("اختر الصنف أولًا.");
      return;
    }
    const maxN = Number(maxQty);
    if (policy === "controlled" && (!Number.isFinite(maxN) || maxN < 0)) {
      setClientError("الحد الأقصى للعجز يجب أن يكون رقمًا ≥ 0.");
      return;
    }
    save.mutate(
      {
        scope,
        warehouseId: scope === "global" ? null : warehouseId,
        itemId: scope === "item" ? item?.id ?? null : null,
        policy,
        maxNegativeQty: Number.isFinite(maxN) && maxN >= 0 ? maxN : 0,
        requireReason,
        isEnabled,
        expectedVersion: editing ? row?.version : undefined,
      },
      { onSuccess: onClose },
    );
  }

  function refreshAfterConflict() {
    qc.invalidateQueries({ queryKey: queryKeys.negativePolicy.all });
    onClose();
  }

  const err = save.error;
  const apiErr = err instanceof ApiError ? err : null;
  const isConflict = !!apiErr?.isConflict;
  const errorMessage = err ? (err instanceof Error ? err.message : "حدث خطأ غير متوقع") : clientError;

  // A non-developer editing a stored `allow` row keeps seeing the current
  // value (disabled) — saving it as-is would 403, so the hint nudges a switch.
  const showAllowOption = isDeveloper || row?.policy === "allow";

  return (
    <FullPageFlow
      open={open}
      onClose={onClose}
      title={TITLES[scope]}
      description={row?.version != null ? `الإصدار ${row.version} — تُحفظ التغييرات مع التحقق من عدم وجود تعديل متزامن.` : "حدد قواعد التعامل مع الرصيد السالب بوضوح لهذا النطاق."}
      eyebrow={`سياسات المخزون · نطاق ${SCOPE_LABELS[scope]}`}
      icon={ShieldAlert}
      size="sm"
      dismissable={!processing}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={processing}>
            إلغاء
          </Button>
          <Button variant="primary" onClick={submit} disabled={processing}>
            {processing ? (
              <>
                <Spinner className="h-4 w-4" /> جارٍ الحفظ…
              </>
            ) : (
              "حفظ السياسة"
            )}
          </Button>
        </>
      }
    >
      <section className="surface p-5 sm:p-6 lg:p-8">
              <div className="space-y-5">
                {scope !== "global" && (
                  <label className="block">
                    <span className="text-xs font-bold text-slate-600">
                      المستودع <span className="text-rose-600">*</span>
                    </span>
                    {editing ? (
                      <div className="field mt-1 flex items-center bg-slate-50 text-slate-500">
                        {row?.warehouseName ?? row?.warehouseId ?? "—"}
                      </div>
                    ) : (
                      <select
                        className="field mt-1"
                        value={warehouseId}
                        disabled={processing}
                        onChange={(e) => setWarehouseId(e.target.value)}
                      >
                        <option value="">اختر المستودع…</option>
                        {warehouseOptions.map((w) => (
                          <option key={w.id} value={w.id}>{w.name}</option>
                        ))}
                      </select>
                    )}
                  </label>
                )}

                {scope === "item" && (
                  <div>
                    <span className="text-xs font-bold text-slate-600">
                      الصنف <span className="text-rose-600">*</span>
                    </span>
                    <div className="mt-1">
                      <ItemSearchSelect value={item} onChange={setItem} disabled={editing || processing} />
                    </div>
                    <p className="mt-1 text-[11px] font-medium leading-4 text-slate-400">
                      الأصناف المتتبَّعة (دفعات/صلاحية) تُمنع دائمًا — سيرفض الخادم أي سياسة غير «منع» لها.
                    </p>
                  </div>
                )}

                <label className="block">
                  <span className="text-xs font-bold text-slate-600">السياسة</span>
                  <select
                    className="field mt-1"
                    value={policy}
                    disabled={processing}
                    onChange={(e) => setPolicy(e.target.value as PolicyMode)}
                  >
                    <option value="block">{POLICY_LABELS.block}</option>
                    <option value="controlled">{POLICY_LABELS.controlled}</option>
                    {showAllowOption && (
                      <option value="allow" disabled={!isDeveloper}>
                        {POLICY_LABELS.allow} — للمطوّر فقط
                      </option>
                    )}
                  </select>
                  {policy === "allow" && !allowEnabled && (
                    <span className="mt-1 block rounded-lg bg-amber-50 px-2 py-1 text-[11px] font-bold text-amber-700">
                      بوابة NEGATIVE_STOCK_ALLOW_ENABLED معطّلة — ستعمل هذه السياسة فعليًا كـ«مقيّد».
                    </span>
                  )}
                </label>

                {policy === "controlled" && (
                  <label className="block">
                    <span className="text-xs font-bold text-slate-600">
                      الحد الأقصى للعجز <span className="text-rose-600">*</span>
                    </span>
                    <input
                      type="number"
                      min={0}
                      step="any"
                      inputMode="decimal"
                      className="field mt-1"
                      value={maxQty}
                      disabled={processing}
                      onChange={(e) => setMaxQty(e.target.value)}
                      aria-label="الحد الأقصى للعجز"
                    />
                    <span className="mt-1 block text-[11px] font-medium text-slate-400">
                      أقصى كمية مسموح بها تحت الصفر (بوحدة الصنف). صفر يعني عدم السماح بأي عجز فعليًا.
                    </span>
                  </label>
                )}

                <ToggleField
                  label="سبب إلزامي"
                  hint="يُطلب سبب نصي عند كل عملية صرف تُنشئ عجزًا."
                  checked={requireReason}
                  disabled={processing}
                  onChange={setRequireReason}
                />
                <ToggleField
                  label="الصف مفعّل"
                  hint="تعطيل الصف يجعله غير مُعتبر في القرار الفعلي دون حذفه."
                  checked={isEnabled}
                  disabled={processing}
                  onChange={setIsEnabled}
                />
              </div>

              {errorMessage && (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
                  <span className="min-w-0 flex-1">{errorMessage}</span>
                  {isConflict && (
                    <Button variant="secondary" size="sm" onClick={refreshAfterConflict}>
                      <RefreshCw className="h-3.5 w-3.5" /> تحديث
                    </Button>
                  )}
                </div>
              )}

      </section>
    </FullPageFlow>
  );
}
