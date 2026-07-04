// Phase W2 — negative-stock policy settings page. Three sections (global /
// per-warehouse / per-item rows) + the effective-policy tester. Editing is
// gated by negativePolicy.edit (admin); the `allow` policy is developer-only
// and env-gated. Users with only negativePolicy.view get a read-only page.

import { useMemo, useState } from "react";
import {
  Ban, Eye, Package, Pencil, Plus, ShieldAlert, SlidersHorizontal, Warehouse as WarehouseIcon,
} from "lucide-react";
import { PageHeader, PanelTitle } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { LoadingState, ErrorState, PermissionDenied } from "@/components/states/States";
import { useCan } from "@/app/permission-provider";
import { useAuth } from "@/app/auth-provider";
import { useWarehouses } from "@/lib/hooks/useWarehouses";
import { useWarehouseScope } from "@/app/warehouse-scope-provider";
import { useNegativePolicySettings } from "@/lib/hooks/useNegativePolicy";
import { formatDateTime, formatQty } from "@/lib/formatters";
import { cn } from "@/lib/cn";
import type { PolicyMode, PolicyRow, PolicyScope } from "@/lib/adapters/negative-policy.adapter";
import { POLICY_HINTS } from "./labels";
import { EnabledBadge, PolicyBadge } from "./shared";
import { PolicyDialog } from "./PolicyDialog";
import { EffectiveTester } from "./EffectiveTester";

interface DialogState {
  open: boolean;
  scope: PolicyScope;
  row: PolicyRow | null;
}

export function NegativePolicyPage() {
  const canView = useCan("negativePolicy.view");
  const canEdit = useCan("negativePolicy.edit");
  const { user } = useAuth();
  const isDeveloper = !!user?.isDeveloper;

  const { accessibleWarehouses, allWarehousesAccess } = useWarehouseScope();
  const allWh = useWarehouses();
  const whOptions = useMemo(() => {
    if (!allWarehousesAccess) return accessibleWarehouses.map((w) => ({ id: w.id, name: w.name }));
    return (allWh.data?.warehouses ?? []).map((w) => ({ id: w.id, name: w.name }));
  }, [allWarehousesAccess, accessibleWarehouses, allWh.data]);

  const { data, isLoading, isError, error, refetch } = useNegativePolicySettings();
  const [dialog, setDialog] = useState<DialogState>({ open: false, scope: "global", row: null });

  if (!canView) return <PermissionDenied />;

  const openDialog = (scope: PolicyScope, row: PolicyRow | null = null) =>
    setDialog({ open: true, scope, row });

  return (
    <div>
      <PageHeader
        eyebrow="الإعدادات"
        title="سياسة المخزون السالب"
        subtitle="تتحكم هذه السياسة في قرار المحرك عندما يحاول صرفٌ ما أخذ رصيد صنف تحت الصفر: منع (الافتراضي) / مقيّد بشروط وحدود / سماح مفتوح للمطوّر فقط. الحسم بين المستويات: الأكثر تحديدًا يفوز (صنف ← مستودع ← عام)، والأصناف المتتبَّعة تُمنع دائمًا."
        action={
          !canEdit ? (
            <span className="chip border-slate-200 bg-slate-50 text-slate-600">
              <Eye className="h-3.5 w-3.5" /> عرض فقط — التعديل يتطلب صلاحية أدمن
            </span>
          ) : null
        }
      />

      {isLoading ? (
        <LoadingState />
      ) : isError ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : !data ? null : (
        <>
          {!data.policyEnabled && (
            <div className="mb-4 flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4">
              <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
              <div className="text-sm font-bold leading-6 text-amber-800">
                التطبيق الفعلي للسياسة معطّل حاليًا (NEGATIVE_STOCK_POLICY_ENABLED غير مفعّلة) — الإعدادات هنا
                تُحفظ وتُعرض، لكن الحارس لا يعمل وقت الصرف حتى يفعّل المطوّر البوابة.
              </div>
            </div>
          )}

          <section className="grid gap-4 lg:grid-cols-3">
            <ExplainerCard policy="block" badge="الافتراضي" />
            <ExplainerCard policy="controlled" />
            {isDeveloper ? (
              <ExplainerCard policy="allow" badge={data.allowEnabled ? "البوابة مفعّلة" : "البوابة معطّلة"} />
            ) : (
              <article className="surface p-4 opacity-70">
                <div className="flex items-center gap-2">
                  <span className="grid h-9 w-9 place-items-center rounded-xl bg-slate-100 text-slate-500">
                    <Ban className="h-4 w-4" />
                  </span>
                  <span className="text-sm font-extrabold text-slate-700">سماح (allow)</span>
                </div>
                <p className="mt-3 text-xs font-medium leading-5 text-slate-500">
                  معطّل ومخفي — متاح للمطوّر فقط وخلف بوابة بيئة، ويتخفّض تلقائيًا إلى «مقيّد» عند إيقافها.
                </p>
              </article>
            )}
          </section>

          {/* ── السياسة العامة ─────────────────────────────────────────── */}
          <section className="surface mt-4 overflow-hidden">
            <PanelTitle
              icon={SlidersHorizontal}
              title="السياسة العامة"
              subtitle="تسري على كل المستودعات والأصناف ما لم يوجد صف أكثر تحديدًا."
              action={
                canEdit ? (
                  <Button variant="secondary" size="sm" onClick={() => openDialog("global", data.globalRow)}>
                    <Pencil className="h-3.5 w-3.5" /> {data.globalRow ? "تعديل" : "ضبط السياسة"}
                  </Button>
                ) : undefined
              }
            />
            <div className="p-5">
              {data.globalRow ? (
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                  <PolicyBadge policy={data.globalRow.policy} />
                  <MetaText label="الحد الأقصى للعجز">
                    {data.globalRow.policy === "controlled" ? formatQty(data.globalRow.maxNegativeQty) : "—"}
                  </MetaText>
                  <MetaText label="سبب إلزامي">{data.globalRow.requireReason ? "نعم" : "لا"}</MetaText>
                  <EnabledBadge enabled={data.globalRow.isEnabled} />
                  <MetaText label="آخر تحديث">
                    {data.globalRow.updatedBy || "—"} · {formatDateTime(data.globalRow.updatedAt)}
                  </MetaText>
                </div>
              ) : (
                <p className="text-sm font-medium text-slate-500">
                  لا توجد سياسة عامة مضبوطة — يسري الافتراضي:{" "}
                  <span className="font-extrabold text-slate-800">منع (block)</span>، أي يُرفض أي صرف يجعل الرصيد سالبًا.
                </p>
              )}
            </div>
          </section>

          {/* ── سياسات المستودعات ─────────────────────────────────────── */}
          <PolicyRowsSection
            icon={WarehouseIcon}
            title="سياسات المستودعات"
            subtitle="استثناء على مستوى مستودع كامل — يتقدّم على السياسة العامة."
            emptyText="لا توجد سياسات مستودعات — تسري السياسة العامة على الجميع."
            rows={data.warehouseRows}
            firstCol="المستودع"
            firstCell={(r) => r.warehouseName ?? r.warehouseId ?? "—"}
            canEdit={canEdit}
            onAdd={() => openDialog("warehouse")}
            onEdit={(r) => openDialog("warehouse", r)}
            addLabel="سياسة مستودع"
          />

          {/* ── سياسات الأصناف ────────────────────────────────────────── */}
          <PolicyRowsSection
            icon={Package}
            title="سياسات الأصناف"
            subtitle="استثناء لصنف بعينه داخل مستودع محدد — المستوى الأعلى تحديدًا وأولويةً."
            emptyText="لا توجد سياسات أصناف — تُحسم الأصناف من مستويي المستودع والعام."
            rows={data.itemRows}
            firstCol="الصنف / المستودع"
            firstCell={(r) => (
              <span>
                <span className="font-extrabold text-slate-900">{r.itemName ?? r.itemId ?? "—"}</span>
                <span className="mr-2 text-xs font-medium text-slate-400">{r.warehouseName ?? r.warehouseId ?? ""}</span>
              </span>
            )}
            canEdit={canEdit}
            onAdd={() => openDialog("item")}
            onEdit={(r) => openDialog("item", r)}
            addLabel="سياسة صنف"
          />

          <EffectiveTester warehouseOptions={whOptions} />

          <PolicyDialog
            open={dialog.open}
            onClose={() => setDialog((d) => ({ ...d, open: false }))}
            scope={dialog.scope}
            row={dialog.row}
            warehouseOptions={whOptions}
            allowEnabled={data.allowEnabled}
          />
        </>
      )}
    </div>
  );
}

function ExplainerCard({ policy, badge }: { policy: PolicyMode; badge?: string }) {
  return (
    <article className="surface p-4">
      <div className="flex items-center justify-between gap-2">
        <PolicyBadge policy={policy} />
        {badge && (
          <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">{badge}</span>
        )}
      </div>
      <p className="mt-3 text-xs font-medium leading-5 text-slate-500">{POLICY_HINTS[policy]}</p>
    </article>
  );
}

function MetaText({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="text-xs font-medium text-slate-500">
      {label}: <span className="font-extrabold text-slate-800">{children}</span>
    </span>
  );
}

function PolicyRowsSection({
  icon,
  title,
  subtitle,
  emptyText,
  rows,
  firstCol,
  firstCell,
  canEdit,
  onAdd,
  onEdit,
  addLabel,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
  emptyText: string;
  rows: PolicyRow[];
  firstCol: string;
  firstCell: (r: PolicyRow) => React.ReactNode;
  canEdit: boolean;
  onAdd: () => void;
  onEdit: (r: PolicyRow) => void;
  addLabel: string;
}) {
  return (
    <section className="surface mt-4 overflow-hidden">
      <PanelTitle
        icon={icon}
        title={title}
        subtitle={subtitle}
        action={
          canEdit ? (
            <Button variant="secondary" size="sm" onClick={onAdd}>
              <Plus className="h-3.5 w-3.5" /> {addLabel}
            </Button>
          ) : undefined
        }
      />
      {rows.length === 0 ? (
        <p className="p-5 text-sm font-medium text-slate-500">{emptyText}</p>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs font-bold text-slate-500">
                <tr>
                  <th className="px-4 py-3 text-right">{firstCol}</th>
                  <th className="px-4 py-3 text-right">السياسة</th>
                  <th className="px-4 py-3 text-right">الحد الأقصى للعجز</th>
                  <th className="px-4 py-3 text-right">سبب إلزامي</th>
                  <th className="px-4 py-3 text-right">الحالة</th>
                  <th className="px-4 py-3 text-right">آخر تحديث</th>
                  {canEdit && <th className="px-4 py-3 text-left">إجراء</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.id} className={cn("transition hover:bg-slate-50", !r.isEnabled && "opacity-60")}>
                    <td className="px-4 py-3 font-bold text-slate-800">{firstCell(r)}</td>
                    <td className="px-4 py-3"><PolicyBadge policy={r.policy} /></td>
                    <td className="px-4 py-3 tabular-nums text-slate-700">
                      {r.policy === "controlled" ? formatQty(r.maxNegativeQty) : "—"}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{r.requireReason ? "نعم" : "لا"}</td>
                    <td className="px-4 py-3"><EnabledBadge enabled={r.isEnabled} /></td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      {r.updatedBy || "—"} · {formatDateTime(r.updatedAt)}
                    </td>
                    {canEdit && (
                      <td className="px-4 py-3 text-left">
                        <Button variant="ghost" size="sm" onClick={() => onEdit(r)} aria-label={`تعديل ${title}`}>
                          <Pencil className="h-3.5 w-3.5" /> تعديل
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="space-y-3 p-4 md:hidden">
            {rows.map((r) => (
              <div key={r.id} className={cn("rounded-xl border border-slate-200 p-4", !r.isEnabled && "opacity-60")}>
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-sm font-extrabold text-slate-900">{firstCell(r)}</span>
                  <PolicyBadge policy={r.policy} />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-medium text-slate-500">
                  <span>الحد: <span className="font-extrabold tabular-nums text-slate-800">{r.policy === "controlled" ? formatQty(r.maxNegativeQty) : "—"}</span></span>
                  <span>سبب إلزامي: {r.requireReason ? "نعم" : "لا"}</span>
                  <EnabledBadge enabled={r.isEnabled} />
                </div>
                {canEdit && (
                  <div className="mt-3">
                    <Button variant="secondary" size="sm" onClick={() => onEdit(r)}>
                      <Pencil className="h-3.5 w-3.5" /> تعديل
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
