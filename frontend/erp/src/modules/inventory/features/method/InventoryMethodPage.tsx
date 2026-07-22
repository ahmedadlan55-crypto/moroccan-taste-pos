import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarCheck, Check, RefreshCw, ShieldAlert, Scale } from "lucide-react";
import { apiClient } from "@/shared/api";
import {
  Button, ConfirmDialog, ErrorState, LoadingState, PageHeader, PanelTitle, StatusBadge, useToast,
} from "@/shared/ui";
import { usePermissions } from "@/app/providers";
import { useT } from "@/i18n";

// /inventory/method — converted from the legacy-only `erpLoadInventoryMethod`.
//
// This setting decides how COGS is computed and posted to the GL, so the screen
// is deliberately not a bare toggle:
//  · the server refuses the switch while movements costed under the outgoing
//    method still sit in an unclosed period (IAS 2 consistency), and says how
//    many — the UI explains that instead of disabling a control with no reason;
//  · an override exists but is an explicit, separate act.
// Neither the guard nor the capability existed before: the endpoint was
// changeable by anyone with any valid token.

type Method = "perpetual" | "periodic";

interface MethodResponse {
  method: Method;
  movementsSinceLastClose: number;
  lastCloseDate: string | null;
  canChange: boolean;
}

const METHOD_ICON: Record<Method, typeof RefreshCw> = {
  perpetual: RefreshCw,
  periodic: CalendarCheck,
};

export function InventoryMethodPage() {
  const t = useT();
  const { can } = usePermissions();
  const canManage = can("inventory.method.manage");
  const { toast } = useToast();
  const qc = useQueryClient();
  const [pending, setPending] = useState<Method | null>(null);
  const [force, setForce] = useState(false);
  const COPY: Record<Method, { title: string; body: string; cogs: string; gl: string; icon: typeof RefreshCw }> = {
    perpetual: {
      title: t("inventoryRest.method.perpetualTitle"),
      body: t("inventoryRest.method.perpetualBody"),
      cogs: t("inventoryRest.method.perpetualCogs"),
      gl: t("inventoryRest.method.perpetualGl"),
      icon: METHOD_ICON.perpetual,
    },
    periodic: {
      title: t("inventoryRest.method.periodicTitle"),
      body: t("inventoryRest.method.periodicBody"),
      cogs: t("inventoryRest.method.periodicCogs"),
      gl: t("inventoryRest.method.periodicGl"),
      icon: METHOD_ICON.periodic,
    },
  };

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["inv", "method"],
    queryFn: ({ signal }) => apiClient.get<MethodResponse>("/erp/inventory-method", { signal }),
  });

  const save = useMutation({
    mutationFn: async (input: { method: Method; force?: boolean }) => {
      const r = await apiClient.post<{ success: boolean; blocked?: boolean; error?: string; movementsSinceLastClose?: number }>(
        "/erp/inventory-method", input,
      );
      if (r && r.success === false) throw new Error(r.error || t("inventoryRest.method.changeFailed"));
      return r;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inv", "method"] });
      toast({ title: t("inventoryRest.method.changed"), tone: "success" });
      setPending(null); setForce(false);
    },
    onError: (e: Error) => toast({ title: t("inventoryRest.method.changeFailed"), description: e.message, tone: "error" }),
  });

  if (isLoading) return <LoadingState />;
  if (isError || !data) return <ErrorState error={error} onRetry={() => refetch()} />;

  const active = data.method;
  const blocked = !data.canChange;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={t("inventoryRest.method.eyebrow")}
        title={t("inventoryRest.method.title")}
        subtitle={t("inventoryRest.method.subtitle")}
      />

      {blocked && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-bold text-amber-900">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1">
            <div>
              {data.movementsSinceLastClose < 0
                ? t("inventoryRest.method.blockedUnknown")
                : t("inventoryRest.method.blockedCount", { count: data.movementsSinceLastClose })}
            </div>
            <div className="font-medium">
              {t("inventoryRest.method.blockedAdvice")}
              {data.lastCloseDate ? t("inventoryRest.method.lastClose", { date: String(data.lastCloseDate).slice(0, 10) }) : ""}.
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {(Object.keys(COPY) as Method[]).map((m) => {
          const c = COPY[m];
          const Icon = c.icon;
          const isActive = active === m;
          return (
            <section key={m} className={`surface ${isActive ? "ring-2 ring-teal-500" : ""}`}>
              <PanelTitle
                icon={Icon}
                title={c.title}
                subtitle={c.body}
                action={isActive ? <StatusBadge tone="success">{t("inventoryRest.method.active")}</StatusBadge> : undefined}
              />
              <div className="grid gap-2 p-5 text-xs">
                <div className="flex justify-between border-b border-slate-100 pb-2">
                  <span className="text-slate-500">{t("inventoryRest.method.cogsLabel")}</span>
                  <span className="font-bold text-slate-700">{c.cogs}</span>
                </div>
                <div className="flex justify-between border-b border-slate-100 pb-2">
                  <span className="text-slate-500">{t("inventoryRest.method.glLabel")}</span>
                  <span className="font-bold text-slate-700">{c.gl}</span>
                </div>
                <div className="flex justify-between pb-2">
                  <span className="text-slate-500">{t("inventoryRest.method.standardLabel")}</span>
                  <span className="font-bold text-slate-700">IAS 2</span>
                </div>
                {!isActive && canManage && (
                  <Button
                    className="mt-2"
                    variant={blocked ? "ghost" : "primary"}
                    onClick={() => { setForce(blocked); setPending(m); }}
                  >
                    <Check className="h-4 w-4" />
                    {blocked ? t("inventoryRest.method.activateDespite") : t("inventoryRest.method.activate", { name: c.title })}
                  </Button>
                )}
                {!isActive && !canManage && (
                  <span className="mt-2 text-[11px] text-slate-400">{t("inventoryRest.method.noPermission")}</span>
                )}
              </div>
            </section>
          );
        })}
      </div>

      <section className="surface">
        <PanelTitle icon={Scale} title={t("inventoryRest.method.impactTitle")} subtitle={t("inventoryRest.method.impactSubtitle")} />
        <p className="p-5 text-xs leading-relaxed text-slate-600">
          {t("inventoryRest.method.impactBody")}
        </p>
      </section>

      <ConfirmDialog
        open={!!pending}
        onClose={() => { setPending(null); setForce(false); }}
        title={pending ? t("inventoryRest.method.activate", { name: COPY[pending].title }) : ""}
        description={
          force
            ? t("inventoryRest.method.confirmForce", { count: data.movementsSinceLastClose })
            : t("inventoryRest.method.confirmNormal")
        }
        confirmLabel={force ? t("inventoryRest.method.confirmForceLabel") : t("inventoryRest.method.confirmLabel")}
        tone={force ? "danger" : "primary"}
        processing={save.isPending}
        onConfirm={() => pending && save.mutate({ method: pending, force })}
      />
    </div>
  );
}

export default InventoryMethodPage;
