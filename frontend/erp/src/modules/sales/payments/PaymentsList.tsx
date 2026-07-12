import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Button, PageHeader } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { Can } from "@/shared/permissions";
import { o2cApi, qk, SalesStatus, Money, DateCell, useDocNav, type Payment } from "@/modules/sales/lib";
import { PaymentForm } from "./PaymentForm";

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "كل الحالات" },
  { value: "draft", label: "مسودة" },
  { value: "approved", label: "معتمد" },
  { value: "posted", label: "مُرحّل" },
  { value: "reversed", label: "معكوس" },
  { value: "cancelled", label: "ملغى" },
];

interface TableState { page: number; pageSize: number; search: string }

export function PaymentsList({ presetCustomerId }: { presetCustomerId?: string }) {
  const { isNew, openDoc, openNew, closeNew } = useDocNav();
  const [status, setStatus] = useState("");
  const [ts, setTs] = useState<TableState>({ page: 1, pageSize: 25, search: "" });

  const params = useMemo(() => ({ q: ts.search, status, page: ts.page, pageSize: ts.pageSize }), [ts, status]);
  const list = useQuery({ queryKey: qk.payments(params), queryFn: ({ signal }) => o2cApi.payments(params, signal) });

  const onStateChange = useCallback((s: { page: number; pageSize: number; search: string }) => {
    setTs((prev) => (prev.page === s.page && prev.pageSize === s.pageSize && prev.search === s.search ? prev : { page: s.page, pageSize: s.pageSize, search: s.search }));
  }, []);

  const columns = useMemo<ColumnDef<Payment>[]>(() => [
    { id: "payment_number", header: "رقم السند", accessor: (p) => p.payment_number, cell: (p) => <span className="font-bold text-teal-700">{p.payment_number}</span> },
    { id: "customer", header: "العميل", accessor: (p) => p.customer_name ?? "—" },
    { id: "date", header: "التاريخ", cell: (p) => <DateCell value={p.payment_date} /> },
    { id: "amount", header: "المبلغ", align: "end", cell: (p) => <Money value={p.amount} /> },
    { id: "allocated", header: "المخصّص", align: "end", cell: (p) => <Money value={p.allocated_amount} /> },
    { id: "unapplied", header: "غير مخصّص", align: "end", cell: (p) => <Money value={p.unapplied_amount} className={Number(p.unapplied_amount) > 0 ? "font-bold text-amber-600" : ""} /> },
    { id: "status", header: "الحالة", cell: (p) => <SalesStatus status={p.status} /> },
  ], []);

  return (
    <div>
      <PageHeader
        eyebrow="التحصيلات"
        title="سندات القبض"
        subtitle="تحصيل ودفعات مقدمة وتخصيص على الفواتير."
        action={<Can cap="payments.create"><Button onClick={openNew}><Plus className="h-4 w-4" /> سند قبض</Button></Can>}
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
        searchPlaceholder="ابحث برقم السند…"
        columnMenu={false}
        emptyTitle="لا توجد سندات قبض"
        emptyBody="سجّل سند قبض جديد."
        mobileTitle={(p) => p.payment_number}
        filterBar={
          <label className="flex items-center">
            <span className="sr-only">تصفية بالحالة</span>
            <select className="field h-10" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="تصفية بالحالة">
              {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
        }
      />
      {isNew && <PaymentForm open onClose={closeNew} onCreated={openDoc} presetCustomerId={presetCustomerId} />}
    </div>
  );
}
