import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Button, PageHeader } from "@/shared/ui";
import { useTx } from "@/shared/ui/i18n";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { Can } from "@/shared/permissions";
import { o2cApi, qk, SalesStatus, Money, DateCell, useDocNav, type Payment } from "@/modules/sales/lib";
import { PaymentForm } from "./PaymentForm";

interface TableState { page: number; pageSize: number; search: string }

export function PaymentsList({ presetCustomerId }: { presetCustomerId?: string }) {
  const t = useTx();
  const { isNew, openDoc, openNew, closeNew } = useDocNav();
  const [status, setStatus] = useState("");
  const [ts, setTs] = useState<TableState>({ page: 1, pageSize: 25, search: "" });

  const statusOptions = useMemo(() => [
    { value: "", label: t("sales.filters.allStatuses") },
    { value: "draft", label: t("sales.payments.filter.draft") },
    { value: "approved", label: t("sales.payments.filter.approved") },
    { value: "posted", label: t("sales.payments.filter.posted") },
    { value: "reversed", label: t("sales.payments.filter.reversed") },
    { value: "cancelled", label: t("sales.payments.filter.cancelled") },
  ], [t]);

  const params = useMemo(() => ({ q: ts.search, status, page: ts.page, pageSize: ts.pageSize }), [ts, status]);
  const list = useQuery({ queryKey: qk.payments(params), queryFn: ({ signal }) => o2cApi.payments(params, signal) });

  const onStateChange = useCallback((s: { page: number; pageSize: number; search: string }) => {
    setTs((prev) => (prev.page === s.page && prev.pageSize === s.pageSize && prev.search === s.search ? prev : { page: s.page, pageSize: s.pageSize, search: s.search }));
  }, []);

  const columns = useMemo<ColumnDef<Payment>[]>(() => [
    { id: "payment_number", header: t("sales.payments.col.number"), accessor: (p) => p.payment_number, cell: (p) => <span className="font-bold text-teal-700">{p.payment_number}</span> },
    { id: "customer", header: t("sales.col.customer"), accessor: (p) => p.customer_name ?? "—" },
    { id: "date", header: t("sales.col.date"), cell: (p) => <DateCell value={p.payment_date} /> },
    { id: "amount", header: t("sales.col.amount"), align: "end", cell: (p) => <Money value={p.amount} /> },
    { id: "allocated", header: t("sales.col.allocated"), align: "end", cell: (p) => <Money value={p.allocated_amount} /> },
    { id: "unapplied", header: t("sales.col.unapplied"), align: "end", cell: (p) => <Money value={p.unapplied_amount} className={Number(p.unapplied_amount) > 0 ? "font-bold text-amber-600" : ""} /> },
    { id: "status", header: t("common.status"), cell: (p) => <SalesStatus status={p.status} /> },
  ], [t]);

  return (
    <div>
      <PageHeader
        eyebrow={t("sales.payments.eyebrow")}
        title={t("sales.payments.title")}
        subtitle={t("sales.payments.subtitle")}
        action={<Can cap="payments.create"><Button onClick={openNew}><Plus className="h-4 w-4" /> {t("sales.payments.newBtn")}</Button></Can>}
      />
      <DataTable<Payment>
        mode="server"
        columns={columns}
        rows={list.data?.data ?? []}
        rowCount={list.data?.pagination?.total ?? 0}
        getRowId={(p) => p.id}
        loading={list.isLoading}
        error={list.isError ? list.error : undefined}
        onRetry={() => list.refetch()}
        onRowClick={(p) => openDoc(p.id)}
        onStateChange={onStateChange}
        initialPageSize={25}
        searchable
        searchPlaceholder={t("sales.payments.searchPlaceholder")}
        columnMenu={false}
        emptyTitle={t("sales.payments.emptyTitle")}
        emptyBody={t("sales.payments.emptyBody")}
        mobileTitle={(p) => p.payment_number}
        filterBar={
          <label className="flex items-center">
            <span className="sr-only">{t("sales.filters.byStatus")}</span>
            <select className="field h-10" value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t("sales.filters.byStatus")}>
              {statusOptions.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
        }
      />
      {isNew && <PaymentForm open onClose={closeNew} onCreated={openDoc} presetCustomerId={presetCustomerId} />}
    </div>
  );
}
