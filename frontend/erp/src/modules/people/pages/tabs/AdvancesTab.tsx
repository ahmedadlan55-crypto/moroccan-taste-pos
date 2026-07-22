import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { ConfirmDialog, IconButton, Select, StatusBadge, safeUserMessage, useToast } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatCurrency, formatDate } from "@/shared/lib";
import { useTx } from "@/shared/ui/i18n";
import { useAuth } from "@/app/providers";
import { peopleApi } from "../../lib/api";
import { qk } from "../../lib/query-keys";
import { statusMeta } from "../../lib/labels";
import type { Advance } from "../../lib/types";

type Confirm = { kind: "approve" | "reject"; advance: Advance } | null;

export function AdvancesTab() {
  const t = useTx();
  const { toast } = useToast();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [status, setStatus] = useState("");
  const [confirm, setConfirm] = useState<Confirm>(null);

  const params = useMemo(() => (status ? { status } : {}), [status]);
  const query = useQuery({
    queryKey: qk.advances(params),
    queryFn: ({ signal }) => peopleApi.listAdvances(params, signal),
  });

  const act = useMutation({
    mutationFn: (v: { kind: NonNullable<Confirm>["kind"]; id: string; reason: string }) =>
      v.kind === "approve"
        ? peopleApi.approveAdvance(v.id, user?.username ?? "")
        : peopleApi.rejectAdvance(v.id, user?.username ?? "", v.reason),
    onSuccess: () => {
      toast({ title: t("people.toast.done"), tone: "success" });
      setConfirm(null);
      qc.invalidateQueries({ queryKey: [...qk.all, "advances"] });
    },
    onError: (e) => toast({ title: t("people.toast.actionFailed"), description: safeUserMessage(e, t), tone: "error" }),
  });

  const columns: ColumnDef<Advance>[] = [
    { id: "employeeName", header: t("people.field.employee"), accessor: (r) => r.employeeName, sortable: true },
    { id: "branchName", header: t("people.field.branch"), accessor: (r) => r.branchName || "—" },
    {
      id: "amount",
      header: t("people.field.amount"),
      accessor: (r) => r.amount,
      cell: (r) => formatCurrency(r.amount),
      numeric: true,
      sortable: true,
    },
    {
      id: "remaining",
      header: t("people.field.remaining"),
      accessor: (r) => r.remaining,
      cell: (r) => formatCurrency(r.remaining),
      numeric: true,
    },
    { id: "deductionMonths", header: t("people.advances.col.deductionMonths"), accessor: (r) => r.deductionMonths, numeric: true },
    {
      id: "requestDate",
      header: t("people.advances.col.requestDate"),
      accessor: (r) => r.requestDate ?? "",
      cell: (r) => formatDate(r.requestDate),
    },
    {
      id: "status",
      header: t("common.status"),
      accessor: (r) => r.status,
      cell: (r) => {
        const m = statusMeta(r.status, t);
        return <StatusBadge tone={m.tone}>{m.label}</StatusBadge>;
      },
    },
  ];

  return (
    <>
      <DataTable
        columns={columns}
        rows={query.data ?? []}
        getRowId={(r) => r.id}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => query.refetch()}
        tableId="people.advances"
        searchable
        emptyTitle={t("people.advances.emptyTitle")}
        exportFilename="advances.csv"
        filterBar={
          <label className="flex items-center gap-2 text-xs font-bold text-slate-500">
            {t("common.status")}
            <Select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="h-10 min-w-36"
              options={[
                { value: "", label: t("common.all") },
                { value: "pending", label: t("people.advances.filter.pending") },
                { value: "approved", label: t("people.advances.filter.approved") },
                { value: "paid", label: t("people.advances.filter.paid") },
                { value: "rejected", label: t("people.advances.filter.rejected") },
              ]}
            />
          </label>
        }
        rowActions={(r) =>
          r.status === "pending" ? (
            <div className="flex items-center gap-1">
              <IconButton aria-label={t("people.advances.aria.approve")} size="sm" variant="ghost" onClick={() => setConfirm({ kind: "approve", advance: r })}>
                <Check className="h-4 w-4" />
              </IconButton>
              <IconButton aria-label={t("people.advances.aria.reject")} size="sm" variant="danger" onClick={() => setConfirm({ kind: "reject", advance: r })}>
                <X className="h-4 w-4" />
              </IconButton>
            </div>
          ) : null
        }
      />

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.kind === "approve" ? t("people.advances.confirm.approveTitle") : t("people.advances.confirm.rejectTitle")}
        description={confirm ? t("people.advances.confirm.desc", { name: confirm.advance.employeeName, amount: formatCurrency(confirm.advance.amount) }) : ""}
        tone={confirm?.kind === "reject" ? "danger" : "primary"}
        requireReason={confirm?.kind === "reject"}
        reasonLabel={t("people.advances.rejectReasonLabel")}
        processing={act.isPending}
        onClose={() => setConfirm(null)}
        onConfirm={(reason) => confirm && act.mutate({ kind: confirm.kind, id: confirm.advance.id, reason })}
      />
    </>
  );
}
