import { useForm } from "react-hook-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Field, FormActions, zodResolver } from "@/shared/forms";
import { z, requiredId, dateISO } from "@/shared/schemas";
import { Button, Dialog, Input, Select, safeUserMessage, useToast } from "@/shared/ui";
import { useAuth } from "@/app/providers";
import { peopleApi } from "../lib/api";
import { qk } from "../lib/query-keys";

// طلب إجازة (خدمة ذاتية) — port of the legacy employee PWA leave form
// (public/employee/app.js openLeaveForm/submitLeave):
//   • types from GET /hr/leave-types (the same public list endpoint),
//   • submit to POST /hr/my-leave-request with the exact legacy body
//     { username, leaveTypeId, startDate, endDate, reason } — the employee is
//     resolved from the JWT server-side; the balance guard is atomic there.
// No employee picker: this is always "me".

const schema = z
  .object({
    leaveTypeId: requiredId,
    startDate: dateISO,
    endDate: dateISO,
    reason: z.string().max(500, "السبب طويل جدًا").optional(),
  })
  .refine((v) => v.endDate >= v.startDate, {
    message: "تاريخ النهاية يجب ألا يسبق تاريخ البداية",
    path: ["endDate"],
  });

type Values = z.infer<typeof schema>;

export function MyLeaveRequestDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const { user } = useAuth();
  const qc = useQueryClient();

  const leaveTypes = useQuery({
    queryKey: qk.leaveTypes(),
    queryFn: ({ signal }) => peopleApi.listLeaveTypes(signal),
    enabled: open,
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { leaveTypeId: "", startDate: "", endDate: "", reason: "" },
  });

  const submit = useMutation({
    mutationFn: (v: Values) =>
      peopleApi.submitMyLeaveRequest({
        username: user?.username ?? "",
        leaveTypeId: v.leaveTypeId,
        startDate: v.startDate,
        endDate: v.endDate,
        reason: v.reason,
      }),
    onSuccess: (res) => {
      toast({ title: res.message || "تم تقديم طلب الإجازة — بانتظار الموافقة", tone: "success" });
      reset();
      onClose();
      void qc.invalidateQueries({ queryKey: [...qk.all, "self"] });
    },
    onError: (e) => toast({ title: "تعذّر إرسال الطلب", description: safeUserMessage(e), tone: "error" }),
  });

  function close() {
    if (submit.isPending) return;
    reset();
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title="طلب إجازة"
      description="يُرسل الطلب باسمك ويُخصم من رصيدك بعد الاعتماد."
      dismissable={!submit.isPending}
    >
      <form onSubmit={handleSubmit((v) => submit.mutate(v))} className="space-y-4" noValidate>
        <Field label="نوع الإجازة" required error={errors.leaveTypeId}>
          {({ id, invalid }) => (
            <Select id={id} invalid={invalid} placeholder="اختر النوع" defaultValue="" {...register("leaveTypeId")}>
              {(leaveTypes.data ?? []).map((t) => (
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
            <textarea id={id} rows={3} className="field w-full resize-y py-2" placeholder="سبب الإجازة…" {...register("reason")} />
          )}
        </Field>

        <FormActions>
          <Button type="button" variant="secondary" onClick={close} disabled={submit.isPending}>
            إلغاء
          </Button>
          <Button type="submit" variant="primary" loading={submit.isPending}>
            إرسال الطلب
          </Button>
        </FormActions>
      </form>
    </Dialog>
  );
}
