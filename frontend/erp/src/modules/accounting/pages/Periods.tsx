import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { CalendarRange, KeyRound, Lock, LockOpen, Plus, ShieldHalf } from "lucide-react";
import {
  Button, ConfirmDialog, DatePicker, Dialog, EmptyState, ErrorState, Input, LoadingState,
  PageHeader, PanelTitle, StatusBadge, useToast,
} from "@/shared/ui";
import { Field } from "@/shared/forms";
import { usePermissions } from "@/app/providers";
import { useT } from "@/i18n";
import {
  allowedPeriodTransitions, useLockPeriod, usePeriods, useSavePeriod,
  type AccountingPeriod, type PeriodStatus,
} from "../api";

// /accounting/periods — converted from the legacy-only `erpLoadPeriods` screen.
//
// The server does the real work (routes/erp.js POST /periods/:id/lock): a hard
// close GENERATES closing journal entries and a reopen REVERSES them with an
// offsetting entry rather than deleting anything. That is why reopening a
// hard-closed period demands force:true — it moves the ledger. The UI states
// that plainly instead of asking "تأكيد؟" like the legacy confirm() did.

const TONE: Record<PeriodStatus, "success" | "warning" | "danger"> = {
  open: "success",
  soft_closed: "warning",
  closed: "danger",
};

// Transition icon per target status; the label/body copy lives in the i18n dict
// (accounting.periods.transition.<status>.{label,body}).
const TRANSITION_ICON: Record<PeriodStatus, typeof Lock> = {
  soft_closed: ShieldHalf,
  closed: Lock,
  open: LockOpen,
};

interface PeriodForm {
  periodName: string;
  startDate: string;
  endDate: string;
}

export function PeriodsPage() {
  const t = useT();
  const { can } = usePermissions();
  const canManage = can("accounting.periods.manage");
  const { toast } = useToast();
  const { data, isLoading, isError, error, refetch } = usePeriods();
  const save = useSavePeriod();
  const lock = useLockPeriod();

  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<{ period: AccountingPeriod; to: PeriodStatus; force: boolean } | null>(null);

  const { register, control, handleSubmit, reset, formState: { errors } } = useForm<PeriodForm>({
    defaultValues: { periodName: "", startDate: "", endDate: "" },
  });

  const periods = data ?? [];

  function submitCreate(v: PeriodForm) {
    save.mutate(v, {
      onSuccess: () => { toast({ title: t("accounting.periods.toast.created"), tone: "success" }); setCreating(false); reset(); },
      onError: (e: Error) => toast({ title: t("accounting.periods.toast.createError"), description: e.message, tone: "error" }),
    });
  }

  function confirmTransition() {
    if (!pending) return;
    const { period, to, force } = pending;
    lock.mutate({ id: period.id, status: to, force }, {
      onSuccess: () => { toast({ title: t("accounting.periods.toast.transitioned", { label: t(`accounting.periods.transition.${to}.label`) }), tone: "success" }); setPending(null); },
      onError: (e: Error) => toast({ title: t("accounting.periods.toast.transitionError"), description: e.message, tone: "error" }),
    });
  }

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={t("accounting.eyebrow")}
        title={t("accounting.periods.title")}
        subtitle={t("accounting.periods.subtitle")}
        action={
          canManage ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> {t("accounting.periods.newPeriod")}
            </Button>
          ) : undefined
        }
      />

      {isError ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : isLoading ? (
        <LoadingState />
      ) : periods.length === 0 ? (
        <EmptyState
          title={t("accounting.periods.empty.title")}
          body={t("accounting.periods.empty.body")}
          action={canManage ? <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> {t("accounting.periods.newPeriod")}</Button> : undefined}
        />
      ) : (
        <section className="surface">
          <PanelTitle icon={CalendarRange} title={t("accounting.periods.panelTitle")} subtitle={t("accounting.periods.count", { count: periods.length })} />
          <div className="overflow-x-auto p-5">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-start text-xs font-bold text-slate-500">
                  <th className="px-3 py-2">{t("accounting.periods.col.name")}</th>
                  <th className="px-3 py-2">{t("accounting.periods.col.from")}</th>
                  <th className="px-3 py-2">{t("accounting.periods.col.to")}</th>
                  <th className="px-3 py-2">{t("accounting.periods.col.status")}</th>
                  <th className="px-3 py-2">{t("accounting.periods.col.closedBy")}</th>
                  <th className="px-3 py-2">{t("common.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {periods.map((p) => (
                  <tr key={p.id} className="border-t border-slate-100">
                    <td className="px-3 py-3 font-bold text-slate-800">{p.periodName}</td>
                    <td className="px-3 py-3 font-mono text-xs text-slate-600">{String(p.startDate).slice(0, 10)}</td>
                    <td className="px-3 py-3 font-mono text-xs text-slate-600">{String(p.endDate).slice(0, 10)}</td>
                    <td className="px-3 py-3">
                      <StatusBadge tone={TONE[p.status]}>{t(`accounting.periods.statusLabel.${p.status}`)}</StatusBadge>
                    </td>
                    <td className="px-3 py-3 text-xs text-slate-500">{p.closedBy || "—"}</td>
                    <td className="px-3 py-3">
                      {canManage ? (
                        <div className="flex flex-wrap gap-2">
                          {allowedPeriodTransitions(p.status).map((tr) => {
                            const Icon = tr.force ? KeyRound : TRANSITION_ICON[tr.to];
                            return (
                              <Button
                                key={tr.to}
                                size="sm"
                                variant={tr.to === "closed" ? "danger" : tr.to === "open" ? "secondary" : "ghost"}
                                onClick={() => setPending({ period: p, to: tr.to, force: tr.force })}
                              >
                                <Icon className="h-3.5 w-3.5" />
                                {tr.force ? t("accounting.periods.reopenForced") : t(`accounting.periods.transition.${tr.to}.label`)}
                              </Button>
                            );
                          })}
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">{t("accounting.periods.viewOnly")}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <Dialog open={creating} onClose={() => setCreating(false)} title={t("accounting.periods.dialogTitle")}>
        <form onSubmit={handleSubmit(submitCreate)} className="grid gap-4" noValidate>
          <Field label={t("accounting.periods.field.name")} required error={errors.periodName}>
            {({ id, invalid }) => (
              <Input id={id} invalid={invalid} placeholder={t("accounting.periods.field.namePlaceholder")}
                {...register("periodName", { required: t("accounting.periods.validation.name") })} />
            )}
          </Field>
          <Field label={t("accounting.periods.field.start")} required error={errors.startDate}>
            {({ id, invalid }) => (
              <Controller
                name="startDate"
                control={control}
                rules={{ required: t("accounting.periods.validation.start") }}
                render={({ field }) => (
                  <DatePicker id={id} invalid={invalid} name={field.name} ref={field.ref} value={field.value} onChange={field.onChange} onBlur={field.onBlur} />
                )}
              />
            )}
          </Field>
          <Field label={t("accounting.periods.field.end")} required error={errors.endDate}>
            {({ id, invalid }) => (
              <Controller
                name="endDate"
                control={control}
                rules={{ required: t("accounting.periods.validation.end") }}
                render={({ field }) => (
                  <DatePicker id={id} invalid={invalid} name={field.name} ref={field.ref} value={field.value} onChange={field.onChange} onBlur={field.onBlur} />
                )}
              />
            )}
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setCreating(false)}>{t("common.cancel")}</Button>
            <Button type="submit" variant="primary" loading={save.isPending}>{t("common.save")}</Button>
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        open={!!pending}
        onClose={() => setPending(null)}
        title={pending ? `${t(`accounting.periods.transition.${pending.to}.label`)} — ${pending.period.periodName}` : ""}
        description={
          pending
            ? pending.force
              ? t("accounting.periods.reopenForcedDesc")
              : t(`accounting.periods.transition.${pending.to}.body`)
            : ""
        }
        confirmLabel={pending?.force ? t("accounting.periods.reopenForcedConfirm") : t("common.confirm")}
        tone={pending?.to === "closed" || pending?.force ? "danger" : "primary"}
        processing={lock.isPending}
        onConfirm={confirmTransition}
      />
    </div>
  );
}

export default PeriodsPage;
