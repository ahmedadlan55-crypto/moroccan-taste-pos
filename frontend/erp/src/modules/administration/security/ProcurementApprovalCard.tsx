import { useState } from "react";
import { UserCheck } from "lucide-react";
import { Button, NumberInput, PanelTitle, StatusBadge, Toggle, useToast } from "@/shared/ui";
import { Field } from "@/shared/forms";
import { Can } from "@/shared/permissions";
import { useT } from "@/i18n";
import { useSaveSecurityPolicies, type ProcurementApprovalPolicy } from "./api";

/**
 * فصل المهام في اعتماد أوامر الشراء — المفتاح الذي طلبه المالك.
 * الفرض نفسه في الخادم داخل معاملة الاعتماد؛ هذه البطاقة تحفظ السياسة فقط.
 */
export function ProcurementApprovalCard({ initial, canManage }: { initial: ProcurementApprovalPolicy; canManage: boolean }) {
  const t = useT();
  const { toast } = useToast();
  const save = useSaveSecurityPolicies();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [thresholdAmount, setThresholdAmount] = useState(initial.thresholdAmount);

  const submit = () =>
    save.mutate(
      { procurementApproval: { enabled, thresholdAmount } },
      {
        onSuccess: () => toast({ title: t("administration.security.poApproval.toastSuccess"), tone: "success" }),
        onError: (e: Error) => toast({ title: t("administration.security.poApproval.saveFailed"), description: e.message, tone: "error" }),
      },
    );

  return (
    <section className="surface">
      <PanelTitle
        icon={UserCheck}
        title={t("administration.security.poApproval.panelTitle")}
        subtitle={t("administration.security.poApproval.panelSubtitle")}
        action={
          <StatusBadge tone={enabled ? "success" : "neutral"}>
            {enabled ? t("administration.security.poApproval.badgeEnabled") : t("administration.security.poApproval.badgeDisabled")}
          </StatusBadge>
        }
      />
      <div className="space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-extrabold text-slate-900">{t("administration.security.poApproval.enableTitle")}</div>
            <p className="mt-0.5 text-xs font-medium text-slate-500">
              {t("administration.security.poApproval.enableBody")}
            </p>
          </div>
          <Toggle
            checked={enabled}
            disabled={!canManage}
            onChange={setEnabled}
            aria-label={t("administration.security.poApproval.enableAria")}
          />
        </div>

        <Field label={t("administration.security.poApproval.threshold")} hint={t("administration.security.poApproval.thresholdHint")}>
          {({ id }) => (
            <NumberInput
              id={id}
              value={thresholdAmount}
              min={0}
              step={1}
              disabled={!canManage || !enabled}
              onChange={(v) => setThresholdAmount(v ?? 0)}
            />
          )}
        </Field>

        <p className="rounded-xl bg-slate-50 px-3 py-3 text-xs font-medium text-slate-500">
          {enabled
            ? thresholdAmount > 0
              ? t("administration.security.poApproval.summaryThreshold", { amount: String(thresholdAmount) })
              : t("administration.security.poApproval.summaryAll")
            : t("administration.security.poApproval.summaryOff")}
        </p>

        <Can cap="administration.security.manage">
          <div className="flex justify-end">
            <Button onClick={submit} loading={save.isPending}>
              {t("administration.security.poApproval.saveBtn")}
            </Button>
          </div>
        </Can>
      </div>
    </section>
  );
}
