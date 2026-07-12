import { useForm } from "react-hook-form";
import { Field, FormActions, zodResolver } from "@/shared/forms";
import { z, requiredId, dateISO } from "@/shared/schemas";
import { Button, Input, Select } from "@/shared/ui";
import type { Employee, LeaveType } from "../lib/types";

const leaveSchema = z
  .object({
    employeeId: requiredId,
    leaveTypeId: requiredId,
    startDate: dateISO,
    endDate: dateISO,
    reason: z.string().max(500, "السبب طويل جدًا").optional(),
  })
  .refine((v) => v.endDate >= v.startDate, {
    message: "تاريخ النهاية يجب ألا يسبق تاريخ البداية",
    path: ["endDate"],
  });

export type LeaveFormValues = z.infer<typeof leaveSchema>;

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
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LeaveFormValues>({
    resolver: zodResolver(leaveSchema),
    defaultValues: { employeeId: "", leaveTypeId: "", startDate: "", endDate: "", reason: "" },
  });

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <Field label="الموظف" required error={errors.employeeId}>
        {({ id, invalid }) => (
          <Select id={id} invalid={invalid} placeholder="اختر الموظف" defaultValue="" {...register("employeeId")}>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.fullName} {e.employeeNumber ? `— ${e.employeeNumber}` : ""}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <Field label="نوع الإجازة" required error={errors.leaveTypeId}>
        {({ id, invalid }) => (
          <Select id={id} invalid={invalid} placeholder="اختر النوع" defaultValue="" {...register("leaveTypeId")}>
            {leaveTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.isPaid ? " (مدفوعة)" : " (غير مدفوعة)"}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="من تاريخ" required error={errors.startDate}>
          {({ id, invalid }) => <Input id={id} type="date" dir="ltr" invalid={invalid} {...register("startDate")} />}
        </Field>
        <Field label="إلى تاريخ" required error={errors.endDate}>
          {({ id, invalid }) => <Input id={id} type="date" dir="ltr" invalid={invalid} {...register("endDate")} />}
        </Field>
      </div>

      <Field label="السبب" error={errors.reason} hint="اختياري">
        {({ id }) => (
          <textarea
            id={id}
            rows={3}
            className="field w-full resize-y py-2"
            placeholder="سبب الإجازة…"
            {...register("reason")}
          />
        )}
      </Field>

      <FormActions>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
          إلغاء
        </Button>
        <Button type="submit" variant="primary" loading={submitting}>
          إرسال الطلب
        </Button>
      </FormActions>
    </form>
  );
}
