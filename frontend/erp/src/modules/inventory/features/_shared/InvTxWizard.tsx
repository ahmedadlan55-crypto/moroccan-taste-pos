import { Fragment, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, Trash2, X } from "lucide-react";
import { PageHeader } from "@/shared/ui";
import { Button } from "@/shared/ui";
import { Stepper } from "@/modules/inventory/features/transfers/Stepper";
import { LoadingState } from "@/shared/ui";
import { ApiError } from "@/shared/api";
import { useT } from "@/i18n";
import { useWarehouses } from "@/modules/inventory/lib/hooks/useWarehouses";
import { useWarehouseScope } from "@/modules/inventory/lib/warehouse-scope-provider";
import { formatCurrency, formatQty } from "@/shared/lib";
import { useInvTxDetail, useInvTxMutations } from "@/modules/inventory/lib/hooks/useInventoryTx";
import { DatePicker, SearchableEntityCombobox } from "@/shared/ui";
import { UnitQtyInput, baseFromValue, type ItemUnitLite, type UnitQtyValue } from "@/shared/ui";
import { makeItemFetcher, makeAccountFetcher, type ItemHit, type AccountHit } from "@/modules/inventory/lib/hooks/useEntitySearch";
import {
  createReceiptInput, createIssueInput, createAdjustmentInput,
  updateReceiptInput, updateIssueInput, updateAdjustmentInput,
} from "@/modules/inventory/lib/schemas/invtx.schema";
import type { InvTxConfig } from "./invtxConfig";

interface Line { itemId: string; itemName: string; unit: string; units: ItemUnitLite[]; uv: UnitQtyValue; unitCost: number; systemQty: number; lotNumber?: string; expiryDate?: string }

// build the base+major unit list a picker returns into the UnitQtyInput shape
function unitsOf(hit: Pick<ItemHit, "baseUnit" | "majorUnits">): ItemUnitLite[] {
  return [
    { code: hit.baseUnit.code, name: hit.baseUnit.name, factor: 1, isBase: true },
    ...(hit.majorUnits ?? []).map((mu) => ({ code: mu.unitCode, name: mu.unitName, factor: mu.factor })),
  ];
}

export function InvTxWizard({ config }: { config: InvTxConfig }) {
  const t = useT();
  const STEPS = [t("inventoryRest.invtx.wizard.stepBasics"), t("inventoryRest.invtx.wizard.stepItems"), t("inventoryRest.invtx.wizard.stepReview")];
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
    if (!r.success) return r.error.issues[0]?.message ?? t("inventoryRest.invtx.wizard.validateFallback");
    return null;
  }

  function submit() {
    setErr(null);
    const v = validate();
    if (v) { setErr(v); return; }
    const payload = buildPayload();
    const onDone = (id?: string) => navigate(`${config.routeBase}?view=${id ?? editId}`);
    const onErr = (e: unknown) => setErr(e instanceof ApiError ? (e.isConflict ? t("inventoryRest.invtx.wizard.draftChanged") : e.message) : t("inventoryRest.invtx.wizard.saveFailed"));
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
        eyebrow={t(config.title)}
        title={editId ? t("inventoryRest.invtx.wizard.editTitle", { number: edit.data?.number ?? "" }) : t(config.newLabel)}
        subtitle={t(config.subtitle)}
        action={<Button variant="ghost" onClick={() => navigate(config.routeBase)}><X className="h-4 w-4" /> {t("inventoryRest.ui.close")}</Button>}
      />
      <div className="surface p-5">
        <Stepper steps={STEPS} current={step} />
        {err && <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">{err}</p>}

        {/* Step 1 — basics */}
        {step === 1 && (
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="block text-xs font-bold text-slate-500">{t("inventoryRest.invtx.wizard.warehouse")}
              <select className="field mt-1 w-full" value={warehouseId} onChange={(e) => { setWarehouseId(e.target.value); setLines([]); }} disabled={!!editId} aria-label={t("inventoryRest.invtx.wizard.warehouse")}>
                <option value="">{t("inventoryRest.invtx.wizard.pickWarehouse")}</option>
                {whOptions.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </label>
            <label className="block text-xs font-bold text-slate-500">{t("inventoryRest.invtx.wizard.date")}
              <DatePicker className="mt-1 block" value={date} onChange={setDate} aria-label={t("inventoryRest.invtx.wizard.date")} />
            </label>
            <label className="block text-xs font-bold text-slate-500 sm:col-span-2">{t("inventoryRest.invtx.wizard.reason")}
              <input className="field mt-1 w-full" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={isReceipt ? t("inventoryRest.invtx.wizard.reasonReceipt") : isAdj ? t("inventoryRest.invtx.wizard.reasonAdjustment") : t("inventoryRest.invtx.wizard.reasonIssue")} aria-label={t("inventoryRest.reasonDialog.reasonAria")} />
            </label>
            {needsAccount && (
              <div className="block text-xs font-bold text-slate-500 sm:col-span-2">
                <span>{isReceipt ? t("inventoryRest.invtx.wizard.counterAccount") : t("inventoryRest.invtx.wizard.expenseAccount")} {t("inventoryRest.invtx.wizard.required")}</span>
                <div className="mt-1">
                  <SearchableEntityCombobox<AccountHit>
                    value={accountSel}
                    onChange={(a) => { setAccountSel(a); setCounterAccount(a?.code ?? ""); }}
                    fetcher={accountFetcher}
                    queryKey={["account-search", isReceipt ? "receipt" : "issue"]}
                    getKey={(a) => a.id}
                    getLabel={(a) => a.name}
                    getSublabel={(a) => `${a.code}`}
                    placeholder={t("inventoryRest.invtx.wizard.accountSearch")}
                    ariaLabel={t("inventoryRest.invtx.wizard.accountAria")}
                    emptyText={t("inventoryRest.invtx.wizard.accountEmpty")}
                  />
                </div>
              </div>
            )}
            {isReceipt && (
              <label className="block text-xs font-bold text-slate-500 sm:col-span-2">{t("inventoryRest.invtx.wizard.sourceRef")}
                <input className="field mt-1 w-full" value={sourceRef} onChange={(e) => setSourceRef(e.target.value)} placeholder={t("inventoryRest.invtx.wizard.sourceRefPlaceholder")} aria-label={t("inventoryRest.invtx.detail.ref")} />
              </label>
            )}
            {config.lineMode === "issue" && (
              <label className="block text-xs font-bold text-slate-500">{t("inventoryRest.invtx.wizard.recipient")}
                <input className="field mt-1 w-full" value={recipient} onChange={(e) => setRecipient(e.target.value)} aria-label={t("inventoryRest.invtx.detail.recipient")} />
              </label>
            )}
            {isAdj && (
              <label className="block text-xs font-bold text-slate-500">{t("inventoryRest.invtx.wizard.evidence")}
                <input className="field mt-1 w-full" value={evidence} onChange={(e) => setEvidence(e.target.value)} aria-label={t("inventoryRest.invtx.detail.evidence")} />
              </label>
            )}
            <label className="block text-xs font-bold text-slate-500 sm:col-span-2">{t("inventoryRest.invtx.wizard.notes")}
              <textarea className="field mt-1 w-full" value={notes} onChange={(e) => setNotes(e.target.value)} aria-label={t("inventoryRest.invtx.wizard.notes")} />
            </label>
            <div className="sm:col-span-2 flex justify-end">
              <Button variant="primary" disabled={!canNext1} onClick={() => setStep(2)}>{t("inventoryRest.ui.next")} <ArrowRight className="h-4 w-4" /></Button>
            </div>
          </div>
        )}

        {/* Step 2 — items */}
        {step === 2 && (
          <div className="mt-5 space-y-4">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-bold text-slate-500">{t("inventoryRest.invtx.wizard.addItem")}</span>
              <div className="max-w-md">
                <SearchableEntityCombobox<ItemHit>
                  value={null}
                  onChange={(hit) => { if (hit) addItem(hit); }}
                  fetcher={itemFetcher}
                  queryKey={["item-search", warehouseId, isReceipt ? "receipt" : isAdj ? "stocktake" : "issue"]}
                  getKey={(it) => it.id}
                  getLabel={(it) => it.name}
                  getSublabel={(it) => [it.sku, it.warehouseQty != null ? `${formatQty(it.warehouseQty)} ${it.baseUnit.name}` : null].filter(Boolean).join(" · ") || undefined}
                  placeholder={t("inventoryRest.invtx.wizard.itemSearch")}
                  ariaLabel={t("inventoryRest.invtx.wizard.addItemAria")}
                  autoSelectExact
                  emptyText={t("inventoryRest.invtx.wizard.itemsEmptyPicker")}
                />
              </div>
            </div>
            {lines.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-200 p-6 text-center text-sm text-slate-400">{t("inventoryRest.invtx.wizard.addAtLeastOne")}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-slate-400">
                    <tr>
                      <th className="py-2 text-right">{t("inventoryRest.invtx.wizard.colItem")}</th>
                      {isAdj ? (<><th>{t("inventoryRest.invtx.wizard.colSystemQty")}</th><th>{t("inventoryRest.invtx.wizard.colCounted")}</th><th>{t("inventoryRest.invtx.wizard.colDelta")}</th></>) : (<th>{t("inventoryRest.invtx.wizard.colQty")}</th>)}
                      {isReceipt && <th>{t("inventoryRest.invtx.wizard.colUnitCost")}</th>}
                      {!isAdj && <th>{t("inventoryRest.invtx.wizard.colTotal")}</th>}
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
                              <td className="text-center"><div className="inline-block"><UnitQtyInput units={l.units} value={l.uv} onChange={(uv) => updateLine(i, { uv })} mode="single" qtyLabel={t("inventoryRest.invtx.wizard.countedQtyLabel")} minQty={0} /></div></td>
                              <td className={`text-center font-bold tabular-nums ${delta < 0 ? "text-rose-600" : delta > 0 ? "text-emerald-600" : "text-slate-400"}`} dir="ltr">{delta > 0 ? "+" : ""}{formatQty(delta)}</td>
                            </>
                          ) : (
                            <td className="text-center"><div className="inline-block"><UnitQtyInput units={l.units} value={l.uv} onChange={(uv) => updateLine(i, { uv })} mode="single" /></div></td>
                          )}
                          {isReceipt && <td className="text-center"><input type="number" min={0} step="any" className="field w-24 text-center" value={l.unitCost} onChange={(e) => updateLine(i, { unitCost: Number(e.target.value) })} aria-label={t("inventoryRest.invtx.wizard.unitCostAria")} dir="ltr" /></td>}
                          {!isAdj && <td className="text-center tabular-nums text-slate-600">{formatCurrency(base * l.unitCost)}</td>}
                          <td className="text-left"><Button variant="ghost" size="icon" aria-label={t("inventoryRest.invtx.wizard.removeAria")} onClick={() => removeLine(i)}><Trash2 className="h-4 w-4" /></Button></td>
                        </tr>
                        {isReceipt && (
                          <tr className="bg-slate-50/50">
                            <td colSpan={6} className="px-2 pb-2">
                              <div className="flex flex-wrap items-center gap-2 text-xs">
                                <span className="font-bold text-slate-400">{t("inventoryRest.invtx.wizard.lotLabel")}</span>
                                <input className="field h-9 w-40" placeholder={t("inventoryRest.invtx.wizard.lotNumber")} value={l.lotNumber ?? ""} onChange={(e) => updateLine(i, { lotNumber: e.target.value })} aria-label={t("inventoryRest.invtx.wizard.lotNumber")} />
                                <DatePicker className="h-9 w-40" value={l.expiryDate ?? ""} onChange={(v) => updateLine(i, { expiryDate: v })} aria-label={t("inventoryRest.invtx.wizard.lotExpiryAria")} />
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
              <Button variant="ghost" onClick={() => setStep(1)}>{t("inventoryRest.ui.prev")}</Button>
              <Button variant="primary" disabled={!canNext2} onClick={() => setStep(3)}>{t("inventoryRest.invtx.wizard.stepReview")} <ArrowRight className="h-4 w-4" /></Button>
            </div>
          </div>
        )}

        {/* Step 3 — review */}
        {step === 3 && (
          <div className="mt-5 space-y-4">
            <div className="grid gap-2 sm:grid-cols-3 text-sm">
              <Stat label={t("inventoryRest.invtx.wizard.reviewWarehouse")} value={whOptions.find((w) => w.id === warehouseId)?.name ?? warehouseId} />
              <Stat label={t("inventoryRest.invtx.wizard.reviewItemCount")} value={String(lines.length)} />
              <Stat label={isAdj ? t("inventoryRest.invtx.wizard.reviewNetDelta") : t("inventoryRest.invtx.wizard.reviewTotal")} value={formatCurrency(total)} />
              {reason && <Stat label={t("inventoryRest.invtx.wizard.reviewReason")} value={reason} />}
            </div>
            {isAdj && <p className="rounded-lg bg-blue-50 px-3 py-2 text-xs font-bold text-blue-700">{t("inventoryRest.invtx.wizard.adjHint")}</p>}
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setStep(2)}>{t("inventoryRest.ui.prev")}</Button>
              <Button variant="primary" disabled={saving} onClick={submit}>{saving ? t("inventoryRest.ui.saving") : editId ? t("inventoryRest.invtx.wizard.saveEdit") : t("inventoryRest.invtx.wizard.saveDraft")}</Button>
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
