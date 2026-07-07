import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { o2cApi } from "@/lib/api";
import { qk } from "@/lib/query-keys";
import { useCan } from "@/app/permission-provider";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { LoadingState, ErrorState, EmptyState } from "@/components/states/States";
import { Money, DateCell, StatusPill, Toolbar, Pagination, TableShell, Th, Td } from "@/features/_shared/ui";
import { InvoiceForm } from "./InvoiceForm";

const PAGE_SIZE = 25;
const STATUSES = ["", "draft", "issued", "partially_paid", "paid", "credited", "cancelled"];
const STATUS_LABEL: Record<string, string> = { "": "كل الحالات", draft: "مسودة", issued: "صادرة", partially_paid: "جزئية", paid: "مدفوعة", credited: "إشعار دائن", cancelled: "ملغاة" };

export function InvoicesPage() {
  const canCreate = useCan("invoices.create");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(false);

  const params = useMemo(() => ({ q, status, page, pageSize: PAGE_SIZE }), [q, status, page]);
  const list = useQuery({ queryKey: qk.invoices(params), queryFn: ({ signal }) => o2cApi.invoices(params, signal) });

  return (
    <div>
      <PageHeader
        eyebrow="الفواتير"
        title="فواتير العملاء"
        subtitle="المصدر الموحّد للذمم — فاتورة صادرة غير قابلة للتعديل."
        action={canCreate ? <Button onClick={() => setFormOpen(true)}><Plus className="ml-1 h-4 w-4" /> فاتورة جديدة</Button> : undefined}
      />
      <Toolbar>
        <label className="relative min-w-64 flex-1">
          <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input className="field w-full pr-10" placeholder="ابحث برقم الفاتورة أو العميل…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        </label>
        <select className="field" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
      </Toolbar>

      {list.isLoading ? <LoadingState rows={8} />
        : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} />
        : list.data!.data.length === 0 ? <EmptyState title="لا توجد فواتير" body="أنشئ فاتورة جديدة للبدء." />
        : (
          <>
            <TableShell head={<tr><Th>رقم الفاتورة</Th><Th>العميل</Th><Th>التاريخ</Th><Th>الاستحقاق</Th><Th>الإجمالي</Th><Th>المتبقّي</Th><Th>الحالة</Th><Th>زاتكا</Th></tr>}>
              {list.data!.data.map((inv) => (
                <tr key={inv.id} className="hover:bg-slate-50/60">
                  <Td><Link to={`/invoices/${inv.id}`} className="font-bold text-teal-700 hover:underline">{inv.document_number}</Link></Td>
                  <Td>{inv.customer_name || "—"}</Td>
                  <Td><DateCell value={inv.issue_date} /></Td>
                  <Td><DateCell value={inv.due_date} /></Td>
                  <Td><Money value={inv.total_amount} /></Td>
                  <Td><Money value={inv.balance_amount} className="font-bold" /></Td>
                  <Td><StatusPill status={inv.status} /></Td>
                  <Td><StatusPill status={inv.zatca_status} /></Td>
                </tr>
              ))}
            </TableShell>
            <Pagination page={page} totalPages={list.data!.pagination?.totalPages ?? 1} total={list.data!.pagination?.total ?? 0} onPage={setPage} />
          </>
        )}

      {formOpen && <InvoiceForm open={formOpen} onClose={() => setFormOpen(false)} />}
    </div>
  );
}
