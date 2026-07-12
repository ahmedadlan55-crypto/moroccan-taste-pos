import { useForm } from "react-hook-form";
import { Field, FormActions, zodResolver } from "@/shared/forms";
import { z, arabicText, money, optionalEmail, saudiPhone } from "@/shared/schemas";
import { Button, Checkbox, Input, Select } from "@/shared/ui";
import type { Department, EmployeeDetail, EmployeeInput } from "../lib/types";

const employeeSchema = z.object({
  firstName: arabicText({ label: "الاسم الأول" }),
  lastName: z.string().max(120).optional(),
  nationalId: z.string().max(30).optional(),
  phone: saudiPhone,
  email: optionalEmail,
  departmentId: z.string().optional(),
  jobTitle: z.string().max(120).optional(),
  employmentType: z.string().min(1, "نوع التوظيف مطلوب"),
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

export type EmployeeFormValues = z.infer<typeof employeeSchema>;

const EMPLOYMENT_TYPES = [
  { value: "full_time", label: "دوام كامل" },
  { value: "part_time", label: "دوام جزئي" },
  { value: "hourly", label: "بالساعة" },
  { value: "contract", label: "عقد" },
];

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
  const isEdit = !!employee?.id;
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<EmployeeFormValues>({
    resolver: zodResolver(employeeSchema),
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
        <Field label="الاسم الأول" required error={errors.firstName}>
          {({ id, invalid }) => <Input id={id} invalid={invalid} {...register("firstName")} />}
        </Field>
        <Field label="اسم العائلة" error={errors.lastName}>
          {({ id }) => <Input id={id} {...register("lastName")} />}
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="رقم الهوية" error={errors.nationalId}>
          {({ id }) => <Input id={id} dir="ltr" {...register("nationalId")} />}
        </Field>
        <Field label="الجوال" error={errors.phone}>
          {({ id, invalid }) => <Input id={id} dir="ltr" invalid={invalid} {...register("phone")} />}
        </Field>
        <Field label="البريد الإلكتروني" error={errors.email}>
          {({ id, invalid }) => <Input id={id} dir="ltr" invalid={invalid} {...register("email")} />}
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="القسم" error={errors.departmentId}>
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
        <Field label="المسمى الوظيفي" error={errors.jobTitle}>
          {({ id }) => <Input id={id} {...register("jobTitle")} />}
        </Field>
        <Field label="نوع التوظيف" required error={errors.employmentType}>
          {({ id, invalid }) => (
            <Select id={id} invalid={invalid} options={EMPLOYMENT_TYPES} {...register("employmentType")} />
          )}
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="الراتب الأساسي" error={errors.basicSalary}>
          {({ id, invalid }) => <Input id={id} type="number" step="0.01" dir="ltr" invalid={invalid} {...register("basicSalary")} />}
        </Field>
        <Field label="بدل سكن" error={errors.housingAllowance}>
          {({ id, invalid }) => <Input id={id} type="number" step="0.01" dir="ltr" invalid={invalid} {...register("housingAllowance")} />}
        </Field>
        <Field label="بدل نقل" error={errors.transportAllowance}>
          {({ id, invalid }) => <Input id={id} type="number" step="0.01" dir="ltr" invalid={invalid} {...register("transportAllowance")} />}
        </Field>
        <Field label="بدلات أخرى" error={errors.otherAllowance}>
          {({ id, invalid }) => <Input id={id} type="number" step="0.01" dir="ltr" invalid={invalid} {...register("otherAllowance")} />}
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="تاريخ التعيين" error={errors.hireDate}>
          {({ id }) => <Input id={id} type="date" dir="ltr" {...register("hireDate")} />}
        </Field>
        <Field label="نهاية العقد" error={errors.contractEndDate}>
          {({ id }) => <Input id={id} type="date" dir="ltr" {...register("contractEndDate")} />}
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="البنك" error={errors.bankName}>
          {({ id }) => <Input id={id} {...register("bankName")} />}
        </Field>
        <Field label="الآيبان (IBAN)" error={errors.bankIban}>
          {({ id }) => <Input id={id} dir="ltr" {...register("bankIban")} />}
        </Field>
      </div>

      <Field label="ملاحظات" error={errors.notes}>
        {({ id }) => <textarea id={id} rows={2} className="field w-full resize-y py-2" {...register("notes")} />}
      </Field>

      {!isEdit && (
        <Checkbox label="إنشاء حساب دخول للنظام تلقائيًا" defaultChecked {...register("createUser")} />
      )}

      <FormActions>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
          إلغاء
        </Button>
        <Button type="submit" variant="primary" loading={submitting}>
          {isEdit ? "حفظ التعديلات" : "إضافة الموظف"}
        </Button>
      </FormActions>
    </form>
  );
}
