import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { o2cApi } from "@/lib/api";
import { qk } from "@/lib/query-keys";
import { useCan } from "@/app/permission-provider";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { LoadingState, ErrorState, EmptyState } from "@/components/states/States";
import { Money, DateCell, StatusPill, Toolbar, Pagination, TableShell, Th, Td } from "@/features/_shared/ui";
import { PaymentForm } from "./PaymentForm";

const PAGE_SIZE = 25;
const STATUSES = ["", "draft", "approved", "posted", "reversed", "cancelled"];
const LABEL: Record<string, string> = { "": "كل الحالات", draft: "مسودة", approved: "معتمد", posted: "مُرحّل", reversed: "معكوس", cancelled: "ملغى" };

export function PaymentsPage() {
  const canCreate = useCan("payments.create");
  const [sp] = useSearchParams();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(false);
  const presetCustomer = sp.get("customerId") || undefined;

  const params = useMemo(() => ({ q, status, page, pageSize: PAGE_SIZE }), [q, status, page]);
  const list = useQuery({ queryKey: qk.payments(params), queryFn: ({ signal }) => o2cApi.payments(params, signal) });

  return (
    <div>
      <PageHeader
        eyebrow="التحصيلات"
        title="سندات القبض"
        subtitle="تحصيل ودفعات مقدمة وتخصيص على الفواتير."
        action={canCreate ? <Button onClick={() => setFormOpen(true)}><Plus className="ml-1 h-4 w-4" /> سند قبض</Button> : undefined}
      />
      <Toolbar>
        <label className="relative min-w-64 flex-1">
          <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input className="field w-full pr-10" placeholder="ابحث برقم السند…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        </label>
        <select className="field" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          {STATUSES.map((s) => <option key={s} value={s}>{LABEL[s]}</option>)}
        </select>
      </Toolbar>

      {list.isLoading ? <LoadingState rows={8} />
        : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} />
        : list.data!.data.length === 0 ? <EmptyState title="لا توجد سندات قبض" body="سجّل سند قبض جديد." />
        : (
          <>
            <TableShell head={<tr><Th>رقم السند</Th><Th>العميل</Th><Th>التاريخ</Th><Th>المبلغ</Th><Th>المخصّص</Th><Th>غير مخصّص</Th><Th>الحالة</Th></tr>}>
              {list.data!.data.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50/60">
                  <Td><Link to={`/payments/${p.id}`} className="font-bold text-teal-700 hover:underline">{p.payment_number}</Link></Td>
                  <Td>{p.customer_name || "—"}</Td>
                  <Td><DateCell value={p.payment_date} /></Td>
                  <Td><Money value={p.amount} /></Td>
                  <Td><Money value={p.allocated_amount} /></Td>
                  <Td><Money value={p.unapplied_amount} className={Number(p.unapplied_amount) > 0 ? "font-bold text-amber-600" : ""} /></Td>
                  <Td><StatusPill status={p.status} /></Td>
                </tr>
              ))}
            </TableShell>
            <Pagination page={page} totalPages={list.data!.pagination?.totalPages ?? 1} total={list.data!.pagination?.total ?? 0} onPage={setPage} />
          </>
        )}

      {formOpen && <PaymentForm open={formOpen} onClose={() => setFormOpen(false)} presetCustomerId={presetCustomer} />}
    </div>
  );
}
