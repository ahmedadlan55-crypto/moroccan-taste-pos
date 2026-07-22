import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Button, Badge, PageHeader } from "@/shared/ui";
import { useTx } from "@/shared/ui/i18n";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { Can } from "@/shared/permissions";
import { o2cApi, qk, SalesStatus, Money, DateCell, useDocNav, type SalesOrder } from "@/modules/sales/lib";
import { OrderForm } from "./OrderForm";

interface TableState { page: number; pageSize: number; search: string }

export function OrdersList() {
  const t = useTx();
  const { isNew, openDoc, openNew, closeNew } = useDocNav();
  const [status, setStatus] = useState("");
  const [ts, setTs] = useState<TableState>({ page: 1, pageSize: 25, search: "" });

  const statusOptions = useMemo(() => [
    { value: "", label: t("sales.filters.allStatuses") },
    { value: "draft", label: t("sales.orders.filter.draft") },
    { value: "confirmed", label: t("sales.orders.filter.confirmed") },
    { value: "fulfilled", label: t("sales.orders.filter.fulfilled") },
    { value: "invoiced", label: t("sales.orders.filter.invoiced") },
    { value: "cancelled", label: t("sales.orders.filter.cancelled") },
  ], [t]);

  const params = useMemo(
    () => ({ q: ts.search, status, page: ts.page, pageSize: ts.pageSize }),
    [ts, status],
  );
  const list = useQuery({ queryKey: qk.orders(params), queryFn: ({ signal }) => o2cApi.orders(params, signal) });

  const onStateChange = useCallback((s: { page: number; pageSize: number; search: string }) => {
    setTs((prev) =>
      prev.page === s.page && prev.pageSize === s.pageSize && prev.search === s.search
        ? prev
        : { page: s.page, pageSize: s.pageSize, search: s.search },
    );
  }, []);

  const columns = useMemo<ColumnDef<SalesOrder>[]>(() => [
    { id: "order_number", header: t("sales.orders.col.number"), accessor: (o) => o.order_number, cell: (o) => <span className="font-bold text-teal-700">{o.order_number}</span> },
    { id: "customer", header: t("sales.col.customer"), accessor: (o) => o.customer_name ?? "—" },
    { id: "date", header: t("sales.col.date"), cell: (o) => <DateCell value={o.order_date} /> },
    { id: "total", header: t("sales.col.total"), align: "end", cell: (o) => <Money value={o.total_amount} /> },
    { id: "credit", header: t("sales.orders.col.credit"), cell: (o) => (o.is_credit_sale ? <Badge tone="warning">{t("sales.orders.credit")}</Badge> : <span className="text-slate-400">{t("sales.orders.cash")}</span>) },
    { id: "status", header: t("common.status"), cell: (o) => <SalesStatus status={o.status} /> },
  ], [t]);

  return (
    <div>
      <PageHeader
        eyebrow={t("sales.orders.eyebrow")}
        title={t("sales.orders.title")}
        subtitle={t("sales.orders.subtitle")}
        action={<Can cap="sales_orders.create"><Button onClick={openNew}><Plus className="h-4 w-4" /> {t("sales.orders.newBtn")}</Button></Can>}
      />
      <DataTable<SalesOrder>
        mode="server"
        columns={columns}
        rows={list.data?.data ?? []}
        rowCount={list.data?.pagination?.total ?? 0}
        getRowId={(o) => o.id}
        loading={list.isLoading}
        error={list.isError ? list.error : undefined}
        onRetry={() => list.refetch()}
        onRowClick={(o) => openDoc(o.id)}
        onStateChange={onStateChange}
        initialPageSize={25}
        searchable
        searchPlaceholder={t("sales.orders.searchPlaceholder")}
        columnMenu={false}
        emptyTitle={t("sales.orders.emptyTitle")}
        emptyBody={t("sales.orders.emptyBody")}
        mobileTitle={(o) => o.order_number}
        filterBar={
          <label className="flex items-center">
            <span className="sr-only">{t("sales.filters.byStatus")}</span>
            <select className="field h-10" value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t("sales.filters.byStatus")}>
              {statusOptions.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
        }
      />
      {isNew && <OrderForm open onClose={closeNew} onCreated={openDoc} />}
    </div>
  );
}
