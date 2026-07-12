import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { X, Plus, Trash2 } from "lucide-react";
import { PageHeader } from "@/shared/ui";
import { Button } from "@/shared/ui";
import { ApiError } from "@/shared/api";
import { useWarehouses } from "@/modules/inventory/lib/hooks/useWarehouses";
import { useWarehouseScope } from "@/modules/inventory/lib/warehouse-scope-provider";
import { formatQty } from "@/shared/lib";
import { useStocktakeMutations } from "@/modules/inventory/lib/hooks/useStocktakes";
import { createStocktakeInput } from "@/modules/inventory/lib/schemas/stocktake.schema";
import { SearchableEntityCombobox } from "@/shared/ui";
import { makeItemFetcher, type ItemHit } from "@/modules/inventory/lib/hooks/useEntitySearch";

type Scope = "full" | "category" | "items";

export function StocktakeWizard() {
  const navigate = useNavigate();
  const { accessibleWarehouses, allWarehousesAccess } = useWarehouseScope();
  const allWh = useWarehouses();
  const m = useStocktakeMutations();

  const [warehouseId, setWarehouseId] = useState("");
  const [scopeType, setScopeType] = useState<Scope>("full");
  const [categoryId, setCategoryId] = useState("");
  const [chosenItems, setChosenItems] = useState<{ id: string; name: string }[]>([]);
  const itemIds = useMemo(() => chosenItems.map((c) => c.id), [chosenItems]);
  const [includeZero, setIncludeZero] = useState(false);
  const [blindCount, setBlindCount] = useState(false);
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [evidenceThreshold, setEvidenceThreshold] = useState("");
  const [date, setDate] = useState("");
  const [notes, setNotes] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const whOptions = useMemo(() => {
    if (!allWarehousesAccess) return accessibleWarehouses.map((w) => ({ id: w.id, name: w.name }));
    return (allWh.data?.warehouses ?? []).map((w) => ({ id: w.id, name: w.name }));
  }, [allWarehousesAccess, accessibleWarehouses, allWh.data]);

  const itemFetcher = useMemo(() => makeItemFetcher({ warehouseId: warehouseId || undefined, context: "stocktake", activeOnly: true }), [warehouseId]);

  function buildPayload(): Record<string, unknown> {
    const base: Record<string, unknown> = { warehouseId, scopeType, reason, includeZero, blindCount, notes: notes || undefined, stocktakeDate: date || undefined };
    if (scopeType === "category") base.categoryId = categoryId;
    if (scopeType === "items") base.itemIds = itemIds;
    if (evidence) base.referenceEvidence = evidence;
    if (evidenceThreshold !== "") base.evidenceThreshold = Number(evidenceThreshold);
    return base;
  }

  function submit() {
    setErr(null);
    const payload = buildPayload();
    const r = createStocktakeInput.safeParse(payload);
    if (!r.success) { setErr(r.error.issues[0]?.message ?? "تحقّق من المدخلات"); return; }
    m.create.mutate(payload, {
      onSuccess: (res) => navigate(`/inventory/stocktakes?view=${(res.data?.id as string) ?? ""}`),
      onError: (e) => setErr(e instanceof ApiError ? e.message : "تعذّر إنشاء المحضر."),
    });
  }

  const canSubmit = !!warehouseId && reason.trim().length >= 2 && (scopeType !== "category" || !!categoryId.trim()) && (scopeType !== "items" || itemIds.length > 0);

  return (
    <div>
      <PageHeader eyebrow="الجرد والتسويات" title="جرد جديد" subtitle="حدّد المستودع والنطاق وإعدادات العد. تُجمّد قائمة الأصناف عند بدء العد."
        action={<Button variant="ghost" onClick={() => navigate("/inventory/stocktakes")}><X className="h-4 w-4" /> إغلاق</Button>} />

      <div className="surface space-y-4 p-5">
        {err && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">{err}</p>}

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-xs font-bold text-slate-500">المستودع
            <select className="field mt-1 w-full" value={warehouseId} onChange={(e) => { setWarehouseId(e.target.value); setChosenItems([]); }} aria-label="المستودع">
              <option value="">اختر المستودع</option>
              {whOptions.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
          <label className="block text-xs font-bold text-slate-500">التاريخ
            <input type="date" className="field mt-1 w-full" value={date} onChange={(e) => setDate(e.target.value)} aria-label="التاريخ" />
          </label>

          <label className="block text-xs font-bold text-slate-500">نطاق الجرد
            <select className="field mt-1 w-full" value={scopeType} onChange={(e) => setScopeType(e.target.value as Scope)} aria-label="نطاق الجرد">
              <option value="full">كامل المستودع</option>
              <option value="category">حسب الفئة</option>
              <option value="items">أصناف محددة</option>
            </select>
          </label>
          {scopeType === "category" && (
            <label className="block text-xs font-bold text-slate-500">الفئة
              <input className="field mt-1 w-full" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} placeholder="اسم الفئة كما في الأصناف" aria-label="الفئة" />
            </label>
          )}

          <label className="block text-xs font-bold text-slate-500 sm:col-span-2">السبب (إلزامي)
            <input className="field mt-1 w-full" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="مثال: جرد دوري شهري" aria-label="السبب" />
          </label>

          <label className="flex items-center gap-2 text-xs font-bold text-slate-600"><input type="checkbox" checked={includeZero} onChange={(e) => setIncludeZero(e.target.checked)} /> تضمين الأصناف ذات الرصيد صفر</label>
          <label className="flex items-center gap-2 text-xs font-bold text-slate-600"><input type="checkbox" checked={blindCount} onChange={(e) => setBlindCount(e.target.checked)} /> عدّ أعمى (إخفاء رصيد النظام أثناء العد)</label>

          <label className="block text-xs font-bold text-slate-500">عتبة الدليل للفرق الكبير (اختياري)
            <input type="number" min={0} step="any" className="field mt-1 w-full" value={evidenceThreshold} onChange={(e) => setEvidenceThreshold(e.target.value)} placeholder="القيمة التي تستوجب دليلًا" aria-label="عتبة الدليل" />
          </label>
          <label className="block text-xs font-bold text-slate-500">دليل/مرجع (للفروقات الكبيرة)
            <input className="field mt-1 w-full" value={evidence} onChange={(e) => setEvidence(e.target.value)} aria-label="الدليل" />
          </label>

          <label className="block text-xs font-bold text-slate-500 sm:col-span-2">ملاحظات
            <textarea className="field mt-1 w-full" value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="ملاحظات" />
          </label>
        </div>

        {scopeType === "items" && (
          <div className="rounded-xl border border-slate-100 p-3">
            <div className="mb-2 flex flex-col gap-1">
              <span className="text-xs font-bold text-slate-500">الأصناف المحددة (بحث بالاسم/SKU/الباركود)</span>
              <div className="max-w-md">
                <SearchableEntityCombobox<ItemHit>
                  value={null}
                  onChange={(hit) => { if (hit && !itemIds.includes(hit.id)) setChosenItems((s) => [...s, { id: hit.id, name: hit.name }]); }}
                  fetcher={itemFetcher}
                  queryKey={["item-search", warehouseId, "stocktake"]}
                  getKey={(it) => it.id}
                  getLabel={(it) => it.name}
                  getSublabel={(it) => [it.sku, it.warehouseQty != null ? `${formatQty(it.warehouseQty)} ${it.baseUnit.name}` : null].filter(Boolean).join(" · ") || undefined}
                  placeholder="ابحث عن صنف لإضافته للنطاق…"
                  ariaLabel="إضافة صنف للجرد"
                  autoSelectExact
                  emptyText="لا أصناف مطابقة."
                />
              </div>
            </div>
            {chosenItems.length === 0 ? <p className="text-xs text-slate-400">لم تُحدَّد أصناف بعد.</p> : (
              <div className="flex flex-wrap gap-2">
                {chosenItems.map((r) => (
                  <span key={r.id} className="flex items-center gap-1 rounded-lg bg-slate-100 px-2 py-1 text-xs font-bold text-slate-700">{r.name}
                    <button type="button" aria-label="حذف" onClick={() => setChosenItems((s) => s.filter((x) => x.id !== r.id))}><Trash2 className="h-3.5 w-3.5 text-slate-400 hover:text-rose-600" /></button>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end">
          <Button variant="primary" disabled={!canSubmit || m.create.isPending} onClick={submit}><Plus className="h-4 w-4" /> {m.create.isPending ? "جارٍ الإنشاء…" : "إنشاء المحضر"}</Button>
        </div>
      </div>
    </div>
  );
}
