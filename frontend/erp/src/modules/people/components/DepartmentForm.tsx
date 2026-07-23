import { useMemo } from "react";
import { useForm } from "react-hook-form";
import { Field, FormActions, zodResolver } from "@/shared/forms";
import { z } from "@/shared/schemas";
import { Button, Input } from "@/shared/ui";
import { useTx } from "@/shared/ui/i18n";
import type { TFunction } from "@/i18n";
import type { Department, DepartmentInput } from "../lib/types";

const makeDeptSchema = (t: TFunction) =>
  z.object({
    name: z
      .string({ required_error: t("people.departmentForm.nameRequired") })
      .trim()
      .min(1, t("people.departmentForm.nameRequired")),
    code: z.string().max(30).optional(),
  });

type DeptFormValues = z.infer<ReturnType<typeof makeDeptSchema>>;

export interface DepartmentFormProps {
  department?: Department | null;
  submitting?: boolean;
  onSubmit: (values: DepartmentInput) => void;
  onCancel: () => void;
}

export function DepartmentForm({ department, submitting, onSubmit, onCancel }: DepartmentFormProps) {
  const t = useTx();
  const schema = useMemo(() => makeDeptSchema(t), [t]);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<DeptFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: department?.name ?? "", code: department?.code ?? "" },
  });

  return (
    <form
      onSubmit={handleSubmit((v) => onSubmit({ id: department?.id, name: v.name, code: v.code || undefined }))}
      className="space-y-4"
      noValidate
    >
      <Field label={t("people.departmentForm.name")} required error={errors.name}>
        {({ id, invalid }) => <Input id={id} invalid={invalid} {...register("name")} />}
      </Field>
      <Field label={t("people.departmentForm.code")} hint={t("people.departmentForm.codeHint")} error={errors.code}>
        {({ id }) => <Input id={id} dir="ltr" {...register("code")} />}
      </Field>
      <FormActions>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" loading={submitting}>
          {t("common.save")}
        </Button>
      </FormActions>
    </form>
  );
}
