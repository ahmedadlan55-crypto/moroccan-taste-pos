import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Monitor, Pencil, Plus, Trash2 } from "lucide-react";
import {
  Badge,
  Button,
  ConfirmDialog,
  IconButton,
  PageHeader,
  Select,
  StatusBadge,
  safeUserMessage,
} from "@/shared/ui";
import { Can } from "@/shared/permissions";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatCurrency } from "@/shared/lib";
import { useT } from "@/i18n";
import { posAdminApi } from "../lib/api";
import { posAdminKeys } from "../lib/shifts";
import { pmGroupLabel, pmGroupOptions, PM_GROUP_TONE } from "../lib/labels";
import type { PaymentMethod, PaymentMethodInput } from "../lib/types";
import { PaymentMethodDialog } from "../components/PaymentMethodDialog";
import { PosLauncherCard } from "../components/PosLauncherCard";

function feeText(pm: PaymentMethod): string {
  if (pm.serviceFeeType === "percent") return `${Number(pm.serviceFeeValue) || 0}%`;
  if (pm.serviceFeeType === "fixed") return formatCurrency(pm.serviceFeeValue);
  return "—";
}

export function RegisterPage() {
  const t = useT();
  const qc = useQueryClient();
  const groupOptions = useMemo(() => pmGroupOptions(t), [t]);
  const query = useQuery({
    queryKey: posAdminKeys.paymentMethods,
    queryFn: ({ signal }) => posAdminApi.paymentMethods(signal),
    staleTime: 30_000,
  });
  const all: PaymentMethod[] = Array.isArray(query.data) ? query.data : [];

  const [group, setGroup] = useState("");
  const [status, setStatus] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PaymentMethod | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PaymentMethod | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const rows = useMemo(
    () =>
      all.filter((p) => {
        if (group && (p.groupType || "cash") !== group) return false;
        if (status !== "" && (p.isActive ? "1" : "0") !== status) return false;
        return true;
      }),
    [all, group, status],
  );

  const saveMut = useMutation({
    mutationFn: async (input: PaymentMethodInput) => {
      const r = await posAdminApi.savePaymentMethod(input);
      if (r && r.success === false) throw new Error(r.error || t("posAdmin.register.saveFailed"));
      return r;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: posAdminKeys.paymentMethods });
      setDialogOpen(false);
      setEditing(null);
    },
    onError: (e) => setSaveError(safeUserMessage(e)),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string | number) => {
      const r = await posAdminApi.deletePaymentMethod(id);
      if (r && r.success === false) throw new Error(r.error || t("posAdmin.register.deleteFailed"));
      return r;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: posAdminKeys.paymentMethods });
      setDeleteTarget(null);
    },
    onError: (e) => setDeleteError(safeUserMessage(e)),
  });

  function openCreate() {
    setEditing(null);
    setSaveError(null);
    setDialogOpen(true);
  }
  function openEdit(pm: PaymentMethod) {
    setEditing(pm);
    setSaveError(null);
    setDialogOpen(true);
  }

  const columns: ColumnDef<PaymentMethod>[] = [
    {
      id: "sortOrder",
      header: t("posAdmin.col.order"),
      accessor: (r) => Number(r.sortOrder) || 0,
      numeric: true,
      sortable: true,
      width: "5rem",
    },
    {
      id: "name",
      header: t("posAdmin.col.name"),
      accessor: (r) => r.nameAr || r.name,
      sortable: true,
      cell: (r) => (
        <div>
          <div className="font-extrabold text-slate-800">{r.nameAr || r.name}</div>
          {r.name && r.name !== r.nameAr && (
            <div dir="ltr" className="text-[11px] font-medium text-slate-400">
              {r.name}
            </div>
          )}
        </div>
      ),
    },
    {
      id: "groupType",
      header: t("posAdmin.col.group"),
      accessor: (r) => pmGroupLabel(t, r.groupType),
      cell: (r) => {
        const g = r.groupType || "cash";
        return <Badge tone={PM_GROUP_TONE[g] ?? "neutral"}>{pmGroupLabel(t, g)}</Badge>;
      },
    },
    {
      id: "fee",
      header: t("posAdmin.col.fee"),
      accessor: (r) => feeText(r),
    },
    {
      id: "shiftClose",
      header: t("posAdmin.col.shiftClose"),
      accessor: (r) => (r.showInShiftClose ? t("common.yes") : t("common.no")),
    },
    {
      id: "status",
      header: t("common.status"),
      accessor: (r) => (r.isActive ? t("posAdmin.register.enabled") : t("posAdmin.register.disabled")),
      cell: (r) => (
        <StatusBadge tone={r.isActive ? "success" : "neutral"}>
          {r.isActive ? t("posAdmin.register.enabled") : t("posAdmin.register.disabled")}
        </StatusBadge>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("posAdmin.register.heading")}
        subtitle={t("posAdmin.register.subtitle")}
      />

      <PosLauncherCard
        icon={Monitor}
        title={t("posAdmin.register.launcherTitle")}
        description={t("posAdmin.register.launcherDesc")}
        ctaLabel={t("posAdmin.register.launcherCta")}
      />

      <DataTable
          columns={columns}
          rows={rows}
          getRowId={(r) => String(r.id)}
          loading={query.isLoading}
          error={query.isError ? query.error : undefined}
          onRetry={() => query.refetch()}
          searchable
          searchPlaceholder={t("posAdmin.register.searchPlaceholder")}
          exportFilename="payment-methods"
          emptyTitle={t("posAdmin.register.emptyTitle")}
          emptyBody={t("posAdmin.register.emptyBody")}
          initialSort={{ columnId: "sortOrder", dir: "asc" }}
          tableId="pos-admin-payment-methods"
          filterBar={
            <>
              <Select
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                aria-label={t("posAdmin.col.group")}
              >
                <option value="">{t("posAdmin.register.groupAll")}</option>
                {groupOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <Select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                aria-label={t("common.status")}
              >
                <option value="">{t("common.all")}</option>
                <option value="1">{t("posAdmin.register.enabled")}</option>
                <option value="0">{t("posAdmin.register.disabled")}</option>
              </Select>
            </>
          }
          toolbarActions={
            <Can cap="pos.register.view">
              <Button variant="primary" onClick={openCreate}>
                <Plus className="h-4 w-4" /> {t("posAdmin.register.newMethod")}
              </Button>
            </Can>
          }
          rowActions={(r) => (
            <Can cap="pos.register.view">
              <div className="flex items-center gap-1">
                <IconButton aria-label={t("common.edit")} size="sm" onClick={() => openEdit(r)}>
                  <Pencil className="h-4 w-4" />
                </IconButton>
                <IconButton
                  aria-label={t("common.delete")}
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    setDeleteError(null);
                    setDeleteTarget(r);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </IconButton>
              </div>
            </Can>
          )}
      />

      <PaymentMethodDialog
        open={dialogOpen}
        method={editing}
        saving={saveMut.isPending}
        error={saveError}
        onClose={() => {
          if (!saveMut.isPending) setDialogOpen(false);
        }}
        onSave={(input) => {
          setSaveError(null);
          saveMut.mutate(input);
        }}
      />

      <ConfirmDialog
        open={deleteTarget != null}
        title={t("posAdmin.register.deleteTitle")}
        description={
          deleteTarget
            ? t("posAdmin.register.deleteBody", { name: deleteTarget.nameAr || deleteTarget.name })
            : ""
        }
        confirmLabel={t("common.delete")}
        tone="danger"
        processing={deleteMut.isPending}
        error={deleteError}
        onConfirm={() => {
          if (deleteTarget) deleteMut.mutate(deleteTarget.id);
        }}
        onClose={() => {
          if (!deleteMut.isPending) setDeleteTarget(null);
        }}
      />
    </div>
  );
}
