// Create a Purchase Order — the showcase for the two reusable inputs:
//   • SearchableEntityCombobox for the supplier + per-line item pickers
//   • UnitQtyInput for quantity entry with a live base-unit conversion
// Totals are previewed client-side but the SERVER recomputes them (authoritative).
import { useMemo, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Plus, Trash2 } from "lucide-react";
import { apiClient } from "@/lib/api-client";
import { PageHeader, PanelTitle } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { SearchableEntityCombobox, type EntityPage } from "@/components/ui/SearchableEntityCombobox";
import { UnitQtyInput, baseFromValue, type ItemUnitLite, type UnitQtyValue } from "@/components/ui/UnitQtyInput";
import { formatCurrency } from "@/lib/formatters";
import { supplierFetcher, useCreateOrder } from "@/lib/hooks/useProcurement";
import { toSupplier, type Supplier } from "@/lib/adapters/procurement.adapter";
import type { ApiError } from "@/lib/api-error";

interface ItemHit {
  id: string; name: string; sku: string;
  baseUnit: { code: string; name: string };
  majorUnits: Array<{ unitCode: string; unitName: string; factor: number }>;
}
function itemFetcher({ q, page, signal }: { q: string; page: number; signal?: AbortSignal }): Promise<EntityPage<ItemHit>> {
  return apiClient.get<{ data: ItemHit[]; pagination: { totalPages: number; total: number } }>(
    "/inventory/v2/item-search", { signal, params: { q, page } },
  ).then((r) => ({
    items: r.data ?? [],
    nextPage: page < (r.pagination?.totalPages ?? 1) ? page + 1 : null,
    total: r.pagination?.total ?? (r.data ?? []).length,
  }));
}
function unitsOf(item: ItemHit): ItemUnitLite[] {
  return [
    { code: item.baseUnit.code, name: item.baseUnit.name, factor: 1, isBase: true },
    ...item.majorUnits.map((m) => ({ code: m.unitCode, name: m.unitName, factor: Number(m.factor) || 1, isBase: false })),
  ];
}

interface LineState {
  key: string;
  item: ItemHit | null;
  qty: UnitQtyValue;
  unitPrice: number;
  vatRate: number;
}
let _k = 0;
const newLine = (): LineState => ({ key: "L" + ++_k, item: null, qty: { unitCode: "", qty: 1 }, unitPrice: 0, vatRate: 15 });

export function OrderCreatePage() {
  const nav = useNavigate();
  const create = useCreateOrder();
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [expectedDate, setExpectedDate] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineState[]>([newLine()]);

  const preview = useMemo(() => {
    let net = 0, vat = 0;
    for (const l of lines) {
      if (!l.item) continue;
      const realNet = (Number(l.qty.qty) || 0) * l.unitPrice; // price entered per chosen unit
      net += realNet;
      vat += realNet * (Number(l.vatRate) || 0) / 100;
    }
    return { net, vat, total: net + vat };
  }, [lines]);

  function submit() {
    if (!supplier) return;
    const payloadLines = lines.filter((l) => l.item).map((l) => {
      const units = unitsOf(l.item as ItemHit);
      const sel = units.find((u) => u.code === l.qty.unitCode) || units[0];
      return {
        itemId: (l.item as ItemHit).id,
        itemName: (l.item as ItemHit).name,
        enteredQty: Number(l.qty.qty) || 0,
        factor: sel ? Number(sel.factor) || 1 : 1,
        enteredUnitCode: sel?.code || "",
        unitPriceEntered: l.unitPrice,
        vatRate: l.vatRate,
      };
    });
    if (!payloadLines.length) return;
    create.mutate(
      { supplierId: supplier.id, expectedDate: expectedDate || undefined, notes: notes || undefined, lines: payloadLines },
      { onSuccess: (r) => { const id = r?.data?.id; if (id) nav(`/purchasing/orders/${id}`); else nav("/purchasing/orders"); } },
    );
  }

  return (
    <div className="grid gap-6">
      <Link to="/purchasing/orders" className="text-sm font-bold text-teal-700 hover:underline">← أوامر الشراء</Link>
      <PageHeader eyebrow="أمر شراء جديد" title="إنشاء أمر شراء" subtitle="اختر المورد والأصناف — تُحسب الإجماليات على الخادم." />

      <section className="surface p-5">
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className="mb-1 block text-xs font-extrabold text-slate-500">المورد</label>
            <SearchableEntityCombobox<Supplier>
              value={supplier} onChange={setSupplier}
              fetcher={(a) => supplierFetcher(a).then((p) => ({ ...p, items: p.items.map((s) => toSupplier(s as unknown as Record<string, unknown>)) }))}
              queryKey={["procurement", "supplier-picker"]}
              getKey={(s) => s.id} getLabel={(s) => s.name} getSublabel={(s) => s.vatNumber || undefined}
              placeholder="ابحث بالاسم / الرقم الضريبي / الهاتف…" ariaLabel="اختيار المورد"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-extrabold text-slate-500">تاريخ التوريد المتوقع</label>
            <input type="date" className="field w-full" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-extrabold text-slate-500">ملاحظات</label>
            <input className="field w-full" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="اختياري" />
          </div>
        </div>
      </section>

      <section className="surface overflow-hidden">
        <PanelTitle title="السطور" action={<Button variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, newLine()])}><Plus className="h-4 w-4" /> سطر</Button>} />
        <div className="grid gap-4 p-4">
          {lines.map((l, idx) => {
            const units = l.item ? unitsOf(l.item) : [{ code: "", name: "", factor: 1, isBase: true }];
            const base = l.item ? baseFromValue(units, l.qty, "single") : 0;
            return (
              <div key={l.key} className="grid gap-3 rounded-xl border border-slate-200 p-3 lg:grid-cols-[2fr_1.6fr_1fr_0.8fr_auto]">
                <div>
                  <label className="mb-1 block text-[11px] font-bold text-slate-400">المادة</label>
                  <SearchableEntityCombobox<ItemHit>
                    value={l.item} onChange={(it) => setLines((ls) => ls.map((x, i) => i === idx ? { ...x, item: it, qty: { unitCode: it ? it.baseUnit.code : "", qty: 1 } } : x))}
                    fetcher={itemFetcher} queryKey={["procurement", "item-picker"]}
                    getKey={(it) => it.id} getLabel={(it) => it.name} getSublabel={(it) => it.sku || undefined}
                    placeholder="ابحث بالاسم / SKU / الباركود…" ariaLabel="اختيار المادة"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-bold text-slate-400">الكمية {base > 0 && <span className="text-teal-600">= {base} (أساسية)</span>}</label>
                  <UnitQtyInput units={units} value={l.qty} onChange={(v) => setLines((ls) => ls.map((x, i) => i === idx ? { ...x, qty: v } : x))} mode="single" />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-bold text-slate-400">سعر الوحدة</label>
                  <input type="number" min={0} step="0.0001" className="field w-full tabular-nums" value={l.unitPrice} onChange={(e) => setLines((ls) => ls.map((x, i) => i === idx ? { ...x, unitPrice: Number(e.target.value) } : x))} />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-bold text-slate-400">الضريبة %</label>
                  <input type="number" min={0} max={100} step="0.01" className="field w-full tabular-nums" value={l.vatRate} onChange={(e) => setLines((ls) => ls.map((x, i) => i === idx ? { ...x, vatRate: Number(e.target.value) } : x))} />
                </div>
                <div className="flex items-end">
                  <button type="button" aria-label="حذف السطر" className="grid h-11 w-11 place-items-center rounded-xl text-slate-400 hover:bg-rose-50 hover:text-rose-600" onClick={() => setLines((ls) => ls.length > 1 ? ls.filter((_, i) => i !== idx) : ls)}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex items-center justify-between border-t border-slate-100 px-5 py-4">
          <div className="text-sm text-slate-500">معاينة: صافي <b className="tabular-nums text-slate-800">{formatCurrency(preview.net)}</b> · ضريبة <b className="tabular-nums text-slate-800">{formatCurrency(preview.vat)}</b> · إجمالي <b className="tabular-nums text-teal-700">{formatCurrency(preview.total)}</b></div>
          <Button disabled={!supplier || create.isPending || !lines.some((l) => l.item)} onClick={submit}>
            {create.isPending ? "جارٍ الإنشاء…" : "إنشاء أمر الشراء"}
          </Button>
        </div>
        {create.isError && <p className="px-5 pb-4 text-sm font-semibold text-rose-600">{(create.error as ApiError)?.message}</p>}
      </section>
    </div>
  );
}
