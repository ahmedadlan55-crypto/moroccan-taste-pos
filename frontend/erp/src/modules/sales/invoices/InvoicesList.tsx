import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Button, PageHeader } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { Can } from "@/shared/permissions";
import { o2cApi, qk, SalesStatus, Money, DateCell, useDocNav, type Invoice } from "@/modules/sales/lib";
import { InvoiceForm } from "./InvoiceForm";

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "كل الحالات" },
  { value: "draft", label: "مسودة" },
  { value: "issued", label: "صادرة" },
  { value: "partially_paid", label: "جزئية" },
  { value: "paid", label: "مدفوعة" },
  { value: "credited", label: "إشعار دائن" },
  { value: "cancelled", label: "ملغاة" },
];

interface TableState { page: number; pageSize: number; search: string }

export function InvoicesList() {
  const { isNew, openDoc, openNew, closeNew } = useDocNav();
  const [status, setStatus] = useState("");
  const [ts, setTs] = useState<TableState>({ page: 1, pageSize: 25, search: "" });

  const params = useMemo(() => ({ q: ts.search, status, page: ts.page, pageSize: ts.pageSize }), [ts, status]);
  const list = useQuery({ queryKey: qk.invoices(params), queryFn: ({ signal }) => o2cApi.invoices(params, signal) });

  const onStateChange = useCallback((s: { page: number; pageSize: number; search: string }) => {
    setTs((prev) => (prev.page === s.page && prev.pageSize === s.pageSize && prev.search === s.search ? prev : { page: s.page, pageSize: s.pageSize, search: s.search }));
  }, []);

  const columns = useMemo<ColumnDef<Invoice>[]>(() => [
    { id: "document_number", header: "رقم الفاتورة", accessor: (i) => i.document_number, cell: (i) => <span className="font-bold text-teal-700">{i.document_number}</span> },
    { id: "customer", header: "العميل", accessor: (i) => i.customer_name ?? "—" },
    { id: "issue_date", header: "التاريخ", cell: (i) => <DateCell value={i.issue_date} /> },
    { id: "due_date", header: "الاستحقاق", cell: (i) => <DateCell value={i.due_date} /> },
    { id: "total", header: "الإجمالي", align: "end", cell: (i) => <Money value={i.total_amount} /> },
    { id: "balance", header: "المتبقّي", align: "end", cell: (i) => <Money value={i.balance_amount} className="font-bold" /> },
    { id: "status", header: "الحالة", cell: (i) => <SalesStatus status={i.status} /> },
    { id: "zatca", header: "زاتكا", cell: (i) => <SalesStatus status={i.zatca_status} /> },
  ], []);

  return (
    <div>
      <PageHeader
        eyebrow="الفواتير"
        title="فواتير العملاء"
        subtitle="المصدر الموحّد للذمم — فاتورة صادرة غير قابلة للتعديل."
        action={<Can cap="invoices.create"><Button onClick={openNew}><Plus className="h-4 w-4" /> فاتورة جديدة</Button></Can>}
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
        searchPlaceholder="ابحث برقم الفاتورة أو العميل…"
        columnMenu={false}
        emptyTitle="لا توجد فواتير"
        emptyBody="أنشئ فاتورة جديدة للبدء."
        mobileTitle={(i) => i.document_number}
        filterBar={
          <label className="flex items-center">
            <span className="sr-only">تصفية بالحالة</span>
            <select className="field h-10" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="تصفية بالحالة">
              {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
        }
      />
      {isNew && <InvoiceForm open onClose={closeNew} onCreated={openDoc} />}
    </div>
  );
}
