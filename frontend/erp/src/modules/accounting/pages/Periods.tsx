import { useState } from "react";
import { useForm } from "react-hook-form";
import { CalendarRange, KeyRound, Lock, LockOpen, Plus, ShieldHalf } from "lucide-react";
import {
  Button, ConfirmDialog, Dialog, EmptyState, ErrorState, Input, LoadingState,
  PageHeader, PanelTitle, StatusBadge, useToast,
} from "@/shared/ui";
import { Field } from "@/shared/forms";
import { usePermissions } from "@/app/providers";
import {
  allowedPeriodTransitions, PERIOD_STATUS_LABEL, useLockPeriod, usePeriods, useSavePeriod,
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

const TRANSITION_COPY: Record<PeriodStatus, { label: string; icon: typeof Lock; body: string }> = {
  soft_closed: {
    label: "إقفال مبدئي",
    icon: ShieldHalf,
    body: "يمنع الترحيل الجديد في هذه الفترة، ويمكن التراجع عنه بإعادة الفتح. لا يُنشئ قيود إقفال.",
  },
  closed: {
    label: "إقفال نهائي",
    icon: Lock,
    body: "يُنشئ قيود الإقفال ويمنع أي ترحيل في الفترة. إعادة الفتح بعد ذلك تتطلّب تأكيدًا إضافيًا وتعكس قيود الإقفال.",
  },
  open: {
    label: "إعادة فتح",
    icon: LockOpen,
    body: "يسمح بالترحيل في الفترة من جديد.",
  },
};

interface PeriodForm {
  periodName: string;
  startDate: string;
  endDate: string;
}

export function PeriodsPage() {
  const { can } = usePermissions();
  const canManage = can("accounting.periods.manage");
  const { toast } = useToast();
  const { data, isLoading, isError, error, refetch } = usePeriods();
  const save = useSavePeriod();
  const lock = useLockPeriod();

  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<{ period: AccountingPeriod; to: PeriodStatus; force: boolean } | null>(null);

  const { register, handleSubmit, reset, formState: { errors } } = useForm<PeriodForm>({
    defaultValues: { periodName: "", startDate: "", endDate: "" },
  });

  const periods = data ?? [];

  function submitCreate(v: PeriodForm) {
    save.mutate(v, {
      onSuccess: () => { toast({ title: "تم إنشاء الفترة", tone: "success" }); setCreating(false); reset(); },
      onError: (e: Error) => toast({ title: "تعذّر إنشاء الفترة", description: e.message, tone: "error" }),
    });
  }

  function confirmTransition() {
    if (!pending) return;
    const { period, to, force } = pending;
    lock.mutate({ id: period.id, status: to, force }, {
      onSuccess: () => { toast({ title: `تم: ${TRANSITION_COPY[to].label}`, tone: "success" }); setPending(null); },
      onError: (e: Error) => toast({ title: "تعذّر تغيير حالة الفترة", description: e.message, tone: "error" }),
    });
  }

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="المحاسبة"
        title="الفترات المحاسبية"
        subtitle="فتح وإقفال الفترات. الإقفال النهائي يُنشئ قيود الإقفال، وإعادة الفتح تعكسها."
        action={
          canManage ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> فترة جديدة
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
          title="لا توجد فترات محاسبية"
          body="ابدأ بإنشاء فترة لتتمكّن من إقفالها لاحقًا."
          action={canManage ? <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> فترة جديدة</Button> : undefined}
        />
      ) : (
        <section className="surface">
          <PanelTitle icon={CalendarRange} title="الفترات" subtitle={`${periods.length} فترة`} />
          <div className="overflow-x-auto p-5">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-right text-xs font-bold text-slate-500">
                  <th className="px-3 py-2">الفترة</th>
                  <th className="px-3 py-2">من</th>
                  <th className="px-3 py-2">إلى</th>
                  <th className="px-3 py-2">الحالة</th>
                  <th className="px-3 py-2">أُقفلت بواسطة</th>
                  <th className="px-3 py-2">إجراءات</th>
                </tr>
              </thead>
              <tbody>
                {periods.map((p) => (
                  <tr key={p.id} className="border-t border-slate-100">
                    <td className="px-3 py-3 font-bold text-slate-800">{p.periodName}</td>
                    <td className="px-3 py-3 font-mono text-xs text-slate-600">{String(p.startDate).slice(0, 10)}</td>
                    <td className="px-3 py-3 font-mono text-xs text-slate-600">{String(p.endDate).slice(0, 10)}</td>
                    <td className="px-3 py-3">
                      <StatusBadge tone={TONE[p.status]}>{PERIOD_STATUS_LABEL[p.status] ?? p.status}</StatusBadge>
                    </td>
                    <td className="px-3 py-3 text-xs text-slate-500">{p.closedBy || "—"}</td>
                    <td className="px-3 py-3">
                      {canManage ? (
                        <div className="flex flex-wrap gap-2">
                          {allowedPeriodTransitions(p.status).map((t) => {
                            const copy = TRANSITION_COPY[t.to];
                            const Icon = t.force ? KeyRound : copy.icon;
                            return (
                              <Button
                                key={t.to}
                                size="sm"
                                variant={t.to === "closed" ? "danger" : t.to === "open" ? "secondary" : "ghost"}
                                onClick={() => setPending({ period: p, to: t.to, force: t.force })}
                              >
                                <Icon className="h-3.5 w-3.5" />
                                {t.force ? "إعادة فتح (تأكيد إضافي)" : copy.label}
                              </Button>
                            );
                          })}
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">للعرض فقط</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <Dialog open={creating} onClose={() => setCreating(false)} title="فترة محاسبية جديدة">
        <form onSubmit={handleSubmit(submitCreate)} className="grid gap-4" noValidate>
          <Field label="الاسم" required error={errors.periodName}>
            {({ id, invalid }) => (
              <Input id={id} invalid={invalid} placeholder="مثال: يناير 2026"
                {...register("periodName", { required: "الاسم مطلوب" })} />
            )}
          </Field>
          <Field label="تاريخ البداية" required error={errors.startDate}>
            {({ id, invalid }) => (
              <Input id={id} invalid={invalid} type="date" {...register("startDate", { required: "تاريخ البداية مطلوب" })} />
            )}
          </Field>
          <Field label="تاريخ النهاية" required error={errors.endDate}>
            {({ id, invalid }) => (
              <Input id={id} invalid={invalid} type="date" {...register("endDate", { required: "تاريخ النهاية مطلوب" })} />
            )}
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setCreating(false)}>إلغاء</Button>
            <Button type="submit" variant="primary" loading={save.isPending}>حفظ</Button>
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        open={!!pending}
        onClose={() => setPending(null)}
        title={pending ? `${TRANSITION_COPY[pending.to].label} — ${pending.period.periodName}` : ""}
        description={
          pending
            ? pending.force
              ? "هذه الفترة مُقفلة نهائيًا. إعادة الفتح ستعكس قيود الإقفال بقيد مقابل (لا تُحذف)، وتسمح بالترحيل من جديد."
              : TRANSITION_COPY[pending.to].body
            : ""
        }
        confirmLabel={pending?.force ? "إعادة الفتح رغم الإقفال" : "تأكيد"}
        tone={pending?.to === "closed" || pending?.force ? "danger" : "primary"}
        processing={lock.isPending}
        onConfirm={confirmTransition}
      />
    </div>
  );
}

export default PeriodsPage;
