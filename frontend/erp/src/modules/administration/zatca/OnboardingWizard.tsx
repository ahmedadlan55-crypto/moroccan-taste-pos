import { useEffect, useState } from "react";
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
import {
  useOnboardCompliance,
  useOnboardProduction,
  useRevokeZatca,
  useZatcaTest,
  type ZatcaStatus,
} from "./api";

const STEPS = ["بيانات الامتثال", "اختبار", "الإنتاج", "مكتمل"];

const INVOICE_TYPES = [
  { value: "1100", label: "ضريبية ومبسّطة (B2B + B2C)" },
  { value: "1000", label: "ضريبية فقط (B2B)" },
  { value: "0100", label: "مبسّطة فقط (B2C)" },
];

// The OTP is user-entered input, sent ONCE to the compliance endpoint. It is
// never written to localStorage or any persistent store — it lives only in this
// form's in-memory state and is cleared on success (reset()).
const complianceSchema = z.object({
  otp: z.string().trim().min(1, "رمز OTP مطلوب"),
  vatNumber: z
    .string()
    .trim()
    .regex(/^\d{15}$/, "الرقم الضريبي يجب أن يكون 15 رقمًا"),
  organizationName: z.string().trim().max(200).optional().or(z.literal("")),
  commonName: z.string().trim().max(200).optional().or(z.literal("")),
  organizationalUnitName: z.string().trim().max(200).optional().or(z.literal("")),
  invoiceType: z.string(),
  sellerLocation: z.string().trim().max(120).optional().or(z.literal("")),
  industryCode: z.string().trim().max(60).optional().or(z.literal("")),
  crNumber: z.string().trim().max(60).optional().or(z.literal("")),
});
type ComplianceForm = z.infer<typeof complianceSchema>;

function currentStep(csid: string): number {
  if (csid === "production") return 4;
  if (csid === "compliance") return 2;
  return 1; // none | revoked | anything else → start over
}

// ── Step 1 — compliance CSID request (OTP + CSR fields) ──────────────────────
function ComplianceStep({ status }: { status: ZatcaStatus }) {
  const { toast } = useToast();
  const mutation = useOnboardCompliance();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ComplianceForm>({
    resolver: zodResolver(complianceSchema),
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
          toast({ title: r.message || "تم تفعيل شهادة الامتثال (CSID)", tone: "success" });
        },
        onError: (e: Error) =>
          toast({ title: "تعذّر طلب الشهادة", description: e.message, tone: "error" }),
      },
    );

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <div className="flex items-start gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-medium text-sky-800">
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>
          احصل على رمز OTP من بوابة فاتورة (Fatoora) لدى هيئة الزكاة والضريبة والجمارك، ثم أدخله
          هنا مع بيانات المنشأة لإصدار شهادة الامتثال.
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="رمز OTP من بوابة فاتورة" required error={errors.otp}>
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
        <Field label="الرقم الضريبي (15 رقمًا)" required error={errors.vatNumber}>
          {({ id, invalid }) => (
            <Input id={id} dir="ltr" inputMode="numeric" invalid={invalid} {...register("vatNumber")} />
          )}
        </Field>
        <Field label="اسم المنشأة" error={errors.organizationName}>
          {({ id }) => <Input id={id} {...register("organizationName")} />}
        </Field>
        <Field label="الاسم الشائع للشهادة" hint="اتركه فارغًا لاستخدام الرقم الضريبي" error={errors.commonName}>
          {({ id }) => <Input id={id} dir="ltr" {...register("commonName")} />}
        </Field>
        <Field label="الوحدة التنظيمية / الفرع" error={errors.organizationalUnitName}>
          {({ id }) => <Input id={id} {...register("organizationalUnitName")} />}
        </Field>
        <Field label="نوع الفواتير" error={errors.invoiceType}>
          {({ id }) => <Select id={id} options={INVOICE_TYPES} {...register("invoiceType")} />}
        </Field>
        <Field label="المدينة / الموقع" error={errors.sellerLocation}>
          {({ id }) => <Input id={id} {...register("sellerLocation")} />}
        </Field>
        <Field label="رمز النشاط الاقتصادي" error={errors.industryCode}>
          {({ id }) => <Input id={id} dir="ltr" inputMode="numeric" {...register("industryCode")} />}
        </Field>
        <Field label="رقم السجل التجاري" error={errors.crNumber} className="sm:col-span-2">
          {({ id }) => <Input id={id} dir="ltr" inputMode="numeric" {...register("crNumber")} />}
        </Field>
      </div>

      <div className="flex justify-end">
        <Button type="submit" loading={mutation.isPending}>
          <ShieldCheck className="h-4 w-4" /> طلب شهادة الامتثال
        </Button>
      </div>
    </form>
  );
}

// ── Step 2 + 3 — synthetic test, then graduate to production ─────────────────
function TestAndProductionStep({ status }: { status: ZatcaStatus }) {
  const { toast } = useToast();
  const testMut = useZatcaTest();
  const prodMut = useOnboardProduction();
  const test = testMut.data;

  const runTest = () =>
    testMut.mutate(undefined, {
      onSuccess: (r) =>
        toast({
          title: r.success ? "تم قبول الفاتورة الاختبارية" : "لم تُقبل الفاتورة الاختبارية",
          description: r.httpStatus ? `استجابة الهيئة: HTTP ${r.httpStatus}` : r.error || undefined,
          tone: r.success ? "success" : "warning",
        }),
      onError: (e: Error) =>
        toast({ title: "تعذّر تنفيذ الاختبار", description: e.message, tone: "error" }),
    });

  const graduate = () =>
    prodMut.mutate(undefined, {
      onSuccess: (r) => toast({ title: r.message || "تم الانتقال إلى الإنتاج", tone: "success" }),
      onError: (e: Error) =>
        toast({ title: "تعذّر الانتقال إلى الإنتاج", description: e.message, tone: "error" }),
    });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700">
        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
        شهادة الامتثال مُفعّلة{status.requestId ? ` · معرّف الطلب ${status.requestId}` : ""}. أرسِل
        فاتورة اختبارية للتحقق ثم انتقل إلى الإنتاج.
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="surface p-4">
          <div className="flex items-center gap-2 text-sm font-extrabold text-slate-900">
            <FlaskConical className="h-4 w-4 text-teal-700" /> اختبار الامتثال
          </div>
          <p className="mt-1 text-xs font-medium text-slate-500">
            يُرسل فاتورة اصطناعية إلى بيئة الامتثال للتحقق من صحة التوقيع والربط.
          </p>
          {test && (
            <div className="mt-2">
              <StatusBadge tone={test.success ? "success" : "warning"}>
                {test.success
                  ? `مقبولة${test.httpStatus ? ` (HTTP ${test.httpStatus})` : ""}`
                  : `مرفوضة${test.httpStatus ? ` (HTTP ${test.httpStatus})` : ""}`}
              </StatusBadge>
            </div>
          )}
          <Button
            variant="secondary"
            className="mt-3 w-full"
            loading={testMut.isPending}
            onClick={runTest}
          >
            <FlaskConical className="h-4 w-4" /> إرسال فاتورة اختبارية
          </Button>
        </div>

        <div className="surface p-4">
          <div className="flex items-center gap-2 text-sm font-extrabold text-slate-900">
            <Rocket className="h-4 w-4 text-teal-700" /> الانتقال إلى الإنتاج
          </div>
          <p className="mt-1 text-xs font-medium text-slate-500">
            بعد نجاح الاختبار، رقِّ الشهادة إلى الإنتاج (Production CSID) لبدء إرسال الفواتير الفعلية.
          </p>
          <Button className="mt-3 w-full" loading={prodMut.isPending} onClick={graduate}>
            <Rocket className="h-4 w-4" /> ترقية إلى الإنتاج
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Step 4 — production active ───────────────────────────────────────────────
function DoneStep({ status }: { status: ZatcaStatus }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-emerald-100 text-emerald-700">
        <CheckCircle2 className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <div className="text-sm font-extrabold text-emerald-800">
          الربط مُفعّل في الإنتاج (Production CSID)
        </div>
        <p className="mt-1 text-xs font-medium text-emerald-700">
          يجري توقيع فواتير المبيعات وإرسالها إلى هيئة الزكاة والضريبة والجمارك تلقائيًا.
          {status.requestId ? ` معرّف الطلب: ${status.requestId}.` : ""}
        </p>
      </div>
    </div>
  );
}

// ── Revoke — clears all server-side credentials (requires a reason) ──────────
function RevokeAction() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const revokeMut = useRevokeZatca();

  return (
    <>
      <div className="flex justify-end border-t border-slate-100 pt-4">
        <Button variant="ghost" className="text-rose-600 hover:bg-rose-50" onClick={() => setOpen(true)}>
          <Ban className="h-4 w-4" /> إبطال الشهادة
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        title="إبطال شهادة ZATCA"
        description="سيتم مسح جميع بيانات الاعتماد المشفّرة من الخادم، ويتوقف إرسال الفواتير حتى إعادة التهيئة."
        tone="danger"
        confirmLabel="إبطال"
        requireReason
        reasonLabel="سبب الإبطال"
        processing={revokeMut.isPending}
        error={revokeMut.isError ? (revokeMut.error as Error).message : null}
        onConfirm={(reason) =>
          revokeMut.mutate(reason, {
            onSuccess: () => {
              setOpen(false);
              toast({ title: "تم إبطال الشهادة", tone: "success" });
            },
            onError: (e: Error) =>
              toast({ title: "تعذّر الإبطال", description: e.message, tone: "error" }),
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
  const csid = status.csidStatus || "none";
  const step = currentStep(csid);
  const hasCredentials = csid === "compliance" || csid === "production";

  return (
    <Can cap="administration.zatca.manage" showDenied>
      <div className="surface space-y-5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-base font-extrabold text-slate-900">تهيئة الربط (المرحلة الثانية)</div>
            <div className="text-xs font-medium text-slate-500">
              التسجيل والحصول على شهادة الامتثال ثم الإنتاج (Onboarding Phase 2).
            </div>
          </div>
          {csid === "revoked" && <StatusBadge tone="danger">مُبطلة</StatusBadge>}
        </div>

        <Stepper steps={STEPS} current={step} />

        {step === 1 && <ComplianceStep status={status} />}
        {step === 2 && <TestAndProductionStep status={status} />}
        {step === 4 && <DoneStep status={status} />}

        <p className="flex items-start gap-2 text-[11px] font-medium text-slate-400">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          المفتاح الخاص والرموز السرية تُحفظ مشفّرة في الخادم ولا تُعرض أو تُخزّن في المتصفح.
        </p>

        {hasCredentials && <RevokeAction />}
      </div>
    </Can>
  );
}
