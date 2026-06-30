import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, Trash2, X } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Stepper } from "@/features/transfers/Stepper";
import { LoadingState } from "@/components/states/States";
import { ApiError } from "@/lib/api-error";
import { useWarehouses } from "@/lib/hooks/useWarehouses";
import { useWarehouseInventory } from "@/lib/hooks/useInventory";
import { useWarehouseScope } from "@/app/warehouse-scope-provider";
import { formatCurrency, formatQty } from "@/lib/formatters";
import { useInvTxDetail, useInvTxMutations, useGlAccounts } from "@/lib/hooks/useInventoryTx";
import {
  createReceiptInput, createIssueInput, createAdjustmentInput,
  updateReceiptInput, updateIssueInput, updateAdjustmentInput,
} from "@/lib/schemas/invtx.schema";
import type { InvTxConfig } from "./invtxConfig";

interface Line { itemId: string; itemName: string; unit: string; qty: number; unitCost: number; countedQty: number; systemQty: number }

const STEPS = ["الأساسيات", "الأصناف", "المراجعة"];

export function InvTxWizard({ config }: { config: InvTxConfig }) {
  const navigate = useNavigate();
  const [sp] = useSearchParams();
  const editId = sp.get("edit");
  const { accessibleWarehouses, allWarehousesAccess } = useWarehouseScope();
  const allWh = useWarehouses();
  const m = useInvTxMutations(config.docType);
  const edit = useInvTxDetail(config.docType, editId);

  const [step, setStep] = useState(1);
  const [warehouseId, setWarehouseId] = useState("");
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [counterAccount, setCounterAccount] = useState("");
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
    setCounterAccount(d.counterAccountCode ?? d.expenseAccountCode ?? "");
    setRecipient(d.recipient ?? "");
    setEvidence(d.referenceEvidence ?? "");
    setNotes(d.notes ?? "");
    setLines(d.lines.map((l) => ({ itemId: l.item.id, itemName: l.item.name, unit: l.item.unit, qty: l.qty || 0, unitCost: l.unitCost || 0, countedQty: l.countedQty || 0, systemQty: l.systemQtySnapshot || 0 })));
    setPrefilled(true);
  }

  const whOptions = useMemo(() => {
    if (!allWarehousesAccess) return accessibleWarehouses.map((w) => ({ id: w.id, name: w.name }));
    return (allWh.data?.warehouses ?? []).map((w) => ({ id: w.id, name: w.name }));
  }, [allWarehousesAccess, accessibleWarehouses, allWh.data]);

  const inv = useWarehouseInventory({ scope: warehouseId || "all", pageSize: 500 });
  const itemOptions = useMemo(() => (inv.data?.rows ?? []).filter((r) => !lines.some((l) => l.itemId === r.itemId)), [inv.data, lines]);

  function addItem(itemId: string) {
    const row = (inv.data?.rows ?? []).find((r) => r.itemId === itemId);
    if (!row) return;
    setLines((ls) => [...ls, { itemId: row.itemId, itemName: row.name, unit: row.unit, qty: 1, unitCost: config.lineMode === "receipt" ? row.avgCost || 0 : 0, countedQty: row.qty, systemQty: row.qty }]);
  }
  function updateLine(i: number, patch: Partial<Line>) { setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l))); }
  function removeLine(i: number) { setLines((ls) => ls.filter((_, idx) => idx !== i)); }

  const isAdj = config.lineMode === "adjustment";
  const isReceipt = config.lineMode === "receipt";
  const isIssue = config.lineMode === "issue";
  // Receipts/issues require a validated GL counter account (no silent default).
  const accountUsage = isReceipt ? "receipt" : isIssue ? "issue" : null;
  const accounts = useGlAccounts(accountUsage);
  const needsAccount = isReceipt || isIssue;
  const total = useMemo(() => lines.reduce((s, l) => s + (isAdj ? (l.countedQty - l.systemQty) * l.unitCost : l.qty * l.unitCost), 0), [lines, isAdj]);

  function buildPayload(): Record<string, unknown> {
    const items = lines.map((l) =>
      isReceipt ? { itemId: l.itemId, qty: Number(l.qty), unitCost: Number(l.unitCost) }
        : isAdj ? { itemId: l.itemId, countedQty: Number(l.countedQty) }
          : { itemId: l.itemId, qty: Number(l.qty) },
    );
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
  const canNext2 = lines.length > 0 && lines.every((l) => (isAdj ? l.countedQty >= 0 : l.qty > 0) && (!isReceipt || l.unitCost > 0));

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
              <label className="block text-xs font-bold text-slate-500 sm:col-span-2">{isReceipt ? "الحساب المقابل (دائن)" : "حساب المصروف (مدين)"} (إلزامي)
                <select className="field mt-1 w-full" value={counterAccount} onChange={(e) => setCounterAccount(e.target.value)} aria-label="الحساب المحاسبي" disabled={accounts.isLoading}>
                  <option value="">{accounts.isLoading ? "تحميل الحسابات…" : "اختر الحساب"}</option>
                  {(accounts.data ?? []).map((a) => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
                </select>
              </label>
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
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold text-slate-500">أصناف المستودع</span>
              <select className="field max-w-xs" value="" onChange={(e) => { if (e.target.value) addItem(e.target.value); }} aria-label="إضافة صنف" disabled={!warehouseId || inv.isLoading}>
                <option value="">{inv.isLoading ? "تحميل…" : "+ أضف صنفًا"}</option>
                {itemOptions.map((r) => <option key={r.itemId} value={r.itemId}>{r.name} ({formatQty(r.qty)} {r.unit})</option>)}
              </select>
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
                      const delta = l.countedQty - l.systemQty;
                      return (
                        <tr key={l.itemId}>
                          <td className="py-2 font-bold text-slate-700">{l.itemName}</td>
                          {isAdj ? (
                            <>
                              <td className="text-center tabular-nums text-slate-500">{formatQty(l.systemQty)}</td>
                              <td className="text-center"><input type="number" min={0} step="any" className="field w-24 text-center" value={l.countedQty} onChange={(e) => updateLine(i, { countedQty: Number(e.target.value) })} aria-label="الكمية المجرودة" /></td>
                              <td className={`text-center font-bold tabular-nums ${delta < 0 ? "text-rose-600" : delta > 0 ? "text-emerald-600" : "text-slate-400"}`}>{delta > 0 ? "+" : ""}{formatQty(delta)}</td>
                            </>
                          ) : (
                            <td className="text-center"><input type="number" min={0} step="any" className="field w-24 text-center" value={l.qty} onChange={(e) => updateLine(i, { qty: Number(e.target.value) })} aria-label="الكمية" /></td>
                          )}
                          {isReceipt && <td className="text-center"><input type="number" min={0} step="any" className="field w-24 text-center" value={l.unitCost} onChange={(e) => updateLine(i, { unitCost: Number(e.target.value) })} aria-label="تكلفة الوحدة" /></td>}
                          {!isAdj && <td className="text-center tabular-nums text-slate-600">{formatCurrency(l.qty * l.unitCost)}</td>}
                          <td className="text-left"><Button variant="ghost" size="icon" aria-label="حذف" onClick={() => removeLine(i)}><Trash2 className="h-4 w-4" /></Button></td>
                        </tr>
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
