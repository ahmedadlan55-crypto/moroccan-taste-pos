import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Button, PageHeader } from "@/shared/ui";
import { useTx } from "@/shared/ui/i18n";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { Can } from "@/shared/permissions";
import { o2cApi, qk, SalesStatus, Money, DateCell, useDocNav, type SalesReturn } from "@/modules/sales/lib";
import { ReturnForm } from "./ReturnForm";

const REFUND_KEYS = new Set(["ar_reduction", "cash", "bank", "customer_deposit"]);

interface TableState { page: number; pageSize: number; search: string }

export function ReturnsList({ presetInvoiceId }: { presetInvoiceId?: string }) {
  const t = useTx();
  const { isNew, openDoc, openNew, closeNew } = useDocNav();
  const [status, setStatus] = useState("");
  const [ts, setTs] = useState<TableState>({ page: 1, pageSize: 25, search: "" });

  const statusOptions = useMemo(() => [
    { value: "", label: t("sales.filters.allStatuses") },
    { value: "draft", label: t("sales.returns.filter.draft") },
    { value: "approved", label: t("sales.returns.filter.approved") },
    { value: "posted", label: t("sales.returns.filter.posted") },
    { value: "reversed", label: t("sales.returns.filter.reversed") },
    { value: "cancelled", label: t("sales.returns.filter.cancelled") },
  ], [t]);

  const params = useMemo(() => ({ q: ts.search, status, page: ts.page, pageSize: ts.pageSize }), [ts, status]);
  const list = useQuery({ queryKey: qk.returns(params), queryFn: ({ signal }) => o2cApi.returns(params, signal) });

  const onStateChange = useCallback((s: { page: number; pageSize: number; search: string }) => {
    setTs((prev) => (prev.page === s.page && prev.pageSize === s.pageSize && prev.search === s.search ? prev : { page: s.page, pageSize: s.pageSize, search: s.search }));
  }, []);

  const columns = useMemo<ColumnDef<SalesReturn>[]>(() => [
    { id: "return_number", header: t("sales.returns.col.number"), accessor: (r) => r.return_number, cell: (r) => <span className="font-bold text-teal-700">{r.return_number}</span> },
    { id: "customer", header: t("sales.col.customer"), accessor: (r) => r.customer_name ?? "—" },
    { id: "date", header: t("sales.col.date"), cell: (r) => <DateCell value={r.return_date} /> },
    { id: "total", header: t("sales.col.total"), align: "end", cell: (r) => <Money value={r.total_amount} /> },
    { id: "refund", header: t("sales.returns.col.refund"), accessor: (r) => (REFUND_KEYS.has(r.refund_method) ? t(`sales.returns.refundList.${r.refund_method}`) : r.refund_method) },
    { id: "status", header: t("common.status"), cell: (r) => <SalesStatus status={r.status} /> },
  ], [t]);

  return (
    <div>
      <PageHeader
        eyebrow={t("sales.returns.eyebrow")}
        title={t("sales.returns.title")}
        subtitle={t("sales.returns.subtitle")}
        action={<Can cap="returns.create"><Button onClick={openNew}><Plus className="h-4 w-4" /> {t("sales.returns.newBtn")}</Button></Can>}
      />
      <DataTable<SalesReturn>
        mode="server"
        columns={columns}
        rows={list.data?.data ?? []}
        rowCount={list.data?.pagination?.total ?? 0}
        getRowId={(r) => r.id}
        loading={list.isLoading}
        error={list.isError ? list.error : undefined}
        onRetry={() => list.refetch()}
        onRowClick={(r) => openDoc(r.id)}
        onStateChange={onStateChange}
        initialPageSize={25}
        searchable
        searchPlaceholder={t("sales.returns.searchPlaceholder")}
        columnMenu={false}
        emptyTitle={t("sales.returns.emptyTitle")}
        emptyBody={t("sales.returns.emptyBody")}
        mobileTitle={(r) => r.return_number}
        filterBar={
          <label className="flex items-center">
            <span className="sr-only">{t("sales.filters.byStatus")}</span>
            <select className="field h-10" value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t("sales.filters.byStatus")}>
              {statusOptions.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
        }
      />
      {isNew && <ReturnForm open onClose={closeNew} onCreated={openDoc} presetInvoiceId={presetInvoiceId} />}
    </div>
  );
}
