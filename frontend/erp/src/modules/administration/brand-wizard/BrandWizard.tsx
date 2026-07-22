// معالج البراند — 7-step guided setup that persists EACH step to its real
// backend endpoint as the user advances (no "save all at the end"). Every
// create call goes through apiClient (no /api prefix) and ensureAck() so a
// legacy { success:false } body throws instead of silently "succeeding".
//
// Real endpoints (verified against routes/):
//   1. البراند      → POST /erp/brands                       { name, code, vatNumber?, logo? }
//   2. الفروع       → POST /erp/branches-full                { name, code, location?, brandId }
//   3. المستودعات    → POST /erp/warehouses-list              { code, name, type, brandId, branchId? }
//                     (+ POST /erp/warehouses/:id/set-main   when the warehouse is the brand main)
//   4. التصنيفات     → POST /erp/item-categories             { name, brandId }
//   5. أصناف خام     → POST /inventory/items                 { name, category?, unit?, cost?, brandId, active, warehouseId }
//   6. المنيو        → POST /menu                            { name, category?, price, brandId, active }
//   7. ملخص/تم.
//
// NOTE: the standalone create endpoints are `/erp/warehouses-list` and
// `/erp/branches-full` (there is no bare `/erp/warehouses` or `/erp/branches`
// create route). Raw-item creation requires a warehouseId in this backend, so
// step 5 is gated on having created at least one warehouse in step 3.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  Store,
  Warehouse,
  Tags,
  Package,
  UtensilsCrossed,
  PartyPopper,
  Plus,
  Check,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { apiClient } from "@/shared/api";
import {
  Stepper,
  PageHeader,
  Button,
  Input,
  Select,
  Toggle,
  CurrencyInput,
  Badge,
  StatusBadge,
  useToast,
} from "@/shared/ui";
import { Field } from "@/shared/forms";
import { useT } from "@/i18n";
import { ensureAck, type MutationAck } from "../_common";

// ── Created-entity shapes kept in wizard state ───────────────────────────────
interface Created {
  id: string;
  name: string;
  extra?: string;
}

const WH_TYPE_VALUES = ["main", "branch"] as const;

async function post<T extends MutationAck>(path: string, body: unknown): Promise<T> {
  const res = await apiClient.post<T>(path, body);
  return ensureAck(res) as T;
}

/** A small "add + list" panel reused by the repeatable steps. */
function AddedList({ items, empty }: { items: Created[]; empty: string }) {
  if (items.length === 0) {
    return <p className="mt-3 text-xs font-medium text-slate-400">{empty}</p>;
  }
  return (
    <ul className="mt-4 space-y-2">
      {items.map((it) => (
        <li
          key={it.id}
          className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50 px-3 py-2"
        >
          <span className="flex items-center gap-2 text-xs font-bold text-slate-700">
            <Check className="h-4 w-4 text-teal-600" />
            {it.name}
          </span>
          {it.extra && <span className="text-[11px] font-medium text-slate-400">{it.extra}</span>}
        </li>
      ))}
    </ul>
  );
}

function StepError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
      {message}
    </div>
  );
}

export function BrandWizard({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const STEPS = [
    t("administration.wizard.steps.brand"),
    t("administration.wizard.steps.branches"),
    t("administration.wizard.steps.warehouses"),
    t("administration.wizard.steps.categories"),
    t("administration.wizard.steps.rawItems"),
    t("administration.wizard.steps.menu"),
    t("administration.wizard.steps.done"),
  ];
  const whTypeOptions = WH_TYPE_VALUES.map((v) => ({ value: v, label: t(`administration.wizard.whType.${v}`) }));

  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Step 1 — brand
  const [brandName, setBrandName] = useState("");
  const [brandCode, setBrandCode] = useState("");
  const [brandVat, setBrandVat] = useState("");
  const [brandLogo, setBrandLogo] = useState("");
  const [brandId, setBrandId] = useState<string | null>(null);

  // Step 2 — branches
  const [branches, setBranches] = useState<Created[]>([]);
  const [bName, setBName] = useState("");
  const [bCode, setBCode] = useState("");
  const [bLocation, setBLocation] = useState("");

  // Step 3 — warehouses
  const [warehouses, setWarehouses] = useState<Created[]>([]);
  const [wName, setWName] = useState("");
  const [wCode, setWCode] = useState("");
  const [wType, setWType] = useState("main");
  const [wBranchId, setWBranchId] = useState("");
  const [wIsMain, setWIsMain] = useState(true);

  // Step 4 — categories
  const [categories, setCategories] = useState<Created[]>([]);
  const [catName, setCatName] = useState("");

  // Step 5 — raw items
  const [rawItems, setRawItems] = useState<Created[]>([]);
  const [riName, setRiName] = useState("");
  const [riCategory, setRiCategory] = useState("");
  const [riUnit, setRiUnit] = useState("");
  const [riCost, setRiCost] = useState<number | null>(null);
  const [riWarehouseId, setRiWarehouseId] = useState("");

  // Step 6 — menu
  const [menuItems, setMenuItems] = useState<Created[]>([]);
  const [miName, setMiName] = useState("");
  const [miCategory, setMiCategory] = useState("");
  const [miPrice, setMiPrice] = useState<number | null>(null);

  function goto(next: number) {
    setErr(null);
    setStep(next);
  }

  // Step 1 → 2: create the brand once, then advance. Re-entering step 1 keeps it.
  async function submitBrand() {
    if (brandId) return goto(2);
    if (!brandName.trim()) {
      setErr(t("administration.wizard.err.brandName"));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await post<MutationAck>("/erp/brands", {
        name: brandName.trim(),
        code: brandCode.trim() || undefined,
        vatNumber: brandVat.trim() || undefined,
        logo: brandLogo.trim() || undefined,
      });
      setBrandId(String(res.id ?? ""));
      toast({ title: t("administration.wizard.toast.brandCreated"), tone: "success" });
      goto(2);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("administration.wizard.err.brandCreate"));
    } finally {
      setBusy(false);
    }
  }

  async function addBranch() {
    if (!brandId || !bName.trim()) {
      setErr(t("administration.wizard.err.branchName"));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await post<MutationAck>("/erp/branches-full", {
        name: bName.trim(),
        code: bCode.trim() || undefined,
        location: bLocation.trim() || undefined,
        brandId,
      });
      setBranches((xs) => [...xs, { id: String(res.id ?? bName), name: bName.trim(), extra: bCode.trim() || undefined }]);
      setBName("");
      setBCode("");
      setBLocation("");
      toast({ title: t("administration.wizard.toast.branchAdded"), tone: "success" });
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("administration.wizard.err.branchAdd"));
    } finally {
      setBusy(false);
    }
  }

  async function addWarehouse() {
    if (!brandId || !wName.trim() || !wCode.trim()) {
      setErr(t("administration.wizard.err.warehouse"));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await post<MutationAck>("/erp/warehouses-list", {
        code: wCode.trim(),
        name: wName.trim(),
        type: wType,
        brandId,
        branchId: wBranchId || undefined,
      });
      const id = String(res.id ?? wCode);
      if (wIsMain && id) {
        // Best-effort: promote to brand main. Non-fatal if it fails.
        try {
          await apiClient.post<MutationAck>(`/erp/warehouses/${id}/set-main`, {});
        } catch {
          /* keep the created warehouse even if promotion failed */
        }
      }
      setWarehouses((xs) => [
        ...xs,
        { id, name: wName.trim(), extra: wIsMain ? t("administration.wizard.step3.mainExtra") : wCode.trim() },
      ]);
      setWName("");
      setWCode("");
      setWBranchId("");
      setWIsMain(false);
      toast({ title: t("administration.wizard.toast.warehouseAdded"), tone: "success" });
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("administration.wizard.err.warehouseAdd"));
    } finally {
      setBusy(false);
    }
  }

  async function addCategory() {
    if (!brandId || !catName.trim()) {
      setErr(t("administration.wizard.err.category"));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await post<MutationAck>("/erp/item-categories", { name: catName.trim(), brandId });
      setCategories((xs) => [...xs, { id: String(res.id ?? catName), name: catName.trim() }]);
      setCatName("");
      toast({ title: t("administration.wizard.toast.categoryAdded"), tone: "success" });
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("administration.wizard.err.categoryAdd"));
    } finally {
      setBusy(false);
    }
  }

  async function addRawItem() {
    if (!brandId || !riName.trim()) {
      setErr(t("administration.wizard.err.rawItemName"));
      return;
    }
    if (!riWarehouseId) {
      setErr(t("administration.wizard.err.rawItemWarehouse"));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await post<MutationAck>("/inventory/items", {
        name: riName.trim(),
        category: riCategory || undefined,
        unit: riUnit.trim() || undefined,
        cost: riCost ?? undefined,
        brandId,
        active: true,
        warehouseId: riWarehouseId,
      });
      setRawItems((xs) => [...xs, { id: String(res.id ?? riName), name: riName.trim(), extra: riUnit.trim() || undefined }]);
      setRiName("");
      setRiCategory("");
      setRiUnit("");
      setRiCost(null);
      toast({ title: t("administration.wizard.toast.rawItemAdded"), tone: "success" });
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("administration.wizard.err.rawItemAdd"));
    } finally {
      setBusy(false);
    }
  }

  async function addMenuItem() {
    if (!brandId || !miName.trim()) {
      setErr(t("administration.wizard.err.menuName"));
      return;
    }
    if (miPrice == null || miPrice < 0) {
      setErr(t("administration.wizard.err.menuPrice"));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await post<MutationAck>("/menu", {
        name: miName.trim(),
        category: miCategory || undefined,
        price: miPrice,
        brandId,
        active: true,
      });
      setMenuItems((xs) => [
        ...xs,
        { id: String(res.id ?? miName), name: miName.trim(), extra: `${miPrice} ${t("sharedUi.currencySymbol")}` },
      ]);
      setMiName("");
      setMiCategory("");
      setMiPrice(null);
      toast({ title: t("administration.wizard.toast.menuAdded"), tone: "success" });
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("administration.wizard.err.menuAdd"));
    } finally {
      setBusy(false);
    }
  }

  function finish() {
    qc.invalidateQueries({ queryKey: ["erp", "brands-stats"] });
    qc.invalidateQueries({ queryKey: ["erp", "brands"] });
    toast({ title: t("administration.wizard.toast.done"), tone: "success" });
    onDone();
  }

  const categoryOptions = [
    { value: "", label: t("administration.wizard.categoryNone") },
    ...categories.map((c) => ({ value: c.name, label: c.name })),
  ];
  const warehouseOptions = [
    { value: "", label: t("administration.wizard.warehousePick") },
    ...warehouses.map((w) => ({ value: w.id, label: w.name })),
  ];
  const branchOptions = [
    { value: "", label: t("administration.wizard.branchNone") },
    ...branches.map((b) => ({ value: b.id, label: b.name })),
  ];

  return (
    <div>
      <PageHeader
        eyebrow={t("administration.eyebrow")}
        title={t("administration.wizard.title")}
        subtitle={t("administration.wizard.subtitle")}
        action={
          <Button variant="ghost" onClick={onCancel}>
            {t("administration.wizard.backToBrands")}
          </Button>
        }
      />

      <div className="surface mb-4 p-4">
        <Stepper steps={STEPS} current={step} />
      </div>

      {/* Step 1 — Brand */}
      {step === 1 && (
        <div className="surface space-y-4 p-5">
          <div className="flex items-center gap-2 text-sm font-extrabold text-slate-800">
            <Building2 className="h-4 w-4 text-teal-600" /> {t("administration.wizard.step1.title")}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("administration.wizard.step1.name")} required className="sm:col-span-2">
              <Input value={brandName} disabled={!!brandId} onChange={(e) => setBrandName(e.target.value)} />
            </Field>
            <Field label={t("administration.wizard.step1.code")} hint={t("administration.wizard.step1.codeHint")}>
              <Input value={brandCode} disabled={!!brandId} onChange={(e) => setBrandCode(e.target.value)} />
            </Field>
            <Field label={t("administration.wizard.step1.vat")} hint={t("administration.wizard.step1.vatHint")}>
              <Input value={brandVat} inputMode="numeric" disabled={!!brandId} onChange={(e) => setBrandVat(e.target.value)} />
            </Field>
            <Field label={t("administration.wizard.step1.logo")} className="sm:col-span-2" hint={t("administration.wizard.step1.logoHint")}>
              <Input value={brandLogo} dir="ltr" disabled={!!brandId} onChange={(e) => setBrandLogo(e.target.value)} />
            </Field>
          </div>
          {brandId && (
            <p className="flex items-center gap-2 text-xs font-bold text-teal-700">
              <Check className="h-4 w-4" /> {t("administration.wizard.step1.created")}
            </p>
          )}
          <StepError message={err} />
          <div className="flex justify-end">
            <Button variant="primary" loading={busy} onClick={submitBrand}>
              {brandId ? t("administration.wizard.step1.nextBtn") : t("administration.wizard.step1.createBtn")} <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Step 2 — Branches */}
      {step === 2 && (
        <div className="surface space-y-4 p-5">
          <div className="flex items-center gap-2 text-sm font-extrabold text-slate-800">
            <Store className="h-4 w-4 text-teal-600" /> {t("administration.wizard.step2.title")}
            <Badge tone="teal">{branches.length}</Badge>
          </div>
          <div className="grid items-end gap-4 sm:grid-cols-4">
            <Field label={t("administration.wizard.step2.name")} required className="sm:col-span-2">
              <Input value={bName} onChange={(e) => setBName(e.target.value)} />
            </Field>
            <Field label={t("administration.wizard.step2.code")}>
              <Input value={bCode} onChange={(e) => setBCode(e.target.value)} />
            </Field>
            <Field label={t("administration.wizard.step2.location")}>
              <Input value={bLocation} onChange={(e) => setBLocation(e.target.value)} />
            </Field>
          </div>
          <div>
            <Button variant="secondary" loading={busy} onClick={addBranch}>
              <Plus className="h-4 w-4" /> {t("administration.wizard.step2.addBtn")}
            </Button>
          </div>
          <AddedList items={branches} empty={t("administration.wizard.step2.empty")} />
          <StepError message={err} />
          <div className="flex justify-between">
            <Button variant="secondary" onClick={() => goto(1)}>
              <ChevronRight className="h-4 w-4" /> {t("administration.wizard.nav.prev")}
            </Button>
            <Button variant="primary" onClick={() => goto(3)}>
              {t("administration.wizard.nav.next")} <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Step 3 — Warehouses */}
      {step === 3 && (
        <div className="surface space-y-4 p-5">
          <div className="flex items-center gap-2 text-sm font-extrabold text-slate-800">
            <Warehouse className="h-4 w-4 text-teal-600" /> {t("administration.wizard.step3.title")}
            <Badge tone="teal">{warehouses.length}</Badge>
          </div>
          <div className="grid items-end gap-4 sm:grid-cols-4">
            <Field label={t("administration.wizard.step3.name")} required className="sm:col-span-2">
              <Input value={wName} onChange={(e) => setWName(e.target.value)} />
            </Field>
            <Field label={t("administration.wizard.step3.code")} required>
              <Input value={wCode} onChange={(e) => setWCode(e.target.value)} />
            </Field>
            <Field label={t("administration.wizard.step3.type")}>
              <Select options={whTypeOptions} value={wType} onChange={(e) => setWType(e.target.value)} />
            </Field>
            <Field label={t("administration.wizard.step3.branch")} className="sm:col-span-2">
              <Select options={branchOptions} value={wBranchId} onChange={(e) => setWBranchId(e.target.value)} />
            </Field>
            <div className="sm:col-span-2 flex items-center">
              <Toggle checked={wIsMain} onChange={setWIsMain} label={t("administration.wizard.step3.mainToggle")} />
            </div>
          </div>
          <div>
            <Button variant="secondary" loading={busy} onClick={addWarehouse}>
              <Plus className="h-4 w-4" /> {t("administration.wizard.step3.addBtn")}
            </Button>
          </div>
          <AddedList items={warehouses} empty={t("administration.wizard.step3.empty")} />
          <StepError message={err} />
          <div className="flex justify-between">
            <Button variant="secondary" onClick={() => goto(2)}>
              <ChevronRight className="h-4 w-4" /> {t("administration.wizard.nav.prev")}
            </Button>
            <Button variant="primary" onClick={() => goto(4)}>
              {t("administration.wizard.nav.next")} <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Step 4 — Categories (skippable) */}
      {step === 4 && (
        <div className="surface space-y-4 p-5">
          <div className="flex items-center gap-2 text-sm font-extrabold text-slate-800">
            <Tags className="h-4 w-4 text-teal-600" /> {t("administration.wizard.step4.title")}
            <Badge tone="teal">{categories.length}</Badge>
            <span className="text-[11px] font-medium text-slate-400">{t("administration.wizard.step4.optional")}</span>
          </div>
          <div className="grid items-end gap-4 sm:grid-cols-4">
            <Field label={t("administration.wizard.step4.name")} required className="sm:col-span-3">
              <Input value={catName} onChange={(e) => setCatName(e.target.value)} />
            </Field>
            <Button variant="secondary" loading={busy} onClick={addCategory}>
              <Plus className="h-4 w-4" /> {t("administration.wizard.step4.addBtn")}
            </Button>
          </div>
          <AddedList items={categories} empty={t("administration.wizard.step4.empty")} />
          <StepError message={err} />
          <div className="flex justify-between">
            <Button variant="secondary" onClick={() => goto(3)}>
              <ChevronRight className="h-4 w-4" /> {t("administration.wizard.nav.prev")}
            </Button>
            <Button variant="primary" onClick={() => goto(5)}>
              {categories.length ? t("administration.wizard.nav.next") : t("administration.wizard.nav.skip")} <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Step 5 — Raw items (skippable) */}
      {step === 5 && (
        <div className="surface space-y-4 p-5">
          <div className="flex items-center gap-2 text-sm font-extrabold text-slate-800">
            <Package className="h-4 w-4 text-teal-600" /> {t("administration.wizard.step5.title")}
            <Badge tone="teal">{rawItems.length}</Badge>
            <span className="text-[11px] font-medium text-slate-400">{t("administration.wizard.step5.optional")}</span>
          </div>
          {warehouses.length === 0 ? (
            <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">
              {t("administration.wizard.step5.warnNoWarehouse")}
            </p>
          ) : (
            <>
              <div className="grid items-end gap-4 sm:grid-cols-4">
                <Field label={t("administration.wizard.step5.name")} required className="sm:col-span-2">
                  <Input value={riName} onChange={(e) => setRiName(e.target.value)} />
                </Field>
                <Field label={t("administration.wizard.step5.category")}>
                  <Select options={categoryOptions} value={riCategory} onChange={(e) => setRiCategory(e.target.value)} />
                </Field>
                <Field label={t("administration.wizard.step5.unit")}>
                  <Input value={riUnit} onChange={(e) => setRiUnit(e.target.value)} placeholder={t("administration.wizard.step5.unitPlaceholder")} />
                </Field>
                <Field label={t("administration.wizard.step5.cost")}>
                  <CurrencyInput value={riCost} onChange={setRiCost} />
                </Field>
                <Field label={t("administration.wizard.step5.warehouse")} required className="sm:col-span-2">
                  <Select options={warehouseOptions} value={riWarehouseId} onChange={(e) => setRiWarehouseId(e.target.value)} />
                </Field>
              </div>
              <div>
                <Button variant="secondary" loading={busy} onClick={addRawItem}>
                  <Plus className="h-4 w-4" /> {t("administration.wizard.step5.addBtn")}
                </Button>
              </div>
            </>
          )}
          <AddedList items={rawItems} empty={t("administration.wizard.step5.empty")} />
          <StepError message={err} />
          <div className="flex justify-between">
            <Button variant="secondary" onClick={() => goto(4)}>
              <ChevronRight className="h-4 w-4" /> {t("administration.wizard.nav.prev")}
            </Button>
            <Button variant="primary" onClick={() => goto(6)}>
              {rawItems.length ? t("administration.wizard.nav.next") : t("administration.wizard.nav.skip")} <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Step 6 — Menu (skippable) */}
      {step === 6 && (
        <div className="surface space-y-4 p-5">
          <div className="flex items-center gap-2 text-sm font-extrabold text-slate-800">
            <UtensilsCrossed className="h-4 w-4 text-teal-600" /> {t("administration.wizard.step6.title")}
            <Badge tone="teal">{menuItems.length}</Badge>
            <span className="text-[11px] font-medium text-slate-400">{t("administration.wizard.step6.optional")}</span>
          </div>
          <div className="grid items-end gap-4 sm:grid-cols-4">
            <Field label={t("administration.wizard.step6.name")} required className="sm:col-span-2">
              <Input value={miName} onChange={(e) => setMiName(e.target.value)} />
            </Field>
            <Field label={t("administration.wizard.step6.category")}>
              <Select options={categoryOptions} value={miCategory} onChange={(e) => setMiCategory(e.target.value)} />
            </Field>
            <Field label={t("administration.wizard.step6.price")} required>
              <CurrencyInput value={miPrice} onChange={setMiPrice} />
            </Field>
          </div>
          <div>
            <Button variant="secondary" loading={busy} onClick={addMenuItem}>
              <Plus className="h-4 w-4" /> {t("administration.wizard.step6.addBtn")}
            </Button>
          </div>
          <AddedList items={menuItems} empty={t("administration.wizard.step6.empty")} />
          <StepError message={err} />
          <div className="flex justify-between">
            <Button variant="secondary" onClick={() => goto(5)}>
              <ChevronRight className="h-4 w-4" /> {t("administration.wizard.nav.prev")}
            </Button>
            <Button variant="primary" onClick={() => goto(7)}>
              {menuItems.length ? t("administration.wizard.nav.next") : t("administration.wizard.nav.skip")} <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Step 7 — Summary */}
      {step === 7 && (
        <div className="surface space-y-5 p-5">
          <div className="flex items-center gap-2 text-base font-extrabold text-slate-900">
            <PartyPopper className="h-5 w-5 text-teal-600" /> {t("administration.wizard.step7.title")}
          </div>
          <p className="text-sm font-medium text-slate-500">
            {t("administration.wizard.step7.body")}
          </p>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <SummaryTile label={t("administration.wizard.step7.tile.brand")} value={brandName || "—"} />
            <SummaryTile label={t("administration.wizard.step7.tile.branches")} value={String(branches.length)} />
            <SummaryTile label={t("administration.wizard.step7.tile.warehouses")} value={String(warehouses.length)} />
            <SummaryTile label={t("administration.wizard.step7.tile.categories")} value={String(categories.length)} />
            <SummaryTile label={t("administration.wizard.step7.tile.rawItems")} value={String(rawItems.length)} />
            <SummaryTile label={t("administration.wizard.step7.tile.menu")} value={String(menuItems.length)} />
          </div>
          <div className="flex justify-between">
            <Button variant="secondary" onClick={() => goto(6)}>
              <ChevronRight className="h-4 w-4" /> {t("administration.wizard.nav.prev")}
            </Button>
            <Button variant="primary" onClick={finish}>
              <Check className="h-4 w-4" /> {t("administration.wizard.step7.doneBtn")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryTile({ label, value }: { label: string; value: string }) {
  const t = useT();
  return (
    <div className="surface p-4">
      <div className="text-xs font-bold text-slate-400">{label}</div>
      <div className="mt-1 flex items-center gap-2">
        <span className="text-lg font-extrabold text-slate-900">{value}</span>
        <StatusBadge tone="success">{t("administration.wizard.saved")}</StatusBadge>
      </div>
    </div>
  );
}
