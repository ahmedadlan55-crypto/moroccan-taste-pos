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
import { DeferredNote, ensureAck, type MutationAck } from "../_common";

interface TwoFaStatus {
  enabled: boolean;
  hasSecret: boolean;
}
type SettingsMap = Record<string, string>;
const boolFrom = (v: string | undefined): boolean => v === "true" || v === "1" || v === "on";

export default function SecurityPage() {
  const canManage = useCan("administration.security");
  const qc = useQueryClient();
  const { toast } = useToast();

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
      toast({ title: "تم تحديث إعداد الأمان", tone: "success" });
    },
    onError: (e: Error) => toast({ title: "تعذّر التحديث", description: e.message, tone: "error" }),
  });

  return (
    <div>
      <PageHeader
        eyebrow="الإدارة"
        title="الأمان"
        subtitle="التحقق بخطوتين وضوابط الحماية للحساب والنظام."
      />

      <div className="space-y-5">
        <section className="surface">
          <PanelTitle icon={KeyRound} title="التحقق بخطوتين (2FA)" subtitle="حالة التحقق بخطوتين لحسابك الحالي." />
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
                      {twoFa.data?.enabled ? "التحقق بخطوتين مُفعّل" : "التحقق بخطوتين غير مُفعّل"}
                    </div>
                    <p className="mt-0.5 text-xs font-medium text-slate-500">
                      يُدار تفعيل/إلغاء التحقق بخطوتين عبر تطبيق المصادقة عند تسجيل الدخول.
                    </p>
                  </div>
                </div>
                <StatusBadge tone={twoFa.data?.enabled ? "success" : "warning"}>
                  {twoFa.data?.enabled ? "مُفعّل" : "غير مُفعّل"}
                </StatusBadge>
              </div>
            )}
          </div>
        </section>

        <section className="surface">
          <PanelTitle icon={ShieldCheck} title="ضوابط الحماية" subtitle="قواعد الاعتماد الحسّاسة في نقاط البيع." />
          <div className="p-5">
            {settings.isLoading ? (
              <LoadingState rows={1} />
            ) : settings.error ? (
              <ErrorState error={settings.error} onRetry={() => settings.refetch()} />
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-extrabold text-slate-900">طلب اعتماد المدير للإلغاء</div>
                  <p className="mt-0.5 text-xs font-medium text-slate-500">
                    يمنع الكاشير من إلغاء الفواتير دون موافقة مدير.
                  </p>
                </div>
                <Toggle
                  checked={voidApproval}
                  disabled={!canManage || toggleSetting.isPending}
                  onChange={(v) => toggleSetting.mutate(v)}
                  aria-label="طلب اعتماد المدير للإلغاء"
                />
              </div>
            )}
          </div>
        </section>

        <DeferredNote
          eyebrow="الأمان"
          title="سياسات الأمان المتقدمة"
          body="سياسة كلمات المرور، مهلة الجلسة، وقوائم عناوين IP المسموح بها ما تزال تُدار من النظام الأصلي."
        />
      </div>
    </div>
  );
}
