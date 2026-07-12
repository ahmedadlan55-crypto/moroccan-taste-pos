import { useEffect } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@/shared/forms";
import { Field } from "@/shared/forms";
import {
  Button,
  Checkbox,
  Dialog,
  Input,
  NumberInput,
  Select,
  Toggle,
} from "@/shared/ui";
import { PM_FEE_TYPE_OPTIONS, PM_GROUP_OPTIONS } from "../lib/labels";
import {
  paymentMethodSchema,
  toFormValues,
  toPaymentMethodInput,
  type PaymentMethodFormValues,
} from "../lib/schema";
import type { PaymentMethod, PaymentMethodInput } from "../lib/types";

interface PaymentMethodDialogProps {
  open: boolean;
  /** The record being edited, or null when creating a new method. */
  method: PaymentMethod | null;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (input: PaymentMethodInput) => void;
}

const FLAGS: { name: keyof PaymentMethodFormValues; label: string }[] = [
  { name: "isActive", label: "مفعّل في النظام" },
  { name: "showInShiftClose", label: "إظهار في إغلاق الشيفت" },
  { name: "showInReports", label: "إظهار في التقارير" },
  { name: "allowManualTotal", label: "السماح بإجمالي يدوي" },
  { name: "requireReference", label: "يتطلب مرجع" },
  { name: "requireTransactionNumber", label: "يتطلب رقم عملية" },
  { name: "requireTerminal", label: "يتطلب جهاز" },
  { name: "allowRefund", label: "يسمح بالاسترجاع" },
  { name: "allowCancel", label: "يسمح بالإلغاء" },
];

/** Create/edit modal for a payment method. Drives /settings/payment-methods-full. */
export function PaymentMethodDialog({
  open,
  method,
  saving,
  error,
  onClose,
  onSave,
}: PaymentMethodDialogProps) {
  const {
    control,
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<PaymentMethodFormValues>({
    resolver: zodResolver(paymentMethodSchema),
    defaultValues: toFormValues(method),
  });

  // Re-seed the form whenever the dialog opens (or switches record).
  useEffect(() => {
    if (open) reset(toFormValues(method));
  }, [open, method, reset]);

  const submit = handleSubmit((values) => onSave(toPaymentMethodInput(values, method)));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      title={method ? "تعديل طريقة دفع" : "طريقة دفع جديدة"}
      description="اضبط بيانات الطريقة والرسوم والخصائص — طرق الدفع تُشغّل شاشة الكاشير."
      dismissable={!saving}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            إلغاء
          </Button>
          <Button type="submit" form="pmDialogForm" loading={saving}>
            حفظ
          </Button>
        </>
      }
    >
      <form id="pmDialogForm" onSubmit={submit} className="space-y-5" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="الاسم بالعربية" required error={errors.nameAr}>
            {({ id, invalid }) => <Input id={id} invalid={invalid} {...register("nameAr")} />}
          </Field>
          <Field label="الاسم بالإنجليزية" error={errors.name}>
            {({ id, invalid }) => (
              <Input id={id} dir="ltr" invalid={invalid} {...register("name")} />
            )}
          </Field>

          <Field label="المجموعة" required error={errors.groupType}>
            {({ id, invalid }) => (
              <Controller
                control={control}
                name="groupType"
                render={({ field }) => (
                  <Select
                    id={id}
                    invalid={invalid}
                    options={PM_GROUP_OPTIONS}
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                  />
                )}
              />
            )}
          </Field>
          <Field label="ترتيب العرض" error={errors.sortOrder}>
            {({ id, invalid }) => (
              <Controller
                control={control}
                name="sortOrder"
                render={({ field }) => (
                  <NumberInput
                    id={id}
                    invalid={invalid}
                    min={0}
                    step={1}
                    value={field.value}
                    onChange={(v) => field.onChange(v ?? 0)}
                    onBlur={field.onBlur}
                  />
                )}
              />
            )}
          </Field>

          <Field label="نوع الرسوم" error={errors.serviceFeeType}>
            {({ id, invalid }) => (
              <Controller
                control={control}
                name="serviceFeeType"
                render={({ field }) => (
                  <Select
                    id={id}
                    invalid={invalid}
                    options={PM_FEE_TYPE_OPTIONS}
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                  />
                )}
              />
            )}
          </Field>
          <Field label="قيمة الرسوم" error={errors.serviceFeeValue}>
            {({ id, invalid }) => (
              <Controller
                control={control}
                name="serviceFeeValue"
                render={({ field }) => (
                  <NumberInput
                    id={id}
                    invalid={invalid}
                    min={0}
                    step="any"
                    value={field.value}
                    onChange={(v) => field.onChange(v ?? 0)}
                    onBlur={field.onBlur}
                  />
                )}
              />
            )}
          </Field>
        </div>

        <fieldset className="space-y-3">
          <legend className="text-xs font-extrabold text-slate-600">الخصائص</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {FLAGS.map((flag) => (
              <Controller
                key={flag.name}
                control={control}
                name={flag.name}
                render={({ field }) =>
                  flag.name === "isActive" ? (
                    <Toggle
                      checked={Boolean(field.value)}
                      onChange={field.onChange}
                      label={flag.label}
                    />
                  ) : (
                    <Checkbox
                      checked={Boolean(field.value)}
                      onChange={(e) => field.onChange(e.target.checked)}
                      label={flag.label}
                    />
                  )
                }
              />
            ))}
          </div>
        </fieldset>

        <Field label="وصف" error={errors.description}>
          {({ id }) => (
            <textarea
              id={id}
              rows={2}
              className="field w-full resize-y py-2"
              {...register("description")}
            />
          )}
        </Field>

        {error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
            {error}
          </div>
        )}
      </form>
    </Dialog>
  );
}
