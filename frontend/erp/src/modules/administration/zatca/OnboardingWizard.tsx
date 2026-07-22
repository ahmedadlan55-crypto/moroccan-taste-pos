import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import {
  Ban,
  CheckCircle2,
  FlaskConical,
  Info,
  KeyRound,
  Rocket,
  ShieldCheck,
} from "lucide-react";
import { Button, ConfirmDialog, Input, Select, StatusBadge, Stepper, useToast } from "@/shared/ui";
import { Field, zodResolver } from "@/shared/forms";
import { z } from "@/shared/schemas";
import { Can } from "@/shared/permissions";
import { useT, type TFunction } from "@/i18n";
import {
  useOnboardCompliance,
  useOnboardProduction,
  useRevokeZatca,
  useZatcaTest,
  type ZatcaStatus,
} from "./api";

const INVOICE_TYPE_VALUES = ["1100", "1000", "0100"] as const;

// The OTP is user-entered input, sent ONCE to the compliance endpoint. It is
// never written to localStorage or any persistent store — it lives only in this
// form's in-memory state and is cleared on success (reset()).
function makeComplianceSchema(t: TFunction) {
  return z.object({
    otp: z.string().trim().min(1, t("administration.zatca.err.otpRequired")),
    vatNumber: z
      .string()
      .trim()
      .regex(/^\d{15}$/, t("administration.zatca.err.vatDigits")),
    organizationName: z.string().trim().max(200).optional().or(z.literal("")),
    commonName: z.string().trim().max(200).optional().or(z.literal("")),
    organizationalUnitName: z.string().trim().max(200).optional().or(z.literal("")),
    invoiceType: z.string(),
    sellerLocation: z.string().trim().max(120).optional().or(z.literal("")),
    industryCode: z.string().trim().max(60).optional().or(z.literal("")),
    crNumber: z.string().trim().max(60).optional().or(z.literal("")),
  });
}
type ComplianceForm = z.infer<ReturnType<typeof makeComplianceSchema>>;

function currentStep(csid: string): number {
  if (csid === "production") return 4;
  if (csid === "compliance") return 2;
  return 1; // none | revoked | anything else → start over
}

// ── Step 1 — compliance CSID request (OTP + CSR fields) ──────────────────────
function ComplianceStep({ status }: { status: ZatcaStatus }) {
  const t = useT();
  const { toast } = useToast();
  const mutation = useOnboardCompliance();
  const schema = useMemo(() => makeComplianceSchema(t), [t]);
  const invoiceTypeOptions = useMemo(
    () => INVOICE_TYPE_VALUES.map((v) => ({ value: v, label: t(`administration.zatca.invoiceType.${v}`) })),
    [t],
  );
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ComplianceForm>({
    resolver: zodResolver(schema),
    defaultValues: {
      otp: "",
      vatNumber: status.sellerVat || "",
      organizationName: status.sellerName || "",
      commonName: "",
      organizationalUnitName: "",
      invoiceType: "1100",
      sellerLocation: "Riyadh",
      industryCode: "0000",
      crNumber: "",
    },
  });

  // Keep VAT / name in sync if the status loads after the form mounts. Never
  // seed the OTP from anywhere — it's always entered fresh by the user.
  useEffect(() => {
    reset((prev) => ({
      ...prev,
      otp: "",
      vatNumber: prev.vatNumber || status.sellerVat || "",
      organizationName: prev.organizationName || status.sellerName || "",
    }));
  }, [status.sellerVat, status.sellerName, reset]);

  const onSubmit = (v: ComplianceForm) =>
    mutation.mutate(
      {
        otp: v.otp,
        vatNumber: v.vatNumber,
        commonName: v.commonName || undefined,
        organizationName: v.organizationName || undefined,
        organizationalUnitName: v.organizationalUnitName || undefined,
        invoiceType: v.invoiceType,
        sellerLocation: v.sellerLocation || undefined,
        industryCode: v.industryCode || undefined,
        crNumber: v.crNumber || undefined,
      },
      {
        onSuccess: (r) => {
          reset(); // clear the OTP (and the rest) from memory immediately
          toast({ title: r.message || t("administration.zatca.compliance.toastSuccess"), tone: "success" });
        },
        onError: (e: Error) =>
          toast({ title: t("administration.zatca.compliance.toastFailed"), description: e.message, tone: "error" }),
      },
    );

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <div className="flex items-start gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-medium text-sky-800">
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{t("administration.zatca.compliance.infoBanner")}</span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("administration.zatca.compliance.otp")} required error={errors.otp}>
          {({ id, invalid }) => (
            <Input
              id={id}
              dir="ltr"
              inputMode="numeric"
              autoComplete="off"
              leading={<KeyRound className="h-4 w-4" />}
              placeholder="123456"
              invalid={invalid}
              {...register("otp")}
            />
          )}
        </Field>
        <Field label={t("administration.zatca.compliance.vatNumber")} required error={errors.vatNumber}>
          {({ id, invalid }) => (
            <Input id={id} dir="ltr" inputMode="numeric" invalid={invalid} {...register("vatNumber")} />
          )}
        </Field>
        <Field label={t("administration.zatca.compliance.orgName")} error={errors.organizationName}>
          {({ id }) => <Input id={id} {...register("organizationName")} />}
        </Field>
        <Field label={t("administration.zatca.compliance.commonName")} hint={t("administration.zatca.compliance.commonNameHint")} error={errors.commonName}>
          {({ id }) => <Input id={id} dir="ltr" {...register("commonName")} />}
        </Field>
        <Field label={t("administration.zatca.compliance.orgUnit")} error={errors.organizationalUnitName}>
          {({ id }) => <Input id={id} {...register("organizationalUnitName")} />}
        </Field>
        <Field label={t("administration.zatca.compliance.invoiceTypeLabel")} error={errors.invoiceType}>
          {({ id }) => <Select id={id} options={invoiceTypeOptions} {...register("invoiceType")} />}
        </Field>
        <Field label={t("administration.zatca.compliance.location")} error={errors.sellerLocation}>
          {({ id }) => <Input id={id} {...register("sellerLocation")} />}
        </Field>
        <Field label={t("administration.zatca.compliance.industryCode")} error={errors.industryCode}>
          {({ id }) => <Input id={id} dir="ltr" inputMode="numeric" {...register("industryCode")} />}
        </Field>
        <Field label={t("administration.zatca.compliance.crNumber")} error={errors.crNumber} className="sm:col-span-2">
          {({ id }) => <Input id={id} dir="ltr" inputMode="numeric" {...register("crNumber")} />}
        </Field>
      </div>

      <div className="flex justify-end">
        <Button type="submit" loading={mutation.isPending}>
          <ShieldCheck className="h-4 w-4" /> {t("administration.zatca.compliance.submitBtn")}
        </Button>
      </div>
    </form>
  );
}

// ── Step 2 + 3 — synthetic test, then graduate to production ─────────────────
function TestAndProductionStep({ status }: { status: ZatcaStatus }) {
  const t = useT();
  const { toast } = useToast();
  const testMut = useZatcaTest();
  const prodMut = useOnboardProduction();
  const test = testMut.data;

  const runTest = () =>
    testMut.mutate(undefined, {
      onSuccess: (r) =>
        toast({
          title: r.success ? t("administration.zatca.test.toastAccepted") : t("administration.zatca.test.toastRejected"),
          description: r.httpStatus ? t("administration.zatca.test.toastResponse", { status: r.httpStatus }) : r.error || undefined,
          tone: r.success ? "success" : "warning",
        }),
      onError: (e: Error) =>
        toast({ title: t("administration.zatca.test.toastTestFailed"), description: e.message, tone: "error" }),
    });

  const graduate = () =>
    prodMut.mutate(undefined, {
      onSuccess: (r) => toast({ title: r.message || t("administration.zatca.test.toastProdSuccess"), tone: "success" }),
      onError: (e: Error) =>
        toast({ title: t("administration.zatca.test.toastProdFailed"), description: e.message, tone: "error" }),
    });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700">
        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
        {status.requestId
          ? t("administration.zatca.test.bannerWithId", { requestId: status.requestId })
          : t("administration.zatca.test.banner")}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="surface p-4">
          <div className="flex items-center gap-2 text-sm font-extrabold text-slate-900">
            <FlaskConical className="h-4 w-4 text-teal-700" /> {t("administration.zatca.test.testTitle")}
          </div>
          <p className="mt-1 text-xs font-medium text-slate-500">
            {t("administration.zatca.test.testBody")}
          </p>
          {test && (
            <div className="mt-2">
              <StatusBadge tone={test.success ? "success" : "warning"}>
                {test.success
                  ? test.httpStatus
                    ? t("administration.zatca.test.acceptedWithStatus", { status: test.httpStatus })
                    : t("administration.zatca.test.accepted")
                  : test.httpStatus
                    ? t("administration.zatca.test.rejectedWithStatus", { status: test.httpStatus })
                    : t("administration.zatca.test.rejected")}
              </StatusBadge>
            </div>
          )}
          <Button
            variant="secondary"
            className="mt-3 w-full"
            loading={testMut.isPending}
            onClick={runTest}
          >
            <FlaskConical className="h-4 w-4" /> {t("administration.zatca.test.runBtn")}
          </Button>
        </div>

        <div className="surface p-4">
          <div className="flex items-center gap-2 text-sm font-extrabold text-slate-900">
            <Rocket className="h-4 w-4 text-teal-700" /> {t("administration.zatca.test.prodTitle")}
          </div>
          <p className="mt-1 text-xs font-medium text-slate-500">
            {t("administration.zatca.test.prodBody")}
          </p>
          <Button className="mt-3 w-full" loading={prodMut.isPending} onClick={graduate}>
            <Rocket className="h-4 w-4" /> {t("administration.zatca.test.prodBtn")}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Step 4 — production active ───────────────────────────────────────────────
function DoneStep({ status }: { status: ZatcaStatus }) {
  const t = useT();
  return (
    <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-emerald-100 text-emerald-700">
        <CheckCircle2 className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <div className="text-sm font-extrabold text-emerald-800">
          {t("administration.zatca.done.title")}
        </div>
        <p className="mt-1 text-xs font-medium text-emerald-700">
          {status.requestId
            ? t("administration.zatca.done.bodyWithId", { requestId: status.requestId })
            : t("administration.zatca.done.body")}
        </p>
      </div>
    </div>
  );
}

// ── Revoke — clears all server-side credentials (requires a reason) ──────────
function RevokeAction() {
  const t = useT();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const revokeMut = useRevokeZatca();

  return (
    <>
      <div className="flex justify-end border-t border-slate-100 pt-4">
        <Button variant="ghost" className="text-rose-600 hover:bg-rose-50" onClick={() => setOpen(true)}>
          <Ban className="h-4 w-4" /> {t("administration.zatca.revoke.btn")}
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        title={t("administration.zatca.revoke.confirmTitle")}
        description={t("administration.zatca.revoke.confirmDesc")}
        tone="danger"
        confirmLabel={t("administration.zatca.revoke.confirmLabel")}
        requireReason
        reasonLabel={t("administration.zatca.revoke.reasonLabel")}
        processing={revokeMut.isPending}
        error={revokeMut.isError ? (revokeMut.error as Error).message : null}
        onConfirm={(reason) =>
          revokeMut.mutate(reason, {
            onSuccess: () => {
              setOpen(false);
              toast({ title: t("administration.zatca.revoke.toastSuccess"), tone: "success" });
            },
            onError: (e: Error) =>
              toast({ title: t("administration.zatca.revoke.toastFailed"), description: e.message, tone: "error" }),
          })
        }
        onClose={() => setOpen(false)}
      />
    </>
  );
}

/**
 * Real ZATCA Phase-2 onboarding wizard. The whole actionable section is gated by
 * `administration.zatca.manage` (backend RBAC remains the real boundary). Which
 * step is active is derived from `status.csidStatus` — no secret is ever read,
 * displayed, stored, or logged; only the non-sensitive status flags are used.
 */
export function ZatcaOnboardingWizard({ status }: { status: ZatcaStatus }) {
  const t = useT();
  const csid = status.csidStatus || "none";
  const step = currentStep(csid);
  const hasCredentials = csid === "compliance" || csid === "production";
  const steps = [
    t("administration.zatca.step.compliance"),
    t("administration.zatca.step.test"),
    t("administration.zatca.step.production"),
    t("administration.zatca.step.done"),
  ];

  return (
    <Can cap="administration.zatca.manage" showDenied>
      <div className="surface space-y-5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-base font-extrabold text-slate-900">{t("administration.zatca.wizard.title")}</div>
            <div className="text-xs font-medium text-slate-500">
              {t("administration.zatca.wizard.subtitle")}
            </div>
          </div>
          {csid === "revoked" && <StatusBadge tone="danger">{t("administration.zatca.wizard.revokedBadge")}</StatusBadge>}
        </div>

        <Stepper steps={steps} current={step} />

        {step === 1 && <ComplianceStep status={status} />}
        {step === 2 && <TestAndProductionStep status={status} />}
        {step === 4 && <DoneStep status={status} />}

        <p className="flex items-start gap-2 text-[11px] font-medium text-slate-400">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {t("administration.zatca.wizard.footerNote")}
        </p>

        {hasCredentials && <RevokeAction />}
      </div>
    </Can>
  );
}
