import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { X, Save, AlertTriangle } from "lucide-react";
import { PageHeader } from "@/shared/ui";
import { Button } from "@/shared/ui";
import { LoadingState } from "@/shared/ui";
import { ApiError } from "@/shared/api";
import { useUnits, useItemCategories, useItemDetail, useItemMutations } from "@/modules/inventory/lib/hooks/useItems";
import { createItemInput, updateItemInput } from "@/modules/inventory/lib/schemas/item.schema";

export function ItemWizard() {
  const navigate = useNavigate();
  const [sp] = useSearchParams();
  const editId = sp.get("edit");
  const units = useUnits();
  const cats = useItemCategories();
  const m = useItemMutations();
  const edit = useItemDetail(editId);

  const [f, setF] = useState<Record<string, string>>({});
  const [prefilled, setPrefilled] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (editId && edit.data && !prefilled) {
    const d = edit.data;
    setF({ name: d.name, nameEn: d.nameEn, sku: d.sku, unit: d.unit, category: d.category, cost: String(d.cost), minStock: String(d.minStock), maxStock: String(d.maxStock), description: d.description, notes: d.notes });
    setPrefilled(true);
  }
  const moved = !!editId && !!edit.data?.hasMovements;
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));
  const num = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number(v));

  function buildPayload(): Record<string, unknown> {
    const base: Record<string, unknown> = {
      name: (f.name || "").trim(), sku: (f.sku || "").trim(), unit: (f.unit || "").trim(),
      nameEn: f.nameEn || undefined, category: f.category || undefined,
      cost: num(f.cost), minStock: num(f.minStock), maxStock: num(f.maxStock),
      description: f.description || undefined, notes: f.notes || undefined,
    };
    return base;
  }
  function submit() {
    setErr(null);
    const payload = buildPayload();
    const schema = editId ? updateItemInput : createItemInput;
    const toValidate = editId ? { ...payload, expectedVersion: edit.data?.version ?? 0 } : payload;
    const r = schema.safeParse(toValidate);
    if (!r.success) { setErr(r.error.issues[0]?.message ?? "تحقّق من المدخلات"); return; }
    const onErr = (e: unknown) => setErr(e instanceof ApiError ? (e.isConflict ? "تغيّر الصنف منذ آخر تحميل — أعد التحميل." : e.message) : "تعذّر الحفظ.");
    if (editId) m.update.mutate({ id: editId, input: { ...payload, expectedVersion: edit.data?.version ?? 0 } }, { onSuccess: () => navigate(`/inventory/items?view=${editId}`), onError: onErr });
    else m.create.mutate(payload, { onSuccess: (res) => navigate(`/inventory/items?view=${res.id ?? ""}`), onError: onErr });
  }

  const saving = m.create.isPending || m.update.isPending;
  if (editId && edit.isLoading) return <div className="p-4"><LoadingState rows={2} /></div>;
  const canSubmit = (f.name || "").trim().length >= 1 && (f.sku || "").trim().length >= 1 && (f.unit || "").trim().length >= 1;

  return (
    <div>
      <PageHeader eyebrow="كتالوج الأصناف" title={editId ? `تعديل صنف — ${edit.data?.name ?? ""}` : "صنف جديد"} subtitle="بيانات الصنف الأساسية. متوسط تكلفة المستودع (WAC) لا يُحرَّر هنا."
        action={<Button variant="ghost" onClick={() => navigate("/inventory/items")}><X className="h-4 w-4" /> إغلاق</Button>} />
      <div className="surface space-y-4 p-5">
        {err && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">{err}</p>}
        {moved && <p className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800"><AlertTriangle className="h-4 w-4" /> لهذا الصنف حركات — لا يمكن تغيير الـ SKU أو الوحدة (محظور حفاظًا على سلامة التاريخ).</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-xs font-bold text-slate-500">الاسم (عربي)
            <input className="field mt-1 w-full" value={f.name ?? ""} onChange={(e) => set("name", e.target.value)} aria-label="الاسم" />
          </label>
          <label className="block text-xs font-bold text-slate-500">الاسم (إنجليزي)
            <input className="field mt-1 w-full" value={f.nameEn ?? ""} onChange={(e) => set("nameEn", e.target.value)} aria-label="الاسم بالإنجليزية" />
          </label>
          <label className="block text-xs font-bold text-slate-500">SKU
            <input className="field mt-1 w-full font-mono" value={f.sku ?? ""} onChange={(e) => set("sku", e.target.value)} aria-label="SKU" disabled={moved} />
          </label>
          <label className="block text-xs font-bold text-slate-500">الوحدة
            <input className="field mt-1 w-full" list="im-units" value={f.unit ?? ""} onChange={(e) => set("unit", e.target.value)} aria-label="الوحدة" disabled={moved} />
            <datalist id="im-units">{(units.data ?? []).map((u) => <option key={u.code} value={u.code}>{u.nameAr}</option>)}</datalist>
          </label>
          <label className="block text-xs font-bold text-slate-500">الفئة
            <input className="field mt-1 w-full" list="im-cats" value={f.category ?? ""} onChange={(e) => set("category", e.target.value)} aria-label="الفئة" />
            <datalist id="im-cats">{(cats.data ?? []).map((c) => <option key={c} value={c} />)}</datalist>
          </label>
          <label className="block text-xs font-bold text-slate-500">التكلفة العامة (fallback فقط)
            <input type="number" min={0} step="any" className="field mt-1 w-full" value={f.cost ?? ""} onChange={(e) => set("cost", e.target.value)} aria-label="التكلفة" />
          </label>
          <label className="block text-xs font-bold text-slate-500">الحد الأدنى العام
            <input type="number" min={0} step="any" className="field mt-1 w-full" value={f.minStock ?? ""} onChange={(e) => set("minStock", e.target.value)} aria-label="الحد الأدنى" />
          </label>
          <label className="block text-xs font-bold text-slate-500">الحد الأقصى العام
            <input type="number" min={0} step="any" className="field mt-1 w-full" value={f.maxStock ?? ""} onChange={(e) => set("maxStock", e.target.value)} aria-label="الحد الأقصى" />
          </label>
          <label className="block text-xs font-bold text-slate-500 sm:col-span-2">الوصف
            <textarea className="field mt-1 w-full" value={f.description ?? ""} onChange={(e) => set("description", e.target.value)} aria-label="الوصف" />
          </label>
        </div>
        <p className="rounded-lg bg-blue-50 px-3 py-2 text-xs font-bold text-blue-700">تعديل التكلفة العامة لا يغيّر WAC في أي مستودع. حدود المستودع الفعلية تُضبط من قواعد إعادة الطلب لكل مستودع.</p>
        <div className="flex justify-end">
          <Button variant="primary" disabled={!canSubmit || saving} onClick={submit}><Save className="h-4 w-4" /> {saving ? "جارٍ الحفظ…" : editId ? "حفظ التعديل" : "إنشاء الصنف"}</Button>
        </div>
      </div>
    </div>
  );
}
