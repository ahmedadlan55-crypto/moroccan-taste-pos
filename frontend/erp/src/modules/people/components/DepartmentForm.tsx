import { useForm } from "react-hook-form";
import { Field, FormActions, zodResolver } from "@/shared/forms";
import { z, arabicText } from "@/shared/schemas";
import { Button, Input } from "@/shared/ui";
import type { Department, DepartmentInput } from "../lib/types";

const deptSchema = z.object({
  name: arabicText({ label: "اسم القسم" }),
  code: z.string().max(30).optional(),
});

type DeptFormValues = z.infer<typeof deptSchema>;

export interface DepartmentFormProps {
  department?: Department | null;
  submitting?: boolean;
  onSubmit: (values: DepartmentInput) => void;
  onCancel: () => void;
}

export function DepartmentForm({ department, submitting, onSubmit, onCancel }: DepartmentFormProps) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<DeptFormValues>({
    resolver: zodResolver(deptSchema),
    defaultValues: { name: department?.name ?? "", code: department?.code ?? "" },
  });

  return (
    <form
      onSubmit={handleSubmit((v) => onSubmit({ id: department?.id, name: v.name, code: v.code || undefined }))}
      className="space-y-4"
      noValidate
    >
      <Field label="اسم القسم" required error={errors.name}>
        {({ id, invalid }) => <Input id={id} invalid={invalid} {...register("name")} />}
      </Field>
      <Field label="الرمز" hint="اتركه فارغًا للتوليد التلقائي" error={errors.code}>
        {({ id }) => <Input id={id} dir="ltr" {...register("code")} />}
      </Field>
      <FormActions>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
          إلغاء
        </Button>
        <Button type="submit" variant="primary" loading={submitting}>
          حفظ
        </Button>
      </FormActions>
    </form>
  );
}
