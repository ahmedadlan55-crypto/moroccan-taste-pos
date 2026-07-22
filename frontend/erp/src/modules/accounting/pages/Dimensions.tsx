import { Badge, PageHeader } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { useT } from "@/i18n";
import { useProjects, type Project } from "../api";

const DIM_STATUSES = ["active", "closed", "on_hold"];

export function DimensionsPage() {
  const t = useT();
  const query = useProjects("");
  const rows = query.data ?? [];

  const statusLabel = (s: string) => (DIM_STATUSES.includes(s) ? t(`accounting.dimensions.status.${s}`) : s);

  const columns: ColumnDef<Project>[] = [
    { id: "code", header: t("accounting.dimensions.col.code"), accessor: (r) => r.code || "—", sortable: true },
    { id: "nameAr", header: t("accounting.dimensions.col.project"), accessor: (r) => r.nameAr, sortable: true },
    { id: "nameEn", header: t("accounting.dimensions.col.nameEn"), accessor: (r) => r.nameEn || "—", defaultHidden: true },
    {
      id: "status",
      header: t("accounting.dimensions.col.status"),
      accessor: (r) => statusLabel(r.status),
      cell: (r) => (
        <Badge tone={r.status === "active" ? "success" : "neutral"}>
          {statusLabel(r.status)}
        </Badge>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow={t("accounting.eyebrow")}
        title={t("accounting.dimensions.title")}
        subtitle={t("accounting.dimensions.subtitle")}
      />
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => query.refetch()}
        searchable
        searchPlaceholder={t("accounting.dimensions.searchPlaceholder")}
        emptyTitle={t("accounting.dimensions.empty.title")}
        emptyBody={t("accounting.dimensions.empty.body")}
      />
    </div>
  );
}
