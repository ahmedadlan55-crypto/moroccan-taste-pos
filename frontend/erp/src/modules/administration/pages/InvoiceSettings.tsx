import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Image as ImageIcon, Layers, ListChecks, MapPin, Printer, Receipt, ReceiptText, Save } from "lucide-react";
import { apiClient } from "@/shared/api";
import { Button, EmptyState, ErrorState, Input, LoadingState, PageHeader, PanelTitle, StatusBadge, Toggle } from "@/shared/ui";
import { Field } from "@/shared/forms";
import { useT, type TFunction } from "@/i18n";
import { a4Defaults, buildSaleReceiptHtml, type A4Options, type DocumentLanguage, type PaperWidth } from "../../../../../shared/invoiceTemplate";

// /administration/invoice-settings — every value the printed invoice carries,
// with WHERE it comes from.
//
// Two things this screen exists to make honest:
//  · Provenance. Identity resolves branch → brand → company → global settings
//    (lib/invoiceIdentity). Before, the receipt read ONLY the flat global
//    settings table while companies/brands/branches sat unused — so a wrong value
//    was undiagnosable. Each row here names its source and says whether it is
//    editable here or derived from another record.
//  · History. Editing anything here affects NEW invoices only. Issued invoices
//    pin their seller block at checkout (sales.receipt_identity_id), so a logo or
//    tax-number change can never rewrite a document already given to a customer.

interface Identity {
  sellerName: string; legalName: string; taxNumber: string; crNumber: string;
  address: string; nationalAddress: string; phone: string; email: string;
  logo: string; currency: string; vatRate: number; salesTaxName: string;
  header: string; footer: string; thankYou: string; returnPolicy: string;
  language: string; branchName: string; branchNameEn?: string; branchCompanyName: string; brandName: string;
}
interface ReceiptSettings { paperWidth: string; autoPrint: string }
type A4Draft = Required<A4Options>;
interface IdentityResponse {
  success: boolean;
  identity: Identity;
  sources: Record<string, string>;
  globalIdentity?: Identity;
  globalSources?: Record<string, string>;
  branches: Array<{ id: string; name: string }>;
  brands: Array<{ id: string; name: string }>;
  showFields: Record<string, boolean>;
  showFieldsRaw?: string | null;
  receiptSettings?: ReceiptSettings;
  a4Options?: Partial<A4Options> | null;
}

/** Fields the owner edits HERE (settings), vs fields derived from another record.
 *  `key` doubles as the i18n leaf under administration.invoice.field.*. */
const EDITABLE: Array<{ key: keyof Identity; settingKey: string; hintKey?: string; multiline?: boolean }> = [
  { key: "sellerName", settingKey: "name" },
  { key: "taxNumber", settingKey: "taxNumber", hintKey: "administration.invoice.field.taxNumberHint" },
  { key: "crNumber", settingKey: "CrNumber" },
  { key: "nationalAddress", settingKey: "NationalAddress" },
  { key: "phone", settingKey: "companyPhone" },
  { key: "email", settingKey: "companyEmail" },
  { key: "currency", settingKey: "currency" },
  { key: "salesTaxName", settingKey: "SalesTaxName" },
  { key: "header", settingKey: "ReceiptHeader", multiline: true },
  { key: "footer", settingKey: "receiptFooter", multiline: true },
  { key: "thankYou", settingKey: "ReceiptThankYou" },
  { key: "returnPolicy", settingKey: "ReceiptReturnPolicy", multiline: true },
];

/** Resolved elsewhere — shown read-only with the record that owns them.
 *  labelKey → administration.invoice.derived.*; ownerKey → administration.invoice.owner.* */
const DERIVED: Array<{ key: keyof Identity; labelKey: string; ownerKey: string }> = [
  { key: "legalName", labelKey: "legalName", ownerKey: "companiesBrands" },
  { key: "brandName", labelKey: "brandName", ownerKey: "companiesBrands" },
  { key: "branchName", labelKey: "branchName", ownerKey: "branches" },
  { key: "address", labelKey: "branchAddress", ownerKey: "branches" },
  { key: "branchCompanyName", labelKey: "branchCompany", ownerKey: "branches" },
  { key: "vatRate", labelKey: "vatRate", ownerKey: "taxes" },
];

/** The 9 optional receipt blocks (settings.ReceiptShowFields, all-true defaults).
 *  `key` doubles as the i18n leaf under administration.invoice.showField.*. */
const SHOW_FIELD_DEFS: Array<{ key: string }> = [
  { key: "logo" },
  { key: "taxNumber" },
  { key: "crNumber" },
  { key: "nationalAddress" },
  { key: "phone" },
  { key: "email" },
  { key: "cashier" },
  { key: "customer" },
  { key: "qr" },
];

/** `value` doubles as the i18n leaf under administration.invoice.paper.*. */
const PAPER_WIDTHS: Array<{ value: string }> = [{ value: "58" }, { value: "80" }, { value: "A4" }];

const LOGO_MAX_DIMENSION = 256;
const LOGO_MAX_BYTES = 100 * 1024;

// A deliberately non-scannable marker for the live preview. A null QR made the
// "show QR" switch appear broken even though real, synced sales print the
// server-stamped ZATCA PNG. Keeping the marker inline also makes the preview
// deterministic and network-independent.
const PREVIEW_QR_DATA_URL = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120"><rect width="120" height="120" fill="white"/><g fill="currentColor"><rect x="8" y="8" width="34" height="34"/><rect x="78" y="8" width="34" height="34"/><rect x="8" y="78" width="34" height="34"/><rect x="51" y="51" width="12" height="12"/><rect x="70" y="55" width="10" height="10"/><rect x="52" y="73" width="15" height="15"/><rect x="82" y="78" width="9" height="9"/><rect x="97" y="94" width="15" height="15"/></g><g fill="white"><rect x="16" y="16" width="18" height="18"/><rect x="86" y="16" width="18" height="18"/><rect x="16" y="86" width="18" height="18"/></g></svg>',
)}`;

/** file → downscaled (≤256px) PNG/JPEG data-URL, rejected when >100KB after compression. */
async function compressLogo(file: File, t: TFunction): Promise<string> {
  if (!/^image\/(png|jpeg)$/.test(file.type)) {
    throw new Error(t("administration.invoice.logo.unsupported"));
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error(t("administration.invoice.logo.readFailed")));
      el.src = url;
    });
    const scale = Math.min(1, LOGO_MAX_DIMENSION / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
    canvas.height = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error(t("administration.invoice.logo.canvasUnsupported"));
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const bytesOf = (dataUrl: string) => Math.ceil(((dataUrl.length - dataUrl.indexOf(",") - 1) * 3) / 4);
    // PNG first (keeps transparency); JPEG as the smaller fallback.
    let out = canvas.toDataURL("image/png");
    if (bytesOf(out) > LOGO_MAX_BYTES) out = canvas.toDataURL("image/jpeg", 0.85);
    if (bytesOf(out) > LOGO_MAX_BYTES) {
      throw new Error(t("administration.invoice.logo.tooLarge"));
    }
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Resolve source prefix → scope code (administration.invoice.scope.*). */
function scopeCode(source: string | undefined): "default" | "branch" | "brand" | "company" | "global" {
  if (!source) return "default";
  if (source.startsWith("branches.")) return "branch";
  if (source.startsWith("brands.")) return "brand";
  if (source.startsWith("companies.")) return "company";
  if (source.startsWith("settings.")) return "global";
  return "default";
}

export function InvoiceSettingsPage() {
  const t = useT();
  const scopeText = (source: string | undefined) => t(`administration.invoice.scope.${scopeCode(source)}`);
  const qc = useQueryClient();
  const [branchId, setBranchId] = useState("");
  const [brandId, setBrandId] = useState("");
  const [draft, setDraft] = useState<Record<string, string>>({});
  // Scoped overrides (branches/brands columns) — a separate draft with a
  // separate save path: they are NOT global settings.
  const [scopeDraft, setScopeDraft] = useState<Record<string, string>>({});
  const [logoError, setLogoError] = useState("");

  // Switching scope drops any unsaved scoped edits — they belonged to the
  // previous branch/brand.
  useEffect(() => { setScopeDraft({}); }, [branchId, brandId]);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["erp", "invoice-identity", branchId, brandId],
    queryFn: ({ signal }) =>
      apiClient.get<IdentityResponse>("/settings/invoice-identity", {
        params: { branchId: branchId || undefined, brandId: brandId || undefined },
        signal,
      }),
  });

  const identity = data?.identity;
  const globalIdentity = data?.globalIdentity ?? identity;
  const sources = data?.sources ?? {};

  const save = useMutation({
    mutationFn: (payload: Record<string, string>) => apiClient.put<{ success: boolean; error?: string }>("/settings", payload),
    onSuccess: () => {
      setDraft({});
      qc.invalidateQueries({ queryKey: ["erp", "invoice-identity"] });
    },
  });

  const scopeSave = useMutation({
    mutationFn: (payload: { branchId?: string; brandId?: string; fields: Record<string, string> }) =>
      apiClient.put<{ success: boolean; error?: string }>("/settings/invoice-identity-scope", payload),
    onSuccess: () => {
      setScopeDraft({});
      qc.invalidateQueries({ queryKey: ["erp", "invoice-identity"] });
    },
  });

  const valueOf = (f: { key: keyof Identity; settingKey: string }) =>
    draft[f.settingKey] ?? String(globalIdentity?.[f.key] ?? "");

  const dirty = Object.keys(draft).length > 0;
  const scopeDirty = Object.keys(scopeDraft).length > 0;

  // ── current (draft-aware) values for the new controls ──
  const showFields: Record<string, boolean> = useMemo(() => {
    const base = data?.showFields ?? Object.fromEntries(SHOW_FIELD_DEFS.map((f) => [f.key, true]));
    if (draft.ReceiptShowFields !== undefined) {
      try { return { ...base, ...(JSON.parse(draft.ReceiptShowFields) as Record<string, boolean>) }; } catch { return base; }
    }
    return base;
  }, [data?.showFields, draft.ReceiptShowFields]);

  const toggleShowField = (key: string, next: boolean) =>
    setDraft((d) => ({ ...d, ReceiptShowFields: JSON.stringify({ ...showFields, [key]: next }) }));

  const paperWidth = draft.ReceiptPaperWidth ?? data?.receiptSettings?.paperWidth ?? "80";
  // The A4 design choices: a JSON setting, drafted as one unit.
  const a4: A4Draft = useMemo(() => {
    const base: A4Draft = { ...a4Defaults(), ...(data?.a4Options ?? {}) } as A4Draft;
    if (draft.InvoiceA4Options !== undefined) {
      try { return { ...base, ...(JSON.parse(draft.InvoiceA4Options) as Partial<A4Options>) } as A4Draft; } catch { return base; }
    }
    return base;
  }, [data?.a4Options, draft.InvoiceA4Options]);
  const patchA4 = (p: Partial<A4Options>) => setDraft((d) => ({ ...d, InvoiceA4Options: JSON.stringify({ ...a4, ...p }) }));
  const selectedPaperWidth: PaperWidth = paperWidth === "58" || paperWidth === "A4" ? paperWidth : "80";
  const autoPrint = (draft.ReceiptAutoPrint ?? data?.receiptSettings?.autoPrint ?? "1") === "1";
  const language = draft.ReceiptLanguage ?? (identity?.language || "ar");
  const logoValue = draft.logo ?? (globalIdentity?.logo || "");

  const onLogoFile = async (file: File | undefined, target: "global" | "brand") => {
    if (!file) return;
    setLogoError("");
    try {
      const dataUrl = await compressLogo(file, t);
      if (target === "global") setDraft((d) => ({ ...d, logo: dataUrl }));
      else setScopeDraft((d) => ({ ...d, logo: dataUrl }));
    } catch (e) {
      setLogoError(e instanceof Error ? e.message : t("administration.invoice.logo.processFailed"));
    }
  };

  const preview = useMemo(() => {
    if (!identity) return null;
    // identity.language is a free-form string on the wire (an old / unrecognized
    // ReceiptLanguage setting value); narrow it the same defensive way
    // invoiceTemplate.ts's own normalizeLanguage() does, so DocumentIdentity's
    // typed `language?: DocumentLanguage` is honored without changing behavior.
    const languageRaw = draft.ReceiptLanguage ?? identity.language;
    const language: DocumentLanguage =
      languageRaw === "en" || languageRaw === "both" ? languageRaw : "ar";
    // A draft global value changes this scope only when the effective value is
    // currently global/default. Company/brand/branch values keep precedence,
    // exactly as they will after saving and reloading. Scoped drafts, on the
    // other hand, are the strongest layer and therefore always win here.
    const globalDraft = (identityKey: keyof Identity, settingKey: string, current: string): string => {
      const source = sources[String(identityKey)] ?? "";
      const canAffectScope = !source || source.startsWith("settings.");
      return canAffectScope && draft[settingKey] !== undefined ? draft[settingKey] : current;
    };
    return {
      ...identity,
      language,
      sellerName: globalDraft("sellerName", "name", identity.sellerName),
      taxNumber: globalDraft("taxNumber", "taxNumber", identity.taxNumber),
      crNumber: globalDraft("crNumber", "CrNumber", identity.crNumber),
      nationalAddress: globalDraft("nationalAddress", "NationalAddress", identity.nationalAddress),
      phone: globalDraft("phone", "companyPhone", identity.phone),
      email: globalDraft("email", "companyEmail", identity.email),
      currency: globalDraft("currency", "currency", identity.currency),
      salesTaxName: globalDraft("salesTaxName", "SalesTaxName", identity.salesTaxName),
      header: globalDraft("header", "ReceiptHeader", identity.header),
      footer: globalDraft("footer", "receiptFooter", identity.footer),
      thankYou: globalDraft("thankYou", "ReceiptThankYou", identity.thankYou),
      returnPolicy: globalDraft("returnPolicy", "ReceiptReturnPolicy", identity.returnPolicy),
      logo: scopeDraft.logo ?? globalDraft("logo", "logo", identity.logo),
      address: scopeDraft.address ?? identity.address,
      branchCompanyName: scopeDraft.branchCompanyName ?? identity.branchCompanyName,
      brandName: scopeDraft.brandName ?? identity.brandName,
    };
  }, [identity, sources, draft, scopeDraft]);

  /** Real preview: builds the EXACT HTML the cashier's print window renders
   *  (buildSaleReceiptHtml, the same function receipt.ts wraps), fed a sample
   *  invoice + the draft identity/showFields — not a mock card. */
  const previewHtml = (paperWidth: PaperWidth): string => {
    if (!preview) return "";
    const vatRate = Number.isFinite(Number(preview.vatRate)) ? Math.max(0, Number(preview.vatRate)) : 15;
    const sampleGross = 33;
    const sampleVat = vatRate > 0 ? sampleGross * vatRate / (100 + vatRate) : 0;
    return buildSaleReceiptHtml({
      lines: [
        { name: t("administration.invoice.preview.line1"), qty: 2, unitPrice: 12, lineDiscount: 0 },
        { name: t("administration.invoice.preview.line2"), qty: 1, unitPrice: 9, lineDiscount: 0 },
      ],
      payments: [{ method: "cash", amount: sampleGross }],
      totals: { subtotal: sampleGross, lineDiscountTotal: 0, discountAmount: 0, vatTotal: sampleVat, total: sampleGross },
      invoiceNumber: "INV-PREVIEW-0001",
      fallbackSellerName: preview.sellerName || t("administration.invoice.preview.sellerFallback"),
      cashierName: t("administration.invoice.preview.cashier"),
      vatRate,
      paperWidth,
      identity: preview,
      showFields: {
        logo: showFields.logo !== false,
        taxNumber: showFields.taxNumber !== false,
        crNumber: showFields.crNumber !== false,
        nationalAddress: showFields.nationalAddress !== false,
        phone: showFields.phone !== false,
        email: showFields.email !== false,
        cashier: showFields.cashier !== false,
        customer: showFields.customer !== false,
        qr: showFields.qr !== false,
      },
      zatcaQrDataUrl: PREVIEW_QR_DATA_URL,
      // A4 preview shows a registered buyer, so the owner sees the parties
      // block exactly as a B2B customer will.
      buyer: paperWidth === "A4"
        ? { name: t("administration.invoice.preview.buyerName"), vatNumber: "300000000000003", address: t("administration.invoice.preview.buyerAddress") }
        : null,
      dueDate: paperWidth === "A4" ? new Date(Date.now() + 30 * 86400000).toISOString() : null,
      a4,
    });
  };

  if (isLoading) return <LoadingState />;
  if (isError) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (!identity) return <EmptyState title={t("administration.invoice.empty.title")} body={t("administration.invoice.empty.body")} />;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={t("administration.eyebrow")}
        title={t("administration.invoice.title")}
        subtitle={t("administration.invoice.subtitle")}
        action={
          <Button
            variant="primary"
            disabled={!dirty}
            loading={save.isPending}
            onClick={() => save.mutate(draft)}
          >
            <Save className="h-4 w-4" /> {t("common.save")}
          </Button>
        }
      />

      <div className="rounded-xl border border-teal-200 bg-teal-50 px-4 py-3 text-xs font-bold text-teal-900">
        {t("administration.invoice.issuedNote")}
      </div>

      <section className="surface">
        <PanelTitle icon={Layers} title={t("administration.invoice.scope.panelTitle")} subtitle={t("administration.invoice.scope.panelSubtitle")} />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label={t("administration.invoice.scope.branchLabel")}>
            {({ id }) => (
              <select id={id} className="field" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                <option value="">{t("administration.invoice.scope.branchGlobal")}</option>
                {(data?.branches ?? []).map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t("administration.invoice.scope.brandLabel")}>
            {({ id }) => (
              <select id={id} className="field" value={brandId} onChange={(e) => setBrandId(e.target.value)}>
                <option value="">{t("administration.invoice.scope.brandGlobal")}</option>
                {(data?.brands ?? []).map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            )}
          </Field>
        </div>
      </section>

      {(branchId || brandId) && (
        <section className="surface">
          <PanelTitle
            icon={MapPin}
            title={t("administration.invoice.custom.panelTitle")}
            subtitle={t("administration.invoice.custom.panelSubtitle")}
          />
          <div className="grid gap-4 p-5 md:grid-cols-2">
            {branchId && (
              <>
                <Field label={t("administration.invoice.custom.branchAddress")} hint={t("administration.invoice.custom.branchAddressHint")}>
                  {({ id }) => (
                    <Input
                      id={id}
                      value={scopeDraft.address ?? identity.address}
                      onChange={(e) => setScopeDraft((d) => ({ ...d, address: e.target.value }))}
                    />
                  )}
                </Field>
                <Field label={t("administration.invoice.custom.branchCompany")} hint={t("administration.invoice.custom.branchCompanyHint")}>
                  {({ id }) => (
                    <Input
                      id={id}
                      value={scopeDraft.branchCompanyName ?? identity.branchCompanyName}
                      onChange={(e) => setScopeDraft((d) => ({ ...d, branchCompanyName: e.target.value }))}
                    />
                  )}
                </Field>
              </>
            )}
            {brandId && (
              <>
                <Field label={t("administration.invoice.custom.brandName")} hint={t("administration.invoice.custom.brandNameHint")}>
                  {({ id }) => (
                    <Input
                      id={id}
                      value={scopeDraft.brandName ?? identity.brandName}
                      onChange={(e) => setScopeDraft((d) => ({ ...d, brandName: e.target.value }))}
                    />
                  )}
                </Field>
                <Field label={t("administration.invoice.custom.brandLogo")} hint={t("administration.invoice.custom.brandLogoHint")}>
                  <div className="flex items-center gap-3">
                    {(scopeDraft.logo ?? "") !== "" ? (
                      <img src={scopeDraft.logo} alt={t("administration.invoice.custom.brandLogoUnsavedAlt")} className="h-12 w-12 rounded border border-slate-200 object-contain" />
                    ) : sources.logo === "brands.logo" && identity.logo ? (
                      <img src={identity.logo} alt={t("administration.invoice.custom.brandLogoAlt")} className="h-12 w-12 rounded border border-slate-200 object-contain" />
                    ) : (
                      <div className="grid h-12 w-12 place-items-center rounded bg-slate-100 text-[9px] font-bold text-slate-400">{t("administration.invoice.custom.noLogo")}</div>
                    )}
                    <input
                      type="file"
                      accept="image/png,image/jpeg"
                      aria-label={t("administration.invoice.custom.uploadBrandLogo")}
                      className="text-xs"
                      onChange={(e) => void onLogoFile(e.target.files?.[0], "brand")}
                    />
                    <Button variant="ghost" onClick={() => setScopeDraft((d) => ({ ...d, logo: "" }))}>
                      {t("administration.invoice.logo.remove")}
                    </Button>
                  </div>
                </Field>
              </>
            )}
          </div>
          <div className="flex items-center gap-3 px-5 pb-5">
            <Button
              variant="primary"
              disabled={!scopeDirty}
              loading={scopeSave.isPending}
              onClick={() =>
                scopeSave.mutate({
                  branchId: branchId || undefined,
                  brandId: brandId || undefined,
                  fields: scopeDraft,
                })
              }
            >
              <Save className="h-4 w-4" /> {t("administration.invoice.custom.saveScopeBtn")}
            </Button>
            {scopeSave.isError && (
              <span className="text-xs font-bold text-rose-700">{t("administration.invoice.custom.scopeSaveFailed")}</span>
            )}
          </div>
        </section>
      )}

      <section className="surface">
        <PanelTitle icon={Building2} title={t("administration.invoice.editable.panelTitle")} subtitle={t("administration.invoice.editable.panelSubtitle")} />
        <div className="grid gap-4 p-5 md:grid-cols-2">
          {EDITABLE.map((f) => (
            <Field
              key={f.settingKey}
              label={t(`administration.invoice.field.${f.key}`)}
              hint={
                f.hintKey
                  ? t("administration.invoice.editable.hintWithNote", { source: sources[f.key] ?? "—", scope: scopeText(sources[f.key]), note: t(f.hintKey) })
                  : t("administration.invoice.editable.hint", { source: sources[f.key] ?? "—", scope: scopeText(sources[f.key]) })
              }
            >
              {({ id }) =>
                f.multiline ? (
                  <textarea
                    id={id}
                    className="field min-h-[72px]"
                    value={valueOf(f)}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.settingKey]: e.target.value }))}
                  />
                ) : (
                  <Input
                    id={id}
                    value={valueOf(f)}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.settingKey]: e.target.value }))}
                  />
                )
              }
            </Field>
          ))}
        </div>
      </section>

      <section className="surface">
        <PanelTitle
          icon={ImageIcon}
          title={t("administration.invoice.logo.panelTitle")}
          subtitle={t("administration.invoice.logo.panelSubtitle")}
        />
        <div className="flex flex-wrap items-center gap-4 p-5">
          {logoValue ? (
            <img src={logoValue} alt={t("administration.invoice.logo.currentAlt")} className="h-16 max-w-[140px] rounded border border-slate-200 object-contain" />
          ) : (
            <div className="grid h-16 w-[140px] place-items-center rounded bg-slate-100 text-[10px] font-bold text-slate-400">{t("administration.invoice.logo.none")}</div>
          )}
          <input
            type="file"
            accept="image/png,image/jpeg"
            aria-label={t("administration.invoice.logo.upload")}
            className="text-xs"
            onChange={(e) => void onLogoFile(e.target.files?.[0], "global")}
          />
          <Button variant="ghost" disabled={!logoValue} onClick={() => setDraft((d) => ({ ...d, logo: "" }))}>
            {t("administration.invoice.logo.remove")}
          </Button>
          <span className="text-[11px] font-medium text-slate-400">
            {t("administration.invoice.logo.meta", { source: sources.logo ?? "—", scope: scopeText(sources.logo) })}
          </span>
          {logoError && <span className="w-full text-xs font-bold text-rose-700">{logoError}</span>}
        </div>
      </section>

      <section className="surface">
        <PanelTitle
          icon={ListChecks}
          title={t("administration.invoice.showFieldsPanel.title")}
          subtitle={t("administration.invoice.showFieldsPanel.subtitle")}
        />
        <div className="grid gap-3 p-5 sm:grid-cols-2 md:grid-cols-3">
          {SHOW_FIELD_DEFS.map((f) => {
            const label = t(`administration.invoice.showField.${f.key}`);
            return (
              <Toggle
                key={f.key}
                checked={showFields[f.key] !== false}
                onChange={(next) => toggleShowField(f.key, next)}
                label={label}
                aria-label={label}
              />
            );
          })}
        </div>
      </section>

      <section className="surface">
        <PanelTitle icon={Printer} title={t("administration.invoice.print.panelTitle")} subtitle={t("administration.invoice.print.panelSubtitle")} />
        <div className="grid gap-5 p-5 md:grid-cols-3">
          <Field label={t("administration.invoice.print.paperWidth")} hint={t("administration.invoice.print.paperWidthHint")}>
            <div className="flex flex-col gap-2" role="radiogroup" aria-label={t("administration.invoice.print.paperWidth")}>
              {PAPER_WIDTHS.map((w) => (
                <label key={w.value} className="inline-flex cursor-pointer items-center gap-2 text-sm font-semibold text-slate-700">
                  <input
                    type="radio"
                    name="receipt-paper-width"
                    value={w.value}
                    checked={paperWidth === w.value}
                    onChange={() => setDraft((d) => ({ ...d, ReceiptPaperWidth: w.value }))}
                    className="h-4 w-4 accent-teal-600"
                  />
                  {t(`administration.invoice.paper.${w.value}`)}
                </label>
              ))}
            </div>
          </Field>
          <Field label={t("administration.invoice.print.autoPrint")} hint={t("administration.invoice.print.autoPrintHint")}>
            <Toggle
              checked={autoPrint}
              onChange={(next) => setDraft((d) => ({ ...d, ReceiptAutoPrint: next ? "1" : "0" }))}
              label={autoPrint ? t("administration.invoice.print.autoPrintOn") : t("administration.invoice.print.autoPrintOff")}
              aria-label={t("administration.invoice.print.autoPrint")}
            />
          </Field>
          <Field
            label={t("administration.invoice.print.language")}
            hint={t("administration.invoice.print.languageHint")}
          >
            {({ id }) => (
              <select
                id={id}
                className="field"
                value={language}
                onChange={(e) => setDraft((d) => ({ ...d, ReceiptLanguage: e.target.value }))}
              >
                <option value="ar">{t("administration.invoice.lang.ar")}</option>
                <option value="en">{t("administration.invoice.lang.en")}</option>
                <option value="both">{t("administration.invoice.lang.both")}</option>
              </select>
            )}
          </Field>
        </div>
      </section>

      {/* A4 tax-invoice design. The receipt toggles above govern the thermal
          receipt; these govern the B2B document — parties, terms, bank,
          signatures. Saved as ONE JSON setting (InvoiceA4Options); a print
          preference, not seller identity, so it never enters an invoice
          snapshot. */}
      <section className="surface">
        <PanelTitle icon={ReceiptText} title={t("administration.invoice.a4.panelTitle")} subtitle={t("administration.invoice.a4.panelSubtitle")} />
        <div className="grid gap-5 p-5 md:grid-cols-2">
          <div className="grid gap-3">
            <Toggle checked={a4.showBuyer} onChange={(next) => patchA4({ showBuyer: next })} label={t("administration.invoice.a4.showBuyer")} aria-label={t("administration.invoice.a4.showBuyer")} />
            <Toggle checked={a4.showSignature} onChange={(next) => patchA4({ showSignature: next })} label={t("administration.invoice.a4.showSignature")} aria-label={t("administration.invoice.a4.showSignature")} />
            <Toggle checked={a4.showBank} onChange={(next) => patchA4({ showBank: next })} label={t("administration.invoice.a4.showBank")} aria-label={t("administration.invoice.a4.showBank")} />
            <p className="text-[11px] font-bold text-slate-400">{t("administration.invoice.a4.hint")}</p>
          </div>
          <div className="grid gap-3">
            <Field label={t("administration.invoice.a4.bankDetails")} hint={t("administration.invoice.a4.bankDetailsHint")}>
              {({ id }) => <textarea id={id} className="field min-h-24" value={a4.bankDetails} onChange={(e) => patchA4({ bankDetails: e.target.value.slice(0, 600) })} disabled={!a4.showBank} />}
            </Field>
            <Field label={t("administration.invoice.a4.terms")} hint={t("administration.invoice.a4.termsHint")}>
              {({ id }) => <textarea id={id} className="field min-h-24" value={a4.terms} onChange={(e) => patchA4({ terms: e.target.value.slice(0, 600) })} />}
            </Field>
          </div>
        </div>
      </section>

      <section className="surface">
        <PanelTitle icon={Receipt} title={t("administration.invoice.derivedPanel.title")} subtitle={t("administration.invoice.derivedPanel.subtitle")} />
        <div className="overflow-x-auto p-5">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-start text-xs font-bold text-slate-500">
                <th className="px-3 py-2">{t("administration.invoice.derivedPanel.thField")}</th>
                <th className="px-3 py-2">{t("administration.invoice.derivedPanel.thValue")}</th>
                <th className="px-3 py-2">{t("administration.invoice.derivedPanel.thSource")}</th>
                <th className="px-3 py-2">{t("administration.invoice.derivedPanel.thScope")}</th>
                <th className="px-3 py-2">{t("administration.invoice.derivedPanel.thOwner")}</th>
              </tr>
            </thead>
            <tbody>
              {DERIVED.map((f) => (
                <tr key={String(f.key)} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-bold text-slate-700">{t(`administration.invoice.derived.${f.labelKey}`)}</td>
                  <td className="px-3 py-2 text-slate-600">{String(identity[f.key] ?? "") || "—"}</td>
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-400">{sources[f.key] ?? "—"}</td>
                  <td className="px-3 py-2"><StatusBadge>{scopeText(sources[f.key])}</StatusBadge></td>
                  <td className="px-3 py-2 text-slate-500">{t(`administration.invoice.owner.${f.ownerKey}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="surface">
        <PanelTitle
          icon={ReceiptText}
          title={t("administration.invoice.previewPanel.title")}
          subtitle={t("administration.invoice.previewPanel.subtitle")}
        />
        <div className="p-5">
          <div
            data-testid="invoice-live-preview"
            className={`mx-auto flex w-full flex-col items-center gap-3 ${selectedPaperWidth === "A4" ? "max-w-5xl" : selectedPaperWidth === "80" ? "max-w-[430px]" : "max-w-[330px]"}`}
          >
              <StatusBadge>{selectedPaperWidth === "A4" ? "A4" : `${selectedPaperWidth}mm`}</StatusBadge>
              <iframe
                title={t("administration.invoice.previewPanel.iframeTitle", { width: selectedPaperWidth })}
                srcDoc={previewHtml(selectedPaperWidth)}
                className={`w-full rounded-xl border-2 border-dashed border-slate-300 bg-white ${selectedPaperWidth === "A4" ? "h-[760px]" : "h-[620px]"}`}
                // Tier A.3 Release Gate item 10 — a bare `sandbox=""` gives a
                // srcDoc document a null/opaque origin, which throws a
                // SecurityError (caught by nothing, surfacing as a page
                // console error) the moment ANYTHING probes localStorage
                // from inside it — verified directly this isn't
                // buildSaleReceiptHtml's own output (it emits zero <script>
                // tags by design, confirmed in frontend/shared/invoiceTemplate.ts's
                // own header comment) but something else (devtools/browser
                // instrumentation) touching every frame on the page,
                // including this one. `allow-same-origin` alone — deliberately
                // WITHOUT `allow-scripts` — fixes it: the security property
                // that actually matters here (this iframe can never execute
                // arbitrary script, since the receipt template has none and
                // none is added) is unaffected; only the null-origin
                // localStorage access is resolved. (`allow-scripts` +
                // `allow-same-origin` TOGETHER would be the real anti-pattern —
                // that combination is not used here.)
                sandbox="allow-same-origin"
              />
          </div>
        </div>
      </section>

      {save.isError && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
          {t("administration.invoice.saveFailed")}
        </div>
      )}
    </div>
  );
}

export default InvoiceSettingsPage;
