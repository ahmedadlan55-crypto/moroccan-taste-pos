import { useEffect, useMemo } from "react";
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
import { useT } from "@/i18n";
import { pmFeeTypeOptions, pmGroupOptions } from "../lib/labels";
import {
  makePaymentMethodSchema,
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

/** Boolean flag fields — the label i18n key lives under posAdmin.dialog.flags.*. */
const FLAGS: { name: keyof PaymentMethodFormValues; labelKey: string }[] = [
  { name: "isActive", labelKey: "posAdmin.dialog.flags.isActive" },
  { name: "showInShiftClose", labelKey: "posAdmin.dialog.flags.showInShiftClose" },
  { name: "showInReports", labelKey: "posAdmin.dialog.flags.showInReports" },
  { name: "allowManualTotal", labelKey: "posAdmin.dialog.flags.allowManualTotal" },
  { name: "requireReference", labelKey: "posAdmin.dialog.flags.requireReference" },
  { name: "requireTransactionNumber", labelKey: "posAdmin.dialog.flags.requireTransactionNumber" },
  { name: "requireTerminal", labelKey: "posAdmin.dialog.flags.requireTerminal" },
  { name: "allowRefund", labelKey: "posAdmin.dialog.flags.allowRefund" },
  { name: "allowCancel", labelKey: "posAdmin.dialog.flags.allowCancel" },
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
  const t = useT();
  const schema = useMemo(() => makePaymentMethodSchema(t), [t]);
  const groupOptions = useMemo(() => pmGroupOptions(t), [t]);
  const feeTypeOptions = useMemo(() => pmFeeTypeOptions(t), [t]);
  const {
    control,
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<PaymentMethodFormValues>({
    resolver: zodResolver(schema),
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
      title={method ? t("posAdmin.dialog.editTitle") : t("posAdmin.dialog.newTitle")}
      description={t("posAdmin.dialog.desc")}
      dismissable={!saving}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form="pmDialogForm" loading={saving}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <form id="pmDialogForm" onSubmit={submit} className="space-y-5" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("posAdmin.dialog.nameAr")} required error={errors.nameAr}>
            {({ id, invalid }) => <Input id={id} invalid={invalid} {...register("nameAr")} />}
          </Field>
          <Field label={t("posAdmin.dialog.nameEn")} error={errors.name}>
            {({ id, invalid }) => (
              <Input id={id} dir="ltr" invalid={invalid} {...register("name")} />
            )}
          </Field>

          <Field label={t("posAdmin.col.group")} required error={errors.groupType}>
            {({ id, invalid }) => (
              <Controller
                control={control}
                name="groupType"
                render={({ field }) => (
                  <Select
                    id={id}
                    invalid={invalid}
                    options={groupOptions}
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                  />
                )}
              />
            )}
          </Field>
          <Field label={t("posAdmin.dialog.sortOrder")} error={errors.sortOrder}>
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

          <Field label={t("posAdmin.dialog.feeType")} error={errors.serviceFeeType}>
            {({ id, invalid }) => (
              <Controller
                control={control}
                name="serviceFeeType"
                render={({ field }) => (
                  <Select
                    id={id}
                    invalid={invalid}
                    options={feeTypeOptions}
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                  />
                )}
              />
            )}
          </Field>
          <Field label={t("posAdmin.dialog.feeValue")} error={errors.serviceFeeValue}>
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
          <legend className="text-xs font-extrabold text-slate-600">
            {t("posAdmin.dialog.flagsLegend")}
          </legend>
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
                      label={t(flag.labelKey)}
                    />
                  ) : (
                    <Checkbox
                      checked={Boolean(field.value)}
                      onChange={(e) => field.onChange(e.target.checked)}
                      label={t(flag.labelKey)}
                    />
                  )
                }
              />
            ))}
          </div>
        </fieldset>

        <Field label={t("posAdmin.dialog.description")} error={errors.description}>
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
