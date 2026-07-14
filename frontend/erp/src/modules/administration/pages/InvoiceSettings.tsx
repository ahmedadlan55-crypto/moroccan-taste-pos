import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Layers, Receipt, ReceiptText, Save } from "lucide-react";
import { apiClient } from "@/shared/api";
import { Button, EmptyState, ErrorState, Input, LoadingState, PageHeader, PanelTitle, StatusBadge } from "@/shared/ui";
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
interface IdentityResponse {
  success: boolean;
  identity: Identity;
  sources: Record<string, string>;
  branches: Array<{ id: string; name: string }>;
  brands: Array<{ id: string; name: string }>;
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

  const valueOf = (f: { key: keyof Identity; settingKey: string }) =>
    draft[f.settingKey] ?? String(identity?.[f.key] ?? "");

  const dirty = Object.keys(draft).length > 0;

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
        <PanelTitle icon={ReceiptText} title="معاينة" subtitle="شكل كتلة البائع أعلى الفاتورة وأسفلها." />
        <div className="mx-auto my-5 w-full max-w-[320px] rounded-xl border-2 border-dashed border-slate-300 bg-white p-4 text-center" dir="rtl">
          {identity.logo ? (
            <img src={identity.logo} alt="شعار" className="mx-auto mb-2 max-h-16 max-w-[120px] object-contain" />
          ) : (
            <div className="mx-auto mb-2 grid h-16 w-[120px] place-items-center rounded bg-slate-100 text-[10px] font-bold text-slate-400">لا يوجد شعار</div>
          )}
          <div className="text-sm font-extrabold text-slate-900">{preview?.sellerName || "—"}</div>
          {preview?.header && <div className="mt-1 whitespace-pre-line text-[11px] text-slate-600">{preview.header}</div>}
          {identity.branchName && <div className="text-[11px] text-slate-500">{identity.branchName}</div>}
          {preview?.nationalAddress && <div className="text-[11px] text-slate-500">{preview.nationalAddress}</div>}
          <div className="mt-1 font-mono text-[11px] text-slate-600">
            {preview?.taxNumber ? `الرقم الضريبي: ${preview.taxNumber}` : "الرقم الضريبي: —"}
          </div>
          {preview?.crNumber && <div className="font-mono text-[11px] text-slate-600">س.ت: {preview.crNumber}</div>}
          <div className="my-2 border-t border-dashed border-slate-300" />
          <div className="text-[10px] text-slate-400">— بنود الفاتورة —</div>
          <div className="my-2 border-t border-dashed border-slate-300" />
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
