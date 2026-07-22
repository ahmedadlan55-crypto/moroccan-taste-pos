// D1 — Branches & warehouses assignment editor (form section d). Controlled by
// the parent ItemFormPage; renders one row per item↔warehouse assignment with a
// dependent branch→warehouse picker, a default-warehouse affordance, per-location
// reorder rules, and a "assign to all branches" shortcut. Cross-branch and
// duplicate assignments are rejected client-side (server D3 is the real gate).
import { useMemo } from "react";
import { Plus, Trash2, Layers, Star } from "lucide-react";
import { Button, Select, Badge } from "@/shared/ui";
import { useT } from "@/i18n";
import {
  type AssignmentDraft,
  type WarehouseUniverseRow,
  blankAssignment,
  allBranchesDrafts,
  validateAssignments,
} from "./assignment-utils";

const RULE_FIELDS: { key: keyof AssignmentDraft; labelKey: string }[] = [
  { key: "reorderPoint", labelKey: "items.assign.reorderPoint" },
  { key: "reorderQty", labelKey: "items.assign.reorderQty" },
  { key: "maxStock", labelKey: "items.assign.maxStock" },
  { key: "safetyStock", labelKey: "items.assign.safetyStock" },
  { key: "minQty", labelKey: "items.assign.minQty" },
  { key: "leadTimeDays", labelKey: "items.assign.leadTimeDays" },
];

export interface AssignmentsSectionProps {
  drafts: AssignmentDraft[];
  onChange: (drafts: AssignmentDraft[]) => void;
  defaultWarehouseId: string;
  onDefaultChange: (warehouseId: string) => void;
  universe: WarehouseUniverseRow[];
  branches: { id: string; name: string }[];
  disabled?: boolean;
  pending?: boolean; // create flow — assignments applied after save
}

export function AssignmentsSection({
  drafts, onChange, defaultWarehouseId, onDefaultChange, universe, branches, disabled, pending,
}: AssignmentsSectionProps) {
  const t = useT();
  const validation = useMemo(() => validateAssignments(drafts, universe), [drafts, universe]);

  const patchRow = (key: string, p: Partial<AssignmentDraft>) =>
    onChange(drafts.map((d) => (d.key === key ? { ...d, ...p } : d)));
  const removeRow = (key: string) => {
    const removed = drafts.find((d) => d.key === key);
    onChange(drafts.filter((d) => d.key !== key));
    if (removed && removed.warehouseId === defaultWarehouseId) onDefaultChange("");
  };
  const addRow = () => onChange([...drafts, blankAssignment()]);
  const assignAll = () => onChange(allBranchesDrafts(universe, drafts));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold text-slate-500">{t("items.assign.subtitle")}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" size="sm" disabled={disabled} onClick={assignAll} title={t("items.assign.allBranchesHint")}>
            <Layers className="h-4 w-4" /> <span className="whitespace-normal">{t("items.assign.allBranches")}</span>
          </Button>
          <Button type="button" variant="secondary" size="sm" disabled={disabled} onClick={addRow}>
            <Plus className="h-4 w-4" /> {t("items.assign.addLocation")}
          </Button>
        </div>
      </div>

      {pending && <p className="rounded-lg bg-blue-50 px-3 py-2 text-xs font-bold text-blue-700">{t("items.assign.savePending")}</p>}

      {validation.cross && (
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
          {t("items.assign.crossBranchError", { warehouse: validation.cross.warehouse, branch: validation.cross.branch })}
        </p>
      )}
      {validation.duplicate && (
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
          {t("items.assign.duplicateWarehouse", { warehouse: validation.duplicate })}
        </p>
      )}
      {validation.ruleIssue && (
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{t("items.assign." + validation.ruleIssue.issue)}</p>
      )}

      {drafts.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-xs text-slate-400">{t("items.assign.emptyAssignments")}</p>
      ) : (
        <div className="space-y-3">
          {drafts.map((d) => {
            const whInBranch = universe.filter((w) => (!d.branchId || w.branchId === d.branchId) && (w.isActive || w.id === d.warehouseId));
            const isDefault = !!d.warehouseId && d.warehouseId === defaultWarehouseId;
            return (
              <div key={d.key} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="flex flex-wrap items-end gap-2">
                  <label className="flex flex-col gap-0.5 text-[10px] font-bold text-slate-400">
                    {t("items.assign.branch")}
                    <Select
                      className="h-9 w-40"
                      value={d.branchId}
                      disabled={disabled}
                      onChange={(e) => patchRow(d.key, { branchId: e.target.value, warehouseId: "" })}
                      aria-label={t("items.assign.branch")}
                    >
                      <option value="">{t("items.assign.pickBranch")}</option>
                      {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </Select>
                  </label>
                  <label className="flex flex-col gap-0.5 text-[10px] font-bold text-slate-400">
                    {t("items.assign.warehouse")}
                    <Select
                      className="h-9 w-48"
                      value={d.warehouseId}
                      disabled={disabled || !d.branchId}
                      onChange={(e) => patchRow(d.key, { warehouseId: e.target.value })}
                      aria-label={t("items.assign.warehouse")}
                    >
                      <option value="">{t("items.assign.pickWarehouse")}</option>
                      {whInBranch.map((w) => <option key={w.id} value={w.id}>{w.name}{w.code ? ` (${w.code})` : ""}</option>)}
                    </Select>
                    {d.branchId && whInBranch.length === 0 && <span className="text-[10px] font-bold text-amber-600">{t("items.assign.noWarehousesInBranch")}</span>}
                  </label>
                  <label className="flex items-center gap-1 pb-2 text-[11px] font-bold text-slate-600">
                    <input type="checkbox" checked={d.isActive} disabled={disabled} onChange={(e) => patchRow(d.key, { isActive: e.target.checked })} /> {t("items.assign.activeHere")}
                  </label>
                  <button
                    type="button"
                    disabled={disabled || !d.warehouseId}
                    onClick={() => onDefaultChange(d.warehouseId)}
                    className={`mb-1 inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-bold transition disabled:opacity-40 ${
                      isDefault ? "bg-teal-600 text-white" : "bg-white text-slate-500 ring-1 ring-slate-200 hover:bg-slate-100"
                    }`}
                    aria-pressed={isDefault}
                  >
                    <Star className="h-3.5 w-3.5" /> {isDefault ? t("items.assign.isDefault") : t("items.assign.setDefault")}
                  </button>
                  <div className="flex-1" />
                  {isDefault && <Badge tone="teal">{t("items.assign.isDefault")}</Badge>}
                  {!disabled && (
                    <Button type="button" variant="ghost" size="icon" aria-label={t("items.assign.remove")} onClick={() => removeRow(d.key)}>
                      <Trash2 className="h-4 w-4 text-rose-500" />
                    </Button>
                  )}
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                  {RULE_FIELDS.map((f) => (
                    <label key={f.key} className="flex flex-col gap-0.5 text-[10px] font-bold text-slate-400">
                      {t(f.labelKey)}
                      <input
                        type="number"
                        min={0}
                        step="any"
                        dir="ltr"
                        className="field h-9 text-center tabular-nums"
                        value={d[f.key] as string}
                        disabled={disabled}
                        onChange={(e) => patchRow(d.key, { [f.key]: e.target.value } as Partial<AssignmentDraft>)}
                        aria-label={t(f.labelKey)}
                      />
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
