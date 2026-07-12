import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, UserCog } from "lucide-react";
import { Button, IconButton, Badge, PageHeader } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { Can } from "@/shared/permissions";
import { useCan } from "@/app/providers";
import { o2cApi, qk, Money, useDocNav, type Customer } from "@/modules/sales/lib";
import { CustomerForm } from "./CustomerForm";

const ACTIVE_OPTIONS: { value: string; label: string }[] = [
  { value: "true", label: "النشطون" },
  { value: "false", label: "المعطّلون" },
  { value: "", label: "الكل" },
];
const TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "كل الأنواع" },
  { value: "B2C", label: "أفراد" },
  { value: "B2B", label: "شركات" },
  { value: "B2G", label: "حكومي" },
];

interface TableState { page: number; pageSize: number; search: string }

export function CustomersList() {
  const { isNew, openDoc, openNew, closeNew } = useDocNav();
  const canEdit = useCan("customers.edit");
  const [active, setActive] = useState<"" | "true" | "false">("true");
  const [type, setType] = useState("");
  const [ts, setTs] = useState<TableState>({ page: 1, pageSize: 25, search: "" });
  const [editing, setEditing] = useState<Customer | null>(null);

  const params = useMemo(
    () => ({ q: ts.search, active, type, page: ts.page, pageSize: ts.pageSize, sort: "name", dir: "ASC" }),
    [ts, active, type],
  );
  const list = useQuery({ queryKey: qk.customers(params), queryFn: ({ signal }) => o2cApi.customers(params, signal) });

  const onStateChange = useCallback((s: { page: number; pageSize: number; search: string }) => {
    setTs((prev) => (prev.page === s.page && prev.pageSize === s.pageSize && prev.search === s.search ? prev : { page: s.page, pageSize: s.pageSize, search: s.search }));
  }, []);

  const columns = useMemo<ColumnDef<Customer>[]>(() => [
    {
      id: "name", header: "العميل", accessor: (c) => c.name,
      cell: (c) => (
        <span className="flex items-center gap-2">
          <span className="font-bold text-slate-800">{c.name}</span>
          {!c.isActive && <Badge tone="neutral">معطّل</Badge>}
        </span>
      ),
    },
    { id: "phone", header: "الهاتف", cell: (c) => <span dir="ltr" className="tabular-nums">{c.phone || "—"}</span> },
    { id: "type", header: "النوع", accessor: (c) => c.customerType },
    { id: "creditLimit", header: "حد الائتمان", align: "end", cell: (c) => <Money value={c.creditLimit} /> },
    { id: "balance", header: "الرصيد", align: "end", cell: (c) => <Money value={c.derived?.arBalance ?? c.balance} className="font-bold" /> },
  ], []);

  return (
    <div>
      <PageHeader
        eyebrow="العملاء"
        title="سجل العملاء"
        subtitle="بحث وتصفية العملاء وإدارة الحدود الائتمانية."
        action={<Can cap="customers.create"><Button onClick={openNew}><Plus className="h-4 w-4" /> عميل جديد</Button></Can>}
      />
      <DataTable<Customer>
        mode="server"
        columns={columns}
        rows={list.data?.data ?? []}
        rowCount={list.data?.pagination?.total ?? 0}
        getRowId={(c) => c.id}
        loading={list.isLoading}
        error={list.isError ? list.error : undefined}
        onRetry={() => list.refetch()}
        onRowClick={(c) => openDoc(c.id)}
        onStateChange={onStateChange}
        initialPageSize={25}
        searchable
        searchPlaceholder="ابحث بالاسم أو الهاتف أو الرقم الضريبي…"
        columnMenu={false}
        emptyTitle="لا يوجد عملاء مطابقون"
        emptyBody="جرّب تعديل البحث أو أضف عميلًا جديدًا."
        mobileTitle={(c) => c.name}
        rowActions={(c) =>
          canEdit ? (
            <IconButton aria-label="تعديل العميل" size="sm" variant="secondary" onClick={() => setEditing(c)}>
              <UserCog className="h-4 w-4" />
            </IconButton>
          ) : null
        }
        filterBar={
          <>
            <label className="flex items-center">
              <span className="sr-only">تصفية بالحالة</span>
              <select className="field h-10" value={active} onChange={(e) => setActive(e.target.value as "" | "true" | "false")} aria-label="تصفية بالحالة">
                {ACTIVE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="flex items-center">
              <span className="sr-only">تصفية بالنوع</span>
              <select className="field h-10" value={type} onChange={(e) => setType(e.target.value)} aria-label="تصفية بالنوع">
                {TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          </>
        }
      />
      {isNew && <CustomerForm open onClose={closeNew} customer={null} />}
      {editing && <CustomerForm open onClose={() => setEditing(null)} customer={editing} />}
    </div>
  );
}
