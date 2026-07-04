import { Fragment, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, Trash2, X } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Stepper } from "@/features/transfers/Stepper";
import { LoadingState } from "@/components/states/States";
import { ApiError } from "@/lib/api-error";
import { useWarehouses } from "@/lib/hooks/useWarehouses";
import { useWarehouseScope } from "@/app/warehouse-scope-provider";
import { formatCurrency, formatQty } from "@/lib/formatters";
import { useInvTxDetail, useInvTxMutations } from "@/lib/hooks/useInventoryTx";
import { SearchableEntityCombobox } from "@/components/ui/SearchableEntityCombobox";
import { UnitQtyInput, baseFromValue, type ItemUnitLite, type UnitQtyValue } from "@/components/ui/UnitQtyInput";
import { makeItemFetcher, makeAccountFetcher, type ItemHit, type AccountHit } from "@/lib/hooks/useEntitySearch";
import {
  createReceiptInput, createIssueInput, createAdjustmentInput,
  updateReceiptInput, updateIssueInput, updateAdjustmentInput,
} from "@/lib/schemas/invtx.schema";
import type { InvTxConfig } from "./invtxConfig";

interface Line { itemId: string; itemName: string; unit: string; units: ItemUnitLite[]; uv: UnitQtyValue; unitCost: number; systemQty: number; lotNumber?: string; expiryDate?: string }

// build the base+major unit list a picker returns into the UnitQtyInput shape
function unitsOf(hit: Pick<ItemHit, "baseUnit" | "majorUnits">): ItemUnitLite[] {
  return [
    { code: hit.baseUnit.code, name: hit.baseUnit.name, factor: 1, isBase: true },
    ...(hit.majorUnits ?? []).map((mu) => ({ code: mu.unitCode, name: mu.unitName, factor: mu.factor })),
  ];
}

const STEPS = ["الأساسيات", "الأصناف", "المراجعة"];

export function InvTxWizard({ config }: { config: InvTxConfig }) {
  const navigate = useNavigate();
  const [sp] = useSearchParams();
  const editId = sp.get("edit");
  const { accessibleWarehouses, allWarehousesAccess } = useWarehouseScope();
  const allWh = useWarehouses();
  const m = useInvTxMutations(config.docType);
  const edit = useInvTxDetail(config.docType, editId);

  const isAdj = config.lineMode === "adjustment";
  const isReceipt = config.lineMode === "receipt";
  const isIssue = config.lineMode === "issue";
  const needsAccount = isReceipt || isIssue;

  const [step, setStep] = useState(1);
  const [warehouseId, setWarehouseId] = useState("");
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [counterAccount, setCounterAccount] = useState("");
  const [accountSel, setAccountSel] = useState<AccountHit | null>(null);
  const [recipient, setRecipient] = useState("");
  const [evidence, setEvidence] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [prefilled, setPrefilled] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Prefill in edit mode once the document loads.
  if (editId && edit.data && !prefilled) {
    const d = edit.data;
    setWarehouseId(d.warehouse.id);
    setDate(d.date ?? "");
    setReason(d.reason ?? "");
    setSourceRef(d.sourceRef ?? "");
    const acode = d.counterAccountCode ?? d.expenseAccountCode ?? "";
    setCounterAccount(acode);
    if (acode) setAccountSel({ id: acode, code: acode, name: acode, type: "", active: true });
    setRecipient(d.recipient ?? "");
    setEvidence(d.referenceEvidence ?? "");
    setNotes(d.notes ?? "");
    setLines(d.lines.map((l) => {
      const units: ItemUnitLite[] = [{ code: l.item.unit, name: l.item.unit, factor: 1, isBase: true }];
      const enteredQty = isAdj ? (l.countedQty || 0) : (l.qty || 0);
      return { itemId: l.item.id, itemName: l.item.name, unit: l.item.unit, units, uv: { unitCode: l.item.unit, qty: enteredQty }, unitCost: l.unitCost || 0, systemQty: l.systemQtySnapshot || 0 };
    }));
    setPrefilled(true);
  }

  const whOptions = useMemo(() => {
    if (!allWarehousesAccess) return accessibleWarehouses.map((w) => ({ id: w.id, name: w.name }));
    return (allWh.data?.warehouses ?? []).map((w) => ({ id: w.id, name: w.name }));
  }, [allWarehousesAccess, accessibleWarehouses, allWh.data]);

  // Server-side item search scoped to the chosen warehouse + document context, so
  // balances/warnings reflect the target warehouse and inactive items are hidden.
  const itemFetcher = useMemo(
    () => makeItemFetcher({ warehouseId: warehouseId || undefined, context: isReceipt ? "receipt" : isAdj ? "stocktake" : "issue", activeOnly: true }),
    [warehouseId, isReceipt, isAdj],
  );
  const accountFetcher = useMemo(
    () => makeAccountFetcher({ context: isReceipt ? "receipt" : "issue", postingOnly: true }),
    [isReceipt],
  );

  function addItem(hit: ItemHit) {
    if (lines.some((l) => l.itemId === hit.id)) return;
    const units = unitsOf(hit);
    setLines((ls) => [...ls, {
      itemId: hit.id, itemName: hit.name, unit: hit.baseUnit.name, units,
      uv: { unitCode: hit.baseUnit.code, qty: 1 },
      unitCost: isReceipt ? (hit.warehouseCost ?? 0) : 0,
      systemQty: hit.warehouseQty ?? 0,
    }]);
  }
  function updateLine(i: number, patch: Partial<Line>) { setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l))); }
  function removeLine(i: number) { setLines((ls) => ls.filter((_, idx) => idx !== i)); }

  const lineBase = (l: Line) => baseFromValue(l.units, l.uv, "single");
  const total = useMemo(() => lines.reduce((s, l) => s + (isAdj ? (lineBase(l) - l.systemQty) * l.unitCost : lineBase(l) * l.unitCost), 0), [lines, isAdj]);

  function buildPayload(): Record<string, unknown> {
    // Send the ENTERED unit + qty; the backend recomputes baseQty (frozen factor).
    // Lots for receipts are always in base qty (the ledger is base-only).
    const items = lines.map((l) => {
      const base = lineBase(l);
      // `qty` (base) satisfies the client zod mirror; `enteredUnitCode`/`enteredQty`
      // drive the server's authoritative base recompute (frozen factor).
      const u = { qty: base, enteredUnitCode: l.uv.unitCode, enteredQty: Number(l.uv.qty) };
      return isReceipt
        ? { itemId: l.itemId, ...u, unitCost: Number(l.unitCost), ...(l.lotNumber && l.lotNumber.trim() ? { lots: [{ lotNumber: l.lotNumber.trim(), qty: base, expiryDate: l.expiryDate || undefined }] } : {}) }
        : isAdj ? { itemId: l.itemId, enteredUnitCode: l.uv.unitCode, countedQty: Number(l.uv.qty), baseCountedQty: base }
          : { itemId: l.itemId, ...u };
    });
    const base: Record<string, unknown> = { warehouseId, notes: notes || undefined, items };
    if (isReceipt) { base.receiptDate = date || undefined; base.reason = reason; base.counterAccountCode = counterAccount; if (sourceRef) base.sourceRef = sourceRef; }
    if (isIssue) { base.issueDate = date || undefined; base.reason = reason; base.expenseAccountCode = counterAccount; if (recipient) base.recipient = recipient; }
    if (isAdj) { base.adjustmentDate = date || undefined; base.reason = reason; if (evidence) base.referenceEvidence = evidence; }
    return base;
  }

  function validate(): string | null {
    const schema = editId
      ? (isReceipt ? updateReceiptInput : isAdj ? updateAdjustmentInput : updateIssueInput)
      : (isReceipt ? createReceiptInput : isAdj ? createAdjustmentInput : createIssueInput);
    const payload = buildPayload();
    if (editId) payload.expectedVersion = edit.data?.version ?? 0;
    const r = schema.safeParse(payload);
    if (!r.success) return r.error.issues[0]?.message ?? "تحقّق من المدخلات";
    return null;
  }

  function submit() {
    setErr(null);
    const v = validate();
    if (v) { setErr(v); return; }
    const payload = buildPayload();
    const onDone = (id?: string) => navigate(`${config.routeBase}?view=${id ?? editId}`);
    const onErr = (e: unknown) => setErr(e instanceof ApiError ? (e.isConflict ? "تغيّرت المسودة منذ آخر تحميل — أعد التحميل وحاول مجددًا." : e.message) : "تعذّر الحفظ.");
    if (editId) {
      m.update.mutate({ id: editId, input: { ...payload, expectedVersion: edit.data?.version ?? 0 } }, { onSuccess: () => onDone(editId), onError: onErr });
    } else {
      m.create.mutate(payload, { onSuccess: (r) => onDone((r.data?.id as string) || undefined), onError: onErr });
    }
  }

  const saving = m.create.isPending || m.update.isPending;
  if (editId && edit.isLoading) return <div className="p-4"><LoadingState rows={2} /></div>;

  const canNext1 = !!warehouseId && reason.trim().length >= 2 && (!needsAccount || !!counterAccount);
  const canNext2 = lines.length > 0 && lines.every((l) => (isAdj ? lineBase(l) >= 0 : lineBase(l) > 0) && (!isReceipt || l.unitCost > 0));

  return (
    <div>
      <PageHeader
        eyebrow={config.title}
        title={editId ? `تعديل مسودة — ${edit.data?.number ?? ""}` : config.newLabel}
        subtitle={config.subtitle}
        action={<Button variant="ghost" onClick={() => navigate(config.routeBase)}><X className="h-4 w-4" /> إغلاق</Button>}
      />
      <div className="surface p-5">
        <Stepper steps={STEPS} current={step} />
        {err && <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">{err}</p>}

        {/* Step 1 — basics */}
        {step === 1 && (
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="block text-xs font-bold text-slate-500">المستودع
              <select className="field mt-1 w-full" value={warehouseId} onChange={(e) => { setWarehouseId(e.target.value); setLines([]); }} disabled={!!editId} aria-label="المستودع">
                <option value="">اختر المستودع</option>
                {whOptions.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </label>
            <label className="block text-xs font-bold text-slate-500">التاريخ
              <input type="date" className="field mt-1 w-full" value={date} onChange={(e) => setDate(e.target.value)} aria-label="التاريخ" />
            </label>
            <label className="block text-xs font-bold text-slate-500 sm:col-span-2">السبب (إلزامي)
              <input className="field mt-1 w-full" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={isReceipt ? "سبب الاستلام" : isAdj ? "سبب التعديل/الجرد" : "سبب الصرف"} aria-label="السبب" />
            </label>
            {needsAccount && (
              <div className="block text-xs font-bold text-slate-500 sm:col-span-2">
                <span>{isReceipt ? "الحساب المقابل (دائن)" : "حساب المصروف (مدين)"} (إلزامي)</span>
                <div className="mt-1">
                  <SearchableEntityCombobox<AccountHit>
                    value={accountSel}
                    onChange={(a) => { setAccountSel(a); setCounterAccount(a?.code ?? ""); }}
                    fetcher={accountFetcher}
                    queryKey={["account-search", isReceipt ? "receipt" : "issue"]}
                    getKey={(a) => a.id}
                    getLabel={(a) => a.name}
                    getSublabel={(a) => `${a.code}`}
                    placeholder="ابحث عن حساب بالكود أو الاسم…"
                    ariaLabel="الحساب المحاسبي"
                    emptyText="لا حسابات ترحيل مطابقة."
                  />
                </div>
              </div>
            )}
            {isReceipt && (
              <label className="block text-xs font-bold text-slate-500 sm:col-span-2">المرجع (اختياري)
                <input className="field mt-1 w-full" value={sourceRef} onChange={(e) => setSourceRef(e.target.value)} placeholder="مثال: رصيد افتتاحي" aria-label="المرجع" />
              </label>
            )}
            {config.lineMode === "issue" && (
              <label className="block text-xs font-bold text-slate-500">الجهة المستلِمة (اختياري)
                <input className="field mt-1 w-full" value={recipient} onChange={(e) => setRecipient(e.target.value)} aria-label="الجهة المستلِمة" />
              </label>
            )}
            {isAdj && (
              <label className="block text-xs font-bold text-slate-500">إثبات/مرجع (للتعديلات الكبيرة)
                <input className="field mt-1 w-full" value={evidence} onChange={(e) => setEvidence(e.target.value)} aria-label="إثبات" />
              </label>
            )}
            <label className="block text-xs font-bold text-slate-500 sm:col-span-2">ملاحظات
              <textarea className="field mt-1 w-full" value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="ملاحظات" />
            </label>
            <div className="sm:col-span-2 flex justify-end">
              <Button variant="primary" disabled={!canNext1} onClick={() => setStep(2)}>التالي <ArrowRight className="h-4 w-4" /></Button>
            </div>
          </div>
        )}

        {/* Step 2 — items */}
        {step === 2 && (
          <div className="mt-5 space-y-4">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-bold text-slate-500">أضف صنفًا (بحث بالاسم/SKU/الباركود)</span>
              <div className="max-w-md">
                <SearchableEntityCombobox<ItemHit>
                  value={null}
                  onChange={(hit) => { if (hit) addItem(hit); }}
                  fetcher={itemFetcher}
                  queryKey={["item-search", warehouseId, isReceipt ? "receipt" : isAdj ? "stocktake" : "issue"]}
                  getKey={(it) => it.id}
                  getLabel={(it) => it.name}
                  getSublabel={(it) => [it.sku, it.warehouseQty != null ? `${formatQty(it.warehouseQty)} ${it.baseUnit.name}` : null].filter(Boolean).join(" · ") || undefined}
                  placeholder="ابحث عن صنف…"
                  ariaLabel="إضافة صنف"
                  autoSelectExact
                  emptyText="لا أصناف مطابقة."
                />
              </div>
            </div>
            {lines.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-200 p-6 text-center text-sm text-slate-400">أضف صنفًا واحدًا على الأقل.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-slate-400">
                    <tr>
                      <th className="py-2 text-right">الصنف</th>
                      {isAdj ? (<><th>رصيد النظام</th><th>المجرود</th><th>الفرق</th></>) : (<th>الكمية</th>)}
                      {isReceipt && <th>تكلفة الوحدة</th>}
                      {!isAdj && <th>الإجمالي</th>}
                      <th></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {lines.map((l, i) => {
                      const base = lineBase(l);
                      const delta = base - l.systemQty;
                      return (
                        <Fragment key={l.itemId}>
                        <tr>
                          <td className="py-2 font-bold text-slate-700">{l.itemName}</td>
                          {isAdj ? (
                            <>
                              <td className="text-center tabular-nums text-slate-500" dir="ltr">{formatQty(l.systemQty)} {l.unit}</td>
                              <td className="text-center"><div className="inline-block"><UnitQtyInput units={l.units} value={l.uv} onChange={(uv) => updateLine(i, { uv })} mode="single" qtyLabel="الكمية المجرودة" minQty={0} /></div></td>
                              <td className={`text-center font-bold tabular-nums ${delta < 0 ? "text-rose-600" : delta > 0 ? "text-emerald-600" : "text-slate-400"}`} dir="ltr">{delta > 0 ? "+" : ""}{formatQty(delta)}</td>
                            </>
                          ) : (
                            <td className="text-center"><div className="inline-block"><UnitQtyInput units={l.units} value={l.uv} onChange={(uv) => updateLine(i, { uv })} mode="single" /></div></td>
                          )}
                          {isReceipt && <td className="text-center"><input type="number" min={0} step="any" className="field w-24 text-center" value={l.unitCost} onChange={(e) => updateLine(i, { unitCost: Number(e.target.value) })} aria-label="تكلفة الوحدة" dir="ltr" /></td>}
                          {!isAdj && <td className="text-center tabular-nums text-slate-600">{formatCurrency(base * l.unitCost)}</td>}
                          <td className="text-left"><Button variant="ghost" size="icon" aria-label="حذف" onClick={() => removeLine(i)}><Trash2 className="h-4 w-4" /></Button></td>
                        </tr>
                        {isReceipt && (
                          <tr className="bg-slate-50/50">
                            <td colSpan={6} className="px-2 pb-2">
                              <div className="flex flex-wrap items-center gap-2 text-xs">
                                <span className="font-bold text-slate-400">دفعة (إلزامية للأصناف المُتتبعة):</span>
                                <input className="field h-9 w-40" placeholder="رقم الدفعة" value={l.lotNumber ?? ""} onChange={(e) => updateLine(i, { lotNumber: e.target.value })} aria-label="رقم الدفعة" />
                                <input type="date" className="field h-9 w-40" value={l.expiryDate ?? ""} onChange={(e) => updateLine(i, { expiryDate: e.target.value })} aria-label="تاريخ الصلاحية" />
                              </div>
                            </td>
                          </tr>
                        )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setStep(1)}>السابق</Button>
              <Button variant="primary" disabled={!canNext2} onClick={() => setStep(3)}>المراجعة <ArrowRight className="h-4 w-4" /></Button>
            </div>
          </div>
        )}

        {/* Step 3 — review */}
        {step === 3 && (
          <div className="mt-5 space-y-4">
            <div className="grid gap-2 sm:grid-cols-3 text-sm">
              <Stat label="المستودع" value={whOptions.find((w) => w.id === warehouseId)?.name ?? warehouseId} />
              <Stat label="عدد الأصناف" value={String(lines.length)} />
              <Stat label={isAdj ? "صافي قيمة الفرق" : "القيمة الإجمالية"} value={formatCurrency(total)} />
              {reason && <Stat label="السبب" value={reason} />}
            </div>
            {isAdj && <p className="rounded-lg bg-blue-50 px-3 py-2 text-xs font-bold text-blue-700">يحسب النظام الفرق (delta) ويعيد قراءة الرصيد عند الترحيل؛ إن تغيّر الرصيد منذ الجرد يُرفض الترحيل (QUANTITY_CONFLICT).</p>}
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setStep(2)}>السابق</Button>
              <Button variant="primary" disabled={saving} onClick={submit}>{saving ? "جارٍ الحفظ…" : editId ? "حفظ التعديل" : "حفظ كمسودة"}</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-slate-100 bg-slate-50 p-3"><div className="text-[10px] font-bold text-slate-400">{label}</div><div className="mt-1 font-extrabold text-slate-800">{value}</div></div>;
}
