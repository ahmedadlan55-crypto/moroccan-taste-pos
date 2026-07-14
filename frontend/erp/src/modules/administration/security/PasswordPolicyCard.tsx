import { useState } from "react";
import { KeyRound } from "lucide-react";
import { Button, Checkbox, NumberInput, PanelTitle, useToast } from "@/shared/ui";
import { Field } from "@/shared/forms";
import { Can } from "@/shared/permissions";
import { useSaveSecurityPolicies, type PasswordPolicy } from "./api";

/** Password-strength rules + expiry, wired to PUT /security-policies. */
export function PasswordPolicyCard({ initial, canManage }: { initial: PasswordPolicy; canManage: boolean }) {
  const { toast } = useToast();
  const save = useSaveSecurityPolicies();
  const [form, setForm] = useState<PasswordPolicy>(initial);
  const patch = (p: Partial<PasswordPolicy>) => setForm((f) => ({ ...f, ...p }));

  const submit = () =>
    save.mutate(
      { passwordPolicy: form },
      {
        onSuccess: () => toast({ title: "تم حفظ سياسة كلمات المرور", tone: "success" }),
        onError: (e: Error) => toast({ title: "تعذّر الحفظ", description: e.message, tone: "error" }),
      },
    );

  return (
    <section className="surface">
      <PanelTitle icon={KeyRound} title="سياسة كلمات المرور" subtitle="قواعد قوة كلمة المرور ومدة صلاحيتها." />
      <div className="space-y-4 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="الحد الأدنى للطول" hint="بين 6 و 128 حرفًا">
            {({ id }) => (
              <NumberInput
                id={id}
                value={form.minLength}
                min={6}
                max={128}
                step={1}
                suffix="حرف"
                disabled={!canManage}
                onChange={(v) => patch({ minLength: v ?? 0 })}
              />
            )}
          </Field>
          <Field label="انتهاء الصلاحية" hint="0 = بلا انتهاء">
            {({ id }) => (
              <NumberInput
                id={id}
                value={form.expiryDays}
                min={0}
                max={3650}
                step={1}
                suffix="يوم"
                disabled={!canManage}
                onChange={(v) => patch({ expiryDays: v ?? 0 })}
              />
            )}
          </Field>
        </div>

        <div className="flex flex-col gap-3">
          <Checkbox
            label="تتطلب حرفًا كبيرًا (A-Z)"
            checked={form.requireUpper}
            disabled={!canManage}
            onChange={(e) => patch({ requireUpper: e.target.checked })}
          />
          <Checkbox
            label="تتطلب رقمًا (0-9)"
            checked={form.requireNumber}
            disabled={!canManage}
            onChange={(e) => patch({ requireNumber: e.target.checked })}
          />
          <Checkbox
            label="تتطلب رمزًا خاصًا (!@#$…)"
            checked={form.requireSymbol}
            disabled={!canManage}
            onChange={(e) => patch({ requireSymbol: e.target.checked })}
          />
        </div>

        <Can cap="administration.security.manage">
          <div className="flex justify-end">
            <Button onClick={submit} loading={save.isPending}>
              حفظ السياسة
            </Button>
          </div>
        </Can>
      </div>
    </section>
  );
}
