import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Button, Badge, PageHeader } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { Can } from "@/shared/permissions";
import { o2cApi, qk, SalesStatus, Money, DateCell, useDocNav, type SalesOrder } from "@/modules/sales/lib";
import { OrderForm } from "./OrderForm";

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "كل الحالات" },
  { value: "draft", label: "مسودة" },
  { value: "confirmed", label: "مؤكَّد" },
  { value: "fulfilled", label: "مُنفَّذ" },
  { value: "invoiced", label: "مُفوتَر" },
  { value: "cancelled", label: "ملغى" },
];

interface TableState { page: number; pageSize: number; search: string }

export function OrdersList() {
  const { isNew, openDoc, openNew, closeNew } = useDocNav();
  const [status, setStatus] = useState("");
  const [ts, setTs] = useState<TableState>({ page: 1, pageSize: 25, search: "" });

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
    { id: "order_number", header: "رقم الأمر", accessor: (o) => o.order_number, cell: (o) => <span className="font-bold text-teal-700">{o.order_number}</span> },
    { id: "customer", header: "العميل", accessor: (o) => o.customer_name ?? "—" },
    { id: "date", header: "التاريخ", cell: (o) => <DateCell value={o.order_date} /> },
    { id: "total", header: "الإجمالي", align: "end", cell: (o) => <Money value={o.total_amount} /> },
    { id: "credit", header: "آجل؟", cell: (o) => (o.is_credit_sale ? <Badge tone="warning">آجل</Badge> : <span className="text-slate-400">نقدي</span>) },
    { id: "status", header: "الحالة", cell: (o) => <SalesStatus status={o.status} /> },
  ], []);

  return (
    <div>
      <PageHeader
        eyebrow="أوامر البيع"
        title="أوامر البيع"
        subtitle="مسودة ← تأكيد ← تنفيذ ← تفويتر."
        action={<Can cap="sales_orders.create"><Button onClick={openNew}><Plus className="h-4 w-4" /> أمر بيع</Button></Can>}
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
        searchPlaceholder="ابحث برقم الأمر أو العميل…"
        columnMenu={false}
        emptyTitle="لا توجد أوامر بيع"
        emptyBody="أنشئ أمر بيع جديد."
        mobileTitle={(o) => o.order_number}
        filterBar={
          <label className="flex items-center">
            <span className="sr-only">تصفية بالحالة</span>
            <select className="field h-10" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="تصفية بالحالة">
              {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
        }
      />
      {isNew && <OrderForm open onClose={closeNew} onCreated={openDoc} />}
    </div>
  );
}
