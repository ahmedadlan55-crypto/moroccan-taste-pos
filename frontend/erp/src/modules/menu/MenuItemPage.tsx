/**
 * MenuItemPage — the full-page New / Details / Edit product screen (Sprint 3 · D2).
 *
 * Replaces the old ItemFormDialog with a routed full page (/menu/brand/new,
 * /menu/brand/:id, /menu/brand/:id/edit — the module index reads the sub-path).
 * Bilingual from the start (menu.* namespace). It hydrates the editable field
 * set from the shared _mapMenu read (GET /menu/all, which D3 extended to expose
 * tax_category + cost_source) and the D3-derived branch/channel counts from a
 * single /menu/list lookup.
 *
 * Cost lock: when cost_source='recipe' the cost is computed from the BOM; a
 * manual edit is refused by the PUT (COST_LOCKED_BY_RECIPE) unless costOverride
 * is set. This page surfaces that as an "unlock to edit" workflow — never a raw
 * error — and only sends costOverride when the cost actually changed. Modifiers/
 * Combos, Price lists and the Recipe/BOM editor are LINKED (not reimplemented).
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, ChefHat, Layers, Tags, Lock, Unlock, Tag, History, ImageOff, Pencil } from "lucide-react";
import {
  Card,
  Button,
  Input,
  Select,
  Toggle,
  NumberInput,
  CurrencyInput,
  StatusBadge,
  LoadingState,
  ErrorState,
  useToast,
} from "@/shared/ui";
import { Field, FormActions } from "@/shared/forms";
import { Can, useCan } from "@/shared/permissions";
import { useT, useLang, type Lang } from "@/i18n";
import {
  useBrands,
  useMenuItemDetail,
  useMenuList,
  useRecipeBom,
  useVatRate,
  useCreateMenuItem,
  useUpdateMenuItem,
  type MenuItemInput,
  type TaxCategory,
  type CostSource,
} from "./api";
import { useBrandScope, pickName, MoneyI18n } from "./lib";
import { ItemImageEditor } from "./ItemImageEditor";
import { PriceEditDialog, PriceHistoryDrawer, toPriceTarget } from "./PriceDialogs";
import { MenuItemThumb, useItemImage } from "./MenuItemThumb";

export type MenuItemPageMode = "new" | "view" | "edit";
const TAX_CATEGORIES: TaxCategory[] = ["S", "Z", "E", "O"];

interface FormState {
  name: string;
  nameEn: string;
  descAr: string;
  descEn: string;
  category: string;
  brandId: string;
  price: number | null;
  cost: number | null;
  unit: string;
  multiUnit: boolean;
  bigUnit: string;
  convRate: number | null;
  taxCategory: TaxCategory;
  active: boolean;
}

const BLANK: FormState = {
  name: "", nameEn: "", descAr: "", descEn: "", category: "عام", brandId: "",
  price: 0, cost: 0, unit: "", multiUnit: false, bigUnit: "", convRate: 1, taxCategory: "S", active: true,
};

// ── Small section wrapper (bilingual, RTL/LTR-neutral via logical spacing) ────
function Section({ icon: Icon, title, subtitle, action, children }: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string; subtitle?: string; action?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div className="flex items-start gap-3">
          {Icon && <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-600"><Icon className="h-5 w-5" /></span>}
          <div>
            <h2 className="text-base font-bold text-slate-900">{title}</h2>
            {subtitle && <p className="mt-1 text-sm font-normal leading-6 text-slate-500">{subtitle}</p>}
          </div>
        </div>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </Card>
  );
}

// ── POS cashier-card preview (one language) ───────────────────────────────────
function PosPreviewCard({ lang, name, price, imgSrc, id, imageVer, hasImage }: {
  lang: Lang; name: string; price: number | null; imgSrc: string | null; id: string; imageVer: string | null; hasImage: boolean;
}) {
  const t = useT();
  const existingSrc = useItemImage(id, imageVer, hasImage);
  const src = imgSrc ?? existingSrc;
  const priceStr = new Intl.NumberFormat(lang === "en" ? "en-US" : "ar-SA-u-nu-latn", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(price) || 0);
  const label = name.trim() || t("menu.preview.noName");
  return (
    <div dir={lang === "en" ? "ltr" : "rtl"} className="w-40 shrink-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="grid aspect-square w-full place-items-center bg-slate-50">
        {src ? (
          <img src={src} alt={label} className="h-full w-full object-cover" />
        ) : (
          <ImageOff className="h-7 w-7 text-slate-300" aria-hidden />
        )}
      </div>
      <div className="space-y-1 p-2.5">
        <div className="line-clamp-2 min-h-[2.4em] text-sm font-bold text-slate-800">{label}</div>
        <div className="flex items-center justify-between">
          <span dir="ltr" className="text-sm font-extrabold tabular-nums text-teal-700">{priceStr}</span>
          <span className="rounded-lg bg-teal-600 px-2 py-1 text-[11px] font-bold text-white">{t("menu.preview.addBtn")}</span>
        </div>
      </div>
    </div>
  );
}

export function MenuItemPage({ mode, id }: { mode: MenuItemPageMode; id?: string }) {
  const t = useT();
  const lang = useLang();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { brandId: scopeBrandId } = useBrandScope();

  const canManage = useCan("menu.catalog.manage");
  const canPrice = useCan("menu.pricing.manage");

  const readOnly = mode === "view" || !canManage;
  const brandQuery = scopeBrandId ? `?brandId=${encodeURIComponent(scopeBrandId)}` : "";

  const brandsQ = useBrands();
  const vatRateQ = useVatRate();
  const vatRate = vatRateQ.data ?? 15;

  const detailQ = useMenuItemDetail(id ?? null);
  const base = detailQ.data ?? null;
  const bomQ = useRecipeBom(mode !== "new" && base?.costSource === "recipe" ? (id ?? null) : null);
  const rowQ = useMenuList({ q: id ?? "", pageSize: 20 }, { enabled: !!id && mode !== "new" });
  const derivedRow = useMemo(() => (rowQ.data?.data ?? []).find((r) => r.id === id) ?? null, [rowQ.data, id]);

  const [form, setForm] = useState<FormState>({ ...BLANK, brandId: scopeBrandId || "" });
  const [imageData, setImageData] = useState<string | undefined>(undefined);
  const [costUnlocked, setCostUnlocked] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [priceOpen, setPriceOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const create = useCreateMenuItem();
  const update = useUpdateMenuItem();
  const pending = create.isPending || update.isPending;

  // Hydrate from the loaded item (edit/view).
  useEffect(() => {
    if (mode === "new" || !base) return;
    setForm({
      name: base.name ?? "",
      nameEn: base.nameEn ?? "",
      // Descriptions are not returned by the shared read yet (no backing column);
      // forward-looking write-only fields, so hydrate blank.
      descAr: "",
      descEn: "",
      category: base.category ?? "عام",
      brandId: base.brandId ?? "",
      price: base.price ?? 0,
      cost: base.cost ?? 0,
      unit: base.unit ?? "",
      multiUnit: !!(base.bigUnit && base.convRate && base.convRate !== 1),
      bigUnit: base.bigUnit ?? "",
      convRate: base.convRate ?? 1,
      taxCategory: (base.taxCategory as TaxCategory) ?? "S",
      active: base.active ?? true,
    });
    setImageData(undefined);
    setCostUnlocked(false);
  }, [mode, base]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((p) => ({ ...p, [key]: value }));

  const costSource: CostSource | null = base?.costSource ?? null;
  const costLocked = costSource === "recipe" && !costUnlocked;
  const computedCost = base?.computedCost ?? 0;

  // Live instant margin (mirrors the server formula: strip VAT only when the
  // stored price is tax-inclusive AND standard-rated).
  const isTaxInclusive = base?.isTaxInclusive ?? true;
  const priceNum = Number(form.price) || 0;
  const costNum = costLocked ? (base?.cost ?? 0) : Number(form.cost) || 0;
  const preTaxPrice = isTaxInclusive && form.taxCategory === "S" ? priceNum / (1 + vatRate / 100) : priceNum;
  const marginValue = Math.round((preTaxPrice - costNum) * 10000) / 10000;
  const marginPctLive = preTaxPrice > 0 ? Math.round((marginValue / preTaxPrice) * 10000) / 100 : 0;

  function validate(): boolean {
    const e: Partial<Record<keyof FormState, string>> = {};
    if (!form.name.trim()) e.name = t("menu.valid.nameRequired");
    if (!form.brandId.trim()) e.brandId = t("menu.valid.brandRequired");
    if (!form.category.trim()) e.category = t("menu.valid.categoryRequired");
    if (form.price == null || !Number.isFinite(form.price) || form.price < 0) e.price = t("menu.valid.priceInvalid");
    if (!costLocked && (form.cost == null || !Number.isFinite(form.cost) || form.cost < 0)) e.cost = t("menu.valid.costInvalid");
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function submit() {
    if (readOnly || !validate()) return;
    const costChanged = !costLocked && Number(form.cost) !== Number(base?.cost ?? NaN);
    const commonImage = imageData !== undefined ? { imageData } : {};

    if (mode === "new") {
      const input: MenuItemInput = {
        name: form.name.trim(),
        nameEn: form.nameEn.trim() || "",
        descAr: form.descAr.trim() || undefined,
        descEn: form.descEn.trim() || undefined,
        category: form.category.trim(),
        brandId: form.brandId || null,
        price: Number(form.price) || 0,
        cost: Number(form.cost) || 0,
        unit: form.unit.trim() || null,
        bigUnit: form.multiUnit ? form.bigUnit.trim() || null : null,
        convRate: form.multiUnit ? Number(form.convRate) || 1 : 1,
        taxCategory: form.taxCategory,
        active: form.active,
        ...(imageData ? { imageData } : {}),
      };
      create.mutate(input, {
        onSuccess: (res) => {
          toast({ title: t("menu.page.created"), tone: "success" });
          const newId = (res as { id?: string }).id;
          navigate(newId ? `/menu/brand/${encodeURIComponent(newId)}${brandQuery}` : `/menu/brand${brandQuery}`);
        },
        onError: (err: Error) => toast({ title: t("states.unexpectedError"), description: err.message, tone: "error" }),
      });
      return;
    }

    // Edit — carry through the columns the PUT route would otherwise reset, and
    // deliberately OMIT taxCategory (create-only) to preserve the stored ZATCA
    // category. Only send costOverride when a recipe-locked cost was unlocked AND
    // actually changed.
    const input: MenuItemInput = {
      name: form.name.trim(),
      nameEn: form.nameEn.trim() || "",
      descAr: form.descAr.trim() || undefined,
      descEn: form.descEn.trim() || undefined,
      category: form.category.trim(),
      brandId: form.brandId || null,
      price: Number(form.price) || 0,
      cost: costLocked ? (base?.cost ?? 0) : Number(form.cost) || 0,
      unit: form.unit.trim() || null,
      bigUnit: form.multiUnit ? form.bigUnit.trim() || null : null,
      convRate: form.multiUnit ? Number(form.convRate) || 1 : 1,
      active: form.active,
      stock: base?.stock,
      minStock: base?.minStock,
      pricingMode: base?.pricingMode,
      markupPct: base?.markupPct,
      yieldQuantity: base?.yieldQuantity,
      yieldUnit: base?.yieldUnit,
      ...(costChanged ? { costOverride: true } : {}),
      ...commonImage,
    };
    update.mutate({ id: id!, input }, {
      onSuccess: () => {
        toast({ title: t("menu.page.saved"), tone: "success" });
        navigate(`/menu/brand/${encodeURIComponent(id!)}${brandQuery}`);
      },
      onError: (err: Error & { code?: string }) => {
        if (err.code === "COST_LOCKED_BY_RECIPE") {
          setCostUnlocked(true);
          toast({ title: t("menu.cost.locked"), description: t("menu.cost.lockedHint"), tone: "warning" });
        } else {
          toast({ title: t("states.unexpectedError"), description: err.message, tone: "error" });
        }
      },
    });
  }

  // ── loading / error / not-found ──
  if (mode !== "new" && detailQ.isLoading) return <LoadingState rows={4} />;
  if (mode !== "new" && detailQ.isError) return <ErrorState error={detailQ.error} onRetry={() => detailQ.refetch()} />;
  if (mode !== "new" && !detailQ.isLoading && !base) {
    return (
      <div className="space-y-4">
        <BackLink to={`/menu/brand${brandQuery}`} label={t("menu.page.back")} />
        <Card className="p-8 text-center text-sm font-medium text-slate-500">{t("menu.page.loadError")}</Card>
      </div>
    );
  }

  const eyebrow = mode === "new" ? t("menu.page.eyebrowNew") : mode === "edit" ? t("menu.page.eyebrowEdit") : t("menu.page.eyebrowView");
  const title = mode === "new" ? t("menu.page.titleNew") : pickName(form.name, form.nameEn, lang) || t("menu.page.titleEdit");
  const pendingImgSrc = imageData === undefined ? (base?.imageData ?? null) : imageData === "" ? null : imageData;

  return (
    <div className="space-y-6">
      <BackLink to={`/menu/brand${brandQuery}`} label={t("menu.page.back")} />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold tracking-wide text-teal-700">{eyebrow}</div>
          <h1 className="mt-0.5 truncate text-2xl font-bold tracking-tight text-slate-950">{title}</h1>
          {mode !== "new" && <div dir="ltr" className="mt-1 font-mono text-xs text-slate-400">{id}</div>}
        </div>
        <div className="flex items-center gap-2">
          {mode !== "new" && <StatusBadge>{form.active ? "active" : "disabled"}</StatusBadge>}
          {mode === "view" && canManage && (
            <Button variant="secondary" onClick={() => navigate(`/menu/brand/${encodeURIComponent(id!)}/edit${brandQuery}`)}>
              <Pencil className="h-4 w-4" /> {t("common.edit")}
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left / main column */}
        <div className="space-y-6 lg:col-span-2">
          <Section icon={Tags} title={t("menu.page.secBasic")}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("menu.page.code")} hint={mode === "new" ? t("menu.page.codeAuto") : undefined}>
                {({ id: fid }) => <Input id={fid} dir="ltr" value={mode === "new" ? "" : id ?? ""} placeholder={t("menu.page.codeAuto")} disabled readOnly />}
              </Field>
              <Field label={t("menu.page.brand")} required error={errors.brandId}>
                {({ id: fid, invalid }) => (
                  <Select id={fid} invalid={invalid} value={form.brandId} onChange={(e) => set("brandId", e.target.value)} disabled={readOnly}>
                    <option value="">{t("menu.page.brandPlaceholder")}</option>
                    {(brandsQ.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </Select>
                )}
              </Field>
              <Field label={t("menu.page.nameAr")} required error={errors.name}>
                {({ id: fid, invalid }) => <Input id={fid} invalid={invalid} value={form.name} onChange={(e) => set("name", e.target.value)} disabled={readOnly} />}
              </Field>
              <Field label={t("menu.page.nameEn")}>
                {({ id: fid }) => (
                  <div className="space-y-1">
                    <Input id={fid} dir="ltr" value={form.nameEn} onChange={(e) => set("nameEn", e.target.value)} disabled={readOnly} />
                    {!form.nameEn.trim() && (
                      <span className="chip border-amber-200 bg-amber-50 text-[11px] text-amber-700" data-testid="missing-nameen">{t("menu.badge.missingEn")}</span>
                    )}
                  </div>
                )}
              </Field>
              <Field label={t("menu.page.category")} required error={errors.category}>
                {({ id: fid, invalid }) => <Input id={fid} invalid={invalid} value={form.category} onChange={(e) => set("category", e.target.value)} disabled={readOnly} />}
              </Field>
              <Field label={t("menu.page.unit")} hint={t("menu.page.unitHint")}>
                {({ id: fid }) => <Input id={fid} value={form.unit} onChange={(e) => set("unit", e.target.value)} disabled={readOnly} />}
              </Field>
              <Field label={t("menu.page.descAr")} className="sm:col-span-2">
                {({ id: fid }) => <textarea id={fid} className="field min-h-16 w-full resize-y py-2" value={form.descAr} onChange={(e) => set("descAr", e.target.value)} disabled={readOnly} />}
              </Field>
              <Field label={t("menu.page.descEn")} className="sm:col-span-2">
                {({ id: fid }) => <textarea id={fid} dir="ltr" className="field min-h-16 w-full resize-y py-2" value={form.descEn} onChange={(e) => set("descEn", e.target.value)} disabled={readOnly} />}
              </Field>
            </div>
            <div className="mt-4">
              <Toggle checked={form.multiUnit} onChange={(v) => set("multiUnit", v)} label={t("menu.page.multiUnit")} />
              {form.multiUnit && (
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  <Field label={t("menu.page.bigUnit")}>
                    {({ id: fid }) => <Input id={fid} value={form.bigUnit} onChange={(e) => set("bigUnit", e.target.value)} disabled={readOnly} />}
                  </Field>
                  <Field label={t("menu.page.convRate")} hint={t("menu.page.convRateHint")}>
                    {({ id: fid }) => <NumberInput id={fid} value={form.convRate} onChange={(v) => set("convRate", v)} min={0} step="any" disabled={readOnly} />}
                  </Field>
                </div>
              )}
            </div>
          </Section>

          <Section icon={Tag} title={t("menu.page.secImage")}>
            {canManage ? (
              <ItemImageEditor current={base?.imageData ?? null} pending={imageData} onChange={setImageData} disabled={readOnly} />
            ) : (
              <div className="flex items-center gap-3">
                <MenuItemThumb id={id ?? ""} imageVer={derivedRow?.imageVer} hasImage={derivedRow?.hasImage} className="h-20 w-20" />
                <p className="text-sm font-medium text-slate-400">{t("menu.page.secImage")}</p>
              </div>
            )}
          </Section>

          <Section icon={Tags} title={t("menu.page.secPricing")}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("menu.page.price")} required error={errors.price}>
                {({ id: fid }) => <CurrencyInput id={fid} value={form.price} onChange={(v) => set("price", v)} min={0} disabled={readOnly} />}
              </Field>
              <Field label={t("menu.tax.category")} hint={mode === "new" ? undefined : t("menu.tax.createOnly")}>
                {({ id: fid }) => (
                  <Select id={fid} value={form.taxCategory} onChange={(e) => set("taxCategory", e.target.value as TaxCategory)} disabled={readOnly || mode !== "new"}>
                    {TAX_CATEGORIES.map((c) => <option key={c} value={c}>{t(`menu.tax.${c}`)}</option>)}
                  </Select>
                )}
              </Field>
            </div>

            {/* Instant margin (gated by menu.cost.view) */}
            <Can cap="menu.cost.view">
              <div className="mt-4 grid grid-cols-2 gap-3 rounded-xl border border-slate-100 bg-slate-50 p-4 sm:grid-cols-4">
                <Metric label={t("menu.margin.vatRate")}><span dir="ltr" className="tabular-nums">{vatRate}%</span></Metric>
                <Metric label={t("menu.margin.exVatPrice")}><MoneyI18n value={preTaxPrice} /></Metric>
                <Metric label={t("menu.margin.value")}><MoneyI18n value={marginValue} className={marginValue >= 0 ? "text-emerald-600" : "text-rose-600"} /></Metric>
                <Metric label={t("menu.margin.pct")}><span dir="ltr" className={marginPctLive >= 0 ? "tabular-nums font-extrabold text-emerald-600" : "tabular-nums font-extrabold text-rose-600"}>{marginPctLive}%</span></Metric>
              </div>
              <p className="mt-2 text-xs font-medium text-slate-400">{t("menu.margin.note")}</p>
            </Can>

            {mode !== "new" && (
              <div className="mt-4 flex flex-wrap gap-2">
                {canPrice && (
                  <Button variant="secondary" size="sm" onClick={() => setPriceOpen(true)}>
                    <Tag className="h-4 w-4" /> {t("menu.rowAction.editPrice")}
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => setHistoryOpen(true)}>
                  <History className="h-4 w-4" /> {t("menu.rowAction.priceHistory")}
                </Button>
              </div>
            )}
          </Section>

          {/* Cost + breakdown + source (gated) */}
          <Can cap="menu.cost.view">
            <Section icon={ChefHat} title={t("menu.page.secCost")}>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-xl border border-slate-100 bg-slate-50 p-4">
                  <div className="text-[11px] font-bold text-slate-400">{t("menu.cost.computed")}</div>
                  <MoneyI18n value={costSource === "recipe" ? computedCost : costNum} className="text-lg font-extrabold text-slate-800" />
                  <div className="mt-1 text-xs font-bold uppercase text-slate-400">
                    {t("menu.cost.source")}: {t(`menu.costSource.${costSource ?? "manual"}`)}
                  </div>
                </div>

                <div>
                  {costLocked ? (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                      <div className="flex items-center gap-2 text-sm font-bold text-amber-700">
                        <Lock className="h-4 w-4" /> {t("menu.cost.locked")}
                      </div>
                      <p className="mt-1 text-xs font-medium text-amber-700">{t("menu.cost.lockedHint")}</p>
                      {!readOnly && (
                        <Button variant="secondary" size="sm" className="mt-3" onClick={() => setCostUnlocked(true)}>
                          <Unlock className="h-4 w-4" /> {t("menu.cost.unlock")}
                        </Button>
                      )}
                    </div>
                  ) : (
                    <Field label={costSource === "recipe" ? t("menu.cost.manualLabel") : t("menu.col.cost")} error={errors.cost} hint={costSource === "recipe" ? t("menu.cost.manualHint") : undefined}>
                      {({ id: fid }) => <CurrencyInput id={fid} value={form.cost} onChange={(v) => set("cost", v)} min={0} disabled={readOnly} />}
                    </Field>
                  )}
                  {costSource === "recipe" && costUnlocked && !readOnly && (
                    <Button variant="ghost" size="sm" className="mt-2" onClick={() => { setCostUnlocked(false); set("cost", base?.cost ?? 0); }}>
                      <Lock className="h-4 w-4" /> {t("menu.cost.relock")}
                    </Button>
                  )}
                </div>
              </div>

              {/* Component breakdown */}
              <div className="mt-4">
                <div className="mb-2 text-xs font-bold text-slate-500">{t("menu.cost.breakdown")}</div>
                {costSource === "recipe" && bomQ.data && bomQ.data.lines.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-sm">
                      <tbody className="divide-y divide-slate-100">
                        {bomQ.data.lines.map((l) => (
                          <tr key={l.id}>
                            <td className="py-2 font-medium text-slate-700">{l.itemName}</td>
                            <td className="py-2 text-end tabular-nums text-slate-500" dir="ltr">{l.quantity} {l.unit}</td>
                            <td className="py-2 text-end"><MoneyI18n value={l.lineCost} className="font-bold text-slate-700" /></td>
                          </tr>
                        ))}
                        <tr className="bg-slate-50 font-extrabold">
                          <td className="py-2 text-slate-500">{t("menu.cost.totalComponents")}</td>
                          <td />
                          <td className="py-2 text-end"><MoneyI18n value={bomQ.data.totalCost} className="text-teal-700" /></td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="rounded-xl border border-dashed border-slate-200 px-4 py-4 text-center text-xs font-medium text-slate-400">{t("menu.cost.noBreakdown")}</p>
                )}
              </div>
            </Section>
          </Can>
        </div>

        {/* Right / side column */}
        <div className="space-y-6">
          <Section icon={Tags} title={t("menu.page.secStatus")}>
            <Toggle checked={form.active} onChange={(v) => set("active", v)} label={t("menu.page.active")} disabled={readOnly} />
          </Section>

          <Section icon={Tags} title={t("menu.page.secPreview")} subtitle={t("menu.preview.body")}>
            <div className="flex flex-wrap gap-4">
              <div>
                <div className="mb-1.5 text-[11px] font-bold text-slate-400">{t("menu.preview.arCard")}</div>
                <PosPreviewCard lang="ar" name={form.name} price={form.price} imgSrc={pendingImgSrc} id={id ?? ""} imageVer={derivedRow?.imageVer ?? null} hasImage={!!derivedRow?.hasImage} />
              </div>
              <div>
                <div className="mb-1.5 text-[11px] font-bold text-slate-400">{t("menu.preview.enCard")}</div>
                <PosPreviewCard lang="en" name={form.nameEn.trim() || form.name} price={form.price} imgSrc={pendingImgSrc} id={id ?? ""} imageVer={derivedRow?.imageVer ?? null} hasImage={!!derivedRow?.hasImage} />
              </div>
            </div>
          </Section>

          <Section icon={ChefHat} title={t("menu.recipe.title")} subtitle={t("menu.recipe.body")}>
            <div className="flex items-center justify-between gap-2">
              <StatusBadge tone={base?.bomId ? "success" : "neutral"}>{base?.bomId ? t("menu.recipe.has") : t("menu.recipe.none")}</StatusBadge>
              {mode !== "new" && (
                <Button variant="secondary" size="sm" onClick={() => navigate(`/menu/recipes-bom?item=${encodeURIComponent(id!)}${scopeBrandId ? `&brandId=${encodeURIComponent(scopeBrandId)}` : ""}`)}>
                  {t("menu.recipe.open")}
                </Button>
              )}
            </div>
          </Section>

          <Section icon={Layers} title={t("menu.page.secLinks")}>
            <div className="grid gap-2">
              <Button variant="secondary" size="sm" onClick={() => navigate(`/menu/combos${brandQuery}`)}>
                <Layers className="h-4 w-4" /> {t("menu.combos.open")}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => navigate(`/menu/price-lists${brandQuery}`)}>
                <Tags className="h-4 w-4" /> {t("menu.priceLists.open")}
              </Button>
            </div>
          </Section>

          <Section icon={Tags} title={t("menu.page.secBranches")} subtitle={t("menu.branches.body")}>
            <div className="grid grid-cols-2 gap-3">
              <Metric label={t("menu.branches.count")}><span dir="ltr" className="tabular-nums">{derivedRow?.branchCount ?? 0}</span></Metric>
              <Metric label={t("menu.channels.count")}><span dir="ltr" className="tabular-nums">{derivedRow?.channelCount ?? 0}</span></Metric>
            </div>
          </Section>
        </div>
      </div>

      {!readOnly && (
        <FormActions sticky>
          <Button variant="secondary" onClick={() => navigate(`/menu/brand${brandQuery}`)} disabled={pending}>{t("common.cancel")}</Button>
          <Can cap="menu.catalog.manage">
            <Button onClick={submit} loading={pending}>{mode === "new" ? t("menu.page.create") : t("menu.page.save")}</Button>
          </Can>
        </FormActions>
      )}

      {priceOpen && base && <PriceEditDialog item={toPriceTarget(base)} onClose={() => setPriceOpen(false)} />}
      {historyOpen && base && <PriceHistoryDrawer item={toPriceTarget(base)} onClose={() => setHistoryOpen(false)} />}
    </div>
  );
}

function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="inline-flex items-center gap-1.5 text-sm font-bold text-teal-700 hover:underline">
      <ArrowRight className="h-4 w-4" /> {label}
    </Link>
  );
}

function Metric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
      <div className="text-[10px] font-extrabold uppercase text-slate-400">{label}</div>
      <div className="mt-0.5 text-sm font-bold text-slate-800">{children}</div>
    </div>
  );
}
