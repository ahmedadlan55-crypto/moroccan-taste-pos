import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { Button, StatusBadge } from "@/shared/ui";
import { useCan } from "@/shared/permissions";
import { formatCurrency, formatDate, formatNumber } from "@/shared/lib";
import { useT } from "@/i18n";
import { productionStatusLabel } from "../production/status-i18n";
import type { BatchRow } from "../../lib/batchApi";
import { useBatchList } from "../../lib/useBatches";

const PAGE_SIZE = 25;

/** The production DOCUMENT list (multi-product batches), shown beside the
 *  single-order list on /inventory/production. */
export function ProductionBatchListPanel() {
  const t = useT();
  const navigate = useNavigate();
  const canCreate = useCan("production.create");
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");

  const query = useMemo(() => ({ page, pageSize: PAGE_SIZE, q: search }), [page, search]);
  const { data, isLoading, isError, error, refetch } = useBatchList(query);

  const columns: ColumnDef<BatchRow>[] = [
    {
      id: "batchNumber",
      header: t("production.batch.list.col.number"),
      accessor: (r) => r.batchNumber,
      cell: (r) => <span className="font-extrabold text-slate-900">{r.batchNumber}</span>,
      priority: 1,
    },
    {
      id: "status",
      header: t("common.status"),
      accessor: (r) => r.status,
      cell: (r) => <StatusBadge>{productionStatusLabel(t, r.status)}</StatusBadge>,
      priority: 2,
    },
    {
      id: "products",
      header: t("production.batch.list.col.products"),
      accessor: (r) => r.childCount,
      cell: (r) => formatNumber(r.childCount),
      numeric: true,
      priority: 3,
    },
    {
      id: "batchDate",
      header: t("production.batch.list.col.date"),
      accessor: (r) => r.batchDate ?? "",
      cell: (r) => formatDate(r.batchDate),
    },
    {
      id: "warehouses",
      header: t("production.batch.list.col.warehouses"),
      accessor: (r) =>
        r.outputWarehouseId !== r.warehouseId ? `${r.warehouseName} → ${r.outputWarehouseName}` : r.warehouseName,
      mobileHidden: true,
    },
    {
      id: "totalCost",
      header: t("production.batch.list.col.materialsCost"),
      accessor: (r) => r.totalCost,
      cell: (r) => formatCurrency(r.totalCost),
      numeric: true,
    },
    {
      id: "wip",
      header: t("production.batch.list.col.wip"),
      accessor: (r) => r.wipBalance,
      cell: (r) => formatCurrency(r.wipBalance),
      numeric: true,
    },
  ];

  return (
    <DataTable<BatchRow>
      columns={columns}
      rows={data?.rows ?? []}
      getRowId={(r) => r.id}
      mode="server"
      rowCount={data?.pagination.total ?? 0}
      initialPageSize={PAGE_SIZE}
      loading={isLoading}
      error={isError ? error : undefined}
      onRetry={() => void refetch()}
      searchable
      searchPlaceholder={t("production.batch.list.searchPlaceholder")}
      tableId="production-batches"
      onStateChange={(s) => {
        setPage(s.page);
        setSearch(s.search);
      }}
      onRowClick={(r) => navigate(`/inventory/production/batches/${r.id}`)}
      mobileTitle={(r) => r.batchNumber}
      emptyTitle={t("production.batch.list.emptyTitle")}
      emptyBody={t("production.batch.list.emptyBody")}
      emptyAction={
        canCreate ? (
          <Button onClick={() => navigate("/inventory/production/new")}>
            <Plus className="h-4 w-4" aria-hidden="true" /> {t("production.batch.create.title")}
          </Button>
        ) : undefined
      }
    />
  );
}
