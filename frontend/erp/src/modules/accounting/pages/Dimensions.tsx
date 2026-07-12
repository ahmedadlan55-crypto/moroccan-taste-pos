import { Badge, PageHeader } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { useProjects, type Project } from "../api";

const STATUS_LABEL: Record<string, string> = {
  active: "نشط",
  closed: "مغلق",
  on_hold: "معلّق",
};

export function DimensionsPage() {
  const query = useProjects("");
  const rows = query.data ?? [];

  const columns: ColumnDef<Project>[] = [
    { id: "code", header: "الرمز", accessor: (r) => r.code || "—", sortable: true },
    { id: "nameAr", header: "المشروع", accessor: (r) => r.nameAr, sortable: true },
    { id: "nameEn", header: "الاسم (EN)", accessor: (r) => r.nameEn || "—", defaultHidden: true },
    {
      id: "status",
      header: "الحالة",
      accessor: (r) => STATUS_LABEL[r.status] ?? r.status,
      cell: (r) => (
        <Badge tone={r.status === "active" ? "success" : "neutral"}>
          {STATUS_LABEL[r.status] ?? r.status}
        </Badge>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="المحاسبة"
        title="المشروعات والأبعاد"
        subtitle="دليل المشروعات المستخدمة كأبعاد تحليلية على القيود المحاسبية (عرض فقط)."
      />
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => query.refetch()}
        searchable
        searchPlaceholder="بحث عن مشروع…"
        emptyTitle="لا توجد مشروعات"
        emptyBody="لم تُضَف أي مشروعات كأبعاد تحليلية بعد."
      />
    </div>
  );
}
