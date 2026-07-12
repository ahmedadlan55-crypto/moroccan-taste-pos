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
import { warehouseHealth, warehouseTypeLabel } from "@/modules/inventory/lib/status-labels";
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
  { id: "info", label: "بيانات المستودع" },
  { id: "stock", label: "الرصيد والقيمة" },
  { id: "movements", label: "آخر الحركات" },
  { id: "access", label: "صلاحيات الوصول" },
  { id: "admin", label: "الإدارة" },
];

export function WarehouseDetailDrawer({
  warehouseId,
  onClose,
}: {
  warehouseId: string | null;
  onClose: () => void;
}) {
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
  const visibleTabs = TABS.filter((t) => (t.id === "access" ? canAssign : true));

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        title={w?.name ?? "…"}
        eyebrow="إدارة المستودع"
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
              {visibleTabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={`whitespace-nowrap rounded-t-xl px-3 py-2.5 text-xs font-extrabold transition ${
                    tab === t.id
                      ? "border-b-2 border-teal-600 text-teal-700"
                      : "text-slate-400 hover:text-slate-600"
                  }`}
                  aria-pressed={tab === t.id}
                >
                  {t.label}
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
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <DetailStat label="الكود" value={<span dir="ltr">{w.code}</span>} />
        <DetailStat label="النوع" value={warehouseTypeLabel(w.type)} />
        <DetailStat label="العلامة التجارية" value={w.brandName || (w.brandId ? w.brandId : "—")} />
        <DetailStat label="الفرع" value={w.branchName || (w.branchId ? w.branchId : "—")} />
        <DetailStat label="الموقع" value={w.location || "—"} />
        <DetailStat label="المسؤول" value={w.manager || "—"} />
        <DetailStat label="مستودع رئيسي" value={w.isMain ? "نعم" : "لا"} />
        <DetailStat label="تاريخ الإنشاء" value={formatDateTime(w.createdAt)} />
      </div>
      {w.description && (
        <p className="mt-4 rounded-xl border border-slate-100 bg-slate-50 px-3 py-3 text-sm font-medium text-slate-600">
          {w.description}
        </p>
      )}
      {canEdit && (
        <Button className="mt-5 w-full" variant="secondary" onClick={onEdit}>
          <Pencil className="h-4 w-4" /> تعديل البيانات
        </Button>
      )}
    </>
  );
}

// ── الرصيد والقيمة ───────────────────────────────────────────────────────────
function StockTab({ w }: { w: WarehouseAdmin }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <DetailStat label="قيمة المخزون" value={formatCurrency(w.totalValue)} />
        <DetailStat label="إجمالي الكمية" value={formatNumber(w.totalQty)} />
        <DetailStat label="عدد الأصناف" value={formatNumber(w.itemCount)} />
        <DetailStat label="عدد الحركات" value={formatNumber(w.movementCount)} />
      </div>
      <h3 className="mt-6 text-sm font-extrabold text-slate-900">تفصيل التنبيهات</h3>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <DetailStat label="منخفض" value={formatNumber(w.lowCount)} />
        <DetailStat label="نافد" value={formatNumber(w.outCount)} />
        <DetailStat label="سالب" value={formatNumber(w.negativeCount)} />
      </div>
      <div className="mt-6 flex items-center gap-2 text-xs font-bold text-slate-400">
        <Building2 className="h-4 w-4" /> القيم بمتوسط تكلفة المستودع (WAC)؛ تُقدَّر بالتكلفة
        العامة عند غياب WAC. آخر حركة: {formatDateTime(w.lastMovementAt)}
      </div>
    </>
  );
}

// ── آخر الحركات ──────────────────────────────────────────────────────────────
function MovementsTab({ data }: { data: import("@/modules/inventory/lib/adapters/warehouse-admin.adapter").WarehouseMovementRow[] }) {
  if (!data.length) {
    return <EmptyState title="لا توجد حركات" body="لم تُسجَّل أي حركة مخزنية على هذا المستودع بعد." />;
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs font-bold text-slate-400">
        <History className="h-4 w-4" /> آخر {formatNumber(data.length)} حركة
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
          <div className="text-left">
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
        title="لا تملك صلاحية الإدارة"
        body="تفعيل/تعطيل المستودع أو حذفه يتطلب صلاحية مدير أو مسؤول."
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
                {w.isActive ? "تعطيل المستودع" : "تفعيل المستودع"}
              </div>
              <p className="mt-1 text-xs font-medium text-slate-500">
                {w.isActive
                  ? "يمنع الحركات الجديدة. يتطلب أن تكون كل الأرصدة صفرًا."
                  : "يعيد المستودع للعمل ويظهر في القوائم التشغيلية."}
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
              <Power className="h-4 w-4" /> {w.isActive ? "تعطيل" : "تفعيل"}
            </Button>
          </div>
        </div>
      )}

      {isAdmin && (
        <div className="rounded-xl border border-rose-100 bg-rose-50/40 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-extrabold text-rose-700">حذف صلب</div>
              <p className="mt-1 text-xs font-medium text-slate-500">
                يحذف المستودع نهائيًا. مسموح فقط لمستودع لم يُستخدم إطلاقًا (بلا أرصدة وبلا
                حركات) — وإلا استخدم التعطيل.
              </p>
            </div>
            <Button
              variant="danger"
              onClick={() => {
                remove.reset();
                setConfirm("delete");
              }}
            >
              <Trash2 className="h-4 w-4" /> حذف
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 text-xs font-bold text-slate-400">
        <ShieldCheck className="h-4 w-4" /> كل إجراء يُسجَّل في سجل التدقيق باسم منفّذه.
      </div>

      <ConfirmDialog
        open={confirm === "toggle"}
        title={w.isActive ? `تعطيل «${w.name}»؟` : `تفعيل «${w.name}»؟`}
        description={
          w.isActive
            ? "سيُمنع إنشاء حركات جديدة على هذا المستودع. إذا كانت هناك أرصدة غير صفرية سيرفض النظام التعطيل."
            : "سيعود المستودع للظهور في القوائم التشغيلية."
        }
        tone={w.isActive ? "danger" : "primary"}
        confirmLabel={w.isActive ? "تعطيل" : "تفعيل"}
        processing={activate.isPending || deactivate.isPending}
        error={toggleErr}
        onConfirm={doToggle}
        onClose={() => setConfirm(null)}
      />

      <ConfirmDialog
        open={confirm === "delete"}
        title={`حذف «${w.name}» نهائيًا؟`}
        description="لا يمكن التراجع عن الحذف الصلب. سيرفض النظام الحذف إذا وُجد أي رصيد أو حركة على المستودع."
        tone="danger"
        confirmLabel="حذف نهائي"
        processing={remove.isPending}
        error={deleteErr}
        onConfirm={doDelete}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}
