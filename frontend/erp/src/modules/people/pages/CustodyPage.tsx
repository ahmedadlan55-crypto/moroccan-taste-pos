import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Drawer, ErrorState, LoadingState, PageHeader, Select, StatusBadge, Tabs } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatCurrency, formatDate } from "@/shared/lib";
import { peopleApi } from "../lib/api";
import { qk } from "../lib/query-keys";
import { statusMeta } from "../lib/labels";
import type { Custody, CustodyExpense } from "../lib/types";

type TabKey = "custodies" | "expenses";

const TABS = [
  { value: "custodies", label: "العُهد" },
  { value: "expenses", label: "المصروفات" },
];

export function CustodyPage() {
  const [tab, setTab] = useState<TabKey>("custodies");
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="الموارد البشرية"
        title="العهد والمستندات"
        subtitle="عُهد الموظفين ومصروفاتها (عرض فقط)."
      />
      <Tabs items={TABS} value={tab} onChange={(v) => setTab(v as TabKey)} aria-label="أقسام العهد" />
      {tab === "custodies" && <CustodiesTab />}
      {tab === "expenses" && <ExpensesTab />}
    </div>
  );
}

function CustodiesTab() {
  const [detailId, setDetailId] = useState<string | null>(null);
  const query = useQuery({ queryKey: qk.custodies(), queryFn: ({ signal }) => peopleApi.listCustodies(signal) });

  const columns: ColumnDef<Custody>[] = [
    { id: "custodyNumber", header: "رقم العهدة", accessor: (r) => r.custodyNumber, sortable: true },
    { id: "userName", header: "المسؤول", accessor: (r) => r.userName || "—", sortable: true },
    { id: "balance", header: "الرصيد", accessor: (r) => r.balance, cell: (r) => formatCurrency(r.balance), numeric: true, sortable: true },
    { id: "totalTopups", header: "الإيداعات", accessor: (r) => r.totalTopups, cell: (r) => formatCurrency(r.totalTopups), numeric: true },
    { id: "totalExpenses", header: "المصروفات", accessor: (r) => r.totalExpenses, cell: (r) => formatCurrency(r.totalExpenses), numeric: true },
    {
      id: "createdDate",
      header: "تاريخ الفتح",
      accessor: (r) => r.createdDate ?? "",
      cell: (r) => formatDate(r.createdDate),
    },
    {
      id: "status",
      header: "الحالة",
      accessor: (r) => r.status,
      cell: (r) => {
        const m = statusMeta(r.status);
        return <StatusBadge tone={m.tone}>{m.label}</StatusBadge>;
      },
    },
  ];

  return (
    <>
      <DataTable
        columns={columns}
        rows={query.data ?? []}
        getRowId={(r) => r.id}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => query.refetch()}
        tableId="people.custodies"
        searchable
        searchPlaceholder="بحث برقم العهدة أو المسؤول…"
        emptyTitle="لا توجد عُهد"
        exportFilename="custodies.csv"
        onRowClick={(r) => setDetailId(r.id)}
      />
      <CustodyDetailDrawer id={detailId} onClose={() => setDetailId(null)} />
    </>
  );
}

function CustodyDetailDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const query = useQuery({
    queryKey: qk.custody(id ?? ""),
    queryFn: ({ signal }) => peopleApi.custodyExpensesFor(id ?? "", signal),
    enabled: !!id,
  });

  return (
    <Drawer open={!!id} onClose={onClose} title="مصروفات العهدة" eyebrow="العهد">
      {query.isLoading && <LoadingState rows={2} />}
      {query.error && <ErrorState error={query.error} onRetry={() => query.refetch()} />}
      {query.data && query.data.length === 0 && (
        <p className="text-sm font-medium text-slate-500">لا توجد مصروفات مسجّلة لهذه العهدة.</p>
      )}
      {query.data && query.data.length > 0 && (
        <ul className="space-y-2">
          {query.data.map((e) => {
            const m = statusMeta(e.status);
            return (
              <li key={e.id} className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-extrabold text-slate-800">{e.description || "—"}</div>
                    <div className="mt-0.5 text-xs font-medium text-slate-500">{formatDate(e.expenseDate)}</div>
                  </div>
                  <div className="shrink-0 text-left">
                    <div className="text-sm font-extrabold tabular-nums text-slate-900" dir="ltr">
                      {formatCurrency(e.totalWithVat)}
                    </div>
                    <div className="mt-1">
                      <StatusBadge tone={m.tone}>{m.label}</StatusBadge>
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Drawer>
  );
}

function ExpensesTab() {
  const [status, setStatus] = useState("");
  const params = useMemo(() => (status ? { status } : {}), [status]);
  const query = useQuery({
    queryKey: qk.custodyExpenses(params),
    queryFn: ({ signal }) => peopleApi.listCustodyExpenses(params, signal),
  });

  const columns: ColumnDef<CustodyExpense>[] = [
    { id: "custodyNumber", header: "العهدة", accessor: (r) => r.custodyNumber || "—", sortable: true },
    { id: "userName", header: "المسؤول", accessor: (r) => r.userName || "—" },
    { id: "description", header: "الوصف", accessor: (r) => r.description || "—" },
    { id: "expenseDate", header: "التاريخ", accessor: (r) => r.expenseDate, cell: (r) => formatDate(r.expenseDate), sortable: true },
    { id: "amount", header: "المبلغ", accessor: (r) => r.amount, cell: (r) => formatCurrency(r.amount), numeric: true, sortable: true },
    { id: "vatAmount", header: "الضريبة", accessor: (r) => r.vatAmount, cell: (r) => formatCurrency(r.vatAmount), numeric: true, defaultHidden: true },
    { id: "totalWithVat", header: "الإجمالي", accessor: (r) => r.totalWithVat, cell: (r) => formatCurrency(r.totalWithVat), numeric: true },
    {
      id: "status",
      header: "الحالة",
      accessor: (r) => r.status,
      cell: (r) => {
        const m = statusMeta(r.status);
        return <StatusBadge tone={m.tone}>{m.label}</StatusBadge>;
      },
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={query.data ?? []}
      getRowId={(r) => r.id}
      loading={query.isLoading}
      error={query.error}
      onRetry={() => query.refetch()}
      tableId="people.custodyExpenses"
      searchable
      searchPlaceholder="بحث بالوصف أو العهدة…"
      emptyTitle="لا توجد مصروفات"
      exportFilename="custody-expenses.csv"
      filterBar={
        <label className="flex items-center gap-2 text-xs font-bold text-slate-500">
          الحالة
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="h-10 min-w-36"
            options={[
              { value: "", label: "الكل" },
              { value: "pending", label: "قيد الاعتماد" },
              { value: "approved", label: "معتمدة" },
              { value: "posted", label: "مُرحّلة" },
              { value: "rejected", label: "مرفوضة" },
            ]}
          />
        </label>
      }
    />
  );
}
