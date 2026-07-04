// Phase U — "الوحدات والتحويلات" tab inside the item detail drawer.
// Manage the base unit + major units (carton/bag), the conversion factor, the
// decimal precision, the allowed document contexts, and per-unit activation.
// After the item has posted movements the factors + base are LOCKED (the backend
// enforces this with UNIT_LOCKED_BY_HISTORY) — the UI disables those fields and
// shows a warning, while still allowing new units / flag toggles / activation.

import { useEffect, useMemo, useState } from "react";
import { Plus, Save, Trash2, Lock, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadingState, ErrorState } from "@/components/states/States";
import { ApiError } from "@/lib/api-error";
import { formatQty } from "@/lib/formatters";
import { useItemUnits, useItemUnitsMutation, type ItemUnitRow } from "@/lib/hooks/useItemUnits";

const CONTEXTS: { key: keyof ItemUnitRow; label: string }[] = [
  { key: "allowPurchase", label: "شراء" }, { key: "allowReceipt", label: "استلام" },
  { key: "allowIssue", label: "صرف/تالف" }, { key: "allowTransfer", label: "تحويل" },
  { key: "allowStocktake", label: "جرد" }, { key: "allowProduction", label: "إنتاج" },
  { key: "allowSale", label: "بيع" },
];

function blankMajor(): ItemUnitRow {
  return { unitName: "", unitCode: "", isBase: false, conversionToBase: 1, precision: 2, allowPurchase: true, allowReceipt: true, allowIssue: true, allowTransfer: true, allowStocktake: true, allowProduction: true, allowSale: true, isActive: true };
}

export function UnitsTab({ itemId, baseUnitName }: { itemId: string; baseUnitName: string }) {
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
    else setRows([{ ...blankMajor(), unitName: baseUnitName || "الوحدة", unitCode: "BASE", isBase: true, conversionToBase: 1 }]);
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
    if (bases.length !== 1) { setErr("يجب تحديد وحدة أساسية واحدة بالضبط."); return; }
    if (Number(bases[0].conversionToBase) !== 1) { setErr("عامل الوحدة الأساسية يجب أن يساوي 1."); return; }
    const codes = new Set<string>();
    for (const r of rows) {
      const c = (r.unitCode || "").trim().toUpperCase();
      if (!c) { setErr("رمز الوحدة مطلوب لكل صف."); return; }
      if (codes.has(c)) { setErr(`رمز وحدة مكرر: ${c}`); return; }
      codes.add(c);
      if (!(Number(r.conversionToBase) > 0)) { setErr(`عامل تحويل غير صالح للوحدة ${c}.`); return; }
    }
    mut.mutate(
      { units: rows, expectedVersion: version },
      {
        onSuccess: () => { setOk(true); q.refetch(); },
        onError: (e) => setErr(e instanceof ApiError ? e.message : "تعذّر الحفظ."),
      },
    );
  }

  if (q.isLoading) return <LoadingState rows={3} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;

  return (
    <div className="space-y-3">
      {hasMovements && (
        <p className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800">
          <Lock className="h-4 w-4" /> هذا الصنف له حركات مُرحّلة — عوامل التحويل والوحدة الأساسية مقفلة. يمكنك إضافة وحدات جديدة أو تبديل السماحيات أو التفعيل/التعطيل فقط.
        </p>
      )}
      {err && <p className="flex items-center gap-2 rounded-lg bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700"><AlertTriangle className="h-4 w-4" /> {err}</p>}
      {ok && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700">حُفظت الوحدات والتحويلات بنجاح.</p>}

      {/* Base unit */}
      {base && (
        <div className="rounded-xl border border-teal-200 bg-teal-50/50 p-3">
          <div className="mb-2 text-xs font-extrabold text-teal-800">الوحدة الأساسية (المخزون والتكلفة دائمًا بها)</div>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="الاسم"><input className="field h-9 w-32" value={base.unitName} onChange={(e) => patch(rows.indexOf(base), { unitName: e.target.value })} aria-label="اسم الوحدة الأساسية" /></Field>
            <Field label="الرمز"><input className="field h-9 w-24" dir="ltr" value={base.unitCode} disabled={hasMovements} onChange={(e) => patch(rows.indexOf(base), { unitCode: e.target.value.toUpperCase() })} aria-label="رمز الوحدة الأساسية" /></Field>
            <Field label="الدقة"><input type="number" min={0} max={6} className="field h-9 w-20 text-center tabular-nums" value={base.precision} onChange={(e) => patch(rows.indexOf(base), { precision: Number(e.target.value) })} aria-label="دقة الوحدة الأساسية" dir="ltr" /></Field>
            <span className="grid h-9 place-items-center rounded-lg bg-white px-3 text-[11px] font-bold text-slate-500">العامل = 1 (ثابت)</span>
          </div>
        </div>
      )}

      {/* Major units */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-extrabold text-slate-700">الوحدات الكبرى (كرتون/شوال…)</span>
          <Button variant="secondary" size="sm" onClick={addMajor}><Plus className="h-4 w-4" /> إضافة وحدة</Button>
        </div>
        {majors.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-xs text-slate-400">لا وحدات كبرى — الصنف يُدار بالوحدة الأساسية فقط.</p>
        ) : majors.map((u) => {
          const idx = rows.indexOf(u);
          const locked = hasMovements && existingCodes.has((u.unitCode || "").toUpperCase());
          return (
            <div key={idx} className="rounded-xl border border-slate-150 bg-slate-50 p-3">
              <div className="flex flex-wrap items-end gap-2">
                <Field label="الاسم"><input className="field h-9 w-32" value={u.unitName} onChange={(e) => patch(idx, { unitName: e.target.value })} aria-label="اسم الوحدة" /></Field>
                <Field label="الرمز"><input className="field h-9 w-24" dir="ltr" value={u.unitCode} disabled={locked} onChange={(e) => patch(idx, { unitCode: e.target.value.toUpperCase() })} aria-label="رمز الوحدة" /></Field>
                <Field label={`العامل (1 = كم ${baseUnitName || "أساسي"})`}>
                  <input type="number" min={0} step="any" className="field h-9 w-28 text-center tabular-nums" value={u.conversionToBase} disabled={locked} onChange={(e) => patch(idx, { conversionToBase: Number(e.target.value) })} aria-label="عامل التحويل" dir="ltr" />
                </Field>
                <Field label="الدقة"><input type="number" min={0} max={6} className="field h-9 w-16 text-center tabular-nums" value={u.precision} onChange={(e) => patch(idx, { precision: Number(e.target.value) })} aria-label="الدقة" dir="ltr" /></Field>
                <label className="flex items-center gap-1 text-[11px] font-bold text-slate-600"><input type="checkbox" checked={u.isActive} onChange={(e) => patch(idx, { isActive: e.target.checked })} /> نشِطة</label>
                <div className="flex-1" />
                {locked ? <span className="flex items-center gap-1 text-[11px] font-bold text-amber-600"><Lock className="h-3.5 w-3.5" /> العامل مقفل</span>
                  : <Button variant="ghost" size="icon" aria-label="حذف الوحدة" onClick={() => remove(idx)}><Trash2 className="h-4 w-4 text-rose-500" /></Button>}
              </div>
              {u.conversionToBase > 0 && (
                <p className="mt-1 text-[11px] font-bold text-teal-700" dir="rtl">1 {u.unitName || "وحدة"} = <span dir="ltr" className="tabular-nums">{formatQty(u.conversionToBase)}</span> {baseUnitName}</p>
              )}
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                {CONTEXTS.map((c) => (
                  <label key={c.key} className="flex items-center gap-1 text-[11px] font-semibold text-slate-500">
                    <input type="checkbox" checked={!!u[c.key]} onChange={(e) => patch(idx, { [c.key]: e.target.checked } as Partial<ItemUnitRow>)} /> {c.label}
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex justify-end">
        <Button variant="primary" disabled={mut.isPending} onClick={save}><Save className="h-4 w-4" /> {mut.isPending ? "جارٍ الحفظ…" : "حفظ الوحدات"}</Button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex flex-col gap-0.5"><span className="text-[10px] font-bold text-slate-400">{label}</span>{children}</label>;
}
