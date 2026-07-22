import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, ShieldCheck, ShieldAlert } from "lucide-react";
import { apiClient } from "@/shared/api";
import {
  LoadingState,
  ErrorState,
  PageHeader,
  PanelTitle,
  StatusBadge,
  Toggle,
  useToast,
} from "@/shared/ui";
import { useCan } from "@/app/providers";
import { useT } from "@/i18n";
import { ensureAck, type MutationAck } from "../_common";
import { useSecurityPolicies } from "../security/api";
import { PasswordPolicyCard } from "../security/PasswordPolicyCard";
import { SessionCard } from "../security/SessionCard";
import { IpAllowlistCard } from "../security/IpAllowlistCard";

interface TwoFaStatus {
  enabled: boolean;
  hasSecret: boolean;
}
type SettingsMap = Record<string, string>;
const boolFrom = (v: string | undefined): boolean => v === "true" || v === "1" || v === "on";

export default function SecurityPage() {
  const t = useT();
  const canManage = useCan("administration.security");
  const canManageSecurity = useCan("administration.security.manage");
  const qc = useQueryClient();
  const { toast } = useToast();

  const policies = useSecurityPolicies();

  const twoFa = useQuery({
    queryKey: ["auth", "2fa-status"],
    queryFn: ({ signal }) => apiClient.get<TwoFaStatus>("/auth/2fa/status", { signal }),
  });

  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: ({ signal }) => apiClient.get<SettingsMap>("/settings", { signal }),
  });

  const voidApproval = boolFrom(settings.data?.RequireManagerApprovalForVoid);

  const toggleSetting = useMutation({
    mutationFn: async (next: boolean) =>
      ensureAck(
        await apiClient.put<MutationAck>("/settings", {
          RequireManagerApprovalForVoid: next ? "true" : "false",
        }),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast({ title: t("administration.security.toast.updated"), tone: "success" });
    },
    onError: (e: Error) => toast({ title: t("administration.security.toast.updateFailed"), description: e.message, tone: "error" }),
  });

  return (
    <div>
      <PageHeader
        eyebrow={t("administration.eyebrow")}
        title={t("administration.security.title")}
        subtitle={t("administration.security.subtitle")}
      />

      <div className="space-y-5">
        <section className="surface">
          <PanelTitle icon={KeyRound} title={t("administration.security.twoFa.panelTitle")} subtitle={t("administration.security.twoFa.panelSubtitle")} />
          <div className="p-5">
            {twoFa.isLoading ? (
              <LoadingState rows={1} />
            ) : twoFa.error ? (
              <ErrorState error={twoFa.error} onRetry={() => twoFa.refetch()} />
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span
                    className={
                      twoFa.data?.enabled
                        ? "grid h-11 w-11 place-items-center rounded-2xl bg-emerald-50 text-emerald-600"
                        : "grid h-11 w-11 place-items-center rounded-2xl bg-amber-50 text-amber-600"
                    }
                  >
                    {twoFa.data?.enabled ? <ShieldCheck className="h-5 w-5" /> : <ShieldAlert className="h-5 w-5" />}
                  </span>
                  <div>
                    <div className="text-sm font-extrabold text-slate-900">
                      {twoFa.data?.enabled ? t("administration.security.twoFa.enabled") : t("administration.security.twoFa.disabled")}
                    </div>
                    <p className="mt-0.5 text-xs font-medium text-slate-500">
                      {t("administration.security.twoFa.note")}
                    </p>
                  </div>
                </div>
                <StatusBadge tone={twoFa.data?.enabled ? "success" : "warning"}>
                  {twoFa.data?.enabled ? t("administration.security.twoFa.badgeEnabled") : t("administration.security.twoFa.badgeDisabled")}
                </StatusBadge>
              </div>
            )}
          </div>
        </section>

        <section className="surface">
          <PanelTitle icon={ShieldCheck} title={t("administration.security.controls.panelTitle")} subtitle={t("administration.security.controls.panelSubtitle")} />
          <div className="p-5">
            {settings.isLoading ? (
              <LoadingState rows={1} />
            ) : settings.error ? (
              <ErrorState error={settings.error} onRetry={() => settings.refetch()} />
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-extrabold text-slate-900">{t("administration.security.controls.voidApprovalTitle")}</div>
                  <p className="mt-0.5 text-xs font-medium text-slate-500">
                    {t("administration.security.controls.voidApprovalBody")}
                  </p>
                </div>
                <Toggle
                  checked={voidApproval}
                  disabled={!canManage || toggleSetting.isPending}
                  onChange={(v) => toggleSetting.mutate(v)}
                  aria-label={t("administration.security.controls.voidApprovalAria")}
                />
              </div>
            )}
          </div>
        </section>

        {policies.isLoading ? (
          <LoadingState rows={2} />
        ) : policies.error ? (
          <ErrorState error={policies.error} onRetry={() => policies.refetch()} />
        ) : policies.data ? (
          <>
            <PasswordPolicyCard initial={policies.data.passwordPolicy} canManage={canManageSecurity} />
            <SessionCard initial={policies.data.session} canManage={canManageSecurity} />
            <IpAllowlistCard initial={policies.data.ipAllowlist} canManage={canManageSecurity} />
          </>
        ) : null}
      </div>
    </div>
  );
}
