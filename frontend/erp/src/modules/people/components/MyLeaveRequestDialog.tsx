import { useMemo } from "react";
import { useForm } from "react-hook-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Field, FormActions, zodResolver } from "@/shared/forms";
import { z, requiredId, dateISO } from "@/shared/schemas";
import { Button, Dialog, Input, Select, safeUserMessage, useToast } from "@/shared/ui";
import { useTx } from "@/shared/ui/i18n";
import type { TFunction } from "@/i18n";
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

const makeSchema = (t: TFunction) =>
  z
    .object({
      leaveTypeId: requiredId,
      startDate: dateISO,
      endDate: dateISO,
      reason: z.string().max(500, t("people.leaveForm.reasonTooLong")).optional(),
    })
    .refine((v) => v.endDate >= v.startDate, {
      message: t("people.leaveForm.endBeforeStart"),
      path: ["endDate"],
    });

type Values = z.infer<ReturnType<typeof makeSchema>>;

export function MyLeaveRequestDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTx();
  const { toast } = useToast();
  const { user } = useAuth();
  const qc = useQueryClient();
  const schema = useMemo(() => makeSchema(t), [t]);

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
      toast({ title: res.message || t("people.leaveForm.submitted"), tone: "success" });
      reset();
      onClose();
      void qc.invalidateQueries({ queryKey: [...qk.all, "self"] });
    },
    onError: (e) => toast({ title: t("people.leaveForm.sendFailed"), description: safeUserMessage(e, t), tone: "error" }),
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
      title={t("people.leaveForm.dialogTitle")}
      description={t("people.leaveForm.dialogDesc")}
      dismissable={!submit.isPending}
    >
      <form onSubmit={handleSubmit((v) => submit.mutate(v))} className="space-y-4" noValidate>
        <Field label={t("people.leaveForm.leaveType")} required error={errors.leaveTypeId}>
          {({ id, invalid }) => (
            <Select id={id} invalid={invalid} placeholder={t("people.leaveForm.pickType")} defaultValue="" {...register("leaveTypeId")}>
              {(leaveTypes.data ?? []).map((lt) => (
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
            {({ id, invalid }) => <Input id={id} type="date" dir="ltr" invalid={invalid} {...register("startDate")} />}
          </Field>
          <Field label={t("people.leaveForm.toDate")} required error={errors.endDate}>
            {({ id, invalid }) => <Input id={id} type="date" dir="ltr" invalid={invalid} {...register("endDate")} />}
          </Field>
        </div>

        <Field label={t("people.leaveForm.reason")} error={errors.reason} hint={t("people.leaveForm.reasonOptional")}>
          {({ id }) => (
            <textarea id={id} rows={3} className="field w-full resize-y py-2" placeholder={t("people.leaveForm.reasonPlaceholder")} {...register("reason")} />
          )}
        </Field>

        <FormActions>
          <Button type="button" variant="secondary" onClick={close} disabled={submit.isPending}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" loading={submit.isPending}>
            {t("people.leaveForm.submit")}
          </Button>
        </FormActions>
      </form>
    </Dialog>
  );
}
