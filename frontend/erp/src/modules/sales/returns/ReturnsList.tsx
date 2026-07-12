import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Button, PageHeader } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { Can } from "@/shared/permissions";
import { o2cApi, qk, SalesStatus, Money, DateCell, useDocNav, type SalesReturn } from "@/modules/sales/lib";
import { ReturnForm } from "./ReturnForm";

const REFUND_LABEL: Record<string, string> = { ar_reduction: "تخفيض ذمم", cash: "نقدي", bank: "بنكي", customer_deposit: "رصيد دائن" };

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "كل الحالات" },
  { value: "draft", label: "مسودة" },
  { value: "approved", label: "معتمد" },
  { value: "posted", label: "مُرحّل" },
  { value: "reversed", label: "معكوس" },
  { value: "cancelled", label: "ملغى" },
];

interface TableState { page: number; pageSize: number; search: string }

export function ReturnsList({ presetInvoiceId }: { presetInvoiceId?: string }) {
  const { isNew, openDoc, openNew, closeNew } = useDocNav();
  const [status, setStatus] = useState("");
  const [ts, setTs] = useState<TableState>({ page: 1, pageSize: 25, search: "" });

  const params = useMemo(() => ({ q: ts.search, status, page: ts.page, pageSize: ts.pageSize }), [ts, status]);
  const list = useQuery({ queryKey: qk.returns(params), queryFn: ({ signal }) => o2cApi.returns(params, signal) });

  const onStateChange = useCallback((s: { page: number; pageSize: number; search: string }) => {
    setTs((prev) => (prev.page === s.page && prev.pageSize === s.pageSize && prev.search === s.search ? prev : { page: s.page, pageSize: s.pageSize, search: s.search }));
  }, []);

  const columns = useMemo<ColumnDef<SalesReturn>[]>(() => [
    { id: "return_number", header: "رقم المرتجع", accessor: (r) => r.return_number, cell: (r) => <span className="font-bold text-teal-700">{r.return_number}</span> },
    { id: "customer", header: "العميل", accessor: (r) => r.customer_name ?? "—" },
    { id: "date", header: "التاريخ", cell: (r) => <DateCell value={r.return_date} /> },
    { id: "total", header: "الإجمالي", align: "end", cell: (r) => <Money value={r.total_amount} /> },
    { id: "refund", header: "طريقة الرد", accessor: (r) => REFUND_LABEL[r.refund_method] || r.refund_method },
    { id: "status", header: "الحالة", cell: (r) => <SalesStatus status={r.status} /> },
  ], []);

  return (
    <div>
      <PageHeader
        eyebrow="المرتجعات"
        title="مرتجعات البيع"
        subtitle="مرتجع جزئي من فاتورة مع إشعار دائن وقيد عكسي."
        action={<Can cap="returns.create"><Button onClick={openNew}><Plus className="h-4 w-4" /> مرتجع جديد</Button></Can>}
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
        searchPlaceholder="ابحث برقم المرتجع…"
        columnMenu={false}
        emptyTitle="لا توجد مرتجعات"
        emptyBody="أنشئ مرتجعًا من فاتورة."
        mobileTitle={(r) => r.return_number}
        filterBar={
          <label className="flex items-center">
            <span className="sr-only">تصفية بالحالة</span>
            <select className="field h-10" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="تصفية بالحالة">
              {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
        }
      />
      {isNew && <ReturnForm open onClose={closeNew} onCreated={openDoc} presetInvoiceId={presetInvoiceId} />}
    </div>
  );
}
