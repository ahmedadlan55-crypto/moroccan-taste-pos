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
import { useT } from "@/i18n";
import { queryKeys } from "@/modules/inventory/lib/query-keys";
import { useSavePolicy } from "@/modules/inventory/lib/hooks/useNegativePolicy";
import type { PolicyMode, PolicyRow, PolicyScope } from "@/modules/inventory/lib/adapters/negative-policy.adapter";
import { policyLabel, scopeLabel } from "./labels";
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

export function PolicyDialog({ open, onClose, scope, row = null, warehouseOptions, allowEnabled }: PolicyDialogProps) {
  const t = useT();
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
      setClientError(t("inventoryRest.negativePolicy.dialog.pickWarehouseFirst"));
      return;
    }
    if (scope === "item" && !item) {
      setClientError(t("inventoryRest.negativePolicy.dialog.pickItemFirst"));
      return;
    }
    const maxN = Number(maxQty);
    if (policy === "controlled" && (!Number.isFinite(maxN) || maxN < 0)) {
      setClientError(t("inventoryRest.negativePolicy.dialog.maxDeficitInvalid"));
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
  const errorMessage = err ? (err instanceof Error ? err.message : t("inventoryRest.negativePolicy.dialog.unexpectedError")) : clientError;

  // A non-developer editing a stored `allow` row keeps seeing the current
  // value (disabled) — saving it as-is would 403, so the hint nudges a switch.
  const showAllowOption = isDeveloper || row?.policy === "allow";

  return (
    <FullPageFlow
      open={open}
      onClose={onClose}
      title={t(`inventoryRest.negativePolicy.dialogTitle.${scope}`)}
      description={row?.version != null ? t("inventoryRest.negativePolicy.dialog.descVersion", { version: row.version }) : t("inventoryRest.negativePolicy.dialog.descNew")}
      eyebrow={t("inventoryRest.negativePolicy.dialog.eyebrow", { scope: scopeLabel(t, scope) })}
      icon={ShieldAlert}
      size="sm"
      dismissable={!processing}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={processing}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={submit} disabled={processing}>
            {processing ? (
              <>
                <Spinner className="h-4 w-4" /> {t("inventoryRest.ui.saving")}
              </>
            ) : (
              t("inventoryRest.negativePolicy.dialog.save")
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
                      {t("inventoryRest.negativePolicy.col.warehouse")} <span className="text-rose-600">*</span>
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
                        <option value="">{t("inventoryRest.negativePolicy.pickWarehouse")}</option>
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
                      {t("inventoryRest.negativePolicy.col.item")} <span className="text-rose-600">*</span>
                    </span>
                    <div className="mt-1">
                      <ItemSearchSelect value={item} onChange={setItem} disabled={editing || processing} />
                    </div>
                    <p className="mt-1 text-[11px] font-medium leading-4 text-slate-400">
                      {t("inventoryRest.negativePolicy.dialog.trackedItemHint")}
                    </p>
                  </div>
                )}

                <label className="block">
                  <span className="text-xs font-bold text-slate-600">{t("inventoryRest.negativePolicy.col.policy")}</span>
                  <select
                    className="field mt-1"
                    value={policy}
                    disabled={processing}
                    onChange={(e) => setPolicy(e.target.value as PolicyMode)}
                  >
                    <option value="block">{policyLabel(t, "block")}</option>
                    <option value="controlled">{policyLabel(t, "controlled")}</option>
                    {showAllowOption && (
                      <option value="allow" disabled={!isDeveloper}>
                        {policyLabel(t, "allow")} — {t("inventoryRest.negativePolicy.dialog.developerOnlySuffix")}
                      </option>
                    )}
                  </select>
                  {policy === "allow" && !allowEnabled && (
                    <span className="mt-1 block rounded-lg bg-amber-50 px-2 py-1 text-[11px] font-bold text-amber-700">
                      {t("inventoryRest.negativePolicy.dialog.allowGateWarning")}
                    </span>
                  )}
                </label>

                {policy === "controlled" && (
                  <label className="block">
                    <span className="text-xs font-bold text-slate-600">
                      {t("inventoryRest.negativePolicy.col.maxDeficit")} <span className="text-rose-600">*</span>
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
                      aria-label={t("inventoryRest.negativePolicy.col.maxDeficit")}
                    />
                    <span className="mt-1 block text-[11px] font-medium text-slate-400">
                      {t("inventoryRest.negativePolicy.dialog.maxDeficitHint")}
                    </span>
                  </label>
                )}

                <ToggleField
                  label={t("inventoryRest.negativePolicy.col.requireReason")}
                  hint={t("inventoryRest.negativePolicy.dialog.requireReasonHint")}
                  checked={requireReason}
                  disabled={processing}
                  onChange={setRequireReason}
                />
                <ToggleField
                  label={t("inventoryRest.negativePolicy.dialog.rowEnabledLabel")}
                  hint={t("inventoryRest.negativePolicy.dialog.rowEnabledHint")}
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
                      <RefreshCw className="h-3.5 w-3.5" /> {t("inventoryRest.ui.refresh")}
                    </Button>
                  )}
                </div>
              )}

      </section>
    </FullPageFlow>
  );
}
