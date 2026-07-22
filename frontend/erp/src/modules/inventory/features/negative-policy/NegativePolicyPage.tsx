// Phase W2 — negative-stock policy settings page. Three sections (global /
// per-warehouse / per-item rows) + the effective-policy tester. Editing is
// gated by negativePolicy.edit (admin); the `allow` policy is developer-only
// and env-gated. Users with only negativePolicy.view get a read-only page.

import { useMemo, useState } from "react";
import {
  Ban, Eye, Package, Pencil, Plus, ShieldAlert, SlidersHorizontal, Warehouse as WarehouseIcon,
} from "lucide-react";
import { PageHeader, PanelTitle } from "@/shared/ui";
import { Button } from "@/shared/ui";
import { LoadingState, ErrorState, PermissionDenied } from "@/shared/ui";
import { useCan } from "@/modules/inventory/lib/permission-provider";
import { useAuth } from "@/app/providers";
import { useWarehouses } from "@/modules/inventory/lib/hooks/useWarehouses";
import { useWarehouseScope } from "@/modules/inventory/lib/warehouse-scope-provider";
import { useNegativePolicySettings } from "@/modules/inventory/lib/hooks/useNegativePolicy";
import { formatDateTime, formatQty } from "@/shared/lib";
import { cn } from "@/shared/lib";
import { useT } from "@/i18n";
import type { PolicyMode, PolicyRow, PolicyScope } from "@/modules/inventory/lib/adapters/negative-policy.adapter";
import { policyHint } from "./labels";
import { EnabledBadge, PolicyBadge } from "./shared";
import { PolicyDialog } from "./PolicyDialog";
import { EffectiveTester } from "./EffectiveTester";

interface DialogState {
  open: boolean;
  scope: PolicyScope;
  row: PolicyRow | null;
}

export function NegativePolicyPage() {
  const t = useT();
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
        eyebrow={t("inventoryRest.negativePolicy.page.eyebrow")}
        title={t("inventoryRest.negativePolicy.page.title")}
        subtitle={t("inventoryRest.negativePolicy.page.subtitle")}
        action={
          !canEdit ? (
            <span className="chip border-slate-200 bg-slate-50 text-slate-600">
              <Eye className="h-3.5 w-3.5" /> {t("inventoryRest.negativePolicy.page.viewOnly")}
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
                {t("inventoryRest.negativePolicy.page.gateDisabledBanner")}
              </div>
            </div>
          )}

          <section className="grid gap-4 lg:grid-cols-3">
            <ExplainerCard policy="block" badge={t("inventoryRest.negativePolicy.badge.default")} />
            <ExplainerCard policy="controlled" />
            {isDeveloper ? (
              <ExplainerCard policy="allow" badge={data.allowEnabled ? t("inventoryRest.negativePolicy.badge.gateOn") : t("inventoryRest.negativePolicy.badge.gateOff")} />
            ) : (
              <article className="surface p-4 opacity-70">
                <div className="flex items-center gap-2">
                  <span className="grid h-9 w-9 place-items-center rounded-xl bg-slate-100 text-slate-500">
                    <Ban className="h-4 w-4" />
                  </span>
                  <span className="text-sm font-extrabold text-slate-700">{t("inventoryRest.negativePolicy.policy.allow")}</span>
                </div>
                <p className="mt-3 text-xs font-medium leading-5 text-slate-500">
                  {t("inventoryRest.negativePolicy.page.allowHiddenBody")}
                </p>
              </article>
            )}
          </section>

          {/* ── السياسة العامة ─────────────────────────────────────────── */}
          <section className="surface mt-4 overflow-hidden">
            <PanelTitle
              icon={SlidersHorizontal}
              title={t("inventoryRest.negativePolicy.global.title")}
              subtitle={t("inventoryRest.negativePolicy.global.subtitle")}
              action={
                canEdit ? (
                  <Button variant="secondary" size="sm" onClick={() => openDialog("global", data.globalRow)}>
                    <Pencil className="h-3.5 w-3.5" /> {data.globalRow ? t("common.edit") : t("inventoryRest.negativePolicy.global.setPolicy")}
                  </Button>
                ) : undefined
              }
            />
            <div className="p-5">
              {data.globalRow ? (
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                  <PolicyBadge policy={data.globalRow.policy} />
                  <MetaText label={t("inventoryRest.negativePolicy.col.maxDeficit")}>
                    {data.globalRow.policy === "controlled" ? formatQty(data.globalRow.maxNegativeQty) : "—"}
                  </MetaText>
                  <MetaText label={t("inventoryRest.negativePolicy.col.requireReason")}>{data.globalRow.requireReason ? t("common.yes") : t("common.no")}</MetaText>
                  <EnabledBadge enabled={data.globalRow.isEnabled} />
                  <MetaText label={t("inventoryRest.negativePolicy.col.lastUpdate")}>
                    {data.globalRow.updatedBy || "—"} · {formatDateTime(data.globalRow.updatedAt)}
                  </MetaText>
                </div>
              ) : (
                <p className="text-sm font-medium text-slate-500">
                  {t("inventoryRest.negativePolicy.global.noPolicyPrefix")}{" "}
                  <span className="font-extrabold text-slate-800">{t("inventoryRest.negativePolicy.policy.block")}</span>{t("inventoryRest.negativePolicy.global.noPolicySuffix")}
                </p>
              )}
            </div>
          </section>

          {/* ── سياسات المستودعات ─────────────────────────────────────── */}
          <PolicyRowsSection
            icon={WarehouseIcon}
            title={t("inventoryRest.negativePolicy.warehouse.title")}
            subtitle={t("inventoryRest.negativePolicy.warehouse.subtitle")}
            emptyText={t("inventoryRest.negativePolicy.warehouse.empty")}
            rows={data.warehouseRows}
            firstCol={t("inventoryRest.negativePolicy.col.warehouse")}
            firstCell={(r) => r.warehouseName ?? r.warehouseId ?? "—"}
            canEdit={canEdit}
            onAdd={() => openDialog("warehouse")}
            onEdit={(r) => openDialog("warehouse", r)}
            addLabel={t("inventoryRest.negativePolicy.warehouse.addLabel")}
          />

          {/* ── سياسات الأصناف ────────────────────────────────────────── */}
          <PolicyRowsSection
            icon={Package}
            title={t("inventoryRest.negativePolicy.item.title")}
            subtitle={t("inventoryRest.negativePolicy.item.subtitle")}
            emptyText={t("inventoryRest.negativePolicy.item.empty")}
            rows={data.itemRows}
            firstCol={t("inventoryRest.negativePolicy.col.itemWarehouse")}
            firstCell={(r) => (
              <span>
                <span className="font-extrabold text-slate-900">{r.itemName ?? r.itemId ?? "—"}</span>
                <span className="mr-2 text-xs font-medium text-slate-400">{r.warehouseName ?? r.warehouseId ?? ""}</span>
              </span>
            )}
            canEdit={canEdit}
            onAdd={() => openDialog("item")}
            onEdit={(r) => openDialog("item", r)}
            addLabel={t("inventoryRest.negativePolicy.item.addLabel")}
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
  const t = useT();
  return (
    <article className="surface p-4">
      <div className="flex items-center justify-between gap-2">
        <PolicyBadge policy={policy} />
        {badge && (
          <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">{badge}</span>
        )}
      </div>
      <p className="mt-3 text-xs font-medium leading-5 text-slate-500">{policyHint(t, policy)}</p>
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
  const t = useT();
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
                  <th className="px-4 py-3 text-right">{t("inventoryRest.negativePolicy.col.policy")}</th>
                  <th className="px-4 py-3 text-right">{t("inventoryRest.negativePolicy.col.maxDeficit")}</th>
                  <th className="px-4 py-3 text-right">{t("inventoryRest.negativePolicy.col.requireReason")}</th>
                  <th className="px-4 py-3 text-right">{t("common.status")}</th>
                  <th className="px-4 py-3 text-right">{t("inventoryRest.negativePolicy.col.lastUpdate")}</th>
                  {canEdit && <th className="px-4 py-3 text-left">{t("inventoryRest.negativePolicy.col.action")}</th>}
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
                    <td className="px-4 py-3 text-slate-600">{r.requireReason ? t("common.yes") : t("common.no")}</td>
                    <td className="px-4 py-3"><EnabledBadge enabled={r.isEnabled} /></td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      {r.updatedBy || "—"} · {formatDateTime(r.updatedAt)}
                    </td>
                    {canEdit && (
                      <td className="px-4 py-3 text-left">
                        <Button variant="ghost" size="sm" onClick={() => onEdit(r)} aria-label={t("inventoryRest.negativePolicy.editAria", { title })}>
                          <Pencil className="h-3.5 w-3.5" /> {t("common.edit")}
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
                  <span>{t("inventoryRest.negativePolicy.limitLabel")}: <span className="font-extrabold tabular-nums text-slate-800">{r.policy === "controlled" ? formatQty(r.maxNegativeQty) : "—"}</span></span>
                  <span>{t("inventoryRest.negativePolicy.col.requireReason")}: {r.requireReason ? t("common.yes") : t("common.no")}</span>
                  <EnabledBadge enabled={r.isEnabled} />
                </div>
                {canEdit && (
                  <div className="mt-3">
                    <Button variant="secondary" size="sm" onClick={() => onEdit(r)}>
                      <Pencil className="h-3.5 w-3.5" /> {t("common.edit")}
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
