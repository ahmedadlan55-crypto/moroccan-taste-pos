import { useState } from "react";
import { Timer } from "lucide-react";
import { Button, NumberInput, PanelTitle, useToast } from "@/shared/ui";
import { Field } from "@/shared/forms";
import { Can } from "@/shared/permissions";
import { useSaveSecurityPolicies, type SessionPolicy } from "./api";

/** Idle + absolute session timeouts, wired to PUT /security-policies. */
export function SessionCard({ initial, canManage }: { initial: SessionPolicy; canManage: boolean }) {
  const { toast } = useToast();
  const save = useSaveSecurityPolicies();
  const [form, setForm] = useState<SessionPolicy>(initial);
  const patch = (p: Partial<SessionPolicy>) => setForm((f) => ({ ...f, ...p }));

  const submit = () =>
    save.mutate(
      { session: form },
      {
        onSuccess: () => toast({ title: "تم حفظ إعدادات الجلسة", tone: "success" }),
        onError: (e: Error) => toast({ title: "تعذّر الحفظ", description: e.message, tone: "error" }),
      },
    );

  return (
    <section className="surface">
      <PanelTitle icon={Timer} title="مهلة الجلسة" subtitle="تسجيل الخروج التلقائي عند الخمول أو بعد مدة قصوى." />
      <div className="space-y-4 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="مهلة الخمول" hint="0 = بلا مهلة خمول">
            {({ id }) => (
              <NumberInput
                id={id}
                value={form.idleTimeoutMinutes}
                min={0}
                max={1440}
                step={1}
                suffix="دقيقة"
                disabled={!canManage}
                onChange={(v) => patch({ idleTimeoutMinutes: v ?? 0 })}
              />
            )}
          </Field>
          <Field label="المهلة المطلقة" hint="0 = بلا حد أقصى">
            {({ id }) => (
              <NumberInput
                id={id}
                value={form.absoluteTimeoutHours}
                min={0}
                max={720}
                step={1}
                suffix="ساعة"
                disabled={!canManage}
                onChange={(v) => patch({ absoluteTimeoutHours: v ?? 0 })}
              />
            )}
          </Field>
        </div>

        <Can cap="administration.security.manage">
          <div className="flex justify-end">
            <Button onClick={submit} loading={save.isPending}>
              حفظ الإعدادات
            </Button>
          </div>
        </Can>
      </div>
    </section>
  );
}
