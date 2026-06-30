import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeftRight, Plus, Search, Trash2, AlertTriangle, ChevronLeft, ChevronRight } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { PermissionDenied } from "@/components/states/States";
import { Stepper } from "./Stepper";
import { useWarehouses } from "@/lib/hooks/useWarehouses";
import { useWarehouseInventory } from "@/lib/hooks/useInventory";
import { useWarehouseScope } from "@/app/warehouse-scope-provider";
import { useCan } from "@/app/permission-provider";
import { useCreateDraft, useDeleteDraft } from "@/lib/hooks/useTransferMutations";
import { useTransferDetail } from "@/lib/hooks/useTransferDetail";
import { createTransferDraftInput } from "@/lib/schemas/transfer.schema";
import { formatQty } from "@/lib/formatters";
import { useDebouncedValue } from "@/lib/hooks/useDebouncedValue";

interface DraftLine { itemId: string; name: string; unit: string; available: number; qtyRequested: number; }

const STEPS = ["بيانات التحويل", "الأصناف", "المراجعة"];

export function TransferCreateWizard() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const editId = params.get("edit");
  const canCreate = useCan("transfer.create");

  const { accessibleWarehouses, allWarehousesAccess } = useWarehouseScope();
  const allWh = useWarehouses();
  const whOptions = useMemo(() => {
    if (!allWarehousesAccess) return accessibleWarehouses.map((w) => ({ id: w.id, name: w.name }));
    return (allWh.data?.warehouses ?? []).map((w) => ({ id: w.id, name: w.name }));
  }, [allWarehousesAccess, accessibleWarehouses, allWh.data]);

  const [step, setStep] = useState(1);
  const [fromWh, setFromWh] = useState("");
  const [toWh, setToWh] = useState("");
  const [issueDate, setIssueDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [search, setSearch] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);

  const createDraft = useCreateDraft();
  const deleteDraft = useDeleteDraft();

  // Edit mode — prefill from the existing draft once.
  const edit = useTransferDetail(editId);
  useEffect(() => {
    if (editId && edit.data && edit.data.status === "draft" && fromWh === "" && lines.length === 0) {
      setFromWh(edit.data.fromWarehouse.id);
      setToWh(edit.data.toWarehouse.id);
      setLines(edit.data.lines.map((l) => ({ itemId: l.item.id, name: l.item.name, unit: l.item.unit, available: 0, qtyRequested: l.qtyRequested })));
    }
  }, [editId, edit.data, fromWh, lines.length]);

  // Step 2 item search — source-warehouse inventory (available qty).
  const debounced = useDebouncedValue(search, 250);
  const inv = useWarehouseInventory({ scope: fromWh || "all", q: debounced, pageSize: 25 });
  const pickedIds = useMemo(() => new Set(lines.map((l) => l.itemId)), [lines]);

  if (!canCreate) return <PermissionDenied />;

  const sameWarehouse = !!fromWh && fromWh === toWh;
  const step1Valid = !!fromWh && !!toWh && !sameWarehouse;
  const allQtyValid = lines.length > 0 && lines.every((l) => l.qtyRequested > 0);
  const step2Valid = allQtyValid;

  function addItem(row: { itemId: string; name: string; unit: string; available: number }) {
    if (pickedIds.has(row.itemId)) return;
    setLines((ls) => [...ls, { itemId: row.itemId, name: row.name, unit: row.unit, available: row.available, qtyRequested: 1 }]);
  }
  function setQty(itemId: string, v: string) {
    setLines((ls) => ls.map((l) => (l.itemId === itemId ? { ...l, qtyRequested: Number(v) || 0 } : l)));
  }
  function removeLine(itemId: string) {
    setLines((ls) => ls.filter((l) => l.itemId !== itemId));
  }

  function submit() {
    setSubmitError(null);
    const payload = {
      fromWarehouseId: fromWh,
      toWarehouseId: toWh,
      issueDate,
      notes: notes || undefined,
      items: lines.map((l) => ({ itemId: l.itemId, qtyRequested: l.qtyRequested })),
    };
    const parsed = createTransferDraftInput.safeParse(payload);
    if (!parsed.success) {
      setSubmitError(parsed.error.issues[0]?.message ?? "تحقق من البيانات المدخلة.");
      return;
    }
    createDraft.mutate(parsed.data, {
      onSuccess: async (res) => {
        if (editId) await deleteDraft.mutateAsync({ id: editId }).catch(() => undefined);
        const newId = (res.data?.id as string) ?? null;
        navigate(newId ? `/transfers?view=${newId}` : "/transfers");
      },
      onError: (e) => setSubmitError(e instanceof Error ? e.message : "تعذّر حفظ المسودة."),
    });
  }

  return (
    <div>
      <PageHeader
        eyebrow="العمليات"
        title={editId ? "تعديل مسودة تحويل" : "تحويل جديد"}
        subtitle="أنشئ إذن تحويل بين مستودعين ثم احفظه كمسودة لاعتماده لاحقًا."
        action={<Button variant="ghost" onClick={() => navigate("/transfers")}>الرجوع إلى القائمة</Button>}
      />

      <div className="surface mb-4 p-4"><Stepper steps={STEPS} current={step} /></div>

      {/* Step 1 — header */}
      {step === 1 && (
        <div className="surface space-y-4 p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-bold text-slate-600">المستودع المصدر <span className="text-rose-600">*</span></span>
              <select className="field mt-1 w-full" value={fromWh} onChange={(e) => setFromWh(e.target.value)}>
                <option value="">اختر المستودع المصدر</option>
                {whOptions.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-bold text-slate-600">المستودع الوجهة <span className="text-rose-600">*</span></span>
              <select className="field mt-1 w-full" value={toWh} onChange={(e) => setToWh(e.target.value)}>
                <option value="">اختر المستودع الوجهة</option>
                {whOptions.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-bold text-slate-600">تاريخ التحويل</span>
              <input type="date" className="field mt-1 w-full" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
            </label>
            <label className="block">
              <span className="text-xs font-bold text-slate-600">ملاحظات</span>
              <input className="field mt-1 w-full" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="اختياري" />
            </label>
          </div>
          {sameWarehouse && (
            <p className="flex items-center gap-2 text-xs font-bold text-rose-600"><AlertTriangle className="h-4 w-4" /> المصدر والوجهة يجب أن يكونا مختلفين.</p>
          )}
          <div className="flex justify-end">
            <Button variant="primary" disabled={!step1Valid} onClick={() => setStep(2)}>التالي <ChevronLeft className="h-4 w-4" /></Button>
          </div>
        </div>
      )}

      {/* Step 2 — items */}
      {step === 2 && (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Picker */}
          <div className="surface p-4">
            <div className="mb-3 text-sm font-extrabold text-slate-800">أصناف المستودع المصدر</div>
            <label className="relative block">
              <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input className="field w-full pr-10" placeholder="بحث بالاسم أو الكود…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </label>
            <div className="mt-3 max-h-80 space-y-1.5 overflow-y-auto">
              {inv.isLoading ? (
                <div className="py-6 text-center text-xs text-slate-400">جارٍ التحميل…</div>
              ) : (inv.data?.rows ?? []).length === 0 ? (
                <div className="py-6 text-center text-xs text-slate-400">لا توجد أصناف مطابقة.</div>
              ) : (
                (inv.data?.rows ?? []).map((r) => (
                  <button key={r.itemId} type="button" disabled={pickedIds.has(r.itemId)} onClick={() => addItem({ itemId: r.itemId, name: r.name, unit: r.unit, available: r.available })}
                    className="flex w-full items-center justify-between gap-2 rounded-xl border border-slate-100 px-3 py-2 text-right transition hover:bg-slate-50 disabled:opacity-40">
                    <div className="min-w-0">
                      <div className="truncate text-xs font-bold text-slate-800">{r.name}</div>
                      <div className="text-[11px] text-slate-400">متاح: {formatQty(r.available, r.unit)}</div>
                    </div>
                    <Plus className="h-4 w-4 text-teal-600" />
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Selected lines */}
          <div className="surface flex flex-col p-4">
            <div className="mb-3 text-sm font-extrabold text-slate-800">الأصناف المختارة ({lines.length})</div>
            {lines.length === 0 ? (
              <div className="grid flex-1 place-items-center py-10 text-center text-xs text-slate-400">اختر صنفًا واحدًا على الأقل من القائمة.</div>
            ) : (
              <div className="space-y-2">
                {lines.map((l) => {
                  const over = l.available > 0 && l.qtyRequested > l.available;
                  return (
                    <div key={l.itemId} className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
                      <div className="min-w-0">
                        <div className="truncate text-xs font-bold text-slate-800">{l.name}</div>
                        <div className="text-[11px] text-slate-400">متاح: {formatQty(l.available, l.unit)}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <input type="number" min={0} step="any" className={`field h-9 w-24 text-center ${l.qtyRequested <= 0 || over ? "border-rose-400" : ""}`}
                          value={l.qtyRequested} onChange={(e) => setQty(l.itemId, e.target.value)} aria-label={`كمية ${l.name}`} />
                        <Button variant="ghost" size="icon" aria-label="حذف" onClick={() => removeLine(l.itemId)}><Trash2 className="h-4 w-4 text-rose-500" /></Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="mt-4 flex justify-between">
              <Button variant="secondary" onClick={() => setStep(1)}><ChevronRight className="h-4 w-4" /> السابق</Button>
              <Button variant="primary" disabled={!step2Valid} onClick={() => setStep(3)}>المراجعة <ChevronLeft className="h-4 w-4" /></Button>
            </div>
          </div>
        </div>
      )}

      {/* Step 3 — review */}
      {step === 3 && (
        <div className="surface space-y-4 p-5">
          <div className="flex flex-wrap items-center gap-2 text-sm font-bold text-slate-700">
            {whOptions.find((w) => w.id === fromWh)?.name ?? fromWh}
            <ArrowLeftRight className="h-4 w-4 text-slate-400" />
            {whOptions.find((w) => w.id === toWh)?.name ?? toWh}
            <span className="text-xs font-medium text-slate-400">· {issueDate}</span>
          </div>
          {notes && <p className="text-xs text-slate-500">ملاحظات: {notes}</p>}
          <div className="overflow-hidden rounded-xl border border-slate-100">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-400"><tr><th className="px-3 py-2 text-right">الصنف</th><th className="px-3 py-2 text-center">الكمية المطلوبة</th><th className="px-3 py-2 text-center">متاح بالمصدر</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {lines.map((l) => {
                  const over = l.available > 0 && l.qtyRequested > l.available;
                  return (
                    <tr key={l.itemId}>
                      <td className="px-3 py-2 font-bold text-slate-800">{l.name}</td>
                      <td className="px-3 py-2 text-center tabular-nums">{formatQty(l.qtyRequested, l.unit)}</td>
                      <td className={`px-3 py-2 text-center tabular-nums ${over ? "font-bold text-amber-600" : "text-slate-500"}`}>{formatQty(l.available)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {lines.some((l) => l.available > 0 && l.qtyRequested > l.available) && (
            <p className="flex items-center gap-2 text-xs font-bold text-amber-600">
              <AlertTriangle className="h-4 w-4" /> بعض الكميات تتجاوز المتاح حاليًا بالمصدر — يُسمح بحفظ المسودة، لكن الإصدار سيتحقق من الرصيد.
            </p>
          )}
          {submitError && <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{submitError}</div>}
          <div className="flex justify-between">
            <Button variant="secondary" onClick={() => setStep(2)}><ChevronRight className="h-4 w-4" /> السابق</Button>
            <Button variant="primary" disabled={createDraft.isPending || !step1Valid || !step2Valid} onClick={submit}>
              {createDraft.isPending ? <><Spinner className="h-4 w-4" /> جارٍ الحفظ…</> : "حفظ كمسودة"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
