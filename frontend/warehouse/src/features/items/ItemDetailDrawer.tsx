import { useState } from "react";
import { Boxes, Pencil, Power, PowerOff, Save } from "lucide-react";
import { Drawer } from "@/components/drawer/Drawer";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge/StatusBadge";
import { LoadingState, ErrorState } from "@/components/states/States";
import { ApiError } from "@/lib/api-error";
import { useCan } from "@/app/permission-provider";
import { formatCurrency, formatQty, formatDate } from "@/lib/formatters";
import { useItemDetail, useItemMutations } from "@/lib/hooks/useItems";
import type { ItemRule } from "@/lib/adapters/item.adapter";
import { BarcodesTab } from "./BarcodesTab";

const TABS = [
  { id: "basics", label: "البيانات الأساسية" },
  { id: "barcodes", label: "الباركود" },
  { id: "warehouses", label: "توزيع المستودعات" },
  { id: "stock", label: "الرصيد وWAC" },
  { id: "rules", label: "قواعد إعادة الطلب" },
  { id: "movements", label: "الحركات" },
  { id: "audit", label: "سجل التدقيق" },
] as const;
type TabId = (typeof TABS)[number]["id"];
const ACTION_LABEL: Record<string, string> = { create: "إنشاء", edit: "تعديل", activate: "تفعيل", deactivate: "تعطيل", rule: "قاعدة إعادة طلب" };

export function ItemDetailDrawer({ id, onClose, onEdit }: { id: string | null; onClose: () => void; onEdit: (id: string) => void }) {
  const q = useItemDetail(id);
  const m = useItemMutations();
  const canEdit = useCan("item.edit");
  const canActivate = useCan("item.activate");
  const [tab, setTab] = useState<TabId>("basics");
  const [err, setErr] = useState<string | null>(null);
  const d = q.data;
  const busy = m.activate.isPending || m.deactivate.isPending;
  function onError(e: unknown) {
    setErr(e instanceof ApiError ? (e.isConflict ? "تغيّر الصنف منذ آخر تحميل — أُعيد التحميل، حاول مجددًا." : e.message) : "تعذّر تنفيذ الإجراء.");
    if (e instanceof ApiError && e.isConflict) q.refetch();
  }

  return (
    <Drawer open={!!id} onClose={onClose} title={d?.name ?? "تفاصيل الصنف"} eyebrow="كتالوج الأصناف" icon={Boxes}>
      {!d ? (q.isLoading ? <LoadingState rows={3} /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : null) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <StatusBadge>{d.active ? "نشط" : "غير نشط"}</StatusBadge>
            <span className="font-mono text-xs text-slate-400">{d.sku || "—"}</span>
            <span className="text-xs font-bold text-slate-400">الإصدار {d.version}</span>
          </div>
          {err && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">{err}</p>}

          <div className="flex flex-wrap gap-1 border-b border-slate-100 pb-2">
            {TABS.map((t) => (
              <button key={t.id} type="button" onClick={() => setTab(t.id)}
                className={`rounded-lg px-3 py-1.5 text-xs font-extrabold transition ${tab === t.id ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-100"}`}>{t.label}</button>
            ))}
          </div>

          {tab === "basics" && (
            <div className="grid grid-cols-2 gap-3 text-sm">
              <F k="الاسم" v={d.name} /><F k="بالإنجليزية" v={d.nameEn || "—"} />
              <F k="SKU" v={d.sku || "—"} /><F k="الفئة" v={d.category || "—"} />
              <F k="الوحدة" v={d.unit} /><F k="النوع" v={d.kind === "semi" ? "نصف مصنّع" : "خام"} />
              <F k="التكلفة العامة (fallback)" v={formatCurrency(d.cost)} /><F k="إجمالي الرصيد" v={formatQty(d.stock)} />
              {d.description && <F k="الوصف" v={d.description} full />}
              {d.notes && <F k="ملاحظات" v={d.notes} full />}
              <p className="col-span-2 rounded-lg bg-blue-50 px-3 py-2 text-xs font-bold text-blue-700">التكلفة العامة هنا هي قيمة احتياطية فقط ولا تُعدّل متوسط تكلفة المستودع (WAC).</p>
            </div>
          )}

          {tab === "barcodes" && <BarcodesTab detail={d} onSaved={() => q.refetch()} />}

          {tab === "warehouses" && (
            <div className="space-y-1">
              {d.distribution.length === 0 ? <p className="text-sm text-slate-400">غير مُسند لأي مستودع.</p> : d.distribution.map((w) => (
                <div key={w.warehouseId} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm">
                  <span className="font-bold text-slate-700">{w.warehouseName}{w.isMain ? " · رئيسي" : ""}</span>
                  <span className="tabular-nums text-slate-600">{formatQty(w.qty)} {d.unit} · {formatCurrency(w.value)}</span>
                </div>
              ))}
            </div>
          )}

          {tab === "stock" && (
            <div className="space-y-1">
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800">WAC للقراءة فقط — لا يُعدَّل من نموذج الصنف؛ يتغيّر فقط عبر حركات المخزون.</p>
              {d.distribution.map((w) => (
                <div key={w.warehouseId} className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2 text-sm">
                  <span className="font-bold text-slate-700">{w.warehouseName}</span>
                  <span className="tabular-nums text-slate-600">رصيد {formatQty(w.qty)} · WAC {formatCurrency(w.avgCost)} · قيمة {formatCurrency(w.value)}</span>
                </div>
              ))}
            </div>
          )}

          {tab === "rules" && <RulesTab itemId={d.id} unit={d.unit} distribution={d.distribution} rules={d.rules} onSaved={() => q.refetch()} />}

          {tab === "movements" && (
            <div className="space-y-1">
              {d.movements.length === 0 ? <p className="text-sm text-slate-400">لا توجد حركات.</p> : d.movements.map((mv) => (
                <div key={mv.id} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-1.5 text-xs">
                  <span>{mv.reason || (mv.type === "in" ? "وارد" : "صادر")} · {formatDate(mv.at)}</span>
                  <span className={`font-bold ${mv.type === "in" ? "text-emerald-700" : "text-sky-700"}`}>{mv.type === "in" ? "+" : "−"}{formatQty(mv.qty)}</span>
                </div>
              ))}
            </div>
          )}

          {tab === "audit" && (
            <ol className="space-y-2">
              {d.timeline.map((e, i) => (
                <li key={i} className="flex items-start gap-2 text-xs">
                  <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-teal-500" />
                  <div><span className="font-bold text-slate-700">{ACTION_LABEL[e.action] ?? e.action}</span><span className="text-slate-400"> · {e.actor} · {formatDate(e.at)}</span>{e.note && <div className="text-slate-500">{e.note}</div>}</div>
                </li>
              ))}
            </ol>
          )}

          <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-4">
            {canEdit && <Button variant="secondary" size="sm" onClick={() => onEdit(d.id)}><Pencil className="h-4 w-4" /> تعديل</Button>}
            {canActivate && (d.active ? (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => m.deactivate.mutate({ id: d.id, expectedVersion: d.version }, { onSuccess: () => q.refetch(), onError })}><PowerOff className="h-4 w-4" /> تعطيل</Button>
            ) : (
              <Button variant="primary" size="sm" disabled={busy} onClick={() => m.activate.mutate({ id: d.id, expectedVersion: d.version }, { onSuccess: () => q.refetch(), onError })}><Power className="h-4 w-4" /> تفعيل</Button>
            ))}
          </div>
        </div>
      )}
    </Drawer>
  );
}

function RulesTab({ itemId, unit, distribution, rules, onSaved }: { itemId: string; unit: string; distribution: { warehouseId: string; warehouseName: string }[]; rules: ItemRule[]; onSaved: () => void }) {
  const m = useItemMutations();
  const canEdit = useCan("item.edit");
  const [whId, setWhId] = useState(distribution[0]?.warehouseId ?? "");
  const existing = rules.find((r) => r.warehouseId === whId);
  const [form, setForm] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const val = (k: keyof ItemRule, dflt = 0) => (form[k] !== undefined ? form[k] : String(existing ? (existing[k] as number) : dflt));
  function set(k: string, v: string) { setForm((f) => ({ ...f, [k]: v })); setSaved(false); }
  function pickWh(id: string) { setWhId(id); setForm({}); setErr(null); setSaved(false); }

  function save() {
    setErr(null);
    const input = {
      minQty: Number(val("minQty")), reorderPoint: Number(val("reorderPoint")), reorderQty: Number(val("reorderQty")),
      maxStock: Number(val("maxStock")), safetyStock: Number(val("safetyStock")), leadTimeDays: Number(val("leadTimeDays")),
      isEnabled: form.isEnabled !== undefined ? form.isEnabled === "1" : (existing ? existing.isEnabled : true),
      expectedVersion: existing ? existing.version : undefined,
    };
    if (input.isEnabled && input.reorderQty <= 0) return setErr("كمية إعادة الطلب يجب أن تكون أكبر من صفر عند التفعيل");
    if (input.maxStock > 0 && input.maxStock < input.reorderPoint) return setErr("الحد الأقصى يجب أن يكون ≥ نقطة إعادة الطلب");
    if (input.reorderPoint < input.safetyStock) return setErr("نقطة إعادة الطلب يجب أن تكون ≥ مخزون الأمان");
    m.saveRule.mutate({ id: itemId, warehouseId: whId, input }, {
      onSuccess: () => { setSaved(true); setForm({}); onSaved(); },
      onError: (e) => setErr(e instanceof ApiError ? (e.isConflict ? "تغيّرت القاعدة منذ آخر تحميل — أعد التحميل." : e.message) : "تعذّر الحفظ."),
    });
  }

  if (!distribution.length) return <p className="text-sm text-slate-400">أسند الصنف إلى مستودع أولًا لضبط قواعد إعادة الطلب.</p>;
  return (
    <div className="space-y-3">
      <label className="block text-xs font-bold text-slate-500">المستودع
        <select className="field mt-1 w-full" value={whId} onChange={(e) => pickWh(e.target.value)} aria-label="مستودع القاعدة">
          {distribution.map((w) => <option key={w.warehouseId} value={w.warehouseId}>{w.warehouseName}</option>)}
        </select>
      </label>
      {err && <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{err}</p>}
      {saved && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700">حُفظت القاعدة.</p>}
      <div className="grid grid-cols-2 gap-3">
        {[["reorderPoint", "نقطة إعادة الطلب"], ["reorderQty", "كمية إعادة الطلب"], ["maxStock", "الحد الأقصى"], ["safetyStock", "مخزون الأمان"], ["minQty", "الحد الأدنى"], ["leadTimeDays", "مهلة التوريد (أيام)"]].map(([key, label]) => (
          <label key={key} className="block text-xs font-bold text-slate-500">{label}
            <input type="number" min={0} step="any" className="field mt-1 w-full" value={val(key as keyof ItemRule)} onChange={(e) => set(key, e.target.value)} aria-label={label} disabled={!canEdit} />
          </label>
        ))}
        <label className="col-span-2 flex items-center gap-2 text-xs font-bold text-slate-600">
          <input type="checkbox" checked={form.isEnabled !== undefined ? form.isEnabled === "1" : (existing ? existing.isEnabled : true)} onChange={(e) => set("isEnabled", e.target.checked ? "1" : "0")} disabled={!canEdit} /> تفعيل قاعدة إعادة الطلب ({unit})
        </label>
      </div>
      {canEdit && <div className="flex justify-end"><Button variant="primary" size="sm" disabled={m.saveRule.isPending} onClick={save}><Save className="h-4 w-4" /> {m.saveRule.isPending ? "جارٍ الحفظ…" : "حفظ القاعدة"}</Button></div>}
    </div>
  );
}

function F({ k, v, full }: { k: string; v: string; full?: boolean }) {
  return <div className={full ? "col-span-2" : ""}><div className="text-[10px] font-bold text-slate-400">{k}</div><div className="mt-0.5 font-bold text-slate-700">{v}</div></div>;
}
