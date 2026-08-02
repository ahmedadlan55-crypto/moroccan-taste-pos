import { useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Percent, ReceiptText } from "lucide-react";
import { apiClient } from "@/shared/api";
import {
  Button,
  Input,
  LoadingState,
  ErrorState,
  PageHeader,
  PanelTitle,
  Toggle,
  useToast,
} from "@/shared/ui";
import { Field, FormActions, zodResolver } from "@/shared/forms";
import { z } from "@/shared/schemas";
import { useCan } from "@/app/providers";
import { useT, type TFunction } from "@/i18n";
import { ensureAck, type MutationAck } from "../_common";
import { ProcurementPurge } from "../ProcurementPurge";

type SettingsMap = Record<string, string>;

const boolFrom = (v: string | undefined): boolean => v === "true" || v === "1" || v === "on";

function makeSettingsSchema(t: TFunction) {
  return z.object({
    name: z.string().trim().max(200).optional().or(z.literal("")),
    companyPhone: z.string().trim().max(30).optional().or(z.literal("")),
    companyEmail: z
      .string()
      .trim()
      .optional()
      .refine((v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), t("validation.email.invalid")),
    address: z.string().trim().max(500).optional().or(z.literal("")),
    taxNumber: z.string().trim().max(50).optional().or(z.literal("")),
    VATRate: z
      .string()
      .trim()
      .optional()
      .or(z.literal(""))
      .refine(
        (v) => !v || (!Number.isNaN(Number(v)) && Number(v) >= 0 && Number(v) <= 100),
        t("administration.settings.err.vatRange"),
      ),
    currency: z.string().trim().max(10).optional().or(z.literal("")),
    receiptFooter: z.string().trim().max(500).optional().or(z.literal("")),
    NewProductsTaxInclusive: z.boolean(),
    RequireManagerApprovalForVoid: z.boolean(),
  });
}
type SettingsForm = z.infer<ReturnType<typeof makeSettingsSchema>>;

const DEFAULTS: SettingsForm = {
  name: "",
  companyPhone: "",
  companyEmail: "",
  address: "",
  taxNumber: "",
  VATRate: "",
  currency: "SAR",
  receiptFooter: "",
  NewProductsTaxInclusive: false,
  RequireManagerApprovalForVoid: false,
};

export default function SettingsPage() {
  const t = useT();
  const canManage = useCan("administration.settings");
  const qc = useQueryClient();
  const { toast } = useToast();

  const schema = useMemo(() => makeSettingsSchema(t), [t]);

  const query = useQuery({
    queryKey: ["settings"],
    queryFn: ({ signal }) => apiClient.get<SettingsMap>("/settings", { signal }),
  });

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isDirty },
  } = useForm<SettingsForm>({ resolver: zodResolver(schema), defaultValues: DEFAULTS });

  useEffect(() => {
    const s = query.data;
    if (!s) return;
    reset({
      name: s.name ?? "",
      companyPhone: s.companyPhone ?? "",
      companyEmail: s.companyEmail ?? "",
      address: s.address ?? "",
      taxNumber: s.taxNumber ?? "",
      VATRate: s.VATRate ?? s.vat_rate ?? "",
      currency: s.currency || "SAR",
      receiptFooter: s.receiptFooter ?? "",
      NewProductsTaxInclusive: boolFrom(s.NewProductsTaxInclusive),
      RequireManagerApprovalForVoid: boolFrom(s.RequireManagerApprovalForVoid),
    });
  }, [query.data, reset]);

  const mutation = useMutation({
    mutationFn: async (values: SettingsForm) => {
      const payload: SettingsMap = {
        name: values.name ?? "",
        companyPhone: values.companyPhone ?? "",
        companyEmail: values.companyEmail ?? "",
        address: values.address ?? "",
        taxNumber: values.taxNumber ?? "",
        VATRate: values.VATRate ?? "",
        currency: values.currency ?? "",
        receiptFooter: values.receiptFooter ?? "",
        NewProductsTaxInclusive: values.NewProductsTaxInclusive ? "true" : "false",
        RequireManagerApprovalForVoid: values.RequireManagerApprovalForVoid ? "true" : "false",
      };
      return ensureAck(await apiClient.put<MutationAck>("/settings", payload));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast({ title: t("administration.settings.toast.saved"), tone: "success" });
    },
    onError: (e: Error) => toast({ title: t("administration.settings.toast.saveFailed"), description: e.message, tone: "error" }),
  });

  return (
    <div>
      <PageHeader
        eyebrow={t("administration.eyebrow")}
        title={t("administration.settings.title")}
        subtitle={t("administration.settings.subtitle")}
      />
      {query.error ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : query.isLoading ? (
        <LoadingState />
      ) : (
        <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="space-y-5" aria-label={t("administration.settings.formAria")} noValidate>
          <section className="surface">
            <PanelTitle icon={Building2} title={t("administration.settings.company.panelTitle")} subtitle={t("administration.settings.company.panelSubtitle")} />
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <Field label={t("administration.settings.company.name")} error={errors.name}>
                {({ id, invalid }) => <Input id={id} invalid={invalid} disabled={!canManage} {...register("name")} />}
              </Field>
              <Field label={t("administration.settings.company.phone")} error={errors.companyPhone}>
                {({ id }) => <Input id={id} dir="ltr" disabled={!canManage} {...register("companyPhone")} />}
              </Field>
              <Field label={t("administration.settings.company.email")} error={errors.companyEmail}>
                {({ id, invalid }) => (
                  <Input id={id} type="email" dir="ltr" invalid={invalid} disabled={!canManage} {...register("companyEmail")} />
                )}
              </Field>
              <Field label={t("administration.settings.company.address")} error={errors.address}>
                {({ id }) => <Input id={id} disabled={!canManage} {...register("address")} />}
              </Field>
            </div>
          </section>

          <section className="surface">
            <PanelTitle icon={Percent} title={t("administration.settings.tax.panelTitle")} subtitle={t("administration.settings.tax.panelSubtitle")} />
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <Field label={t("administration.settings.tax.taxNumber")} error={errors.taxNumber}>
                {({ id }) => <Input id={id} inputMode="numeric" dir="ltr" disabled={!canManage} {...register("taxNumber")} />}
              </Field>
              <Field label={t("administration.settings.tax.vatRate")} error={errors.VATRate} hint={t("administration.settings.tax.vatRateHint")}>
                {({ id, invalid }) => (
                  <Input id={id} inputMode="decimal" dir="ltr" invalid={invalid} disabled={!canManage} {...register("VATRate")} />
                )}
              </Field>
              <Field label={t("administration.settings.tax.currency")} error={errors.currency}>
                {({ id }) => <Input id={id} dir="ltr" disabled={!canManage} {...register("currency")} />}
              </Field>
              <div className="flex items-end">
                <Toggle
                  checked={watch("NewProductsTaxInclusive")}
                  onChange={(v) => setValue("NewProductsTaxInclusive", v, { shouldDirty: true })}
                  disabled={!canManage}
                  label={t("administration.settings.tax.taxInclusiveToggle")}
                />
              </div>
            </div>
          </section>

          <section className="surface">
            <PanelTitle icon={ReceiptText} title={t("administration.settings.receipt.panelTitle")} subtitle={t("administration.settings.receipt.panelSubtitle")} />
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <Field label={t("administration.settings.receipt.footer")} error={errors.receiptFooter} className="sm:col-span-2">
                {({ id }) => <Input id={id} disabled={!canManage} {...register("receiptFooter")} />}
              </Field>
              <div className="flex items-end">
                <Toggle
                  checked={watch("RequireManagerApprovalForVoid")}
                  onChange={(v) => setValue("RequireManagerApprovalForVoid", v, { shouldDirty: true })}
                  disabled={!canManage}
                  label={t("administration.settings.receipt.voidApprovalToggle")}
                />
              </div>
            </div>
          </section>

          {/* Destructive administration lives at the BOTTOM, after everything
              routine, and behind its own preview + typed confirmation. */}
          <ProcurementPurge />

          {canManage && (
            <FormActions sticky>
              <Button variant="secondary" type="button" onClick={() => query.refetch()} disabled={mutation.isPending}>
                {t("administration.settings.resetBtn")}
              </Button>
              <Button type="submit" loading={mutation.isPending} disabled={!isDirty}>
                {t("administration.settings.saveBtn")}
              </Button>
            </FormActions>
          )}
        </form>
      )}
    </div>
  );
}
