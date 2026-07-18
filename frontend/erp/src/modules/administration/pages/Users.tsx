import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Pencil, Plus } from "lucide-react";
import { apiClient, ApiError } from "@/shared/api";
import { Badge, Button, IconButton, PageHeader, StatusBadge } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { useCan } from "@/app/providers";
import { asArray } from "../_common";
import type { User } from "../users/types";
import { ROLE_LABEL } from "../users/roles";
import { UserDialog, type UserDialogMode } from "../users/UserDialog";

interface UsersResult {
  limited: boolean;
  rows: User[];
}

export default function UsersPage() {
  const canManage = useCan("administration.users");
  const [dialog, setDialog] = useState<{ mode: UserDialogMode; user: User | null } | null>(null);

  const query = useQuery<UsersResult>({
    queryKey: ["auth", "users"],
    queryFn: async ({ signal }) => {
      try {
        const data = await apiClient.get<unknown>("/auth/users", { signal });
        return { limited: false, rows: asArray<User>(data) };
      } catch (e) {
        // Non-admin roles get a 403 on /users but may still read the lightweight
        // display-name directory — degrade to a read-only list instead of erroring.
        if (e instanceof ApiError && (e.kind === "forbidden" || e.status === 403)) {
          const data = await apiClient.get<unknown>("/auth/users-list", { signal });
          const rows = asArray<{ username: string; fullName: string }>(data).map<User>((u) => ({
            username: u.username,
            displayName: u.fullName || u.username,
            role: "",
            active: true,
            email: "",
            phone: "",
          }));
          return { limited: true, rows };
        }
        throw e;
      }
    },
  });

  const limited = query.data?.limited ?? false;
  const rows = query.data?.rows ?? [];

  const columns: ColumnDef<User>[] = [
    { id: "username", header: "اسم المستخدم", accessor: (r) => r.username, sortable: true },
    { id: "displayName", header: "الاسم", accessor: (r) => r.displayName || "—" },
    {
      id: "role",
      header: "الدور",
      accessor: (r) => (r.role ? ROLE_LABEL.get(r.role) ?? r.role : "—"),
      cell: (r) =>
        r.role ? (
          <Badge tone={r.isDeveloper ? "purple" : "teal"}>{ROLE_LABEL.get(r.role) ?? r.role}</Badge>
        ) : (
          "—"
        ),
    },
    { id: "branch", header: "الفرع", accessor: (r) => r.branchName || "—", defaultHidden: limited },
    { id: "brand", header: "العلامة", accessor: (r) => r.brandName || "—", defaultHidden: true },
    {
      id: "warehouse",
      header: "المستودع",
      accessor: (r) => r.defaultWarehouseName || "—",
      defaultHidden: true,
    },
    {
      id: "portals",
      header: "البوابات",
      accessor: (r) => [r.employeePortal ? "موظف" : "", r.custodyPortal ? "عهدة" : ""].filter(Boolean).join("، ") || "—",
      defaultHidden: true,
    },
    { id: "email", header: "البريد", accessor: (r) => r.email || "—", defaultHidden: true },
    {
      id: "status",
      header: "الحالة",
      accessor: (r) => (r.active ? "نشط" : "معطّل"),
      cell: (r) => <StatusBadge>{r.active ? "نشط" : "معطّل"}</StatusBadge>,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="الإدارة"
        title="المستخدمون"
        subtitle="حسابات الدخول والأدوار والبوابات. الإنشاء والتعديل متاح لمديري النظام فقط."
        action={
          limited ? (
            <Badge tone="warning">عرض محدود</Badge>
          ) : canManage ? (
            <Button onClick={() => setDialog({ mode: "create", user: null })}>
              <Plus className="h-4 w-4" /> مستخدم جديد
            </Button>
          ) : undefined
        }
      />
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.username}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => query.refetch()}
        searchable
        searchPlaceholder="بحث بالاسم أو اسم المستخدم…"
        exportFilename="users.csv"
        tableId="admin-users"
        emptyTitle="لا يوجد مستخدمون"
        mobileTitle={(r) => r.displayName || r.username}
        rowActions={
          canManage && !limited
            ? (r) => (
                <IconButton
                  aria-label={`تعديل ${r.username}`}
                  size="sm"
                  onClick={() => setDialog({ mode: "edit", user: r })}
                >
                  <Pencil className="h-4 w-4" />
                </IconButton>
              )
            : undefined
        }
      />
      <UserDialog
        mode={dialog?.mode ?? "create"}
        open={!!dialog}
        initial={dialog?.user ?? null}
        onClose={() => setDialog(null)}
      />
    </div>
  );
}
