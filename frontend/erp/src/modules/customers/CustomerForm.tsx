import { useEffect, useMemo, useRef, useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { z } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import { Drawer, Button, Select, SegmentedControl, safeUserMessage, CountryPicker, CityPicker } from "@/shared/ui";
import { Field, zodResolver } from "@/shared/forms";
import { useT, useLang, type TFunction } from "@/i18n";
import { o2cApi, qk, type Customer } from "@/modules/sales/lib";
import { useCoaAccounts, useCostCenterDims } from "@/modules/banking/api";
import { useCountryHit, cityHitFromName, type GeoHit } from "@/shared/lib/geo";

// Schema is built per-render from t() so validation messages follow the UI
// language. The FormValues type is derived from the factory's return shape.
const makeSchema = (t: TFunction) =>
  z.object({
    name: z.string().min(1, t("misc.customers.form.validation.nameRequired")),
    nameEn: z.string().optional(),
    phone: z.string().optional(),
    vatRegistered: z.boolean().default(true),
    vatNumber: z.string().optional().refine((v) => !v || /^\d{15}$/.test(v), t("misc.customers.form.validation.vatDigits")),
    email: z.string().email(t("misc.customers.form.validation.emailInvalid")).optional().or(z.literal("")),
    city: z.string().optional(),
    street: z.string().optional(),
    buildingNumber: z.string().optional(),
    district: z.string().optional(),
    additionalNo: z.string().optional(),
    postalCode: z.string().optional(),
    defaultRevenueAccountId: z.string().optional(),
    defaultRevenueCostCenterId: z.string().optional(),
    customerType: z.enum(["B2C", "B2B", "B2G"]),
    creditLimit: z.coerce.number().min(0, t("misc.customers.form.validation.notNegative")),
    paymentTerms: z.string().min(1),
    creditDays: z.coerce.number().int().min(0),
  });
type FormValues = z.infer<ReturnType<typeof makeSchema>>;

export function CustomerForm({ open, onClose, customer }: { open: boolean; onClose: () => void; customer?: Customer | null }) {
  const t = useT();
  const lang = useLang();
  const qc = useQueryClient();
  const editing = !!customer;
  const editingName = customer ? (lang === "en" ? customer.nameEn || customer.name : customer.name) : "";
  const schema = useMemo(() => makeSchema(t), [t]);
  const { register, handleSubmit, control, watch, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: customer?.name ?? "", nameEn: customer?.nameEn ?? "", phone: customer?.phone ?? "",
      vatRegistered: customer?.vatRegistered ?? true,
      vatNumber: customer?.vatNumber ?? "", email: customer?.email ?? "", city: customer?.city ?? "",
      street: customer?.street ?? "", buildingNumber: customer?.buildingNumber ?? "",
      district: customer?.district ?? "", additionalNo: customer?.additionalNo ?? "", postalCode: customer?.postalCode ?? "",
      defaultRevenueAccountId: customer?.defaultRevenueAccountId ?? "", defaultRevenueCostCenterId: customer?.defaultRevenueCostCenterId ?? "",
      customerType: customer?.customerType ?? "B2C",
      creditLimit: customer?.creditLimit ?? 0, paymentTerms: customer?.paymentTerms ?? "Cash", creditDays: customer?.creditDays ?? 0,
    },
  });
  const vatRegistered = watch("vatRegistered");
  const coa = useCoaAccounts(open);
  const costCenters = useCostCenterDims();
  const revenueAccounts = (coa.data ?? []).filter((a) => a.isLeaf && a.code.startsWith("4"));

  // Country + city are searchable pickers (GeoHit), persisted as country = hit.code
  // (ISO2) and city = hit.name. On edit, seed the country ONCE (resolving "SA" →
  // "المملكة العربية السعودية") and the city from its stored name.
  const seededCountry = useCountryHit(customer?.country);
  const [countryHit, setCountryHit] = useState<GeoHit | null>(null);
  const seededRef = useRef(false);
  useEffect(() => {
    if (!seededRef.current && customer?.country && seededCountry.data) {
      seededRef.current = true;
      setCountryHit(seededCountry.data);
    }
  }, [customer?.country, seededCountry.data]);
  const [cityHit, setCityHit] = useState<GeoHit | null>(() => cityHitFromName(customer?.country, customer?.city));
  function onCountryChange(v: GeoHit | null) {
    setCountryHit(v);
    setCityHit(null); // the chosen city belongs to the previous country — reset it
  }

  const mutation = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      editing ? o2cApi.updateCustomer(customer!.id, values) : o2cApi.createCustomer(values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.all });
      onClose();
    },
  });

  const submit = handleSubmit((v) =>
    mutation.mutate({ ...v, country: countryHit?.code ?? null, city: cityHit?.name ?? null }),
  );

  return (
    <Drawer
      open={open}
      onClose={onClose}
      icon={UserPlus}
      eyebrow={editing ? t("misc.customers.form.editEyebrow") : t("misc.customers.form.newEyebrow")}
      title={editing ? editingName : t("misc.customers.form.addTitle")}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
          <Button loading={mutation.isPending} onClick={submit}>
            {editing ? t("misc.customers.form.saveChanges") : t("misc.customers.form.saveCustomer")}
          </Button>
        </div>
      }
    >
      <form className="grid grid-cols-1 gap-4" onSubmit={submit}>
        {mutation.isError && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">
            {safeUserMessage(mutation.error)}
          </div>
        )}

        <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
          <div className="mb-2 text-xs font-extrabold text-slate-500">{t("misc.customers.form.section.entity")}</div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t("misc.customers.form.field.name")} required error={errors.name} className="sm:col-span-2">
              <input className="field w-full" aria-label={t("misc.customers.form.field.nameAria")} {...register("name")} />
            </Field>
            <Field label={t("misc.customers.form.field.nameEn")}><input dir="ltr" className="field w-full" {...register("nameEn")} /></Field>
            <Field label={t("misc.customers.form.field.phone")}><input dir="ltr" className="field w-full tabular-nums" {...register("phone")} /></Field>
            <Field label={t("misc.customers.form.field.vatRegistration")} className="sm:col-span-2">
              <Controller
                control={control}
                name="vatRegistered"
                render={({ field }) => (
                  <SegmentedControl
                    aria-label={t("misc.customers.form.field.vatRegistration")}
                    value={field.value ? "registered" : "unregistered"}
                    onChange={(v) => field.onChange(v === "registered")}
                    options={[
                      { value: "registered", label: t("misc.customers.form.vat.registered") },
                      { value: "unregistered", label: t("misc.customers.form.vat.unregistered") },
                    ]}
                  />
                )}
              />
            </Field>
            {vatRegistered && (
              <Field label={t("misc.customers.form.field.vatNumber")} error={errors.vatNumber} className="sm:col-span-2">
                <input dir="ltr" className="field w-full tabular-nums" {...register("vatNumber")} />
              </Field>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
          <div className="mb-2 text-xs font-extrabold text-slate-500">{t("misc.customers.form.section.address")}</div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label={t("misc.customers.form.field.country")}>
              <CountryPicker value={countryHit} onChange={onCountryChange} />
            </Field>
            <Field label={t("misc.customers.form.field.city")}>
              <CityPicker countryCode={countryHit?.code ?? null} value={cityHit} onChange={setCityHit} />
            </Field>
            <Field label={t("misc.customers.form.field.district")}><input className="field w-full" {...register("district")} /></Field>
            <Field label={t("misc.customers.form.field.postalCode")}><input dir="ltr" className="field w-full tabular-nums" {...register("postalCode")} /></Field>
            <Field label={t("misc.customers.form.field.street")} className="sm:col-span-2"><input className="field w-full" {...register("street")} /></Field>
            <Field label={t("misc.customers.form.field.buildingNumber")}><input dir="ltr" className="field w-full tabular-nums" {...register("buildingNumber")} /></Field>
            <Field label={t("misc.customers.form.field.additionalNo")} hint={t("misc.customers.form.hint.optional")} className="sm:col-span-3"><input dir="ltr" className="field w-full tabular-nums sm:w-1/3" {...register("additionalNo")} /></Field>
          </div>
        </div>

        <div className="rounded-xl border border-teal-100 bg-teal-50/40 p-3">
          <div className="mb-2 text-xs font-extrabold text-teal-800">{t("misc.customers.form.section.salesDefaults")}</div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t("misc.customers.form.field.revenueAccount")}>
              <Select {...register("defaultRevenueAccountId")} disabled={coa.isLoading} placeholder={t("misc.customers.form.selectNone")}>
                {revenueAccounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.code} — {a.nameAr}</option>
                ))}
              </Select>
            </Field>
            <Field label={t("misc.customers.form.field.revenueCostCenter")}>
              <Select {...register("defaultRevenueCostCenterId")} disabled={costCenters.isLoading} placeholder={t("misc.customers.form.selectNone")}>
                {(costCenters.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
              </Select>
            </Field>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t("misc.customers.form.field.email")} error={errors.email}><input dir="ltr" className="field w-full" {...register("email")} /></Field>
          <Field label={t("misc.customers.form.field.customerType")}>
            <select className="field w-full" {...register("customerType")}>
              <option value="B2C">{t("misc.customers.form.type.b2c")}</option>
              <option value="B2B">{t("misc.customers.form.type.b2b")}</option>
              <option value="B2G">{t("misc.customers.form.type.b2g")}</option>
            </select>
          </Field>
          <Field label={t("misc.customers.form.field.creditLimit")} hint={t("misc.customers.form.hint.creditLimit")} error={errors.creditLimit}>
            <input dir="ltr" type="number" step="0.01" className="field w-full tabular-nums" {...register("creditLimit")} />
          </Field>
          <Field label={t("misc.customers.form.field.paymentTerms")} hint={t("misc.customers.form.hint.paymentTerms")}><input dir="ltr" className="field w-full" {...register("paymentTerms")} /></Field>
          <Field label={t("misc.customers.form.field.creditDays")}><input dir="ltr" type="number" className="field w-full tabular-nums" {...register("creditDays")} /></Field>
        </div>
      </form>
    </Drawer>
  );
}
