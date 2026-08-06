import { Fragment, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowRight, Check, PackageCheck, TriangleAlert, X } from "lucide-react";
import { DatePicker, PageHeader } from "@/shared/ui";
import { Button } from "@/shared/ui";
import { Stepper } from "@/modules/inventory/features/transfers/Stepper";
import { LoadingState, ErrorState } from "@/shared/ui";
import { useT } from "@/i18n";
import { useWarehouseScope } from "@/modules/inventory/lib/warehouse-scope-provider";
import { useWarehouses } from "@/modules/inventory/lib/hooks/useWarehouses";
import { useReceivePlan } from "@/modules/inventory/lib/hooks/usePurchaseReceiving";
import { useInvTxMutations } from "@/modules/inventory/lib/hooks/useInventoryTx";
import { formatCurrency, formatQty, formatDate } from "@/shared/lib";
import { ApiError } from "@/shared/api";
import { SearchableEntityCombobox } from "@/shared/ui";
import { makeAccountFetcher, type AccountHit } from "@/modules/inventory/lib/hooks/useEntitySearch";

interface LineState { qty: string; unitCost: string; lotNumber: string; expiryDate: string }

// Receive a legacy purchase (fully or partially) through the V2 receipts flow:
// requested / previously received / remaining per line, current receipt qty
// capped at outstanding (over-receipt is rejected server-side too), lot/expiry
// entry for tracked items, then a draft inv_receipt linked by purchaseId.
export function PurchaseReceiveWizard() {
  const t = useT();
  const { purchaseId = "" } = useParams();
  const navigate = useNavigate();
  const plan = useReceivePlan(purchaseId);
  const m = useInvTxMutations("receipt");
  const { accessibleWarehouses, allWarehousesAccess } = useWarehouseScope();
  const allWh = useWarehouses();
  const accountFetcher = useMemo(() => makeAccountFetcher({ context: "receipt", postingOnly: true }), []);

  const STEPS = [
    t("inventoryRest.purchaseReceiving.wizard.stepPlan"),
    t("inventoryRest.purchaseReceiving.wizard.stepQuantities"),
    t("inventoryRest.purchaseReceiving.wizard.stepReview"),
  ];

  const [step, setStep] = useState(1);
  const [warehouseId, setWarehouseId] = useState("");
  const [counterAccount, setCounterAccount] = useState("");
  const [accountSel, setAccountSel] = useState<AccountHit | null>(null);
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Record<string, LineState>>({});
  const [prefilled, setPrefilled] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!plan.data || prefilled) return;
    setWarehouseId(plan.data.warehouseId ?? "");
    const init: Record<string, LineState> = {};
    for (const l of plan.data.lines) {
      init[l.itemId] = {
        qty: l.outstanding > 0 ? String(l.outstanding) : "0",
        unitCost: l.unitPrice > 0 ? String(l.unitPrice) : "",
        lotNumber: "",
        expiryDate: "",
      };
    }
    setLines(init);
    // Default the credit account to AP (2100) when it exists in the options.
    setPrefilled(true);
  }, [plan.data, prefilled]);

  // Default the credit account to AP (2100) once, without loading the full list.
  useEffect(() => {
    // The account name is chart-of-accounts DATA (name_ar), not UI copy.
    if (!counterAccount) { setCounterAccount("2100"); setAccountSel({ id: "2100", code: "2100", name: "الذمم الدائنة (الموردون)", type: "liability", active: true }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const whOptions = useMemo(() => {
    if (!allWarehousesAccess) return accessibleWarehouses.map((w) => ({ id: w.id, name: w.name }));
    return (allWh.data?.warehouses ?? []).map((w) => ({ id: w.id, name: w.name }));
  }, [allWarehousesAccess, accessibleWarehouses, allWh.data]);

  const activeLines = useMemo(() => {
    if (!plan.data) return [];
    return plan.data.lines
      .map((l) => ({ plan: l, state: lines[l.itemId] ?? { qty: "0", unitCost: "", lotNumber: "", expiryDate: "" } }))
      .filter((x) => (Number(x.state.qty) || 0) > 0);
  }, [plan.data, lines]);

  const total = useMemo(
    () => activeLines.reduce((s, x) => s + (Number(x.state.qty) || 0) * (Number(x.state.unitCost) || 0), 0),
    [activeLines],
  );

  const problems = useMemo(() => {
    const out: string[] = [];
    for (const { plan: p, state: s } of activeLines) {
      const qty = Number(s.qty) || 0;
      if (qty > p.outstanding + 1e-6) out.push(t("inventoryRest.purchaseReceiving.wizard.problemOverQty", { name: p.name, qty, outstanding: p.outstanding }));
      if (!(Number(s.unitCost) > 0)) out.push(t("inventoryRest.purchaseReceiving.wizard.problemUnitCost", { name: p.name }));
      if (p.trackingMode !== "none" && !s.lotNumber.trim()) out.push(t("inventoryRest.purchaseReceiving.wizard.problemLot", { name: p.name }));
      if (p.trackingMode === "expiry" && !s.expiryDate) out.push(t("inventoryRest.purchaseReceiving.wizard.problemExpiry", { name: p.name }));
    }
    return out;
  }, [activeLines, t]);

  function patchLine(itemId: string, patch: Partial<LineState>) {
    setLines((s) => ({ ...s, [itemId]: { ...(s[itemId] ?? { qty: "0", unitCost: "", lotNumber: "", expiryDate: "" }), ...patch } }));
  }

  function submit() {
    setErr(null);
    const items = activeLines.map(({ plan: p, state: s }) => ({
      itemId: p.itemId,
      qty: Number(s.qty),
      unitCost: Number(s.unitCost),
      ...(p.trackingMode !== "none"
        ? { lots: [{ lotNumber: s.lotNumber.trim(), qty: Number(s.qty), expiryDate: s.expiryDate || undefined }] }
        : {}),
    }));
    m.create.mutate(
      {
        warehouseId,
        purchaseId,
        reason: t("inventoryRest.purchaseReceiving.wizard.receiptReason", { id: purchaseId }),
        counterAccountCode: counterAccount,
        sourceRef: `PO:${purchaseId}`,
        notes: notes || undefined,
        items,
      },
      {
        onSuccess: (r) => navigate(`/receipts?view=${(r.data?.id as string) ?? ""}`),
        onError: (e) => setErr(e instanceof ApiError ? e.message : t("inventoryRest.purchaseReceiving.wizard.createFailed")),
      },
    );
  }

  if (plan.isLoading) return <div className="p-4"><LoadingState rows={2} /></div>;
  if (plan.isError || !plan.data) return <ErrorState error={plan.error} onRetry={() => plan.refetch()} />;

  const d = plan.data;
  const canNext1 = !!warehouseId && !!counterAccount;
  const canNext2 = activeLines.length > 0 && problems.length === 0;

  return (
    <div>
      <PageHeader
        eyebrow={t("inventoryRest.purchaseReceiving.wizard.eyebrow")}
        title={t("inventoryRest.purchaseReceiving.wizard.title", { id: d.purchaseId })}
        subtitle={t("inventoryRest.purchaseReceiving.wizard.subtitle", { supplier: d.supplierName ?? "—", date: formatDate(d.purchaseDate) })}
        action={<Button variant="ghost" onClick={() => navigate("/purchase-receiving")}><X className="h-4 w-4" /> {t("common.close")}</Button>}
      />
      <div className="surface p-5">
        <Stepper steps={STEPS} current={step} />
        {err && <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">{err}</p>}

        {step === 1 && (
          <div className="mt-5 space-y-4">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs font-bold text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-right">{t("inventoryRest.purchaseReceiving.wizard.colItem")}</th>
                    <th className="px-3 py-2 text-right">{t("inventoryRest.purchaseReceiving.wizard.colOrdered")}</th>
                    <th className="px-3 py-2 text-right">{t("inventoryRest.purchaseReceiving.wizard.colReceivedBefore")}</th>
                    <th className="px-3 py-2 text-right">{t("inventoryRest.purchaseReceiving.wizard.colOutstanding")}</th>
                    <th className="px-3 py-2 text-left">{t("inventoryRest.purchaseReceiving.wizard.colUnitPrice")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {d.lines.map((l) => (
                    <tr key={l.itemId} className={l.outstanding <= 0 ? "opacity-50" : ""}>
                      <td className="px-3 py-2 font-bold text-slate-800">
                        {l.name}
                        {l.trackingMode !== "none" && <span className="mr-2 rounded-md bg-sky-50 px-1.5 py-0.5 text-[10px] font-bold text-sky-700">{t("inventoryRest.purchaseReceiving.wizard.tracked")}</span>}
                        {!l.active && <span className="mr-2 rounded-md bg-rose-50 px-1.5 py-0.5 text-[10px] font-bold text-rose-700">{t("common.inactive")}</span>}
                      </td>
                      <td className="px-3 py-2 tabular-nums">{formatQty(l.ordered, l.unit)}</td>
                      <td className="px-3 py-2 tabular-nums text-slate-500">{formatQty(l.receivedV2)}</td>
                      <td className={`px-3 py-2 font-bold tabular-nums ${l.outstanding > 0 ? "text-amber-600" : "text-emerald-600"}`}>{formatQty(l.outstanding)}</td>
                      <td className="px-3 py-2 text-left tabular-nums text-slate-600">{formatCurrency(l.unitPrice)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-xs font-bold text-slate-500">{t("inventoryRest.purchaseReceiving.wizard.receiveWarehouse")}
                <select className="field mt-1 w-full" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} aria-label={t("inventoryRest.purchaseReceiving.wizard.warehouseAria")}>
                  <option value="">{t("inventoryRest.purchaseReceiving.wizard.pickWarehouse")}</option>
                  {whOptions.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </label>
              <div className="block text-xs font-bold text-slate-500">{t("inventoryRest.purchaseReceiving.wizard.counterAccount")}
                <div className="mt-1">
                  <SearchableEntityCombobox<AccountHit>
                    value={accountSel}
                    onChange={(a) => { setAccountSel(a); setCounterAccount(a?.code ?? ""); }}
                    fetcher={accountFetcher}
                    queryKey={["account-search", "receipt"]}
                    getKey={(a) => a.id}
                    getLabel={(a) => a.name}
                    getSublabel={(a) => a.code}
                    placeholder={t("inventoryRest.purchaseReceiving.wizard.accountSearch")}
                    ariaLabel={t("inventoryRest.purchaseReceiving.wizard.accountAria")}
                    emptyText={t("inventoryRest.purchaseReceiving.wizard.accountEmpty")}
                  />
                </div>
              </div>
              <label className="block text-xs font-bold text-slate-500 sm:col-span-2">{t("inventoryRest.purchaseReceiving.wizard.notes")}
                <textarea className="field mt-1 w-full" value={notes} onChange={(e) => setNotes(e.target.value)} aria-label={t("inventoryRest.purchaseReceiving.wizard.notes")} />
              </label>
            </div>
            <div className="flex justify-end">
              <Button variant="primary" disabled={!canNext1} onClick={() => setStep(2)}>{t("common.next")} <ArrowRight className="h-4 w-4" /></Button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="mt-5 space-y-4">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs font-bold text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-right">{t("inventoryRest.purchaseReceiving.wizard.colItem")}</th>
                    <th className="px-3 py-2 text-right">{t("inventoryRest.purchaseReceiving.wizard.colOutstanding")}</th>
                    <th className="px-3 py-2 text-right">{t("inventoryRest.purchaseReceiving.wizard.colReceiveQty")}</th>
                    <th className="px-3 py-2 text-right">{t("inventoryRest.purchaseReceiving.wizard.colUnitCost")}</th>
                    <th className="px-3 py-2 text-left">{t("inventoryRest.purchaseReceiving.wizard.colTotal")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {d.lines.filter((l) => l.outstanding > 0).map((l) => {
                    const s = lines[l.itemId] ?? { qty: "0", unitCost: "", lotNumber: "", expiryDate: "" };
                    const qty = Number(s.qty) || 0;
                    const over = qty > l.outstanding + 1e-6;
                    return (
                      <Fragment key={l.itemId}>
                        <tr className={over ? "bg-rose-50/60" : ""}>
                          <td className="px-3 py-2 font-bold text-slate-800">{l.name}{l.trackingMode !== "none" && <span className="mr-2 rounded-md bg-sky-50 px-1.5 py-0.5 text-[10px] font-bold text-sky-700">{t("inventoryRest.purchaseReceiving.wizard.tracked")}</span>}</td>
                          <td className="px-3 py-2 tabular-nums text-slate-500">{formatQty(l.outstanding, l.unit)}</td>
                          <td className="px-3 py-2">
                            <input type="number" min={0} step="any" dir="ltr" className={`field w-28 tabular-nums ${over ? "border-rose-400" : ""}`} value={s.qty} onChange={(e) => patchLine(l.itemId, { qty: e.target.value })} aria-label={t("inventoryRest.purchaseReceiving.wizard.qtyAria", { name: l.name })} />
                          </td>
                          <td className="px-3 py-2">
                            <input type="number" min={0} step="any" dir="ltr" className="field w-28 tabular-nums" value={s.unitCost} onChange={(e) => patchLine(l.itemId, { unitCost: e.target.value })} aria-label={t("inventoryRest.purchaseReceiving.wizard.costAria", { name: l.name })} />
                          </td>
                          <td className="px-3 py-2 text-left tabular-nums text-slate-600">{formatCurrency(qty * (Number(s.unitCost) || 0))}</td>
                        </tr>
                        {l.trackingMode !== "none" && qty > 0 && (
                          <tr className="bg-slate-50/50">
                            <td colSpan={5} className="px-3 pb-2">
                              <div className="flex flex-wrap items-center gap-2 text-xs">
                                <span className="font-bold text-slate-400">{t("inventoryRest.purchaseReceiving.wizard.lotLabel")}</span>
                                <input className="field h-9 w-44" placeholder={t("inventoryRest.purchaseReceiving.wizard.lotPlaceholder")} value={s.lotNumber} onChange={(e) => patchLine(l.itemId, { lotNumber: e.target.value })} aria-label={t("inventoryRest.purchaseReceiving.wizard.lotAria", { name: l.name })} />
                                <DatePicker className="h-9 w-44 py-1" value={s.expiryDate} onChange={(v) => patchLine(l.itemId, { expiryDate: v })} aria-label={t("inventoryRest.purchaseReceiving.wizard.expiryAria", { name: l.name })} />
                                {l.trackingMode === "expiry" && <span className="font-bold text-amber-600">{t("inventoryRest.purchaseReceiving.wizard.expiryRequired")}</span>}
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
            {problems.length > 0 && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-bold text-amber-800">
                <TriangleAlert className="ml-1 inline h-4 w-4" />
                <ul className="mt-1 list-inside list-disc space-y-0.5">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
              </div>
            )}
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setStep(1)}>{t("inventoryRest.ui.prev")}</Button>
              <Button variant="primary" disabled={!canNext2} onClick={() => setStep(3)}>{t("inventoryRest.purchaseReceiving.wizard.stepReview")} <ArrowRight className="h-4 w-4" /></Button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="mt-5 space-y-4">
            <div className="grid gap-2 text-sm sm:grid-cols-4">
              <Stat label={t("inventoryRest.purchaseReceiving.wizard.statPo")} value={d.purchaseId} />
              <Stat label={t("inventoryRest.purchaseReceiving.wizard.statWarehouse")} value={whOptions.find((w) => w.id === warehouseId)?.name ?? warehouseId} />
              <Stat label={t("inventoryRest.purchaseReceiving.wizard.statLines")} value={String(activeLines.length)} />
              <Stat label={t("inventoryRest.purchaseReceiving.wizard.statValue")} value={formatCurrency(total)} />
            </div>
            <p className="rounded-lg bg-blue-50 px-3 py-2 text-xs font-bold text-blue-700">
              <PackageCheck className="ml-1 inline h-4 w-4" />
              {t("inventoryRest.purchaseReceiving.wizard.info")}
            </p>
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setStep(2)}>{t("inventoryRest.ui.prev")}</Button>
              <Button variant="primary" disabled={m.create.isPending} onClick={submit}>
                {m.create.isPending ? t("inventoryRest.purchaseReceiving.wizard.creating") : t("inventoryRest.purchaseReceiving.wizard.create")} <Check className="h-4 w-4" />
              </Button>
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
