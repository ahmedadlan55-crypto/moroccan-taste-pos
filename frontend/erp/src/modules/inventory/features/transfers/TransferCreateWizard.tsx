import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeftRight, Trash2, AlertTriangle, ChevronLeft, ChevronRight } from "lucide-react";
import { PageHeader } from "@/shared/ui";
import { Button } from "@/shared/ui";
import { Spinner } from "@/shared/ui";
import { PermissionDenied } from "@/shared/ui";
import { Stepper } from "./Stepper";
import { useWarehouses } from "@/modules/inventory/lib/hooks/useWarehouses";
import { useWarehouseScope } from "@/modules/inventory/lib/warehouse-scope-provider";
import { useCan } from "@/modules/inventory/lib/permission-provider";
import { useCreateDraft, useUpdateDraft } from "@/modules/inventory/lib/hooks/useTransferMutations";
import { useTransferDetail } from "@/modules/inventory/lib/hooks/useTransferDetail";
import { createTransferDraftInput, updateTransferDraftInput } from "@/modules/inventory/lib/schemas/transfer.schema";
import { formatQty } from "@/shared/lib";
import { useT } from "@/i18n";
import { DatePicker, SearchableEntityCombobox } from "@/shared/ui";
import { UnitQtyInput, baseFromValue, type ItemUnitLite, type UnitQtyValue } from "@/shared/ui";
import { makeItemFetcher, type ItemHit } from "@/modules/inventory/lib/hooks/useEntitySearch";

interface DraftLine { itemId: string; name: string; unit: string; units: ItemUnitLite[]; available: number; uv: UnitQtyValue; }
const unitsOf = (h: Pick<ItemHit, "baseUnit" | "majorUnits">): ItemUnitLite[] => [
  { code: h.baseUnit.code, name: h.baseUnit.name, factor: 1, isBase: true },
  ...(h.majorUnits ?? []).map((mu) => ({ code: mu.unitCode, name: mu.unitName, factor: mu.factor })),
];

export function TransferCreateWizard() {
  const t = useT();
  const STEPS = [t("inventoryRest.transfers.wizard.stepHeader"), t("inventoryRest.transfers.wizard.stepItems"), t("inventoryRest.transfers.wizard.stepReview")];
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
  const [submitError, setSubmitError] = useState<string | null>(null);

  const createDraft = useCreateDraft();
  const updateDraft = useUpdateDraft();

  // Edit mode — prefill from the existing draft once.
  const edit = useTransferDetail(editId);
  useEffect(() => {
    if (editId && edit.data && edit.data.status === "draft" && fromWh === "" && lines.length === 0) {
      setFromWh(edit.data.fromWarehouse.id);
      setToWh(edit.data.toWarehouse.id);
      setLines(edit.data.lines.map((l) => ({
        itemId: l.item.id, name: l.item.name, unit: l.item.unit,
        units: [{ code: l.item.unit, name: l.item.unit, factor: 1, isBase: true }],
        available: 0, uv: { unitCode: l.item.unit, qty: l.qtyRequested },
      })));
    }
  }, [editId, edit.data, fromWh, lines.length]);

  // Server-side item search scoped to the SOURCE warehouse (balances = available).
  const itemFetcher = useMemo(() => makeItemFetcher({ warehouseId: fromWh || undefined, context: "transfer", activeOnly: true }), [fromWh]);
  const pickedIds = useMemo(() => new Set(lines.map((l) => l.itemId)), [lines]);
  const lineBase = (l: DraftLine) => baseFromValue(l.units, l.uv, "single");

  if (!canCreate) return <PermissionDenied />;

  const sameWarehouse = !!fromWh && fromWh === toWh;
  const step1Valid = !!fromWh && !!toWh && !sameWarehouse;
  const step2Valid = lines.length > 0 && lines.every((l) => lineBase(l) > 0);

  function addItem(hit: ItemHit) {
    if (pickedIds.has(hit.id)) return;
    setLines((ls) => [...ls, { itemId: hit.id, name: hit.name, unit: hit.baseUnit.name, units: unitsOf(hit), available: hit.warehouseQty ?? 0, uv: { unitCode: hit.baseUnit.code, qty: 1 } }]);
  }
  function setLineUv(itemId: string, uv: UnitQtyValue) {
    setLines((ls) => ls.map((l) => (l.itemId === itemId ? { ...l, uv } : l)));
  }
  function removeLine(itemId: string) {
    setLines((ls) => ls.filter((l) => l.itemId !== itemId));
  }

  function submit() {
    setSubmitError(null);
    const base = {
      fromWarehouseId: fromWh,
      toWarehouseId: toWh,
      issueDate,
      notes: notes || undefined,
      items: lines.map((l) => ({ itemId: l.itemId, qtyRequested: lineBase(l), enteredUnitCode: l.uv.unitCode, enteredQty: Number(l.uv.qty) })),
    };
    if (editId) {
      // Real in-place edit — PATCH the SAME document (preserves number + URL).
      const parsed = updateTransferDraftInput.safeParse({ ...base, expectedVersion: edit.data?.version ?? 0 });
      if (!parsed.success) {
        setSubmitError(parsed.error.issues[0]?.message ?? t("inventoryRest.transfers.wizard.validate"));
        return;
      }
      updateDraft.mutate(
        { id: editId, input: parsed.data },
        {
          onSuccess: () => navigate(`/inventory/transfers?view=${editId}`),
          onError: (e) => setSubmitError(e instanceof Error ? e.message : t("inventoryRest.transfers.wizard.saveEditFailed")),
        },
      );
      return;
    }
    const parsed = createTransferDraftInput.safeParse(base);
    if (!parsed.success) {
      setSubmitError(parsed.error.issues[0]?.message ?? t("inventoryRest.transfers.wizard.validate"));
      return;
    }
    createDraft.mutate(parsed.data, {
      onSuccess: (res) => {
        const newId = (res.data?.id as string) ?? null;
        navigate(newId ? `/inventory/transfers?view=${newId}` : "/inventory/transfers");
      },
      onError: (e) => setSubmitError(e instanceof Error ? e.message : t("inventoryRest.transfers.wizard.saveDraftFailed")),
    });
  }

  return (
    <div>
      <PageHeader
        eyebrow={t("inventoryRest.transfers.eyebrow")}
        title={editId ? t("inventoryRest.transfers.wizard.editTitle") : t("inventoryRest.transfers.wizard.newTitle")}
        subtitle={t("inventoryRest.transfers.wizard.subtitle")}
        action={<Button variant="ghost" onClick={() => navigate("/inventory/transfers")}>{t("inventoryRest.transfers.wizard.backToList")}</Button>}
      />

      <div className="surface mb-4 p-4"><Stepper steps={STEPS} current={step} /></div>

      {/* Step 1 — header */}
      {step === 1 && (
        <div className="surface space-y-4 p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-bold text-slate-600">{t("inventoryRest.transfers.wizard.fromWarehouse")} <span className="text-rose-600">*</span></span>
              <select className="field mt-1 w-full" value={fromWh} onChange={(e) => setFromWh(e.target.value)}>
                <option value="">{t("inventoryRest.transfers.wizard.pickFrom")}</option>
                {whOptions.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-bold text-slate-600">{t("inventoryRest.transfers.wizard.toWarehouse")} <span className="text-rose-600">*</span></span>
              <select className="field mt-1 w-full" value={toWh} onChange={(e) => setToWh(e.target.value)}>
                <option value="">{t("inventoryRest.transfers.wizard.pickTo")}</option>
                {whOptions.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-bold text-slate-600">{t("inventoryRest.transfers.wizard.transferDate")}</span>
              <DatePicker className="mt-1 block" value={issueDate} onChange={setIssueDate} />
            </label>
            <label className="block">
              <span className="text-xs font-bold text-slate-600">{t("inventoryRest.transfers.wizard.notes")}</span>
              <input className="field mt-1 w-full" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t("inventoryRest.transfers.wizard.notesPlaceholder")} />
            </label>
          </div>
          {sameWarehouse && (
            <p className="flex items-center gap-2 text-xs font-bold text-rose-600"><AlertTriangle className="h-4 w-4" /> {t("inventoryRest.transfers.wizard.sameWarehouse")}</p>
          )}
          <div className="flex justify-end">
            <Button variant="primary" disabled={!step1Valid} onClick={() => setStep(2)}>{t("inventoryRest.ui.next")} <ChevronLeft className="h-4 w-4" /></Button>
          </div>
        </div>
      )}

      {/* Step 2 — items */}
      {step === 2 && (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Picker — central searchable combobox (server search, scoped to source) */}
          <div className="surface p-4">
            <div className="mb-3 text-sm font-extrabold text-slate-800">{t("inventoryRest.transfers.wizard.sourceItems")}</div>
            <SearchableEntityCombobox<ItemHit>
              value={null}
              onChange={(hit) => { if (hit && !pickedIds.has(hit.id)) addItem(hit); }}
              fetcher={itemFetcher}
              queryKey={["item-search", fromWh, "transfer"]}
              getKey={(it) => it.id}
              getLabel={(it) => it.name}
              getSublabel={(it) => [it.sku, it.warehouseQty != null ? t("inventoryRest.transfers.wizard.availableWithLabel", { qty: formatQty(it.warehouseQty), unit: it.baseUnit.name }) : null].filter(Boolean).join(" · ") || undefined}
              placeholder={t("inventoryRest.transfers.wizard.searchPlaceholder")}
              ariaLabel={t("inventoryRest.transfers.wizard.addItemAria")}
              autoSelectExact
              emptyText={t("inventoryRest.transfers.wizard.noSourceItems")}
            />
            <p className="mt-2 text-[11px] text-slate-400">{t("inventoryRest.transfers.wizard.pickerHint")}</p>
          </div>

          {/* Selected lines */}
          <div className="surface flex flex-col p-4">
            <div className="mb-3 text-sm font-extrabold text-slate-800">{t("inventoryRest.transfers.wizard.selectedItems", { count: lines.length })}</div>
            {lines.length === 0 ? (
              <div className="grid flex-1 place-items-center py-10 text-center text-xs text-slate-400">{t("inventoryRest.transfers.wizard.selectAtLeastOne")}</div>
            ) : (
              <div className="space-y-2">
                {lines.map((l) => {
                  const base = lineBase(l);
                  const over = l.available > 0 && base > l.available;
                  return (
                    <div key={l.itemId} className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
                      <div className="min-w-0">
                        <div className="truncate text-xs font-bold text-slate-800">{l.name}</div>
                        <div className={`text-[11px] ${over ? "font-bold text-rose-500" : "text-slate-400"}`} dir="ltr">{t("inventoryRest.transfers.wizard.available", { qty: formatQty(l.available), unit: l.unit })}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <UnitQtyInput units={l.units} value={l.uv} onChange={(uv) => setLineUv(l.itemId, uv)} mode="single" />
                        <Button variant="ghost" size="icon" aria-label={t("inventoryRest.transfers.wizard.removeAria")} onClick={() => removeLine(l.itemId)}><Trash2 className="h-4 w-4 text-rose-500" /></Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="mt-4 flex justify-between">
              <Button variant="secondary" onClick={() => setStep(1)}><ChevronRight className="h-4 w-4" /> {t("inventoryRest.ui.prev")}</Button>
              <Button variant="primary" disabled={!step2Valid} onClick={() => setStep(3)}>{t("inventoryRest.transfers.wizard.stepReview")} <ChevronLeft className="h-4 w-4" /></Button>
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
          {notes && <p className="text-xs text-slate-500">{t("inventoryRest.transfers.wizard.reviewNotes", { notes })}</p>}
          <div className="overflow-hidden rounded-xl border border-slate-100">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-400"><tr><th className="px-3 py-2 text-right">{t("inventoryRest.transfers.wizard.colItem")}</th><th className="px-3 py-2 text-center">{t("inventoryRest.transfers.wizard.colRequested")}</th><th className="px-3 py-2 text-center">{t("inventoryRest.transfers.wizard.colAvailable")}</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {lines.map((l) => {
                  const base = lineBase(l);
                  const over = l.available > 0 && base > l.available;
                  return (
                    <tr key={l.itemId}>
                      <td className="px-3 py-2 font-bold text-slate-800">{l.name}</td>
                      <td className="px-3 py-2 text-center tabular-nums" dir="ltr">{formatQty(base)} {l.unit}</td>
                      <td className={`px-3 py-2 text-center tabular-nums ${over ? "font-bold text-amber-600" : "text-slate-500"}`}>{formatQty(l.available)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {lines.some((l) => l.available > 0 && lineBase(l) > l.available) && (
            <p className="flex items-center gap-2 text-xs font-bold text-amber-600">
              <AlertTriangle className="h-4 w-4" /> {t("inventoryRest.transfers.wizard.overWarning")}
            </p>
          )}
          {submitError && <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{submitError}</div>}
          <div className="flex justify-between">
            <Button variant="secondary" onClick={() => setStep(2)}><ChevronRight className="h-4 w-4" /> {t("inventoryRest.ui.prev")}</Button>
            <Button variant="primary" disabled={createDraft.isPending || updateDraft.isPending || !step1Valid || !step2Valid} onClick={submit}>
              {createDraft.isPending || updateDraft.isPending ? <><Spinner className="h-4 w-4" /> {t("inventoryRest.ui.saving")}</> : editId ? t("inventoryRest.transfers.wizard.saveEdit") : t("inventoryRest.transfers.wizard.saveDraft")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
