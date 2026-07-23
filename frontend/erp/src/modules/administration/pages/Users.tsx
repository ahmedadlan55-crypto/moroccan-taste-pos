import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Pencil, Plus } from "lucide-react";
import { apiClient, ApiError } from "@/shared/api";
import { Badge, Button, IconButton, PageHeader, StatusBadge } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { useCan } from "@/app/providers";
import { useT } from "@/i18n";
import { asArray } from "../_common";
import type { User } from "../users/types";
import { roleLabelKey } from "../users/roles";
import { UserDialog, type UserDialogMode } from "../users/UserDialog";

interface UsersResult {
  limited: boolean;
  rows: User[];
}

export default function UsersPage() {
  const t = useT();
  const canManage = useCan("administration.users");
  const [dialog, setDialog] = useState<{ mode: UserDialogMode; user: User | null } | null>(null);
  const roleLabel = (role: string) => t(roleLabelKey(role));

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
    { id: "username", header: t("administration.users.col.username"), accessor: (r) => r.username, sortable: true },
    { id: "displayName", header: t("administration.users.col.displayName"), accessor: (r) => r.displayName || "—" },
    {
      id: "role",
      header: t("administration.users.col.role"),
      accessor: (r) => (r.role ? roleLabel(r.role) : "—"),
      cell: (r) =>
        r.role ? (
          <Badge tone={r.isDeveloper ? "purple" : "teal"}>{roleLabel(r.role)}</Badge>
        ) : (
          "—"
        ),
    },
    { id: "branch", header: t("administration.users.col.branch"), accessor: (r) => r.branchName || "—", defaultHidden: limited },
    { id: "brand", header: t("administration.users.col.brand"), accessor: (r) => r.brandName || "—", defaultHidden: true },
    {
      id: "warehouse",
      header: t("administration.users.col.warehouse"),
      accessor: (r) => r.defaultWarehouseName || "—",
      defaultHidden: true,
    },
    {
      id: "portals",
      header: t("administration.users.col.portals"),
      accessor: (r) =>
        [r.employeePortal ? t("administration.users.portal.employee") : "", r.custodyPortal ? t("administration.users.portal.custody") : ""]
          .filter(Boolean)
          .join(t("administration.users.portal.separator")) || "—",
      defaultHidden: true,
    },
    { id: "email", header: t("administration.users.col.email"), accessor: (r) => r.email || "—", defaultHidden: true },
    {
      id: "status",
      header: t("administration.users.col.status"),
      accessor: (r) => t(r.active ? "status.active" : "status.disabled"),
      cell: (r) => <StatusBadge>{r.active ? "active" : "disabled"}</StatusBadge>,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow={t("administration.eyebrow")}
        title={t("administration.users.title")}
        subtitle={t("administration.users.subtitle")}
        action={
          limited ? (
            <Badge tone="warning">{t("administration.users.limitedBadge")}</Badge>
          ) : canManage ? (
            <Button onClick={() => setDialog({ mode: "create", user: null })}>
              <Plus className="h-4 w-4" /> {t("administration.users.newUser")}
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
        searchPlaceholder={t("administration.users.searchPlaceholder")}
        exportFilename="users.csv"
        tableId="admin-users"
        emptyTitle={t("administration.users.empty")}
        mobileTitle={(r) => r.displayName || r.username}
        rowActions={
          canManage && !limited
            ? (r) => (
                <IconButton
                  aria-label={t("administration.users.editAria", { name: r.username })}
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
