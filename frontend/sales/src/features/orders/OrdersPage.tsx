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
import { OrderForm } from "./OrderForm";

const PAGE_SIZE = 25;

export function OrdersPage() {
  const canCreate = useCan("sales_orders.create");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(false);

  const params = useMemo(() => ({ q, status, page, pageSize: PAGE_SIZE }), [q, status, page]);
  const list = useQuery({ queryKey: qk.orders(params), queryFn: ({ signal }) => o2cApi.orders(params, signal) });

  return (
    <div>
      <PageHeader
        eyebrow="أوامر البيع"
        title="أوامر البيع"
        subtitle="مسودة ← تأكيد ← تنفيذ ← تفويتر."
        action={canCreate ? <Button onClick={() => setFormOpen(true)}><Plus className="ml-1 h-4 w-4" /> أمر بيع</Button> : undefined}
      />
      <Toolbar>
        <label className="relative min-w-64 flex-1">
          <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input className="field w-full pr-10" placeholder="ابحث برقم الأمر أو العميل…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        </label>
        <select className="field" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">كل الحالات</option><option value="draft">مسودة</option><option value="confirmed">مؤكَّد</option><option value="fulfilled">مُنفَّذ</option><option value="invoiced">مُفوتَر</option><option value="cancelled">ملغى</option>
        </select>
      </Toolbar>

      {list.isLoading ? <LoadingState rows={8} />
        : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} />
        : list.data!.data.length === 0 ? <EmptyState title="لا توجد أوامر بيع" body="أنشئ أمر بيع جديد." />
        : (
          <>
            <TableShell head={<tr><Th>رقم الأمر</Th><Th>العميل</Th><Th>التاريخ</Th><Th>الإجمالي</Th><Th>آجل؟</Th><Th>الحالة</Th></tr>}>
              {list.data!.data.map((o) => (
                <tr key={o.id} className="hover:bg-slate-50/60">
                  <Td><Link to={`/orders/${o.id}`} className="font-bold text-teal-700 hover:underline">{o.order_number}</Link></Td>
                  <Td>{o.customer_name || "—"}</Td>
                  <Td><DateCell value={o.order_date} /></Td>
                  <Td><Money value={o.total_amount} /></Td>
                  <Td>{o.is_credit_sale ? <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">آجل</span> : <span className="text-slate-400">نقدي</span>}</Td>
                  <Td><StatusPill status={o.status} /></Td>
                </tr>
              ))}
            </TableShell>
            <Pagination page={page} totalPages={list.data!.pagination?.totalPages ?? 1} total={list.data!.pagination?.total ?? 0} onPage={setPage} />
          </>
        )}

      {formOpen && <OrderForm open={formOpen} onClose={() => setFormOpen(false)} />}
    </div>
  );
}
