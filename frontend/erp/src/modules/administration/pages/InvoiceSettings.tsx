import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Image as ImageIcon, Layers, ListChecks, MapPin, Printer, Receipt, ReceiptText, Save } from "lucide-react";
import { apiClient } from "@/shared/api";
import { Button, EmptyState, ErrorState, Input, LoadingState, PageHeader, PanelTitle, StatusBadge, Toggle } from "@/shared/ui";
import { Field } from "@/shared/forms";

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
  language: string; branchName: string; branchCompanyName: string; brandName: string;
}
interface ReceiptSettings { paperWidth: string; autoPrint: string }
interface IdentityResponse {
  success: boolean;
  identity: Identity;
  sources: Record<string, string>;
  branches: Array<{ id: string; name: string }>;
  brands: Array<{ id: string; name: string }>;
  showFields: Record<string, boolean>;
  showFieldsRaw?: string | null;
  receiptSettings?: ReceiptSettings;
}

/** Fields the owner edits HERE (settings), vs fields derived from another record. */
const EDITABLE: Array<{ key: keyof Identity; settingKey: string; label: string; hint?: string; multiline?: boolean }> = [
  { key: "sellerName", settingKey: "name", label: "الاسم التجاري" },
  { key: "taxNumber", settingKey: "taxNumber", label: "الرقم الضريبي", hint: "يظهر على الفاتورة وداخل رمز ZATCA." },
  { key: "crNumber", settingKey: "CrNumber", label: "السجل التجاري" },
  { key: "nationalAddress", settingKey: "NationalAddress", label: "العنوان الوطني" },
  { key: "phone", settingKey: "companyPhone", label: "الهاتف" },
  { key: "email", settingKey: "companyEmail", label: "البريد الإلكتروني" },
  { key: "currency", settingKey: "currency", label: "العملة" },
  { key: "salesTaxName", settingKey: "SalesTaxName", label: "اسم الضريبة على الفاتورة" },
  { key: "header", settingKey: "ReceiptHeader", label: "رأس الفاتورة", multiline: true },
  { key: "footer", settingKey: "receiptFooter", label: "تذييل الفاتورة", multiline: true },
  { key: "thankYou", settingKey: "ReceiptThankYou", label: "رسالة الشكر" },
  { key: "returnPolicy", settingKey: "ReceiptReturnPolicy", label: "سياسة الاسترجاع", multiline: true },
];

/** Resolved elsewhere — shown read-only with the record that owns them. */
const DERIVED: Array<{ key: keyof Identity; label: string; owner: string }> = [
  { key: "legalName", label: "الاسم القانوني", owner: "الشركات والعلامات التجارية" },
  { key: "brandName", label: "العلامة التجارية", owner: "الشركات والعلامات التجارية" },
  { key: "branchName", label: "الفرع", owner: "الفروع" },
  { key: "address", label: "عنوان الفرع", owner: "الفروع" },
  { key: "branchCompanyName", label: "الشركة المشغّلة للفرع", owner: "الفروع" },
  { key: "vatRate", label: "نسبة الضريبة", owner: "الضرائب" },
];

/** The 9 optional receipt blocks (settings.ReceiptShowFields, all-true defaults). */
const SHOW_FIELD_DEFS: Array<{ key: string; label: string }> = [
  { key: "logo", label: "الشعار" },
  { key: "taxNumber", label: "الرقم الضريبي" },
  { key: "crNumber", label: "السجل التجاري" },
  { key: "nationalAddress", label: "العنوان الوطني" },
  { key: "phone", label: "الهاتف" },
  { key: "email", label: "البريد الإلكتروني" },
  { key: "cashier", label: "الكاشير" },
  { key: "customer", label: "العميل" },
  { key: "qr", label: "رمز QR" },
];

const PAPER_WIDTHS: Array<{ value: string; label: string }> = [
  { value: "58", label: "58مم (حراري ضيّق)" },
  { value: "80", label: "80مم (حراري قياسي)" },
  { value: "A4", label: "A4 (طابعة مكتبية)" },
];

const LOGO_MAX_DIMENSION = 256;
const LOGO_MAX_BYTES = 100 * 1024;

/** file → downscaled (≤256px) PNG/JPEG data-URL, rejected when >100KB after compression. */
async function compressLogo(file: File): Promise<string> {
  if (!/^image\/(png|jpeg)$/.test(file.type)) {
    throw new Error("صيغة غير مدعومة — PNG أو JPEG فقط.");
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("تعذّر قراءة الصورة."));
      el.src = url;
    });
    const scale = Math.min(1, LOGO_MAX_DIMENSION / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
    canvas.height = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("المتصفح لا يدعم معالجة الصور.");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const bytesOf = (dataUrl: string) => Math.ceil(((dataUrl.length - dataUrl.indexOf(",") - 1) * 3) / 4);
    // PNG first (keeps transparency); JPEG as the smaller fallback.
    let out = canvas.toDataURL("image/png");
    if (bytesOf(out) > LOGO_MAX_BYTES) out = canvas.toDataURL("image/jpeg", 0.85);
    if (bytesOf(out) > LOGO_MAX_BYTES) {
      throw new Error("الشعار أكبر من 100KB بعد الضغط — اختر صورة أبسط أو أصغر.");
    }
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function scopeLabel(source: string | undefined): string {
  if (!source) return "افتراضي";
  if (source.startsWith("branches.")) return "فرع";
  if (source.startsWith("brands.")) return "علامة تجارية";
  if (source.startsWith("companies.")) return "شركة";
  if (source.startsWith("settings.")) return "عام";
  return "افتراضي";
}

export function InvoiceSettingsPage() {
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
    draft[f.settingKey] ?? String(identity?.[f.key] ?? "");

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
  const autoPrint = (draft.ReceiptAutoPrint ?? data?.receiptSettings?.autoPrint ?? "1") === "1";
  const language = draft.ReceiptLanguage ?? (identity?.language || "ar");
  const logoValue = draft.logo ?? (identity?.logo || "");

  const onLogoFile = async (file: File | undefined, target: "global" | "brand") => {
    if (!file) return;
    setLogoError("");
    try {
      const dataUrl = await compressLogo(file);
      if (target === "global") setDraft((d) => ({ ...d, logo: dataUrl }));
      else setScopeDraft((d) => ({ ...d, logo: dataUrl }));
    } catch (e) {
      setLogoError(e instanceof Error ? e.message : "تعذّرت معالجة الصورة.");
    }
  };

  const preview = useMemo(() => {
    if (!identity) return null;
    return {
      ...identity,
      sellerName: draft.name ?? identity.sellerName,
      taxNumber: draft.taxNumber ?? identity.taxNumber,
      crNumber: draft.CrNumber ?? identity.crNumber,
      nationalAddress: draft.NationalAddress ?? identity.nationalAddress,
      header: draft.ReceiptHeader ?? identity.header,
      footer: draft.receiptFooter ?? identity.footer,
      thankYou: draft.ReceiptThankYou ?? identity.thankYou,
      returnPolicy: draft.ReceiptReturnPolicy ?? identity.returnPolicy,
    };
  }, [identity, draft]);

  if (isLoading) return <LoadingState />;
  if (isError) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (!identity) return <EmptyState title="لا توجد بيانات فاتورة" body="لم يتعذّر التحميل، لكن الخادم لم يُعِد هوية فاتورة." />;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="الإدارة"
        title="بيانات وتصميم الفاتورة"
        subtitle="كل قيمة تُطبع على الفاتورة ومصدرها. التعديل يسري على الفواتير الجديدة فقط."
        action={
          <Button
            variant="primary"
            disabled={!dirty}
            loading={save.isPending}
            onClick={() => save.mutate(draft)}
          >
            <Save className="h-4 w-4" /> حفظ
          </Button>
        }
      />

      <div className="rounded-xl border border-teal-200 bg-teal-50 px-4 py-3 text-xs font-bold text-teal-900">
        الفاتورة الصادرة تحتفظ ببياناتها وقت الإصدار ولا تتغيّر بعد ذلك — تغيير الشعار أو الرقم
        الضريبي هنا يؤثّر على الفواتير الجديدة فقط.
      </div>

      <section className="surface">
        <PanelTitle icon={Layers} title="النطاق" subtitle="اختر فرعًا أو علامة تجارية لمعاينة القيم التي تُطبع لهما. الأخص يفوز." />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label="الفرع">
            {({ id }) => (
              <select id={id} className="field" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                <option value="">— عام (بدون فرع) —</option>
                {(data?.branches ?? []).map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            )}
          </Field>
          <Field label="العلامة التجارية">
            {({ id }) => (
              <select id={id} className="field" value={brandId} onChange={(e) => setBrandId(e.target.value)}>
                <option value="">— عام (بدون علامة) —</option>
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
            title="تخصيص لهذا النطاق"
            subtitle="يُحفظ على سجل الفرع/العلامة نفسه (وليس في الإعدادات العامة) — الحقول ذات الأعمدة المخصّصة فقط. بقية الحقول عامة دائمًا."
          />
          <div className="grid gap-4 p-5 md:grid-cols-2">
            {branchId && (
              <>
                <Field label="عنوان الفرع" hint="يُحفظ في branches.location — يظهر لفواتير هذا الفرع فقط.">
                  {({ id }) => (
                    <Input
                      id={id}
                      value={scopeDraft.address ?? identity.address}
                      onChange={(e) => setScopeDraft((d) => ({ ...d, address: e.target.value }))}
                    />
                  )}
                </Field>
                <Field label="الشركة المشغّلة للفرع" hint="يُحفظ في branches.company_name.">
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
                <Field label="اسم العلامة التجارية" hint="يُحفظ في brands.name — يظهر على فواتير هذه العلامة.">
                  {({ id }) => (
                    <Input
                      id={id}
                      value={scopeDraft.brandName ?? identity.brandName}
                      onChange={(e) => setScopeDraft((d) => ({ ...d, brandName: e.target.value }))}
                    />
                  )}
                </Field>
                <Field label="شعار العلامة التجارية" hint="يُحفظ في brands.logo ويتقدّم على شعار الشركة والإعدادات العامة.">
                  <div className="flex items-center gap-3">
                    {(scopeDraft.logo ?? "") !== "" ? (
                      <img src={scopeDraft.logo} alt="شعار العلامة (غير محفوظ)" className="h-12 w-12 rounded border border-slate-200 object-contain" />
                    ) : sources.logo === "brands.logo" && identity.logo ? (
                      <img src={identity.logo} alt="شعار العلامة" className="h-12 w-12 rounded border border-slate-200 object-contain" />
                    ) : (
                      <div className="grid h-12 w-12 place-items-center rounded bg-slate-100 text-[9px] font-bold text-slate-400">لا شعار</div>
                    )}
                    <input
                      type="file"
                      accept="image/png,image/jpeg"
                      aria-label="رفع شعار العلامة"
                      className="text-xs"
                      onChange={(e) => void onLogoFile(e.target.files?.[0], "brand")}
                    />
                    <Button variant="ghost" onClick={() => setScopeDraft((d) => ({ ...d, logo: "" }))}>
                      إزالة
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
              <Save className="h-4 w-4" /> حفظ التخصيص
            </Button>
            {scopeSave.isError && (
              <span className="text-xs font-bold text-rose-700">تعذّر حفظ التخصيص. حاول مجددًا.</span>
            )}
          </div>
        </section>
      )}

      <section className="surface">
        <PanelTitle icon={Building2} title="حقول قابلة للتعديل" subtitle="تُحفظ في الإعدادات العامة." />
        <div className="grid gap-4 p-5 md:grid-cols-2">
          {EDITABLE.map((f) => (
            <Field key={f.settingKey} label={f.label} hint={`المصدر: ${sources[f.key] ?? "—"} · النطاق: ${scopeLabel(sources[f.key])}${f.hint ? ` · ${f.hint}` : ""}`}>
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
          title="الشعار"
          subtitle="يُصغَّر تلقائيًا إلى 256px كحد أقصى ويُحفظ في الإعدادات العامة (settings.logo). شعار العلامة/الشركة — إن وُجد — يتقدّم عليه."
        />
        <div className="flex flex-wrap items-center gap-4 p-5">
          {logoValue ? (
            <img src={logoValue} alt="الشعار الحالي" className="h-16 max-w-[140px] rounded border border-slate-200 object-contain" />
          ) : (
            <div className="grid h-16 w-[140px] place-items-center rounded bg-slate-100 text-[10px] font-bold text-slate-400">لا يوجد شعار</div>
          )}
          <input
            type="file"
            accept="image/png,image/jpeg"
            aria-label="رفع شعار"
            className="text-xs"
            onChange={(e) => void onLogoFile(e.target.files?.[0], "global")}
          />
          <Button variant="ghost" disabled={!logoValue} onClick={() => setDraft((d) => ({ ...d, logo: "" }))}>
            إزالة
          </Button>
          <span className="text-[11px] font-medium text-slate-400">
            PNG أو JPEG · حتى 100KB بعد الضغط · المصدر: {sources.logo ?? "—"} · النطاق: {scopeLabel(sources.logo)}
          </span>
          {logoError && <span className="w-full text-xs font-bold text-rose-700">{logoError}</span>}
        </div>
      </section>

      <section className="surface">
        <PanelTitle
          icon={ListChecks}
          title="حقول تظهر على الفاتورة"
          subtitle="تشغيل/إيقاف الكتل الاختيارية (settings.ReceiptShowFields). الافتراضي: الكل ظاهر."
        />
        <div className="grid gap-3 p-5 sm:grid-cols-2 md:grid-cols-3">
          {SHOW_FIELD_DEFS.map((f) => (
            <Toggle
              key={f.key}
              checked={showFields[f.key] !== false}
              onChange={(next) => toggleShowField(f.key, next)}
              label={f.label}
              aria-label={f.label}
            />
          ))}
        </div>
      </section>

      <section className="surface">
        <PanelTitle icon={Printer} title="الطباعة" subtitle="عرض الورق والطباعة التلقائية ولغة الفاتورة — إعدادات عامة لكل الفروع." />
        <div className="grid gap-5 p-5 md:grid-cols-3">
          <Field label="عرض الورق" hint="يصل للكاشير ضمن كتالوج نقطة البيع (receiptSettings.paperWidth).">
            <div className="flex flex-col gap-2" role="radiogroup" aria-label="عرض الورق">
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
                  {w.label}
                </label>
              ))}
            </div>
          </Field>
          <Field label="طباعة تلقائية" hint="فتح نافذة الطباعة تلقائيًا بعد إتمام البيع.">
            <Toggle
              checked={autoPrint}
              onChange={(next) => setDraft((d) => ({ ...d, ReceiptAutoPrint: next ? "1" : "0" }))}
              label={autoPrint ? "مفعّلة" : "متوقفة"}
              aria-label="طباعة تلقائية"
            />
          </Field>
          <Field
            label="لغة الفاتورة"
            hint="قالب الطباعة الحالي يطبع بالعربية فقط — خيار English/ثنائي اللغة معروض للتوثيق وسيُفعَّل عندما يدعمه قالب الفاتورة."
          >
            {({ id }) => (
              <select
                id={id}
                className="field"
                value={language}
                onChange={(e) => setDraft((d) => ({ ...d, ReceiptLanguage: e.target.value }))}
              >
                <option value="ar">العربية</option>
                <option value="en" disabled title="قالب الفاتورة لا يدعم الإنجليزية بعد">
                  English (غير مدعومة بعد)
                </option>
                <option value="both" disabled title="قالب الفاتورة لا يدعم الطباعة ثنائية اللغة بعد">
                  ثنائية اللغة (غير مدعومة بعد)
                </option>
              </select>
            )}
          </Field>
        </div>
      </section>

      <section className="surface">
        <PanelTitle icon={Receipt} title="حقول مشتقّة" subtitle="تُدار من سجلاتها، وتظهر هنا للشفافية فقط." />
        <div className="overflow-x-auto p-5">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-right text-xs font-bold text-slate-500">
                <th className="px-3 py-2">الحقل</th>
                <th className="px-3 py-2">القيمة</th>
                <th className="px-3 py-2">المصدر</th>
                <th className="px-3 py-2">النطاق</th>
                <th className="px-3 py-2">تُدار من</th>
              </tr>
            </thead>
            <tbody>
              {DERIVED.map((f) => (
                <tr key={String(f.key)} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-bold text-slate-700">{f.label}</td>
                  <td className="px-3 py-2 text-slate-600">{String(identity[f.key] ?? "") || "—"}</td>
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-400">{sources[f.key] ?? "—"}</td>
                  <td className="px-3 py-2"><StatusBadge>{scopeLabel(sources[f.key])}</StatusBadge></td>
                  <td className="px-3 py-2 text-slate-500">{f.owner}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="surface">
        <PanelTitle icon={ReceiptText} title="معاينة" subtitle="شكل كتلة البائع أعلى الفاتورة وأسفلها — تحترم مفاتيح الإظهار أعلاه." />
        <div className="mx-auto my-5 w-full max-w-[320px] rounded-xl border-2 border-dashed border-slate-300 bg-white p-4 text-center" dir="rtl">
          {showFields.logo !== false && (
            logoValue ? (
              <img src={logoValue} alt="شعار" className="mx-auto mb-2 max-h-16 max-w-[120px] object-contain" />
            ) : (
              <div className="mx-auto mb-2 grid h-16 w-[120px] place-items-center rounded bg-slate-100 text-[10px] font-bold text-slate-400">لا يوجد شعار</div>
            )
          )}
          <div className="text-sm font-extrabold text-slate-900">{preview?.sellerName || "—"}</div>
          {preview?.header && <div className="mt-1 whitespace-pre-line text-[11px] text-slate-600">{preview.header}</div>}
          {identity.branchName && <div className="text-[11px] text-slate-500">{identity.branchName}</div>}
          {showFields.nationalAddress !== false && preview?.nationalAddress && (
            <div className="text-[11px] text-slate-500">{preview.nationalAddress}</div>
          )}
          {showFields.taxNumber !== false && (
            <div className="mt-1 font-mono text-[11px] text-slate-600">
              {preview?.taxNumber ? `الرقم الضريبي: ${preview.taxNumber}` : "الرقم الضريبي: —"}
            </div>
          )}
          {showFields.crNumber !== false && preview?.crNumber && (
            <div className="font-mono text-[11px] text-slate-600">س.ت: {preview.crNumber}</div>
          )}
          <div className="my-2 border-t border-dashed border-slate-300" />
          <div className="text-[10px] text-slate-400">— بنود الفاتورة —</div>
          <div className="my-2 border-t border-dashed border-slate-300" />
          {showFields.qr !== false && (
            <div className="mx-auto my-2 grid h-14 w-14 place-items-center rounded border border-dashed border-slate-300 text-[9px] font-bold text-slate-400">
              QR
            </div>
          )}
          <div className="text-[11px] font-bold text-slate-700">{preview?.thankYou || "شُكرًا لِزيارَتِكم"}</div>
          {preview?.footer && <div className="mt-1 whitespace-pre-line text-[10px] text-slate-500">{preview.footer}</div>}
          {preview?.returnPolicy && <div className="mt-1 whitespace-pre-line text-[10px] text-slate-500">{preview.returnPolicy}</div>}
        </div>
      </section>

      {save.isError && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
          تعذّر الحفظ. حاول مجددًا.
        </div>
      )}
    </div>
  );
}

export default InvoiceSettingsPage;
