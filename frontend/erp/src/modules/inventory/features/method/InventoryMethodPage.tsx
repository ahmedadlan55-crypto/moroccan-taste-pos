import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarCheck, Check, RefreshCw, ShieldAlert, Scale } from "lucide-react";
import { apiClient } from "@/shared/api";
import {
  Button, ConfirmDialog, ErrorState, LoadingState, PageHeader, PanelTitle, StatusBadge, useToast,
} from "@/shared/ui";
import { usePermissions } from "@/app/providers";

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

const COPY: Record<Method, { title: string; body: string; cogs: string; gl: string; icon: typeof RefreshCw }> = {
  perpetual: {
    title: "الجرد المستمر",
    body: "يُحدَّث المخزون وتُحتسب التكلفة مع كل حركة بيع.",
    cogs: "لحظي (مع كل بيع)",
    gl: "ترحيل تلقائي مع البيع",
    icon: RefreshCw,
  },
  periodic: {
    title: "الجرد الدوري",
    body: "تُحتسب التكلفة عند الجرد في نهاية الفترة.",
    cogs: "دوري (عند كل جرد)",
    gl: "ترحيل عند الجرد",
    icon: CalendarCheck,
  },
};

export function InventoryMethodPage() {
  const { can } = usePermissions();
  const canManage = can("inventory.method.manage");
  const { toast } = useToast();
  const qc = useQueryClient();
  const [pending, setPending] = useState<Method | null>(null);
  const [force, setForce] = useState(false);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["inv", "method"],
    queryFn: ({ signal }) => apiClient.get<MethodResponse>("/erp/inventory-method", { signal }),
  });

  const save = useMutation({
    mutationFn: async (input: { method: Method; force?: boolean }) => {
      const r = await apiClient.post<{ success: boolean; blocked?: boolean; error?: string; movementsSinceLastClose?: number }>(
        "/erp/inventory-method", input,
      );
      if (r && r.success === false) throw new Error(r.error || "تعذّر تغيير الطريقة");
      return r;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inv", "method"] });
      toast({ title: "تم تغيير طريقة التقييم", tone: "success" });
      setPending(null); setForce(false);
    },
    onError: (e: Error) => toast({ title: "تعذّر تغيير الطريقة", description: e.message, tone: "error" }),
  });

  if (isLoading) return <LoadingState />;
  if (isError || !data) return <ErrorState error={error} onRetry={() => refetch()} />;

  const active = data.method;
  const blocked = !data.canChange;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="المخزون"
        title="طريقة تقييم المخزون"
        subtitle="تحدّد كيفية احتساب تكلفة البضاعة المباعة وترحيلها إلى الأستاذ العام (IAS 2)."
      />

      {blocked && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-bold text-amber-900">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1">
            <div>
              {data.movementsSinceLastClose < 0
                ? "تعذّر التحقق من حركات المخزون، لذلك تغيير الطريقة موقوف احترازيًا."
                : `توجد ${data.movementsSinceLastClose} حركة مخزون في فترة غير مُقفلة حُسبت تكلفتها بالطريقة الحالية.`}
            </div>
            <div className="font-medium">
              تغيير الطريقة الآن يجعل تكلفة الفترة الواحدة محسوبة بطريقتين. أقفل الفترة أولًا
              {data.lastCloseDate ? ` (آخر إقفال: ${String(data.lastCloseDate).slice(0, 10)})` : ""}.
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
                action={isActive ? <StatusBadge tone="success">مفعّلة</StatusBadge> : undefined}
              />
              <div className="grid gap-2 p-5 text-xs">
                <div className="flex justify-between border-b border-slate-100 pb-2">
                  <span className="text-slate-500">احتساب COGS</span>
                  <span className="font-bold text-slate-700">{c.cogs}</span>
                </div>
                <div className="flex justify-between border-b border-slate-100 pb-2">
                  <span className="text-slate-500">ترحيل GL</span>
                  <span className="font-bold text-slate-700">{c.gl}</span>
                </div>
                <div className="flex justify-between pb-2">
                  <span className="text-slate-500">المعيار</span>
                  <span className="font-bold text-slate-700">IAS 2</span>
                </div>
                {!isActive && canManage && (
                  <Button
                    className="mt-2"
                    variant={blocked ? "ghost" : "primary"}
                    onClick={() => { setForce(blocked); setPending(m); }}
                  >
                    <Check className="h-4 w-4" />
                    {blocked ? "تفعيل رغم الحركات" : `تفعيل ${c.title}`}
                  </Button>
                )}
                {!isActive && !canManage && (
                  <span className="mt-2 text-[11px] text-slate-400">لا تملك صلاحية تغيير الطريقة.</span>
                )}
              </div>
            </section>
          );
        })}
      </div>

      <section className="surface">
        <PanelTitle icon={Scale} title="الأثر المحاسبي" subtitle="ما الذي يتغيّر فعليًا عند التبديل." />
        <p className="p-5 text-xs leading-relaxed text-slate-600">
          الطريقة تحكم توقيت احتساب تكلفة البضاعة المباعة وترحيلها. الحركات التي رُحّلت بالطريقة
          السابقة لا يُعاد احتسابها بأثر رجعي، لذلك يُفضَّل التبديل بعد إقفال الفترة حتى تبقى تكلفة
          كل فترة محسوبة بطريقة واحدة.
        </p>
      </section>

      <ConfirmDialog
        open={!!pending}
        onClose={() => { setPending(null); setForce(false); }}
        title={pending ? `تفعيل ${COPY[pending].title}` : ""}
        description={
          force
            ? `سيتم التغيير رغم وجود ${data.movementsSinceLastClose} حركة في فترة غير مُقفلة. تكلفة هذه الفترة ستكون محسوبة بطريقتين مختلطتين، ولن يُعاد احتساب ما رُحّل سابقًا.`
            : "سيتم تغيير طريقة احتساب تكلفة البضاعة المباعة للحركات القادمة."
        }
        confirmLabel={force ? "تأكيد التغيير رغم الحركات" : "تأكيد"}
        tone={force ? "danger" : "primary"}
        processing={save.isPending}
        onConfirm={() => pending && save.mutate({ method: pending, force })}
      />
    </div>
  );
}

export default InventoryMethodPage;
