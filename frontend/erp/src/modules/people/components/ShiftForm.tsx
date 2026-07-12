import { useState } from "react";
import { useForm } from "react-hook-form";
import { Field, FormActions, zodResolver } from "@/shared/forms";
import { z, arabicText } from "@/shared/schemas";
import { Button, Checkbox, Input } from "@/shared/ui";
import { cn } from "@/shared/lib";
import type { Shift, ShiftInput } from "../lib/types";

const shiftSchema = z.object({
  name: arabicText({ label: "اسم الوردية" }),
  code: z.string().max(30).optional(),
  startTime: z.string().min(1, "وقت البداية مطلوب"),
  endTime: z.string().min(1, "وقت النهاية مطلوب"),
  breakMinutes: z.coerce.number().min(0, "لا يمكن أن يكون سالبًا"),
  graceLateMinutes: z.coerce.number().min(0, "لا يمكن أن يكون سالبًا"),
  graceEarlyLeaveMinutes: z.coerce.number().min(0, "لا يمكن أن يكون سالبًا"),
  isDefault: z.boolean().optional(),
});

type ShiftFormValues = z.infer<typeof shiftSchema>;

const DAYS = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

export interface ShiftFormProps {
  shift?: Shift | null;
  submitting?: boolean;
  onSubmit: (values: ShiftInput) => void;
  onCancel: () => void;
}

export function ShiftForm({ shift, submitting, onSubmit, onCancel }: ShiftFormProps) {
  const isEdit = !!shift?.id;
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
    resolver: zodResolver(shiftSchema),
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
        <Field label="اسم الوردية" required error={errors.name}>
          {({ id, invalid }) => <Input id={id} invalid={invalid} {...register("name")} />}
        </Field>
        <Field label="الرمز" error={errors.code}>
          {({ id }) => <Input id={id} dir="ltr" {...register("code")} />}
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="وقت البداية" required error={errors.startTime}>
          {({ id, invalid }) => <Input id={id} type="time" dir="ltr" invalid={invalid} {...register("startTime")} />}
        </Field>
        <Field label="وقت النهاية" required error={errors.endTime}>
          {({ id, invalid }) => <Input id={id} type="time" dir="ltr" invalid={invalid} {...register("endTime")} />}
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="دقائق الراحة" error={errors.breakMinutes}>
          {({ id, invalid }) => <Input id={id} type="number" dir="ltr" invalid={invalid} {...register("breakMinutes")} />}
        </Field>
        <Field label="سماح التأخير (دقيقة)" error={errors.graceLateMinutes}>
          {({ id, invalid }) => <Input id={id} type="number" dir="ltr" invalid={invalid} {...register("graceLateMinutes")} />}
        </Field>
        <Field label="سماح الانصراف المبكر" error={errors.graceEarlyLeaveMinutes}>
          {({ id, invalid }) => (
            <Input id={id} type="number" dir="ltr" invalid={invalid} {...register("graceEarlyLeaveMinutes")} />
          )}
        </Field>
      </div>

      <div>
        <span className="mb-1 block text-xs font-bold text-slate-600">أيام العمل</span>
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
                  "min-h-9 rounded-xl border px-3 text-xs font-bold transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100",
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

      <Checkbox label="اجعلها الوردية الافتراضية" {...register("isDefault")} />

      <FormActions>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
          إلغاء
        </Button>
        <Button type="submit" variant="primary" loading={submitting}>
          {isEdit ? "حفظ التعديلات" : "إضافة الوردية"}
        </Button>
      </FormActions>
    </form>
  );
}
