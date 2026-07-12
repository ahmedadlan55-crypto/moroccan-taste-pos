import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, Check, Factory, Search, TriangleAlert } from "lucide-react";
import { PageHeader } from "@/shared/ui";
import { Button } from "@/shared/ui";
import { StatusBadge } from "@/shared/ui";
import { LoadingState, ErrorState, EmptyState } from "@/shared/ui";
import { useWarehouseScope } from "@/modules/inventory/lib/warehouse-scope-provider";
import { useWarehouses } from "@/modules/inventory/lib/hooks/useWarehouses";
import { useDebouncedValue } from "@/modules/inventory/lib/hooks/useDebouncedValue";
import { useBoms, usePreviewAvailability, useProductionDetail, useProductionMutations } from "@/modules/inventory/lib/hooks/useProduction";
import { formatCurrency, formatQty, formatNumber } from "@/shared/lib";
import type { BomOption } from "@/modules/inventory/lib/adapters/production.adapter";
import { ApiError } from "@/shared/api";

const STEPS = ["المنتج والوصفة", "الكميات والمستودعات", "توفر المواد", "المراجعة والإنشاء"] as const;

export function ProductionCreateWizard() {
  const navigate = useNavigate();
  const [psp] = useSearchParams();
  const editId = psp.get("edit") ?? undefined;
  const { accessibleWarehouses, allWarehousesAccess } = useWarehouseScope();
  const allWh = useWarehouses();
  const { create, update } = useProductionMutations();
  const existing = useProductionDetail(editId ?? null);

  const [step, setStep] = useState(0);
  const [prefilled, setPrefilled] = useState(false);
  const [bom, setBom] = useState<BomOption | null>(null);
  const [qtyPlanned, setQtyPlanned] = useState<string>("");
  const [warehouseId, setWarehouseId] = useState("");
  const [outputWarehouseId, setOutputWarehouseId] = useState("");
  const [plannedDate, setPlannedDate] = useState("");
  const [priority, setPriority] = useState("normal");
  const [allowedScrapPct, setAllowedScrapPct] = useState<string>("");
  const [batchNumber, setBatchNumber] = useState("");
  const [notes, setNotes] = useState("");
  const [bomQuery, setBomQuery] = useState("");
  const debouncedBomQuery = useDebouncedValue(bomQuery, 250);

  const boms = useBoms(debouncedBomQuery);

  // Edit mode: prefill once from the loaded draft (draft-only guard is on the
  // backend; a non-draft edit attempt will 422 at submit).
  useEffect(() => {
    if (!editId || prefilled || !existing.data) return;
    const o = existing.data.order;
    const fromList = (boms.data ?? []).find((b) => b.id === o.bomId);
    setBom(fromList ?? {
      id: o.bomId, productId: o.productId, productName: o.productName,
      productUnit: o.productUnit, trackingMode: existing.data.order.productTrackingMode,
      yieldQuantity: 1, yieldUnit: o.productUnit, lineCount: existing.data.plan.length,
    });
    setQtyPlanned(String(o.qtyPlanned));
    setWarehouseId(o.warehouseId);
    setOutputWarehouseId(o.outputWarehouseId !== o.warehouseId ? o.outputWarehouseId : "");
    setPlannedDate(o.plannedDate ? o.plannedDate.slice(0, 10) : "");
    setPriority(o.priority);
    setAllowedScrapPct(existing.data.order.allowedScrapPct ? String(existing.data.order.allowedScrapPct) : "");
    setBatchNumber(o.batchNumber ?? "");
    setNotes(existing.data.order.notes ?? "");
    setPrefilled(true);
  }, [editId, prefilled, existing.data, boms.data]);

  const whOptions = useMemo(() => {
    if (!allWarehousesAccess) return accessibleWarehouses.map((w) => ({ id: w.id, name: w.name }));
    return (allWh.data?.warehouses ?? []).map((w) => ({ id: w.id, name: w.name }));
  }, [allWarehousesAccess, accessibleWarehouses, allWh.data]);

  const qtyNum = Number(qtyPlanned);
  const previewInput = step >= 2 && bom && warehouseId && qtyNum > 0
    ? { bomId: bom.id, qtyPlanned: qtyNum, warehouseId }
    : null;
  const preview = usePreviewAvailability(previewInput);

  const canNext =
    step === 0 ? !!bom
    : step === 1 ? qtyNum > 0 && !!warehouseId
    : step === 2 ? !!preview.data
    : true;

  const activeMutation = editId ? update : create;
  const err = activeMutation.error instanceof ApiError ? activeMutation.error.message : activeMutation.error?.message ?? null;

  async function submit() {
    const input = {
      bomId: bom!.id,
      qtyPlanned: qtyNum,
      warehouseId,
      outputWarehouseId: outputWarehouseId || warehouseId,
      plannedDate: plannedDate || undefined,
      priority,
      allowedScrapPct: allowedScrapPct !== "" ? Number(allowedScrapPct) : undefined,
      batchNumber: batchNumber.trim() || undefined,
      notes: notes.trim() || undefined,
    };
    if (editId && existing.data) {
      await update.mutateAsync({ id: editId, input: { ...input, expectedVersion: existing.data.order.version } });
      navigate(`/inventory/production?doc=${editId}`, { replace: true });
    } else {
      const r = await create.mutateAsync(input);
      navigate(`/inventory/production?doc=${r.id}`, { replace: true });
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="العمليات · أوامر الإنتاج"
        title="أمر إنتاج جديد"
        subtitle="أنشئ مسودة من وصفة نشطة — الاعتماد والإصدار خطوات لاحقة لا تُحرّك المخزون الآن."
        action={<Button variant="ghost" onClick={() => navigate("/inventory/production")}>عودة للقائمة</Button>}
      />

      <ol className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="خطوات الإنشاء">
        {STEPS.map((s, i) => (
          <li key={s} className={`rounded-xl border px-3 py-2 text-xs font-extrabold ${i === step ? "border-teal-600 bg-teal-50 text-teal-800" : i < step ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-white text-slate-400"}`}>
            <span className="ml-1 tabular-nums">{i + 1}.</span> {s} {i < step && <Check className="mr-1 inline h-3.5 w-3.5" />}
          </li>
        ))}
      </ol>

      <section className="surface p-5">
        {step === 0 && (
          <div>
            <label className="relative mb-4 block">
              <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input className="field w-full pr-10" placeholder="ابحث عن منتج أو وصفة…" value={bomQuery} onChange={(e) => setBomQuery(e.target.value)} aria-label="بحث الوصفات" />
            </label>
            {boms.isLoading ? <LoadingState rows={2} /> : boms.isError ? <ErrorState error={boms.error} onRetry={() => boms.refetch()} /> : !boms.data || boms.data.length === 0 ? (
              <EmptyState title="لا توجد وصفات نشطة" body="أنشئ وصفة (BOM) بمكوّناتها من شاشة الوصفات أولًا." />
            ) : (
              <ul className="grid gap-2 md:grid-cols-2">
                {boms.data.map((b) => (
                  <li key={b.id}>
                    <button type="button" onClick={() => setBom(b)}
                      className={`w-full rounded-xl border p-4 text-right transition ${bom?.id === b.id ? "border-teal-600 bg-teal-50 ring-2 ring-teal-100" : "border-slate-200 bg-white hover:border-slate-300"}`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-extrabold text-slate-900">{b.productName}</span>
                        {b.trackingMode !== "none" && <StatusBadge>{b.trackingMode === "expiry" ? "تتبع صلاحية" : "تتبع دفعات"}</StatusBadge>}
                      </div>
                      <div className="mt-1 text-xs font-medium text-slate-500">
                        دفعة الوصفة تنتج {formatQty(b.yieldQuantity, b.yieldUnit || b.productUnit)} · {formatNumber(b.lineCount)} مكوّن
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {step === 1 && bom && (
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block text-xs font-bold text-slate-500">
              الكمية المخططة ({bom.yieldUnit || bom.productUnit || "وحدة"})
              <input type="number" min="0.0001" step="any" dir="ltr" className="field mt-1 w-full tabular-nums" value={qtyPlanned} onChange={(e) => setQtyPlanned(e.target.value)} aria-label="الكمية المخططة" />
              {qtyNum > 0 && <span className="mt-1 block text-[11px] font-medium text-slate-400">= {formatNumber(qtyNum / bom.yieldQuantity)} دفعة من الوصفة</span>}
            </label>
            <label className="block text-xs font-bold text-slate-500">
              تاريخ الإنتاج المخطط
              <input type="date" className="field mt-1 w-full" value={plannedDate} onChange={(e) => setPlannedDate(e.target.value)} aria-label="تاريخ الإنتاج" />
            </label>
            <label className="block text-xs font-bold text-slate-500">
              مستودع المواد (المصدر)
              <select className="field mt-1 w-full" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} aria-label="مستودع المواد">
                <option value="">اختر مستودعًا…</option>
                {whOptions.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </label>
            <label className="block text-xs font-bold text-slate-500">
              مستودع الإخراج (المنتج النهائي)
              <select className="field mt-1 w-full" value={outputWarehouseId} onChange={(e) => setOutputWarehouseId(e.target.value)} aria-label="مستودع الإخراج">
                <option value="">نفس مستودع المواد</option>
                {whOptions.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </label>
            <label className="block text-xs font-bold text-slate-500">
              الأولوية
              <select className="field mt-1 w-full" value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="الأولوية">
                <option value="normal">عادية</option>
                <option value="high">عالية</option>
                <option value="urgent">عاجلة</option>
              </select>
            </label>
            <label className="block text-xs font-bold text-slate-500">
              سماحية الهدر % (تجاوزها يتطلب مديرًا)
              <input type="number" min="0" max="100" step="any" dir="ltr" className="field mt-1 w-full tabular-nums" value={allowedScrapPct} onChange={(e) => setAllowedScrapPct(e.target.value)} aria-label="سماحية الهدر" />
            </label>
            {bom.trackingMode !== "none" && (
              <label className="block text-xs font-bold text-slate-500">
                رقم دفعة المنتج (افتراضي — يمكن تغييره عند التسجيل)
                <input className="field mt-1 w-full" value={batchNumber} onChange={(e) => setBatchNumber(e.target.value)} aria-label="رقم الدفعة" />
              </label>
            )}
            <label className="block text-xs font-bold text-slate-500 md:col-span-2">
              ملاحظات
              <textarea className="field mt-1 min-h-20 w-full" value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="ملاحظات" />
            </label>
          </div>
        )}

        {step === 2 && (
          preview.isLoading ? <LoadingState rows={2} /> : preview.isError ? <ErrorState error={preview.error} onRetry={() => preview.refetch()} /> : preview.data ? (
            <div>
              <div className={`mb-4 flex items-center gap-2 rounded-xl border p-3 text-sm font-bold ${preview.data.summary.allAvailable ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
                {preview.data.summary.allAvailable
                  ? <><Check className="h-4 w-4" /> كل المواد متوفرة — القيمة التقديرية {formatCurrency(preview.data.summary.reservedValue ?? 0)}</>
                  : <><TriangleAlert className="h-4 w-4" /> {formatNumber(preview.data.summary.shortageCount)} مادة ناقصة — يمكنك إنشاء المسودة الآن وإصدار المواد جزئيًا لاحقًا</>}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs font-bold text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-right">المادة</th>
                      <th className="px-3 py-2 text-right">المطلوب</th>
                      <th className="px-3 py-2 text-right">المتاح</th>
                      <th className="px-3 py-2 text-right">FEFO متاح</th>
                      <th className="px-3 py-2 text-right">العجز/الفائض</th>
                      <th className="px-3 py-2 text-left">التكلفة</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {preview.data.items.map((i) => (
                      <tr key={i.itemId} className={i.status === "short" ? "bg-rose-50/60" : ""}>
                        <td className="px-3 py-2 font-bold text-slate-800">{i.itemName}</td>
                        <td className="px-3 py-2 tabular-nums">{formatQty(i.required, i.itemUnit)}</td>
                        <td className="px-3 py-2 tabular-nums">{formatQty(i.available)}</td>
                        <td className="px-3 py-2 tabular-nums">{i.fefoAvailable != null ? formatQty(i.fefoAvailable) : "—"}</td>
                        <td className={`px-3 py-2 font-bold tabular-nums ${i.delta < 0 ? "text-rose-600" : "text-emerald-600"}`}>{i.delta > 0 ? "+" : ""}{formatQty(i.delta)}</td>
                        <td className="px-3 py-2 text-left tabular-nums text-slate-600">{formatCurrency(i.lineCost ?? 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null
        )}

        {step === 3 && bom && (
          <div className="grid gap-3 text-sm md:grid-cols-2">
            <ReviewCell label="المنتج" value={bom.productName} />
            <ReviewCell label="الكمية المخططة" value={formatQty(qtyNum, bom.yieldUnit || bom.productUnit)} />
            <ReviewCell label="مستودع المواد" value={whOptions.find((w) => w.id === warehouseId)?.name ?? warehouseId} />
            <ReviewCell label="مستودع الإخراج" value={whOptions.find((w) => w.id === (outputWarehouseId || warehouseId))?.name ?? "نفس مستودع المواد"} />
            <ReviewCell label="الأولوية" value={priority === "urgent" ? "عاجلة" : priority === "high" ? "عالية" : "عادية"} />
            <ReviewCell label="سماحية الهدر" value={allowedScrapPct !== "" ? `${allowedScrapPct}%` : "—"} />
            {plannedDate && <ReviewCell label="التاريخ المخطط" value={plannedDate} />}
            {batchNumber && <ReviewCell label="رقم الدفعة" value={batchNumber} />}
            {notes && <ReviewCell label="ملاحظات" value={notes} />}
            <div className="md:col-span-2 rounded-xl border border-teal-200 bg-teal-50 p-3 text-xs font-bold text-teal-800">
              <Factory className="ml-1 inline h-4 w-4" />
              سيُنشأ الأمر كمسودة — لا يتحرك أي مخزون قبل الاعتماد ثم إصدار المواد.
            </div>
            {err && <p className="md:col-span-2 rounded-lg bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{err}</p>}
          </div>
        )}
      </section>

      <div className="mt-4 flex items-center justify-between">
        <Button variant="secondary" disabled={step === 0 || create.isPending} onClick={() => setStep((s) => s - 1)}>
          <ArrowRight className="h-4 w-4" /> السابق
        </Button>
        {step < STEPS.length - 1 ? (
          <Button variant="primary" disabled={!canNext} onClick={() => setStep((s) => s + 1)}>
            التالي <ArrowLeft className="h-4 w-4" />
          </Button>
        ) : (
          <Button variant="primary" disabled={create.isPending} onClick={() => void submit()}>
            {create.isPending ? "جارٍ الإنشاء…" : "إنشاء المسودة"} <Check className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}

function ReviewCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="text-[11px] font-bold text-slate-400">{label}</div>
      <div className="mt-0.5 font-bold text-slate-800">{value}</div>
    </div>
  );
}
