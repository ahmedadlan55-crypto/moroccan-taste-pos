// D1 — Inventory Item full-page create / edit. Replaces the old ItemWizard with
// a routed page (/inventory/items/new and /inventory/items/:id/edit). Sections:
//   (a) basic data  (b) units & conversion  (c) cost & accounting
//   (d) branches & warehouses assignment  (e) save.
// Full-page (NOT a dialog/drawer). WAC / GL are display-only — this form never
// edits balances. Units in CREATE are captured inline (base + one major); in
// EDIT the full item_units editor (UnitsTab, history-locked) + barcodes are
// embedded. Cost blocks are gated by `item.cost.view`.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Save, Plus, AlertTriangle, Boxes, Ruler, Coins, Building2, FileText } from "lucide-react";
import { Button, Select, PanelTitle, LoadingState, ErrorState, StatusBadge, Badge } from "@/shared/ui";
import { ApiError, apiClient } from "@/shared/api";
import { useCan } from "@/modules/inventory/lib/permission-provider";
import { formatCurrency, formatNumber } from "@/shared/lib";
import { useT } from "@/i18n";
import { useItemDetail, useItemMutations, useItemCategories } from "@/modules/inventory/lib/hooks/useItems";
import { useItemAssignments, useSaveItemAssignments } from "@/modules/inventory/lib/hooks/useItemAssignments";
import { useWarehouseAdminList } from "@/modules/inventory/lib/hooks/useWarehouseAdmin";
import { useVatRate } from "@/modules/inventory/lib/hooks/useVatRate";
import { useUnsavedGuard } from "@/shared/forms";
import { UnitsTab } from "./UnitsTab";
import { BarcodesTab } from "./BarcodesTab";
import { AssignmentsSection } from "./AssignmentsSection";
import {
  type AssignmentDraft,
  type WarehouseUniverseRow,
  validateAssignments,
  draftsToInput,
} from "./assignment-utils";

interface FormFields {
  code: string; nameAr: string; nameEn: string; descAr: string; notes: string;
  category: string; kind: "raw" | "semi";
  baseUnit: string; majorUnit: string; convRate: string; cost: string;
}
const EMPTY: FormFields = {
  code: "", nameAr: "", nameEn: "", descAr: "", notes: "",
  category: "", kind: "raw", baseUnit: "", majorUnit: "", convRate: "", cost: "",
};

export function ItemFormPage({ mode, itemId }: { mode: "create" | "edit"; itemId?: string }) {
  const t = useT();
  const navigate = useNavigate();
  const canCost = useCan("item.cost.view");
  const m = useItemMutations();
  const saveAssignments = useSaveItemAssignments(itemId ?? "");

  const detailQ = useItemDetail(mode === "edit" ? (itemId ?? null) : null);
  const assignQ = useItemAssignments(mode === "edit" ? (itemId ?? null) : null);
  const cats = useItemCategories();
  const whList = useWarehouseAdminList();
  const vat = useVatRate();

  const [f, setF] = useState<FormFields>(EMPTY);
  const [drafts, setDrafts] = useState<AssignmentDraft[]>([]);
  const [defaultWh, setDefaultWh] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [assignWarn, setAssignWarn] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [assignDirty, setAssignDirty] = useState(false);
  const prefilled = useRef(false);
  const assignSeeded = useRef(false);

  const detail = detailQ.data;
  const hasMovements = !!detail?.hasMovements;
  useUnsavedGuard(dirty);

  // universe of warehouses (grouped by branch) for the assignment editor
  const universe = useMemo<WarehouseUniverseRow[]>(
    () => (whList.data?.warehouses ?? []).map((w) => ({
      id: w.id, name: w.name, code: w.code, branchId: w.branchId, branchName: w.branchName, isActive: w.isActive, isMain: w.isMain,
    })),
    [whList.data],
  );
  const branches = useMemo(() => {
    const map = new Map<string, string>();
    for (const w of universe) if (w.branchId) map.set(w.branchId, w.branchName || w.branchId);
    return [...map.entries()].map(([id, name]) => ({ id, name }));
  }, [universe]);

  // ── prefill (edit) ──
  useEffect(() => {
    if (mode !== "edit" || !detail || prefilled.current) return;
    prefilled.current = true;
    setF({
      code: detail.sku, nameAr: detail.name, nameEn: detail.nameEn, descAr: detail.description, notes: detail.notes,
      category: detail.category, kind: detail.kind === "semi" ? "semi" : "raw",
      baseUnit: detail.unit, majorUnit: detail.bigUnit, convRate: detail.convRate > 1 ? String(detail.convRate) : "",
      cost: detail.cost ? String(detail.cost) : "",
    });
    setDefaultWh(detail.defaultWarehouseId || "");
  }, [mode, detail]);

  // ── seed assignment drafts (edit): prefer D3 assignments, fall back to the
  //    item's current distribution + rules so the editor is populated today ──
  useEffect(() => {
    if (mode !== "edit" || assignSeeded.current) return;
    const byWh = new Map(universe.map((w) => [w.id, w]));
    if (assignQ.data && assignQ.data.assignments.length) {
      assignSeeded.current = true;
      setDrafts(assignQ.data.assignments.map((a) => ({
        key: "asg-" + a.warehouseId, branchId: a.branchId || byWh.get(a.warehouseId)?.branchId || "",
        warehouseId: a.warehouseId, isActive: a.isActive,
        minQty: a.minQty ? String(a.minQty) : "", maxStock: a.maxStock ? String(a.maxStock) : "",
        reorderPoint: a.reorderPoint ? String(a.reorderPoint) : "", reorderQty: a.reorderQty ? String(a.reorderQty) : "",
        safetyStock: a.safetyStock ? String(a.safetyStock) : "", leadTimeDays: a.leadTimeDays ? String(a.leadTimeDays) : "",
      })));
      if (assignQ.data.defaultWarehouseId) setDefaultWh(assignQ.data.defaultWarehouseId);
    } else if (detail && (detail.distribution.length || detail.rules.length) && universe.length) {
      assignSeeded.current = true;
      const ruleByWh = new Map(detail.rules.map((r) => [r.warehouseId, r]));
      setDrafts(detail.distribution.map((w) => {
        const r = ruleByWh.get(w.warehouseId);
        return {
          key: "asg-" + w.warehouseId, branchId: byWh.get(w.warehouseId)?.branchId || "",
          warehouseId: w.warehouseId, isActive: true,
          minQty: r?.minQty ? String(r.minQty) : "", maxStock: r?.maxStock ? String(r.maxStock) : "",
          reorderPoint: r?.reorderPoint ? String(r.reorderPoint) : "", reorderQty: r?.reorderQty ? String(r.reorderQty) : "",
          safetyStock: r?.safetyStock ? String(r.safetyStock) : "", leadTimeDays: r?.leadTimeDays ? String(r.leadTimeDays) : "",
        };
      }));
    }
  }, [mode, assignQ.data, detail, universe]);

  const set = <K extends keyof FormFields>(k: K, v: FormFields[K]) => { setF((s) => ({ ...s, [k]: v })); setDirty(true); setSummary(null); };
  const onDraftsChange = (d: AssignmentDraft[]) => { setDrafts(d); setDirty(true); setAssignDirty(true); setSummary(null); };
  const onDefaultChange = (id: string) => { setDefaultWh(id); setDirty(true); setAssignDirty(true); };

  // ── derived cost ──
  const factor = Number(f.convRate) || 0;
  const hasMajor = !!f.majorUnit.trim() && factor > 0;
  const baseCostNum = Number(f.cost) || 0;
  const computedMajorCost = hasMajor ? baseCostNum * factor : null;

  // ── validation ──
  function validate(): Record<string, string> {
    const e: Record<string, string> = {};
    // SKU is REQUIRED ON CREATE and OPTIONAL ON EDIT — matching what the rest
    // of the stack already does, which this check used to contradict:
    //   • the column is nullable by design (server.js adds `sku` with a UNIQUE
    //     on the NORMALISED column precisely so, in its own words, legacy rows
    //     can have no SKU — MySQL permits many NULLs in a unique index);
    //   • routes/inventory-items.js requires it on POST (_validateBasics with
    //     requireSku: true) but on PATCH only validates `sku` when it is
    //     actually SENT and changed — omitting it is legal;
    //   • the product treats no-SKU as a first-class state: the items list has
    //     a "بلا SKU / أصناف قديمة" KPI card, computed server-side.
    // This function was mode-agnostic, and handleSave returns before any
    // network call when it produces errors — so every legacy item without a
    // SKU (17 of the 19 rows in this database) was UNEDITABLE through the UI:
    // open it, change anything, press save, and it silently refused.
    if (mode === "create" && !f.code.trim()) e.code = t("items.form.validation.codeRequired");
    if (!f.nameAr.trim()) e.nameAr = t("items.form.validation.nameArRequired");
    if (mode === "create" && !f.nameEn.trim()) e.nameEn = t("items.form.validation.nameEnRequiredNew");
    if (!f.baseUnit.trim()) e.baseUnit = t("items.form.validation.unitRequired");
    if (mode === "create" && f.majorUnit.trim() && !(factor > 0)) e.convRate = t("items.form.validation.factorPositive");
    return e;
  }

  const assignValidation = useMemo(() => validateAssignments(drafts, universe), [drafts, universe]);
  const assignHasWarehouses = drafts.some((d) => d.warehouseId);

  function buildAssignmentsPayload(version: number | undefined) {
    return { defaultWarehouseId: defaultWh || null, assignments: draftsToInput(drafts), expectedVersion: version };
  }

  function handleError(e: unknown) {
    if (e instanceof ApiError) {
      const msg = e.message || "";
      if (e.isConflict) { setBanner(t("states.conflict")); return; }
      if (/SKU|الـ SKU/i.test(msg)) { setErrors((p) => ({ ...p, code: t("items.form.validation.codeTaken") })); setBanner(msg); return; }
      setBanner(msg); return;
    }
    setBanner(t("states.unexpectedError"));
  }

  const saving = m.create.isPending || m.update.isPending || saveAssignments.isPending;

  async function handleSave(addAnother: boolean) {
    setAssignWarn(false);
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) { setBanner(t("items.form.validation.fixBeforeSave")); return; }
    if (!assignValidation.ok) { setBanner(t("items.form.validation.fixBeforeSave")); return; }
    setBanner(null);

    try {
      if (mode === "create") {
        const payload: Record<string, unknown> = {
          name: f.nameAr.trim(), sku: f.code.trim(), unit: f.baseUnit.trim(),
          nameEn: f.nameEn.trim() || undefined, category: f.category.trim() || undefined,
          kind: f.kind, cost: f.cost === "" ? undefined : baseCostNum,
          bigUnit: f.majorUnit.trim() || undefined, convRate: hasMajor ? factor : undefined,
          description: f.descAr.trim() || undefined, notes: f.notes.trim() || undefined,
          defaultWarehouseId: defaultWh || undefined,
        };
        const res = await m.create.mutateAsync(payload);
        const newId = res.id;
        if (newId && assignHasWarehouses) {
          await apiClient.put(`/inventory/v2/items/${newId}/assignments`, buildAssignmentsPayload(undefined)).catch(() => setAssignWarn(true));
        }
        setDirty(false);
        if (addAnother) {
          setF(EMPTY); setDrafts([]); setDefaultWh(""); setErrors({});
          assignSeeded.current = false;
          setSummary(t("items.form.createdSummary", { name: payload.name as string }));
          window.scrollTo(0, 0);
        } else {
          navigate(`/inventory/items/${newId}`);
        }
      } else {
        const skuChanged = f.code.trim() !== detail!.sku;
        const unitChanged = f.baseUnit.trim() !== detail!.unit;
        const payload: Record<string, unknown> = {
          name: f.nameAr.trim(), nameEn: f.nameEn.trim(), category: f.category.trim(),
          cost: f.cost === "" ? undefined : baseCostNum,
          description: f.descAr, notes: f.notes, defaultWarehouseId: defaultWh || "",
          expectedVersion: detail!.version,
          ...(skuChanged && !hasMovements ? { sku: f.code.trim() } : {}),
          ...(unitChanged && !hasMovements ? { unit: f.baseUnit.trim() } : {}),
        };
        await m.update.mutateAsync({ id: itemId!, input: payload });
        if (assignDirty && assignHasWarehouses) {
          await saveAssignments
            .mutateAsync(buildAssignmentsPayload(assignQ.data?.version))
            .catch(() => setAssignWarn(true));
        }
        setDirty(false);
        navigate(`/inventory/items/${itemId}`);
      }
    } catch (err) {
      handleError(err);
    }
  }

  function cancel() {
    if (dirty && !window.confirm(t("items.form.unsavedBody"))) return;
    navigate(mode === "edit" && itemId ? `/inventory/items/${itemId}` : "/inventory/items");
  }

  if (mode === "edit" && detailQ.isLoading) return <div className="p-4"><LoadingState rows={3} /></div>;
  if (mode === "edit" && detailQ.isError) return <div className="p-4"><ErrorState error={detailQ.error} onRetry={() => detailQ.refetch()} /></div>;

  const title = mode === "create" ? t("items.form.newTitle") : `${t("items.form.editTitle")} — ${detail?.name ?? ""}`;

  return (
    <div className="grid gap-6 pb-24">
      <button type="button" onClick={cancel} className="flex w-fit items-center gap-1 text-sm font-bold text-teal-700 hover:underline">
        <ArrowRight className="h-4 w-4" /> {t("items.detail.back")}
      </button>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-wide text-teal-700">
            <Boxes className="h-4 w-4" /> {t("items.detail.eyebrow")}
          </div>
          <h1 className="mt-0.5 text-2xl font-extrabold text-slate-900">{title}</h1>
          <p className="mt-1 text-sm font-medium text-slate-500">{mode === "create" ? t("items.form.createSubtitle") : t("items.form.editSubtitle")}</p>
        </div>
        {dirty && <Badge tone="warning"><AlertTriangle className="h-3.5 w-3.5" /> {t("items.form.unsavedIndicator")}</Badge>}
      </div>

      {banner && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">{banner}</p>}
      {summary && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm font-bold text-emerald-700">{summary}</p>}
      {assignWarn && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800">{t("items.assign.savePending")}</p>}

      {/* (a) Basic data */}
      <Section icon={Boxes} title={t("items.form.section.basics")} subtitle={t("items.form.section.basicsHint")}>
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          {/* An EMPTY SKU on an existing item is a legitimate state (legacy
              rows predate the field — see validate() above), not missing data.
              Say so, instead of rendering a blank box that reads as "we lost
              your value": the hint switches to an explicit "this item has no
              SKU — optional" and the placeholder repeats it inside the input. */}
          <Field
            label={t("items.form.field.code")}
            hint={mode === "edit" && !f.code.trim() ? t("items.form.field.codeOptionalHint") : t("items.form.field.codeHint")}
            error={errors.code}
          >
            <input
              className="field w-full font-mono"
              dir="ltr"
              value={f.code}
              disabled={hasMovements}
              placeholder={mode === "edit" ? t("items.form.field.codeEmptyPlaceholder") : undefined}
              onChange={(e) => set("code", e.target.value)}
              aria-label={t("items.form.field.code")}
            />
          </Field>
          <Field label={t("items.form.field.kind")}>
            <Select className="w-full" value={f.kind} disabled={mode === "edit"} onChange={(e) => set("kind", e.target.value as "raw" | "semi")} aria-label={t("items.form.field.kind")}>
              <option value="raw">{t("items.form.field.kindRaw")}</option>
              <option value="semi">{t("items.form.field.kindSemi")}</option>
            </Select>
          </Field>
          <Field label={t("items.form.field.nameAr")} error={errors.nameAr}>
            <input className="field w-full" value={f.nameAr} onChange={(e) => set("nameAr", e.target.value)} aria-label={t("items.form.field.nameAr")} />
          </Field>
          <Field label={t("items.form.field.nameEn")} error={errors.nameEn}>
            <input className="field w-full" dir="ltr" value={f.nameEn} onChange={(e) => set("nameEn", e.target.value)} aria-label={t("items.form.field.nameEn")} />
          </Field>
          <Field label={t("items.form.field.category")}>
            <input className="field w-full" list="item-cats" value={f.category} onChange={(e) => set("category", e.target.value)} aria-label={t("items.form.field.category")} />
            <datalist id="item-cats">{(cats.data ?? []).map((c) => <option key={c} value={c} />)}</datalist>
          </Field>
          <Field label={t("items.form.field.status")}>
            <div className="flex h-10 items-center"><StatusBadge>{mode === "create" || detail?.active ? t("status.active") : t("common.inactive")}</StatusBadge></div>
          </Field>
          <Field label={t("items.form.field.descAr")} full>
            <textarea className="field w-full" rows={2} value={f.descAr} onChange={(e) => set("descAr", e.target.value)} aria-label={t("items.form.field.descAr")} />
          </Field>
          <Field label={t("items.form.field.notes")} full>
            <textarea className="field w-full" rows={2} value={f.notes} onChange={(e) => set("notes", e.target.value)} aria-label={t("items.form.field.notes")} />
          </Field>
        </div>
      </Section>

      {/* (b) Units & conversion */}
      <Section icon={Ruler} title={t("items.form.section.units")} subtitle={t("items.form.section.unitsHint")}>
        {mode === "edit" && detail ? (
          <div className="p-5"><UnitsTab itemId={detail.id} baseUnitName={detail.unit} /></div>
        ) : (
          <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={t("items.form.field.baseUnitName")} error={errors.baseUnit}>
              <input className="field w-full" list="item-units-dl" value={f.baseUnit} onChange={(e) => set("baseUnit", e.target.value)} aria-label={t("items.form.field.baseUnitName")} />
            </Field>
            <Field label={t("items.form.field.majorUnitName")}>
              <input className="field w-full" value={f.majorUnit} onChange={(e) => set("majorUnit", e.target.value)} aria-label={t("items.form.field.majorUnitName")} />
            </Field>
            <Field label={t("items.form.field.conversionFactor")} error={errors.convRate}>
              <input type="number" min={0} step="any" dir="ltr" className="field w-full text-center tabular-nums" value={f.convRate} onChange={(e) => set("convRate", e.target.value)} aria-label={t("items.form.field.conversionFactor")} />
            </Field>
            <div className="flex items-end">
              <p className="text-sm font-bold text-teal-700" dir="rtl" data-testid="conv-preview">
                {hasMajor
                  ? t("items.conversionPreview", { major: f.majorUnit || t("items.form.field.majorUnitName"), factor: formatNumber(factor), base: f.baseUnit || t("items.form.field.baseUnitName") })
                  : t("items.conversionNone")}
              </p>
            </div>
          </div>
        )}
      </Section>

      {/* (c) Cost & accounting — gated by item.cost.view */}
      {canCost && (
        <Section icon={Coins} title={t("items.form.section.cost")} subtitle={t("items.form.section.costHint")}>
          <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={t("items.form.field.currency")}>
              <div className="flex h-10 items-center font-bold text-slate-700" dir="ltr">SAR</div>
            </Field>
            <Field label={t("items.form.field.purchaseCostBase")}>
              <input type="number" min={0} step="any" dir="ltr" className="field w-full text-center tabular-nums" value={f.cost} onChange={(e) => set("cost", e.target.value)} aria-label={t("items.form.field.purchaseCostBase")} />
            </Field>
            <Field label={t("items.form.field.purchaseCostMajor")}>
              <div className="flex h-10 items-center tabular-nums text-slate-700" dir="ltr">{computedMajorCost == null ? "—" : formatCurrency(computedMajorCost)}</div>
            </Field>
            <Field label={t("items.form.field.costMethod")}>
              <div className="flex h-10 items-center"><Badge tone="neutral">{t("items.form.costMethodWac")}</Badge></div>
            </Field>
            <Field label={t("items.form.field.taxCategory")}>
              <div className="flex h-10 items-center text-slate-700">{t("status.available") /* standard */}</div>
            </Field>
            <Field label={t("items.form.field.taxRate")}>
              <div className="flex h-10 items-center tabular-nums text-slate-700" dir="ltr">{vat.rate == null ? "—" : `${formatNumber(vat.rate)}%`}</div>
            </Field>
            <Field label={t("items.form.field.inventoryAccount")}>
              <div className="flex h-10 items-center text-slate-400">—</div>
            </Field>
            <Field label={t("items.form.field.cogsAccount")}>
              <div className="flex h-10 items-center text-slate-400">—</div>
            </Field>
          </div>
          <div className="space-y-1 px-5 pb-5">
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800">{t("items.form.wacReadOnly")}</p>
            <p className="rounded-lg bg-blue-50 px-3 py-2 text-xs font-bold text-blue-700">{t("items.form.vatFromSettings")}</p>
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs font-bold text-slate-500">{t("items.form.glReadOnly")}</p>
          </div>
        </Section>
      )}

      {/* (d) Branches & warehouses */}
      <Section icon={Building2} title={t("items.form.section.assignments")} subtitle={t("items.form.section.assignmentsHint")}>
        <div className="p-5">
          <AssignmentsSection
            drafts={drafts}
            onChange={onDraftsChange}
            defaultWarehouseId={defaultWh}
            onDefaultChange={onDefaultChange}
            universe={universe}
            branches={branches}
            pending={mode === "create"}
          />
        </div>
      </Section>

      {/* Barcodes (edit only — needs a persisted item id) */}
      {mode === "edit" && detail && (
        <Section icon={FileText} title={t("items.form.section.barcodes")}>
          <div className="p-5"><BarcodesTab detail={detail} onSaved={() => detailQ.refetch()} /></div>
        </Section>
      )}

      {/* (e) Save bar */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={cancel} disabled={saving}>{t("items.form.cancel")}</Button>
          {mode === "create" && (
            <Button variant="secondary" onClick={() => handleSave(true)} disabled={saving}>
              <Plus className="h-4 w-4" /> {t("items.form.saveAndAddAnother")}
            </Button>
          )}
          <Button variant="primary" onClick={() => handleSave(false)} disabled={saving}>
            <Save className="h-4 w-4" /> {saving ? t("items.form.saving") : mode === "create" ? t("items.form.create") : t("items.form.saveEdit")}
          </Button>
        </div>
      </div>

      <datalist id="item-units-dl" />
    </div>
  );
}

function Section({ icon: Icon, title, subtitle, children }: { icon?: React.ComponentType<{ className?: string }>; title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="surface overflow-hidden">
      <PanelTitle icon={Icon} title={title} subtitle={subtitle} />
      {children}
    </section>
  );
}

function Field({ label, hint, error, full, children }: { label: string; hint?: string; error?: string; full?: boolean; children: ReactNode }) {
  return (
    <label className={`block text-xs font-bold text-slate-500 ${full ? "sm:col-span-2 lg:col-span-4" : ""}`}>
      <span>{label}</span>
      <div className="mt-1">{children}</div>
      {error ? <span className="mt-1 block text-[11px] font-bold text-rose-600">{error}</span>
        : hint ? <span className="mt-1 block text-[11px] font-medium text-slate-400">{hint}</span> : null}
    </label>
  );
}
