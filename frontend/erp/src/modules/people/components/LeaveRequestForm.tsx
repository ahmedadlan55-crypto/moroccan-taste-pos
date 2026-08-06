import { useMemo } from "react";
import { Controller, useForm } from "react-hook-form";
import { Field, FormActions, zodResolver } from "@/shared/forms";
import { z, requiredId, dateISO } from "@/shared/schemas";
import { Button, DatePicker, Select } from "@/shared/ui";
import { useTx } from "@/shared/ui/i18n";
import type { TFunction } from "@/i18n";
import type { Employee, LeaveType } from "../lib/types";

// requiredId / dateISO are shared primitives whose messages localize via
// FieldError's reverse map; only the custom messages are sourced from t().
const makeLeaveSchema = (t: TFunction) =>
  z
    .object({
      employeeId: requiredId,
      leaveTypeId: requiredId,
      startDate: dateISO,
      endDate: dateISO,
      reason: z.string().max(500, t("people.leaveForm.reasonTooLong")).optional(),
    })
    .refine((v) => v.endDate >= v.startDate, {
      message: t("people.leaveForm.endBeforeStart"),
      path: ["endDate"],
    });

export type LeaveFormValues = z.infer<ReturnType<typeof makeLeaveSchema>>;

export interface LeaveRequestFormProps {
  employees: Employee[];
  leaveTypes: LeaveType[];
  submitting?: boolean;
  onSubmit: (values: LeaveFormValues) => void;
  onCancel: () => void;
}

/** Create-a-leave-request form (react-hook-form + zod). Prop-driven so it can be
 *  rendered standalone (and unit-tested) without the surrounding data layer. */
export function LeaveRequestForm({ employees, leaveTypes, submitting, onSubmit, onCancel }: LeaveRequestFormProps) {
  const t = useTx();
  const schema = useMemo(() => makeLeaveSchema(t), [t]);
  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<LeaveFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { employeeId: "", leaveTypeId: "", startDate: "", endDate: "", reason: "" },
  });

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <Field label={t("people.leaveForm.employee")} required error={errors.employeeId}>
        {({ id, invalid }) => (
          <Select id={id} invalid={invalid} placeholder={t("people.leaveForm.pickEmployee")} defaultValue="" {...register("employeeId")}>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.fullName} {e.employeeNumber ? `— ${e.employeeNumber}` : ""}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <Field label={t("people.leaveForm.leaveType")} required error={errors.leaveTypeId}>
        {({ id, invalid }) => (
          <Select id={id} invalid={invalid} placeholder={t("people.leaveForm.pickType")} defaultValue="" {...register("leaveTypeId")}>
            {leaveTypes.map((lt) => (
              <option key={lt.id} value={lt.id}>
                {lt.name}
                {lt.isPaid ? t("people.leaveForm.paidSuffix") : t("people.leaveForm.unpaidSuffix")}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("people.leaveForm.fromDate")} required error={errors.startDate}>
          {({ id, invalid }) => (
            <Controller
              name="startDate"
              control={control}
              render={({ field }) => (
                <DatePicker id={id} invalid={invalid} name={field.name} ref={field.ref} value={field.value} onChange={field.onChange} onBlur={field.onBlur} />
              )}
            />
          )}
        </Field>
        <Field label={t("people.leaveForm.toDate")} required error={errors.endDate}>
          {({ id, invalid }) => (
            <Controller
              name="endDate"
              control={control}
              render={({ field }) => (
                <DatePicker id={id} invalid={invalid} name={field.name} ref={field.ref} value={field.value} onChange={field.onChange} onBlur={field.onBlur} />
              )}
            />
          )}
        </Field>
      </div>

      <Field label={t("people.leaveForm.reason")} error={errors.reason} hint={t("people.leaveForm.reasonOptional")}>
        {({ id }) => (
          <textarea
            id={id}
            rows={3}
            className="field w-full resize-y py-2"
            placeholder={t("people.leaveForm.reasonPlaceholder")}
            {...register("reason")}
          />
        )}
      </Field>

      <FormActions>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" loading={submitting}>
          {t("people.leaveForm.submit")}
        </Button>
      </FormActions>
    </form>
  );
}
