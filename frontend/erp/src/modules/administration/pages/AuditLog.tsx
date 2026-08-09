import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { apiClient } from "@/shared/api";
import {
  Badge,
  Button,
  DatePicker,
  Dialog,
  PageHeader,
  Select,
  StatusBadge,
  useToast,
} from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatDateTime } from "@/shared/lib";
import { useT } from "@/i18n";
import { asArray } from "../_common";

interface AuditRow {
  id: number | string;
  action: string;
  entityType: string;
  entityId: string;
  username: string;
  details: string;
  ipAddress: string;
  createdAt: string;
}
interface VerifyResult {
  success?: boolean;
  verified?: boolean;
  count?: number;
  brokenAt?: number;
  error?: string;
}
interface UserLite {
  username: string;
  fullName: string;
}

// Known audit action codes localized under administration.auditLog.action.*;
// any other code falls back to the raw string from the server.
const ACTION_KEYS = new Set(["create", "update", "delete", "login", "logout", "approve", "reverse", "post"]);

export default function AuditLogPage() {
  const t = useT();
  const { toast } = useToast();
  const actionLabel = (action: string): string =>
    action && ACTION_KEYS.has(action) ? t(`administration.auditLog.action.${action}`) : action || "—";
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [user, setUser] = useState("");
  const [entity, setEntity] = useState("");
  const [action, setAction] = useState("");
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);

  const query = useQuery({
    queryKey: ["erp", "audit-logs", { from, to, user, entity, action }],
    queryFn: ({ signal }) =>
      apiClient.get<unknown>("/erp/audit-logs", {
        signal,
        params: { from, to, user, entity, action, limit: 1000 },
      }),
  });
  const rows = asArray<AuditRow>(query.data);

  const usersQuery = useQuery({
    queryKey: ["auth", "users-list"],
    queryFn: ({ signal }) => apiClient.get<unknown>("/auth/users-list", { signal }),
  });
  const users = asArray<UserLite>(usersQuery.data);

  const entityOptions = useMemo(
    () => [...new Set(rows.map((r) => r.entityType).filter(Boolean))].sort(),
    [rows],
  );
  const actionOptions = useMemo(
    () => [...new Set(rows.map((r) => r.action).filter(Boolean))].sort(),
    [rows],
  );

  const verify = useMutation({
    mutationFn: () => apiClient.get<VerifyResult>("/auth/audit/verify", { params: { limit: 1000 } }),
    onSuccess: (res) => {
      setVerifyResult(res);
      if (res.success === false) {
        toast({ title: t("administration.auditLog.verify.toastFailed"), description: res.error, tone: "error" });
      }
    },
    onError: (e: Error) => toast({ title: t("administration.auditLog.verify.toastError"), description: e.message, tone: "error" }),
  });

  const columns: ColumnDef<AuditRow>[] = [
    {
      id: "createdAt",
      header: t("administration.auditLog.col.date"),
      accessor: (r) => r.createdAt,
      cell: (r) => formatDateTime(r.createdAt),
      sortable: true,
      width: "12rem",
    },
    {
      id: "action",
      header: t("administration.auditLog.col.action"),
      accessor: (r) => actionLabel(r.action),
      cell: (r) => <Badge tone="teal">{actionLabel(r.action)}</Badge>,
    },
    { id: "entity", header: t("administration.auditLog.col.entity"), accessor: (r) => r.entityType || "—" },
    { id: "entityId", header: t("administration.auditLog.col.reference"), accessor: (r) => r.entityId || "—" },
    { id: "username", header: t("administration.auditLog.col.username"), accessor: (r) => r.username || "—", sortable: true },
    { id: "details", header: t("administration.auditLog.col.details"), accessor: (r) => r.details || "—" },
    { id: "ip", header: t("administration.auditLog.col.ip"), accessor: (r) => r.ipAddress || "—", numeric: true, defaultHidden: true },
  ];

  const filterCtl = (label: string, node: React.ReactNode) => (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-bold text-slate-500">{label}</span>
      {node}
    </label>
  );

  return (
    <div>
      <PageHeader
        eyebrow={t("administration.eyebrow")}
        title={t("administration.auditLog.title")}
        subtitle={t("administration.auditLog.subtitle")}
        action={
          <Button variant="secondary" onClick={() => verify.mutate()} loading={verify.isPending}>
            <ShieldCheck className="h-4 w-4" /> {t("administration.auditLog.verifyBtn")}
          </Button>
        }
      />
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => String(r.id)}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => query.refetch()}
        searchable
        searchPlaceholder={t("administration.auditLog.searchPlaceholder")}
        exportFilename="audit-logs.csv"
        tableId="admin-audit-log"
        initialSort={{ columnId: "createdAt", dir: "desc" }}
        initialPageSize={50}
        emptyTitle={t("administration.auditLog.empty")}
        emptyBody={t("administration.auditLog.emptyBody")}
        filterBar={
          <div className="flex flex-wrap items-end gap-2">
            {filterCtl(t("administration.auditLog.filter.from"), <DatePicker className="w-40" value={from} onChange={setFrom} />)}
            {filterCtl(t("administration.auditLog.filter.to"), <DatePicker className="w-40" value={to} onChange={setTo} />)}
            {filterCtl(
              t("administration.auditLog.filter.user"),
              <div className="w-40">
                <Select value={user} onChange={(e) => setUser(e.target.value)}>
                  <option value="">{t("common.all")}</option>
                  {users.map((u) => (
                    <option key={u.username} value={u.username}>
                      {u.fullName || u.username}
                    </option>
                  ))}
                </Select>
              </div>,
            )}
            {filterCtl(
              t("administration.auditLog.filter.entity"),
              <div className="w-40">
                <Select value={entity} onChange={(e) => setEntity(e.target.value)}>
                  <option value="">{t("common.all")}</option>
                  {entityOptions.map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </Select>
              </div>,
            )}
            {filterCtl(
              t("administration.auditLog.filter.action"),
              <div className="w-36">
                <Select value={action} onChange={(e) => setAction(e.target.value)}>
                  <option value="">{t("common.all")}</option>
                  {actionOptions.map((x) => (
                    <option key={x} value={x}>
                      {actionLabel(x)}
                    </option>
                  ))}
                </Select>
              </div>,
            )}
            {(from || to || user || entity || action) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setFrom("");
                  setTo("");
                  setUser("");
                  setEntity("");
                  setAction("");
                }}
              >
                {t("common.clear")}
              </Button>
            )}
          </div>
        }
      />

      <Dialog
        open={!!verifyResult}
        onClose={() => setVerifyResult(null)}
        title={t("administration.auditLog.verify.title")}
        size="md"
        footer={
          <Button onClick={() => setVerifyResult(null)}>{t("common.close")}</Button>
        }
      >
        {verifyResult && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-bold text-slate-600">{t("administration.auditLog.verify.statusLabel")}</span>
              <StatusBadge tone={verifyResult.verified ? "success" : "danger"}>
                {verifyResult.verified ? t("administration.auditLog.verify.intact") : t("administration.auditLog.verify.tampered")}
              </StatusBadge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm font-bold text-slate-600">{t("administration.auditLog.verify.checkedLabel")}</span>
              <span className="font-extrabold tabular-nums" dir="ltr">
                {verifyResult.count ?? 0}
              </span>
            </div>
            {!verifyResult.verified && verifyResult.brokenAt != null && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
                {t("administration.auditLog.verify.brokenAt", { id: verifyResult.brokenAt })}
              </div>
            )}
          </div>
        )}
      </Dialog>
    </div>
  );
}
