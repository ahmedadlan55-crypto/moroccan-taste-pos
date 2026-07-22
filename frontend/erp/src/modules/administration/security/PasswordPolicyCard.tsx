import { useState } from "react";
import { KeyRound } from "lucide-react";
import { Button, Checkbox, NumberInput, PanelTitle, useToast } from "@/shared/ui";
import { Field } from "@/shared/forms";
import { Can } from "@/shared/permissions";
import { useT } from "@/i18n";
import { useSaveSecurityPolicies, type PasswordPolicy } from "./api";

/** Password-strength rules + expiry, wired to PUT /security-policies. */
export function PasswordPolicyCard({ initial, canManage }: { initial: PasswordPolicy; canManage: boolean }) {
  const t = useT();
  const { toast } = useToast();
  const save = useSaveSecurityPolicies();
  const [form, setForm] = useState<PasswordPolicy>(initial);
  const patch = (p: Partial<PasswordPolicy>) => setForm((f) => ({ ...f, ...p }));

  const submit = () =>
    save.mutate(
      { passwordPolicy: form },
      {
        onSuccess: () => toast({ title: t("administration.security.password.toastSuccess"), tone: "success" }),
        onError: (e: Error) => toast({ title: t("administration.security.password.saveFailed"), description: e.message, tone: "error" }),
      },
    );

  return (
    <section className="surface">
      <PanelTitle icon={KeyRound} title={t("administration.security.password.panelTitle")} subtitle={t("administration.security.password.panelSubtitle")} />
      <div className="space-y-4 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("administration.security.password.minLength")} hint={t("administration.security.password.minLengthHint")}>
            {({ id }) => (
              <NumberInput
                id={id}
                value={form.minLength}
                min={6}
                max={128}
                step={1}
                suffix={t("administration.security.password.suffixChar")}
                disabled={!canManage}
                onChange={(v) => patch({ minLength: v ?? 0 })}
              />
            )}
          </Field>
          <Field label={t("administration.security.password.expiry")} hint={t("administration.security.password.expiryHint")}>
            {({ id }) => (
              <NumberInput
                id={id}
                value={form.expiryDays}
                min={0}
                max={3650}
                step={1}
                suffix={t("administration.security.password.suffixDay")}
                disabled={!canManage}
                onChange={(v) => patch({ expiryDays: v ?? 0 })}
              />
            )}
          </Field>
        </div>

        <div className="flex flex-col gap-3">
          <Checkbox
            label={t("administration.security.password.requireUpper")}
            checked={form.requireUpper}
            disabled={!canManage}
            onChange={(e) => patch({ requireUpper: e.target.checked })}
          />
          <Checkbox
            label={t("administration.security.password.requireNumber")}
            checked={form.requireNumber}
            disabled={!canManage}
            onChange={(e) => patch({ requireNumber: e.target.checked })}
          />
          <Checkbox
            label={t("administration.security.password.requireSymbol")}
            checked={form.requireSymbol}
            disabled={!canManage}
            onChange={(e) => patch({ requireSymbol: e.target.checked })}
          />
        </div>

        <Can cap="administration.security.manage">
          <div className="flex justify-end">
            <Button onClick={submit} loading={save.isPending}>
              {t("administration.security.password.saveBtn")}
            </Button>
          </div>
        </Can>
      </div>
    </section>
  );
}
