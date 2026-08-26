import { useEffect, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Building2,
  History,
  Pencil,
  Power,
  ShieldCheck,
  Trash2,
  Warehouse as WarehouseIcon,
} from "lucide-react";
import { Drawer, DetailStat } from "@/shared/ui";
import { Button } from "@/shared/ui";
import { Spinner } from "@/shared/ui";
import { ConfirmDialog } from "@/shared/ui";
import { ErrorState, EmptyState } from "@/shared/ui";
import { StatusBadge } from "@/shared/ui";
import { useCan } from "@/modules/inventory/lib/permission-provider";
import { formatCurrency, formatNumber, formatDateTime, formatQty } from "@/shared/lib";
import { useT } from "@/i18n";
import { warehouseHealth } from "@/modules/inventory/lib/status-labels";
import { warehouseTypeLabel } from "./WarehousesPage";
import { ApiError } from "@/shared/api";
import {
  useWarehouseAdminDetail,
  useActivateWarehouse,
  useDeactivateWarehouse,
  useDeleteWarehouse,
} from "@/modules/inventory/lib/hooks/useWarehouseAdmin";
import type { WarehouseAdmin } from "@/modules/inventory/lib/adapters/warehouse-admin.adapter";
import { WarehouseFormDialog } from "./WarehouseFormDialog";
import { ScopeAssignmentsSection } from "./ScopeAssignmentsSection";

// Warehouse detail drawer (Phase W6) — tabs: بيانات المستودع / الرصيد والقيمة /
// آخر الحركات / صلاحيات الوصول / الإدارة (activate/deactivate + hard delete).
// Blocked-reason errors (422) from the backend render INSIDE the confirm
// dialogs so the user sees exactly why an action was refused.

type Tab = "info" | "stock" | "movements" | "access" | "admin";

const TABS: { id: Tab; label: string }[] = [
  { id: "info", label: "inventoryRest.warehouses.tabs.info" },
  { id: "stock", label: "inventoryRest.warehouses.tabs.stock" },
  { id: "movements", label: "inventoryRest.warehouses.tabs.movements" },
  { id: "access", label: "inventoryRest.warehouses.tabs.access" },
  { id: "admin", label: "inventoryRest.warehouses.tabs.admin" },
];

export function WarehouseDetailDrawer({
  warehouseId,
  onClose,
}: {
  warehouseId: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const open = !!warehouseId;
  const { data, isLoading, isError, error, refetch } = useWarehouseAdminDetail(warehouseId);
  const canEdit = useCan("warehouse.edit");
  const canAssign = useCan("warehouse.scopeAssign");
  const [tab, setTab] = useState<Tab>("info");
  const [editOpen, setEditOpen] = useState(false);

  useEffect(() => {
    if (open) setTab("info");
  }, [open, warehouseId]);

  const w = data?.warehouse ?? null;
  const visibleTabs = TABS.filter((tabDef) => (tabDef.id === "access" ? canAssign : true));

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        title={w?.name ?? "…"}
        eyebrow={t("inventoryRest.warehouses.drawerEyebrow")}
        icon={WarehouseIcon}
      >
        {isLoading && (
          <div className="grid place-items-center p-10">
            <Spinner className="h-6 w-6" />
          </div>
        )}
        {!isLoading && (isError || !data) && open && (
          <ErrorState error={error} onRetry={() => refetch()} />
        )}
        {!isLoading && data && w && (
          <>
            <div className="mb-4 flex items-center justify-between gap-2">
              <StatusBadge>{warehouseHealth(w)}</StatusBadge>
              <span className="text-xs font-bold text-slate-400" dir="ltr">
                {w.code}
              </span>
            </div>

            <div className="scrollbar-thin -mx-1 mb-5 flex gap-1 overflow-x-auto border-b border-slate-100 px-1">
              {visibleTabs.map((tabDef) => (
                <button
                  key={tabDef.id}
                  type="button"
                  onClick={() => setTab(tabDef.id)}
                  className={`whitespace-nowrap rounded-t-xl px-3 py-2.5 text-xs font-extrabold transition ${
                    tab === tabDef.id
                      ? "border-b-2 border-teal-600 text-teal-700"
                      : "text-slate-400 hover:text-slate-600"
                  }`}
                  aria-pressed={tab === tabDef.id}
                >
                  {t(tabDef.label)}
                </button>
              ))}
            </div>

            {tab === "info" && (
              <InfoTab w={w} canEdit={canEdit} onEdit={() => setEditOpen(true)} />
            )}
            {tab === "stock" && <StockTab w={w} />}
            {tab === "movements" && <MovementsTab data={data.movements} />}
            {tab === "access" && canAssign && warehouseId && (
              <ScopeAssignmentsSection warehouseId={warehouseId} />
            )}
            {tab === "admin" && warehouseId && (
              <AdminTab w={w} warehouseId={warehouseId} onDeleted={onClose} />
            )}
          </>
        )}
      </Drawer>

      <WarehouseFormDialog
        open={editOpen}
        warehouse={w}
        onClose={() => setEditOpen(false)}
      />
    </>
  );
}

// ── بيانات المستودع ──────────────────────────────────────────────────────────
function InfoTab({ w, canEdit, onEdit }: { w: WarehouseAdmin; canEdit: boolean; onEdit: () => void }) {
  const t = useT();
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <DetailStat label={t("inventoryRest.warehouses.info.code")} value={<span dir="ltr">{w.code}</span>} />
        <DetailStat label={t("inventoryRest.warehouses.info.type")} value={warehouseTypeLabel(t, w.type)} />
        <DetailStat label={t("inventoryRest.warehouses.info.brand")} value={w.brandName || (w.brandId ? w.brandId : "—")} />
        <DetailStat label={t("inventoryRest.warehouses.info.branch")} value={w.branchName || (w.branchId ? w.branchId : "—")} />
        <DetailStat label={t("inventoryRest.warehouses.info.location")} value={w.location || "—"} />
        <DetailStat label={t("inventoryRest.warehouses.info.manager")} value={w.manager || "—"} />
        <DetailStat label={t("inventoryRest.warehouses.info.isMain")} value={w.isMain ? t("inventoryRest.warehouses.info.yes") : t("inventoryRest.warehouses.info.no")} />
        <DetailStat label={t("inventoryRest.warehouses.info.createdAt")} value={formatDateTime(w.createdAt)} />
      </div>
      {w.description && (
        <p className="mt-4 rounded-xl border border-slate-100 bg-slate-50 px-3 py-3 text-sm font-medium text-slate-600">
          {w.description}
        </p>
      )}
      {canEdit && (
        <Button className="mt-5 w-full" variant="secondary" onClick={onEdit}>
          <Pencil className="h-4 w-4" /> {t("inventoryRest.warehouses.info.editBtn")}
        </Button>
      )}
    </>
  );
}

// ── الرصيد والقيمة ───────────────────────────────────────────────────────────
function StockTab({ w }: { w: WarehouseAdmin }) {
  const t = useT();
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <DetailStat label={t("inventoryRest.warehouses.stock.value")} value={formatCurrency(w.totalValue)} />
        <DetailStat label={t("inventoryRest.warehouses.stock.totalQty")} value={formatNumber(w.totalQty)} />
        <DetailStat label={t("inventoryRest.warehouses.stock.itemCount")} value={formatNumber(w.itemCount)} />
        <DetailStat label={t("inventoryRest.warehouses.stock.movementCount")} value={formatNumber(w.movementCount)} />
      </div>
      <h3 className="mt-6 text-sm font-extrabold text-slate-900">{t("inventoryRest.warehouses.stock.alertsTitle")}</h3>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <DetailStat label={t("inventoryRest.warehouses.stock.low")} value={formatNumber(w.lowCount)} />
        <DetailStat label={t("inventoryRest.warehouses.stock.out")} value={formatNumber(w.outCount)} />
        <DetailStat label={t("inventoryRest.warehouses.stock.negative")} value={formatNumber(w.negativeCount)} />
      </div>
      <div className="mt-6 flex items-center gap-2 text-xs font-bold text-slate-400">
        <Building2 className="h-4 w-4" /> {t("inventoryRest.warehouses.stock.wacNote", { date: formatDateTime(w.lastMovementAt) })}
      </div>
    </>
  );
}

// ── آخر الحركات ──────────────────────────────────────────────────────────────
function MovementsTab({ data }: { data: import("@/modules/inventory/lib/adapters/warehouse-admin.adapter").WarehouseMovementRow[] }) {
  const t = useT();
  if (!data.length) {
    return <EmptyState title={t("inventoryRest.warehouses.movements.emptyTitle")} body={t("inventoryRest.warehouses.movements.emptyBody")} />;
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs font-bold text-slate-400">
        <History className="h-4 w-4" /> {t("inventoryRest.warehouses.movements.lastN", { count: formatNumber(data.length) })}
      </div>
      {data.map((m) => (
        <div key={m.id} className="flex items-center gap-3 rounded-xl border border-slate-100 px-3 py-3">
          <span
            className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${
              m.type === "in" ? "bg-teal-50 text-teal-700" : "bg-rose-50 text-rose-600"
            }`}
          >
            {m.type === "in" ? <ArrowDownLeft className="h-4 w-4" /> : <ArrowUpRight className="h-4 w-4" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-extrabold text-slate-800">{m.itemName || m.itemId}</div>
            <div className="truncate text-xs font-bold text-slate-400">
              {m.reason || "—"}
              {m.username ? ` · ${m.username}` : ""}
            </div>
          </div>
          <div className="text-end">
            <div className={`text-sm font-extrabold tabular-nums ${m.type === "in" ? "text-teal-700" : "text-rose-600"}`}>
              {m.type === "in" ? "+" : "−"}
              {formatQty(m.qty)}
            </div>
            <div className="text-[10px] font-bold text-slate-400">{formatDateTime(m.date)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── الإدارة: تفعيل/تعطيل + حذف صلب ──────────────────────────────────────────
function AdminTab({
  w,
  warehouseId,
  onDeleted,
}: {
  w: WarehouseAdmin;
  warehouseId: string;
  onDeleted: () => void;
}) {
  const t = useT();
  const canDeactivate = useCan("warehouse.deactivate");
  // The hard delete is admin-only on the backend; warehouse.scopeAssign is the
  // client-side admin mirror (permissions.ts has no dedicated warehouse.delete).
  const isAdmin = useCan("warehouse.scopeAssign");
  const activate = useActivateWarehouse();
  const deactivate = useDeactivateWarehouse();
  const remove = useDeleteWarehouse();
  const [confirm, setConfirm] = useState<"toggle" | "delete" | null>(null);

  const toggleErr =
    (w.isActive ? deactivate.error : activate.error) instanceof ApiError
      ? ((w.isActive ? deactivate.error : activate.error) as ApiError).message
      : (w.isActive ? deactivate.error : activate.error)?.message ?? null;
  const deleteErr =
    remove.error instanceof ApiError ? remove.error.message : remove.error?.message ?? null;

  async function doToggle() {
    try {
      if (w.isActive) await deactivate.mutateAsync({ id: warehouseId });
      else await activate.mutateAsync({ id: warehouseId });
      setConfirm(null);
    } catch {
      // 422/409 stays on the mutation and renders inside the dialog.
    }
  }

  async function doDelete() {
    try {
      await remove.mutateAsync({ id: warehouseId });
      setConfirm(null);
      onDeleted();
    } catch {
      // blocked-reason error renders inside the dialog
    }
  }

  if (!canDeactivate && !isAdmin) {
    return (
      <EmptyState
        title={t("inventoryRest.warehouses.admin.noPermTitle")}
        body={t("inventoryRest.warehouses.admin.noPermBody")}
      />
    );
  }

  return (
    <div className="space-y-3">
      {canDeactivate && (
        <div className="rounded-xl border border-slate-100 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-extrabold text-slate-800">
                {w.isActive ? t("inventoryRest.warehouses.admin.deactivateTitle") : t("inventoryRest.warehouses.admin.activateTitle")}
              </div>
              <p className="mt-1 text-xs font-medium text-slate-500">
                {w.isActive
                  ? t("inventoryRest.warehouses.admin.deactivateBody")
                  : t("inventoryRest.warehouses.admin.activateBody")}
              </p>
            </div>
            <Button
              variant={w.isActive ? "danger" : "primary"}
              onClick={() => {
                activate.reset();
                deactivate.reset();
                setConfirm("toggle");
              }}
            >
              <Power className="h-4 w-4" /> {w.isActive ? t("inventoryRest.warehouses.admin.deactivate") : t("inventoryRest.warehouses.admin.activate")}
            </Button>
          </div>
        </div>
      )}

      {isAdmin && (
        <div className="rounded-xl border border-rose-100 bg-rose-50/40 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-extrabold text-rose-700">{t("inventoryRest.warehouses.admin.hardDeleteTitle")}</div>
              <p className="mt-1 text-xs font-medium text-slate-500">
                {t("inventoryRest.warehouses.admin.hardDeleteBody")}
              </p>
            </div>
            <Button
              variant="danger"
              onClick={() => {
                remove.reset();
                setConfirm("delete");
              }}
            >
              <Trash2 className="h-4 w-4" /> {t("inventoryRest.warehouses.admin.delete")}
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 text-xs font-bold text-slate-400">
        <ShieldCheck className="h-4 w-4" /> {t("inventoryRest.warehouses.admin.auditNote")}
      </div>

      <ConfirmDialog
        open={confirm === "toggle"}
        title={w.isActive ? t("inventoryRest.warehouses.admin.confirmDeactivate", { name: w.name }) : t("inventoryRest.warehouses.admin.confirmActivate", { name: w.name })}
        description={
          w.isActive
            ? t("inventoryRest.warehouses.admin.confirmDeactivateBody")
            : t("inventoryRest.warehouses.admin.confirmActivateBody")
        }
        tone={w.isActive ? "danger" : "primary"}
        confirmLabel={w.isActive ? t("inventoryRest.warehouses.admin.deactivate") : t("inventoryRest.warehouses.admin.activate")}
        processing={activate.isPending || deactivate.isPending}
        error={toggleErr}
        onConfirm={doToggle}
        onClose={() => setConfirm(null)}
      />

      <ConfirmDialog
        open={confirm === "delete"}
        title={t("inventoryRest.warehouses.admin.confirmDeleteTitle", { name: w.name })}
        description={t("inventoryRest.warehouses.admin.confirmDeleteBody")}
        tone="danger"
        confirmLabel={t("inventoryRest.warehouses.admin.confirmDeleteLabel")}
        processing={remove.isPending}
        error={deleteErr}
        onConfirm={doDelete}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}
