import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { apiClient } from "@/shared/api";
import {
  Badge,
  Button,
  Dialog,
  Input,
  PageHeader,
  Select,
  StatusBadge,
  useToast,
} from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatDateTime } from "@/shared/lib";
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

const ACTION_AR: Record<string, string> = {
  create: "إنشاء",
  update: "تعديل",
  delete: "حذف",
  login: "دخول",
  logout: "خروج",
  approve: "اعتماد",
  reverse: "عكس",
  post: "ترحيل",
};

export default function AuditLogPage() {
  const { toast } = useToast();
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
        toast({ title: "تعذّر الفحص", description: res.error, tone: "error" });
      }
    },
    onError: (e: Error) => toast({ title: "تعذّر فحص السجل", description: e.message, tone: "error" }),
  });

  const columns: ColumnDef<AuditRow>[] = [
    {
      id: "createdAt",
      header: "التاريخ",
      accessor: (r) => r.createdAt,
      cell: (r) => formatDateTime(r.createdAt),
      sortable: true,
      width: "12rem",
    },
    {
      id: "action",
      header: "الإجراء",
      accessor: (r) => ACTION_AR[r.action] ?? r.action,
      cell: (r) => <Badge tone="teal">{ACTION_AR[r.action] ?? r.action ?? "—"}</Badge>,
    },
    { id: "entity", header: "الكيان", accessor: (r) => r.entityType || "—" },
    { id: "entityId", header: "المرجع", accessor: (r) => r.entityId || "—" },
    { id: "username", header: "المستخدم", accessor: (r) => r.username || "—", sortable: true },
    { id: "details", header: "التفاصيل", accessor: (r) => r.details || "—" },
    { id: "ip", header: "IP", accessor: (r) => r.ipAddress || "—", numeric: true, defaultHidden: true },
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
        eyebrow="الإدارة"
        title="سجل التدقيق"
        subtitle="سجل غير قابل للتعديل لكل عملية حسّاسة في النظام."
        action={
          <Button variant="secondary" onClick={() => verify.mutate()} loading={verify.isPending}>
            <ShieldCheck className="h-4 w-4" /> فحص سلامة السجل
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
        searchPlaceholder="بحث سريع في التفاصيل…"
        exportFilename="audit-logs.csv"
        tableId="admin-audit-log"
        initialSort={{ columnId: "createdAt", dir: "desc" }}
        initialPageSize={50}
        emptyTitle="لا توجد سجلات مطابقة"
        emptyBody="عدّل عوامل التصفية لعرض سجلات أخرى."
        filterBar={
          <div className="flex flex-wrap items-end gap-2">
            {filterCtl("من", <Input className="w-40" type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)} />)}
            {filterCtl("إلى", <Input className="w-40" type="date" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} />)}
            {filterCtl(
              "المستخدم",
              <div className="w-40">
                <Select value={user} onChange={(e) => setUser(e.target.value)}>
                  <option value="">الكل</option>
                  {users.map((u) => (
                    <option key={u.username} value={u.username}>
                      {u.fullName || u.username}
                    </option>
                  ))}
                </Select>
              </div>,
            )}
            {filterCtl(
              "الكيان",
              <div className="w-40">
                <Select value={entity} onChange={(e) => setEntity(e.target.value)}>
                  <option value="">الكل</option>
                  {entityOptions.map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </Select>
              </div>,
            )}
            {filterCtl(
              "الإجراء",
              <div className="w-36">
                <Select value={action} onChange={(e) => setAction(e.target.value)}>
                  <option value="">الكل</option>
                  {actionOptions.map((x) => (
                    <option key={x} value={x}>
                      {ACTION_AR[x] ?? x}
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
                مسح
              </Button>
            )}
          </div>
        }
      />

      <Dialog
        open={!!verifyResult}
        onClose={() => setVerifyResult(null)}
        title="نتيجة فحص سلامة السجل"
        size="md"
        footer={
          <Button onClick={() => setVerifyResult(null)}>إغلاق</Button>
        }
      >
        {verifyResult && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-bold text-slate-600">الحالة</span>
              <StatusBadge tone={verifyResult.verified ? "success" : "danger"}>
                {verifyResult.verified ? "السلسلة سليمة" : "تم اكتشاف تلاعب"}
              </StatusBadge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm font-bold text-slate-600">عدد السجلات المفحوصة</span>
              <span className="font-extrabold tabular-nums" dir="ltr">
                {verifyResult.count ?? 0}
              </span>
            </div>
            {!verifyResult.verified && verifyResult.brokenAt != null && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
                أول سجل مكسور عند المعرّف #{verifyResult.brokenAt}
              </div>
            )}
          </div>
        )}
      </Dialog>
    </div>
  );
}
