import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/shared/ui";
import { useTx } from "@/shared/ui/i18n";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { o2cApi, qk, SalesStatus, Money, DateCell, useDocNav, type Invoice } from "@/modules/sales/lib";

interface TableState { page: number; pageSize: number; search: string }

// Read-only AR ledger. This is a cash/card restaurant: invoices are PROJECTED
// from POS checkouts, never keyed by hand, so there is no create flow here.
export function InvoicesList() {
  const t = useTx();
  const { openDoc } = useDocNav();
  const [status, setStatus] = useState("");
  const [ts, setTs] = useState<TableState>({ page: 1, pageSize: 25, search: "" });

  const statusOptions = useMemo(() => [
    { value: "", label: t("sales.filters.allStatuses") },
    { value: "draft", label: t("sales.invoices.filter.draft") },
    { value: "issued", label: t("sales.invoices.filter.issued") },
    { value: "partially_paid", label: t("sales.invoices.filter.partial") },
    { value: "paid", label: t("sales.invoices.filter.paid") },
    { value: "credited", label: t("sales.invoices.filter.credited") },
    { value: "cancelled", label: t("sales.invoices.filter.cancelled") },
  ], [t]);

  const params = useMemo(() => ({ q: ts.search, status, page: ts.page, pageSize: ts.pageSize }), [ts, status]);
  const list = useQuery({ queryKey: qk.invoices(params), queryFn: ({ signal }) => o2cApi.invoices(params, signal) });

  const onStateChange = useCallback((s: { page: number; pageSize: number; search: string }) => {
    setTs((prev) => (prev.page === s.page && prev.pageSize === s.pageSize && prev.search === s.search ? prev : { page: s.page, pageSize: s.pageSize, search: s.search }));
  }, []);

  const columns = useMemo<ColumnDef<Invoice>[]>(() => [
    { id: "document_number", header: t("sales.invoices.col.number"), accessor: (i) => i.document_number, cell: (i) => <span className="font-bold text-teal-700">{i.document_number}</span> },
    { id: "customer", header: t("sales.col.customer"), accessor: (i) => i.customer_name ?? "—" },
    { id: "issue_date", header: t("sales.col.date"), cell: (i) => <DateCell value={i.issue_date} /> },
    { id: "due_date", header: t("sales.invoices.col.due"), cell: (i) => <DateCell value={i.due_date} /> },
    { id: "total", header: t("sales.col.total"), align: "end", cell: (i) => <Money value={i.total_amount} /> },
    { id: "balance", header: t("sales.col.remaining"), align: "end", cell: (i) => <Money value={i.balance_amount} className="font-bold" /> },
    { id: "status", header: t("common.status"), cell: (i) => <SalesStatus status={i.status} /> },
    { id: "zatca", header: t("sales.invoices.col.zatca"), cell: (i) => <SalesStatus status={i.zatca_status} /> },
  ], [t]);

  return (
    <div>
      <PageHeader
        eyebrow={t("sales.invoices.eyebrow")}
        title={t("sales.invoices.title")}
        subtitle={t("sales.invoices.subtitle")}
      />
      <DataTable<Invoice>
        mode="server"
        columns={columns}
        rows={list.data?.data ?? []}
        rowCount={list.data?.pagination?.total ?? 0}
        getRowId={(i) => i.id}
        loading={list.isLoading}
        error={list.isError ? list.error : undefined}
        onRetry={() => list.refetch()}
        onRowClick={(i) => openDoc(i.id)}
        onStateChange={onStateChange}
        initialPageSize={25}
        searchable
        searchPlaceholder={t("sales.invoices.searchPlaceholder")}
        columnMenu={false}
        emptyTitle={t("sales.invoices.emptyTitle")}
        emptyBody={t("sales.invoices.emptyBody")}
        mobileTitle={(i) => i.document_number}
        filterBar={
          <label className="flex items-center">
            <span className="sr-only">{t("sales.filters.byStatus")}</span>
            <select className="field h-10" value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t("sales.filters.byStatus")}>
              {statusOptions.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
        }
      />
    </div>
  );
}
