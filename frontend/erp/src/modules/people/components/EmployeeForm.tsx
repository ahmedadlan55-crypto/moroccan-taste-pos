import { useMemo } from "react";
import { Controller, useForm } from "react-hook-form";
import { Field, FormActions, zodResolver } from "@/shared/forms";
import { z, money, optionalEmail, saudiPhone } from "@/shared/schemas";
import { Button, Checkbox, DatePicker, Input, Select } from "@/shared/ui";
import { useTx } from "@/shared/ui/i18n";
import type { TFunction } from "@/i18n";
import type { Department, EmployeeDetail, EmployeeInput } from "../lib/types";

// Schema is built per-render from t() so validation messages follow the UI
// language (the sanctioned makeSchema(t) pattern). Shared primitives (money /
// saudiPhone / optionalEmail) localize via FieldError's reverse map.
const makeEmployeeSchema = (t: TFunction) =>
  z.object({
    firstName: z
      .string({ required_error: t("people.employeeForm.firstNameRequired") })
      .trim()
      .min(1, t("people.employeeForm.firstNameRequired")),
    lastName: z.string().max(120).optional(),
    nationalId: z.string().max(30).optional(),
    phone: saudiPhone,
    email: optionalEmail,
    departmentId: z.string().optional(),
    jobTitle: z.string().max(120).optional(),
    employmentType: z.string().min(1, t("people.employeeForm.employmentTypeRequired")),
    basicSalary: money,
    housingAllowance: money,
    transportAllowance: money,
    otherAllowance: money,
    hireDate: z.string().optional(),
    contractEndDate: z.string().optional(),
    bankName: z.string().max(120).optional(),
    bankIban: z.string().max(40).optional(),
    notes: z.string().max(500).optional(),
    createUser: z.boolean().optional(),
  });

export type EmployeeFormValues = z.infer<ReturnType<typeof makeEmployeeSchema>>;

export interface EmployeeFormProps {
  employee?: EmployeeDetail | null;
  departments: Department[];
  submitting?: boolean;
  onSubmit: (values: EmployeeInput) => void;
  onCancel: () => void;
}

/** Create / edit an employee (react-hook-form + zod). Salary math and the
 *  employee number are owned by the server — this only captures the raw fields. */
export function EmployeeForm({ employee, departments, submitting, onSubmit, onCancel }: EmployeeFormProps) {
  const t = useTx();
  const isEdit = !!employee?.id;
  const schema = useMemo(() => makeEmployeeSchema(t), [t]);
  const EMPLOYMENT_TYPES = [
    { value: "full_time", label: t("people.employmentType.full_time") },
    { value: "part_time", label: t("people.employmentType.part_time") },
    { value: "hourly", label: t("people.employmentType.hourly") },
    { value: "contract", label: t("people.employmentType.contract") },
  ];
  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<EmployeeFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      firstName: employee?.firstName ?? "",
      lastName: employee?.lastName ?? "",
      nationalId: employee?.nationalId ?? "",
      phone: employee?.phone ?? "",
      email: employee?.email ?? "",
      departmentId: employee?.departmentId ?? "",
      jobTitle: employee?.jobTitle ?? "",
      employmentType: employee?.employmentType ?? "full_time",
      basicSalary: employee?.basicSalary ?? 0,
      housingAllowance: employee?.housingAllowance ?? 0,
      transportAllowance: employee?.transportAllowance ?? 0,
      otherAllowance: employee?.otherAllowance ?? 0,
      hireDate: (employee?.hireDate ?? "").slice(0, 10),
      contractEndDate: (employee?.contractEndDate ?? "").slice(0, 10),
      bankName: employee?.bankName ?? "",
      bankIban: employee?.bankIban ?? "",
      notes: employee?.notes ?? "",
      createUser: !isEdit,
    },
  });

  const submit = (values: EmployeeFormValues) => {
    onSubmit({
      firstName: values.firstName,
      lastName: values.lastName || undefined,
      nationalId: values.nationalId || undefined,
      phone: values.phone || undefined,
      email: values.email || undefined,
      departmentId: values.departmentId || undefined,
      jobTitle: values.jobTitle || undefined,
      employmentType: values.employmentType,
      basicSalary: values.basicSalary,
      housingAllowance: values.housingAllowance,
      transportAllowance: values.transportAllowance,
      otherAllowance: values.otherAllowance,
      hireDate: values.hireDate || undefined,
      contractEndDate: values.contractEndDate || undefined,
      bankName: values.bankName || undefined,
      bankIban: values.bankIban || undefined,
      notes: values.notes || undefined,
      createUser: isEdit ? undefined : values.createUser,
    });
  };

  return (
    <form onSubmit={handleSubmit(submit)} className="space-y-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("people.employeeForm.firstName")} required error={errors.firstName}>
          {({ id, invalid }) => <Input id={id} invalid={invalid} {...register("firstName")} />}
        </Field>
        <Field label={t("people.employeeForm.lastName")} error={errors.lastName}>
          {({ id }) => <Input id={id} {...register("lastName")} />}
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t("people.employeeForm.idNumber")} error={errors.nationalId}>
          {({ id }) => <Input id={id} dir="ltr" {...register("nationalId")} />}
        </Field>
        <Field label={t("people.employeeForm.phone")} error={errors.phone}>
          {({ id, invalid }) => <Input id={id} dir="ltr" invalid={invalid} {...register("phone")} />}
        </Field>
        <Field label={t("people.employeeForm.email")} error={errors.email}>
          {({ id, invalid }) => <Input id={id} dir="ltr" invalid={invalid} {...register("email")} />}
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t("people.employeeForm.department")} error={errors.departmentId}>
          {({ id }) => (
            <Select id={id} defaultValue="" {...register("departmentId")}>
              <option value="">—</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t("people.employeeForm.jobTitle")} error={errors.jobTitle}>
          {({ id }) => <Input id={id} {...register("jobTitle")} />}
        </Field>
        <Field label={t("people.employeeForm.employmentType")} required error={errors.employmentType}>
          {({ id, invalid }) => (
            <Select id={id} invalid={invalid} options={EMPLOYMENT_TYPES} {...register("employmentType")} />
          )}
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label={t("people.employeeForm.basicSalary")} error={errors.basicSalary}>
          {({ id, invalid }) => <Input id={id} type="number" step="0.01" dir="ltr" invalid={invalid} {...register("basicSalary")} />}
        </Field>
        <Field label={t("people.employeeForm.housing")} error={errors.housingAllowance}>
          {({ id, invalid }) => <Input id={id} type="number" step="0.01" dir="ltr" invalid={invalid} {...register("housingAllowance")} />}
        </Field>
        <Field label={t("people.employeeForm.transport")} error={errors.transportAllowance}>
          {({ id, invalid }) => <Input id={id} type="number" step="0.01" dir="ltr" invalid={invalid} {...register("transportAllowance")} />}
        </Field>
        <Field label={t("people.employeeForm.otherAllowance")} error={errors.otherAllowance}>
          {({ id, invalid }) => <Input id={id} type="number" step="0.01" dir="ltr" invalid={invalid} {...register("otherAllowance")} />}
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("people.employeeForm.hireDate")} error={errors.hireDate}>
          {({ id }) => (
            <Controller
              name="hireDate"
              control={control}
              render={({ field }) => (
                <DatePicker id={id} name={field.name} ref={field.ref} value={field.value ?? ""} onChange={field.onChange} onBlur={field.onBlur} />
              )}
            />
          )}
        </Field>
        <Field label={t("people.employeeForm.contractEnd")} error={errors.contractEndDate}>
          {({ id }) => (
            <Controller
              name="contractEndDate"
              control={control}
              render={({ field }) => (
                <DatePicker id={id} name={field.name} ref={field.ref} value={field.value ?? ""} onChange={field.onChange} onBlur={field.onBlur} />
              )}
            />
          )}
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("people.employeeForm.bank")} error={errors.bankName}>
          {({ id }) => <Input id={id} {...register("bankName")} />}
        </Field>
        <Field label={t("people.employeeForm.iban")} error={errors.bankIban}>
          {({ id }) => <Input id={id} dir="ltr" {...register("bankIban")} />}
        </Field>
      </div>

      <Field label={t("people.employeeForm.notes")} error={errors.notes}>
        {({ id }) => <textarea id={id} rows={2} className="field w-full resize-y py-2" {...register("notes")} />}
      </Field>

      {!isEdit && (
        <Checkbox label={t("people.employeeForm.createUser")} defaultChecked {...register("createUser")} />
      )}

      <FormActions>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" loading={submitting}>
          {isEdit ? t("people.employeeForm.saveEdit") : t("people.employeeForm.add")}
        </Button>
      </FormActions>
    </form>
  );
}
