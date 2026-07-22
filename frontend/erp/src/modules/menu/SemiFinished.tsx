import { useMemo } from "react";
import { PageHeader, LoadingState, Badge } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { useT } from "@/i18n";
import { useBrands, useSemiFinished, type SemiFinishedItem } from "./api";
import { Money, Num, useBrandScope, BrandSelect } from "./lib";

// Read-only: semi-finished items are intermediate products (kind='semi' in
// inv_items). They are produced by the kitchen/production flow and consumed by
// finished items' recipes — they are NOT sold from the cashier, and are managed
// from the raw-materials editor, so this screen is view-only by design.
export function SemiFinished() {
  const t = useT();
  const { brandId, setBrandId } = useBrandScope();
  const brandsQ = useBrands();
  const q = useSemiFinished(brandId || undefined);

  const columns = useMemo<ColumnDef<SemiFinishedItem>[]>(() => [
    { id: "name", header: t("menuRest.semiFinished.product"), accessor: (r) => r.name, sortable: true, cell: (r) => <span className="font-bold text-slate-800">{r.name}</span> },
    { id: "category", header: t("menuRest.fields.category"), accessor: (r) => r.category || "—", sortable: true },
    { id: "unit", header: t("menuRest.fields.unit"), accessor: (r) => r.unit || "—" },
    { id: "cost", header: t("menuRest.fields.cost"), numeric: true, accessor: (r) => r.cost, cell: (r) => <Money value={r.cost} /> },
    { id: "stock", header: t("menuRest.fields.stock"), numeric: true, accessor: (r) => r.stock, cell: (r) => <Num value={r.stock} /> },
    {
      id: "consumers",
      header: t("menuRest.semiFinished.consumers"),
      numeric: true,
      accessor: (r) => r.consumerCount,
      cell: (r) => (r.consumerCount > 0 ? <Badge tone="info">{String(r.consumerCount)}</Badge> : <span className="text-slate-400">0</span>),
    },
    { id: "brand", header: t("menuRest.semiFinished.brandCol"), accessor: (r) => r.brandName || "—" },
  ], [t]);

  return (
    <div>
      <PageHeader
        eyebrow={t("menuRest.eyebrow")}
        title={t("menuRest.semiFinished.title")}
        subtitle={t("menuRest.semiFinished.subtitle")}
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
          searchPlaceholder={t("menuRest.semiFinished.searchPlaceholder")}
          emptyTitle={t("menuRest.semiFinished.emptyTitle")}
          emptyBody={t("menuRest.semiFinished.emptyBody")}
          mobileTitle={(r) => r.name}
          exportFilename={`semi-finished-${brandId || "all"}.csv`}
          filterBar={<BrandSelect brands={brandsQ.data ?? []} value={brandId} onChange={setBrandId} />}
        />
      )}
    </div>
  );
}
