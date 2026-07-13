import { useMemo } from "react";
import { PageHeader, LoadingState, Badge } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { useBrands, useSemiFinished, type SemiFinishedItem } from "./api";
import { Money, Num, useBrandScope, BrandSelect } from "./lib";

// Read-only: semi-finished items are intermediate products (kind='semi' in
// inv_items). They are produced by the kitchen/production flow and consumed by
// finished items' recipes — they are NOT sold from the cashier, and are managed
// from the raw-materials editor, so this screen is view-only by design.
export function SemiFinished() {
  const { brandId, setBrandId } = useBrandScope();
  const brandsQ = useBrands();
  const q = useSemiFinished(brandId || undefined);

  const columns = useMemo<ColumnDef<SemiFinishedItem>[]>(() => [
    { id: "name", header: "المنتج", accessor: (r) => r.name, sortable: true, cell: (r) => <span className="font-bold text-slate-800">{r.name}</span> },
    { id: "category", header: "الفئة", accessor: (r) => r.category || "—", sortable: true },
    { id: "unit", header: "الوحدة", accessor: (r) => r.unit || "—" },
    { id: "cost", header: "التكلفة", numeric: true, accessor: (r) => r.cost, cell: (r) => <Money value={r.cost} /> },
    { id: "stock", header: "المخزون", numeric: true, accessor: (r) => r.stock, cell: (r) => <Num value={r.stock} /> },
    {
      id: "consumers",
      header: "أصناف تستهلكه",
      numeric: true,
      accessor: (r) => r.consumerCount,
      cell: (r) => (r.consumerCount > 0 ? <Badge tone="info">{String(r.consumerCount)}</Badge> : <span className="text-slate-400">0</span>),
    },
    { id: "brand", header: "العلامة", accessor: (r) => r.brandName || "—" },
  ], []);

  return (
    <div>
      <PageHeader
        eyebrow="القوائم والوصفات"
        title="المنتجات نصف المصنّعة"
        subtitle="الأصناف الوسيطة الناتجة عن الإنتاج وتُستهلك في وصفات الأصناف النهائية (عرض فقط)."
      />
      {brandsQ.isLoading ? (
        <LoadingState rows={2} />
      ) : (
        <DataTable<SemiFinishedItem>
          columns={columns}
          rows={q.data ?? []}
          getRowId={(r) => r.id}
          loading={q.isLoading}
          error={q.isError ? q.error : undefined}
          onRetry={() => q.refetch()}
          searchable
          searchPlaceholder="ابحث باسم المنتج…"
          emptyTitle="لا توجد منتجات نصف مصنّعة"
          emptyBody="أنشئ منتجًا نصف مصنّع من قسم المواد الخام (kind=semi)."
          mobileTitle={(r) => r.name}
          exportFilename={`semi-finished-${brandId || "all"}.csv`}
          filterBar={<BrandSelect brands={brandsQ.data ?? []} value={brandId} onChange={setBrandId} />}
        />
      )}
    </div>
  );
}
