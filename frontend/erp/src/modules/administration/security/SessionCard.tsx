import { useState } from "react";
import { Timer } from "lucide-react";
import { Button, NumberInput, PanelTitle, useToast } from "@/shared/ui";
import { Field } from "@/shared/forms";
import { Can } from "@/shared/permissions";
import { useT } from "@/i18n";
import { useSaveSecurityPolicies, type SessionPolicy } from "./api";

/** Idle + absolute session timeouts, wired to PUT /security-policies. */
export function SessionCard({ initial, canManage }: { initial: SessionPolicy; canManage: boolean }) {
  const t = useT();
  const { toast } = useToast();
  const save = useSaveSecurityPolicies();
  const [form, setForm] = useState<SessionPolicy>(initial);
  const patch = (p: Partial<SessionPolicy>) => setForm((f) => ({ ...f, ...p }));

  const submit = () =>
    save.mutate(
      { session: form },
      {
        onSuccess: () => toast({ title: t("administration.security.session.toastSuccess"), tone: "success" }),
        onError: (e: Error) => toast({ title: t("administration.security.session.saveFailed"), description: e.message, tone: "error" }),
      },
    );

  return (
    <section className="surface">
      <PanelTitle icon={Timer} title={t("administration.security.session.panelTitle")} subtitle={t("administration.security.session.panelSubtitle")} />
      <div className="space-y-4 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("administration.security.session.idle")} hint={t("administration.security.session.idleHint")}>
            {({ id }) => (
              <NumberInput
                id={id}
                value={form.idleTimeoutMinutes}
                min={0}
                max={1440}
                step={1}
                suffix={t("administration.security.session.suffixMinute")}
                disabled={!canManage}
                onChange={(v) => patch({ idleTimeoutMinutes: v ?? 0 })}
              />
            )}
          </Field>
          <Field label={t("administration.security.session.absolute")} hint={t("administration.security.session.absoluteHint")}>
            {({ id }) => (
              <NumberInput
                id={id}
                value={form.absoluteTimeoutHours}
                min={0}
                max={720}
                step={1}
                suffix={t("administration.security.session.suffixHour")}
                disabled={!canManage}
                onChange={(v) => patch({ absoluteTimeoutHours: v ?? 0 })}
              />
            )}
          </Field>
        </div>

        <Can cap="administration.security.manage">
          <div className="flex justify-end">
            <Button onClick={submit} loading={save.isPending}>
              {t("administration.security.session.saveBtn")}
            </Button>
          </div>
        </Can>
      </div>
    </section>
  );
}
