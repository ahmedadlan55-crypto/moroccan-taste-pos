import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { Field, FormActions, zodResolver } from "@/shared/forms";
import { z } from "@/shared/schemas";
import { Button, Checkbox, Input } from "@/shared/ui";
import { useTx } from "@/shared/ui/i18n";
import { cn } from "@/shared/lib";
import type { TFunction } from "@/i18n";
import type { Shift, ShiftInput } from "../lib/types";

const makeShiftSchema = (t: TFunction) =>
  z.object({
    name: z
      .string({ required_error: t("people.shiftForm.nameRequired") })
      .trim()
      .min(1, t("people.shiftForm.nameRequired")),
    code: z.string().max(30).optional(),
    startTime: z.string().min(1, t("people.shiftForm.startRequired")),
    endTime: z.string().min(1, t("people.shiftForm.endRequired")),
    breakMinutes: z.coerce.number().min(0, t("people.shiftForm.nonNegative")),
    graceLateMinutes: z.coerce.number().min(0, t("people.shiftForm.nonNegative")),
    graceEarlyLeaveMinutes: z.coerce.number().min(0, t("people.shiftForm.nonNegative")),
    isDefault: z.boolean().optional(),
  });

type ShiftFormValues = z.infer<ReturnType<typeof makeShiftSchema>>;

export interface ShiftFormProps {
  shift?: Shift | null;
  submitting?: boolean;
  onSubmit: (values: ShiftInput) => void;
  onCancel: () => void;
}

export function ShiftForm({ shift, submitting, onSubmit, onCancel }: ShiftFormProps) {
  const t = useTx();
  const isEdit = !!shift?.id;
  const schema = useMemo(() => makeShiftSchema(t), [t]);
  const DAYS = [0, 1, 2, 3, 4, 5, 6].map((d) => t(`people.day.${d}`));
  const [workDays, setWorkDays] = useState<number[]>(
    (shift?.workDays ?? "0,1,2,3,4")
      .split(",")
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n)),
  );

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ShiftFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: shift?.name ?? "",
      code: shift?.code ?? "",
      startTime: (shift?.startTime ?? "08:00").slice(0, 5),
      endTime: (shift?.endTime ?? "17:00").slice(0, 5),
      breakMinutes: shift?.breakMinutes ?? 60,
      graceLateMinutes: shift?.graceLateMinutes ?? 5,
      graceEarlyLeaveMinutes: shift?.graceEarlyLeaveMinutes ?? 0,
      isDefault: shift?.isDefault ?? false,
    },
  });

  const toggleDay = (d: number) =>
    setWorkDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort((a, b) => a - b)));

  const submit = (values: ShiftFormValues) => {
    onSubmit({
      id: shift?.id,
      name: values.name,
      code: values.code || undefined,
      startTime: values.startTime,
      endTime: values.endTime,
      breakMinutes: values.breakMinutes,
      graceLateMinutes: values.graceLateMinutes,
      graceEarlyLeaveMinutes: values.graceEarlyLeaveMinutes,
      workDays: workDays.join(","),
      isDefault: !!values.isDefault,
    });
  };

  return (
    <form onSubmit={handleSubmit(submit)} className="space-y-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("people.shiftForm.name")} required error={errors.name}>
          {({ id, invalid }) => <Input id={id} invalid={invalid} {...register("name")} />}
        </Field>
        <Field label={t("people.shiftForm.code")} error={errors.code}>
          {({ id }) => <Input id={id} dir="ltr" {...register("code")} />}
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("people.shiftForm.startTime")} required error={errors.startTime}>
          {({ id, invalid }) => <Input id={id} type="time" dir="ltr" invalid={invalid} {...register("startTime")} />}
        </Field>
        <Field label={t("people.shiftForm.endTime")} required error={errors.endTime}>
          {({ id, invalid }) => <Input id={id} type="time" dir="ltr" invalid={invalid} {...register("endTime")} />}
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t("people.shiftForm.breakMinutes")} error={errors.breakMinutes}>
          {({ id, invalid }) => <Input id={id} type="number" dir="ltr" invalid={invalid} {...register("breakMinutes")} />}
        </Field>
        <Field label={t("people.shiftForm.graceLate")} error={errors.graceLateMinutes}>
          {({ id, invalid }) => <Input id={id} type="number" dir="ltr" invalid={invalid} {...register("graceLateMinutes")} />}
        </Field>
        <Field label={t("people.shiftForm.graceEarly")} error={errors.graceEarlyLeaveMinutes}>
          {({ id, invalid }) => (
            <Input id={id} type="number" dir="ltr" invalid={invalid} {...register("graceEarlyLeaveMinutes")} />
          )}
        </Field>
      </div>

      <div>
        <span className="mb-1 block text-xs font-bold text-slate-600">{t("people.shiftForm.workDays")}</span>
        <div className="flex flex-wrap gap-2">
          {DAYS.map((label, d) => {
            const on = workDays.includes(d);
            return (
              <button
                key={d}
                type="button"
                onClick={() => toggleDay(d)}
                aria-pressed={on}
                className={cn(
                  "min-h-11 rounded-xl border px-3 text-xs font-bold transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100",
                  on
                    ? "border-teal-600 bg-teal-600 text-white"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <Checkbox label={t("people.shiftForm.makeDefault")} {...register("isDefault")} />

      <FormActions>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" loading={submitting}>
          {isEdit ? t("people.shiftForm.saveEdit") : t("people.shiftForm.add")}
        </Button>
      </FormActions>
    </form>
  );
}
