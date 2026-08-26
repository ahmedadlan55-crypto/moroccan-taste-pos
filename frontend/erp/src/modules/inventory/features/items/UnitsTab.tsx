// Phase U — units and conversions tab inside the item detail view.
// Manage the base unit + major units (carton/bag), the conversion factor, the
// decimal precision, the allowed document contexts, and per-unit activation.
// After the item has posted movements the factors + base are LOCKED (the backend
// enforces this with UNIT_LOCKED_BY_HISTORY) — the UI disables those fields and
// shows a warning, while still allowing new units / flag toggles / activation.

import { useEffect, useMemo, useState } from "react";
import { Plus, Save, Trash2, Lock, AlertTriangle } from "lucide-react";
import { Button, Checkbox } from "@/shared/ui";
import { LoadingState, ErrorState } from "@/shared/ui";
import { formatQty } from "@/shared/lib";
import { useT } from "@/i18n";
import { useItemUnits, useItemUnitsMutation, type ItemUnitRow } from "@/modules/inventory/lib/hooks/useItemUnits";

const CONTEXTS: { key: keyof ItemUnitRow; labelKey: string }[] = [
  { key: "allowPurchase", labelKey: "inventoryRest.itemUnits.context.purchase" },
  { key: "allowReceipt", labelKey: "inventoryRest.itemUnits.context.receipt" },
  { key: "allowIssue", labelKey: "inventoryRest.itemUnits.context.issue" },
  { key: "allowTransfer", labelKey: "inventoryRest.itemUnits.context.transfer" },
  { key: "allowStocktake", labelKey: "inventoryRest.itemUnits.context.stocktake" },
  { key: "allowProduction", labelKey: "inventoryRest.itemUnits.context.production" },
  { key: "allowSale", labelKey: "inventoryRest.itemUnits.context.sale" },
];

function blankMajor(): ItemUnitRow {
  return { unitName: "", unitCode: "", isBase: false, conversionToBase: 1, precision: 2, allowPurchase: true, allowReceipt: true, allowIssue: true, allowTransfer: true, allowStocktake: true, allowProduction: true, allowSale: true, isActive: true };
}

export function UnitsTab({ itemId, baseUnitName }: { itemId: string; baseUnitName: string }) {
  const t = useT();
  const q = useItemUnits(itemId);
  const mut = useItemUnitsMutation(itemId);
  const [rows, setRows] = useState<ItemUnitRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const hasMovements = q.data?.hasMovements ?? false;
  const version = q.data?.item.version ?? 0;

  useEffect(() => {
    if (!q.data) return;
    if (q.data.units.length) setRows(q.data.units.map((u) => ({ ...u })));
    else setRows([{ ...blankMajor(), unitName: baseUnitName || t("inventoryRest.itemUnits.fallbackBaseUnit"), unitCode: "BASE", isBase: true, conversionToBase: 1 }]);
  // Refresh from the server, not merely because the interface language changed;
  // otherwise switching language would silently discard unsaved unit edits.
  }, [q.data, baseUnitName]);

  const base = useMemo(() => rows.find((r) => r.isBase), [rows]);
  const majors = rows.filter((r) => !r.isBase);
  const existingCodes = useMemo(() => new Set((q.data?.units ?? []).map((u) => u.unitCode.toUpperCase())), [q.data]);

  function patch(idx: number, p: Partial<ItemUnitRow>) { setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, ...p } : r))); setOk(false); }
  function addMajor() { setRows((rs) => [...rs, blankMajor()]); setOk(false); }
  function remove(idx: number) { setRows((rs) => rs.filter((_, i) => i !== idx)); setOk(false); }

  function save() {
    setErr(null); setOk(false);
    // client sanity: one base, base factor 1, positive factors, unique codes
    const bases = rows.filter((r) => r.isBase);
    if (bases.length !== 1) { setErr(t("inventoryRest.itemUnits.validation.oneBase")); return; }
    if (Number(bases[0].conversionToBase) !== 1) { setErr(t("inventoryRest.itemUnits.validation.baseFactor")); return; }
    const codes = new Set<string>();
    for (const r of rows) {
      const c = (r.unitCode || "").trim().toUpperCase();
      if (!c) { setErr(t("inventoryRest.itemUnits.validation.codeRequired")); return; }
      if (codes.has(c)) { setErr(t("inventoryRest.itemUnits.validation.duplicateCode", { code: c })); return; }
      codes.add(c);
      if (!(Number(r.conversionToBase) > 0)) { setErr(t("inventoryRest.itemUnits.validation.invalidFactor", { code: c })); return; }
    }
    mut.mutate(
      { units: rows, expectedVersion: version },
      {
        onSuccess: () => { setOk(true); q.refetch(); },
        onError: () => setErr(t("inventoryRest.itemUnits.validation.saveFailed")),
      },
    );
  }

  if (q.isLoading) return <LoadingState rows={3} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;

  return (
    <div className="space-y-4">
      {hasMovements && (
        <p className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-xs font-bold leading-5 text-amber-800">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {t("inventoryRest.itemUnits.movementLock")}
        </p>
      )}
      {err && <p className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-3 text-xs font-bold leading-5 text-rose-700"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {err}</p>}
      {ok && <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-xs font-bold text-emerald-700">{t("inventoryRest.itemUnits.saved")}</p>}

      {/* Base unit */}
      {base && (
        <section className="rounded-2xl border border-teal-200 bg-teal-50/50 p-4">
          <div className="mb-3">
            <h3 className="text-sm font-extrabold text-teal-900">{t("inventoryRest.itemUnits.baseTitle")}</h3>
            <p className="mt-0.5 text-xs font-medium leading-5 text-teal-800/80">{t("inventoryRest.itemUnits.baseSubtitle")}</p>
          </div>
          <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Field label={t("inventoryRest.itemUnits.field.name")}><input className="field min-h-11 w-full" value={base.unitName} onChange={(e) => patch(rows.indexOf(base), { unitName: e.target.value })} aria-label={t("inventoryRest.itemUnits.aria.baseName")} /></Field>
            <Field label={t("inventoryRest.itemUnits.field.code")}><input className="field min-h-11 w-full font-mono" dir="ltr" value={base.unitCode} disabled={hasMovements} onChange={(e) => patch(rows.indexOf(base), { unitCode: e.target.value.toUpperCase() })} aria-label={t("inventoryRest.itemUnits.aria.baseCode")} /></Field>
            <Field label={t("inventoryRest.itemUnits.field.precision")}><input type="number" min={0} max={6} className="field min-h-11 w-full text-center tabular-nums" value={base.precision} onChange={(e) => patch(rows.indexOf(base), { precision: Number(e.target.value) })} aria-label={t("inventoryRest.itemUnits.aria.basePrecision")} dir="ltr" /></Field>
            <span className="flex min-h-11 items-center justify-center rounded-xl border border-teal-100 bg-white px-3 text-center text-xs font-bold text-slate-600">{t("inventoryRest.itemUnits.baseFactor")}</span>
          </div>
        </section>
      )}

      {/* Major units */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-extrabold text-slate-800">{t("inventoryRest.itemUnits.majorsTitle")}</h3>
            <p className="mt-0.5 text-xs font-medium leading-5 text-slate-500">{t("inventoryRest.itemUnits.majorsSubtitle")}</p>
          </div>
          <Button className="w-full sm:w-auto" variant="secondary" size="sm" onClick={addMajor}><Plus className="h-4 w-4" aria-hidden="true" /> {t("inventoryRest.itemUnits.addUnit")}</Button>
        </div>
        {majors.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-200 p-5 text-center text-xs font-medium leading-5 text-slate-500">{t("inventoryRest.itemUnits.emptyMajors")}</p>
        ) : majors.map((u) => {
          const idx = rows.indexOf(u);
          const locked = hasMovements && existingCodes.has((u.unitCode || "").toUpperCase());
          return (
            <section key={idx} className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
              <div className="mb-3 flex min-w-0 flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 break-words text-sm font-extrabold text-slate-800">{u.unitName || t("inventoryRest.itemUnits.unnamedUnit")}</span>
                {locked ? <span className="flex min-h-11 items-center gap-1.5 rounded-xl bg-amber-50 px-3 text-xs font-bold text-amber-700"><Lock className="h-4 w-4" aria-hidden="true" /> {t("inventoryRest.itemUnits.factorLocked")}</span>
                  : <Button variant="ghost" size="icon" aria-label={t("inventoryRest.itemUnits.aria.deleteUnit", { name: u.unitName || t("inventoryRest.itemUnits.unnamedUnit") })} onClick={() => remove(idx)}><Trash2 className="h-4 w-4 text-rose-500" aria-hidden="true" /></Button>}
              </div>
              <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Field label={t("inventoryRest.itemUnits.field.name")}><input className="field min-h-11 w-full" value={u.unitName} onChange={(e) => patch(idx, { unitName: e.target.value })} aria-label={t("inventoryRest.itemUnits.aria.unitName")} /></Field>
                <Field label={t("inventoryRest.itemUnits.field.code")}><input className="field min-h-11 w-full font-mono" dir="ltr" value={u.unitCode} disabled={locked} onChange={(e) => patch(idx, { unitCode: e.target.value.toUpperCase() })} aria-label={t("inventoryRest.itemUnits.aria.unitCode")} /></Field>
                <Field label={t("inventoryRest.itemUnits.field.conversion", { unit: u.unitName || t("inventoryRest.itemUnits.unnamedUnit") })}>
                  <input type="number" min={0} step="any" className="field min-h-11 w-full text-center tabular-nums" value={u.conversionToBase} disabled={locked} onChange={(e) => patch(idx, { conversionToBase: Number(e.target.value) })} aria-label={t("inventoryRest.itemUnits.aria.conversion")} dir="ltr" />
                </Field>
                <Field label={t("inventoryRest.itemUnits.field.precision")}><input type="number" min={0} max={6} className="field min-h-11 w-full text-center tabular-nums" value={u.precision} onChange={(e) => patch(idx, { precision: Number(e.target.value) })} aria-label={t("inventoryRest.itemUnits.aria.precision")} dir="ltr" /></Field>
              </div>
              {u.conversionToBase > 0 && (
                <p className="mt-3 break-words rounded-xl bg-teal-50 px-3 py-2 text-start text-xs font-bold text-teal-800">{t("inventoryRest.itemUnits.equation", { major: u.unitName || t("inventoryRest.itemUnits.unnamedUnit"), factor: formatQty(u.conversionToBase), base: baseUnitName || t("inventoryRest.itemUnits.fallbackBaseUnit") })}</p>
              )}
              <fieldset className="mt-3 border-t border-slate-200 pt-3">
                <legend className="mb-1 text-xs font-extrabold text-slate-600">{t("inventoryRest.itemUnits.contextsTitle")}</legend>
                <div className="grid grid-cols-2 gap-x-3 sm:grid-cols-3 xl:grid-cols-4">
                  <Checkbox label={t("inventoryRest.itemUnits.field.active")} checked={u.isActive} onChange={(e) => patch(idx, { isActive: e.target.checked })} />
                {CONTEXTS.map((c) => (
                    <Checkbox key={c.key} label={t(c.labelKey)} checked={!!u[c.key]} onChange={(e) => patch(idx, { [c.key]: e.target.checked } as Partial<ItemUnitRow>)} />
                ))}
                </div>
              </fieldset>
            </section>
          );
        })}
      </div>

      <div className="grid grid-cols-1 border-t border-slate-100 pt-4 sm:flex sm:justify-end">
        <Button className="w-full sm:w-auto" variant="primary" disabled={mut.isPending} onClick={save}><Save className="h-4 w-4" aria-hidden="true" /> {mut.isPending ? t("inventoryRest.itemUnits.saving") : t("inventoryRest.itemUnits.save")}</Button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex min-w-0 flex-col gap-1"><span className="break-words text-xs font-bold leading-5 text-slate-500">{label}</span>{children}</label>;
}
