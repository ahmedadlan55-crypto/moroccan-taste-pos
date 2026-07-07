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
import { ReturnForm } from "./ReturnForm";

const PAGE_SIZE = 25;
const REFUND_LABEL: Record<string, string> = { ar_reduction: "تخفيض ذمم", cash: "نقدي", bank: "بنكي", customer_deposit: "رصيد دائن" };

export function ReturnsPage() {
  const canCreate = useCan("returns.create");
  const [sp] = useSearchParams();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(false);
  const presetInvoice = sp.get("invoiceId") || undefined;

  const params = useMemo(() => ({ q, status, page, pageSize: PAGE_SIZE }), [q, status, page]);
  const list = useQuery({ queryKey: qk.returns(params), queryFn: ({ signal }) => o2cApi.returns(params, signal) });

  return (
    <div>
      <PageHeader
        eyebrow="المرتجعات"
        title="مرتجعات البيع"
        subtitle="مرتجع جزئي من فاتورة مع إشعار دائن وقيد عكسي."
        action={canCreate ? <Button onClick={() => setFormOpen(true)}><Plus className="ml-1 h-4 w-4" /> مرتجع جديد</Button> : undefined}
      />
      <Toolbar>
        <label className="relative min-w-64 flex-1">
          <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input className="field w-full pr-10" placeholder="ابحث برقم المرتجع…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        </label>
        <select className="field" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">كل الحالات</option><option value="draft">مسودة</option><option value="approved">معتمد</option><option value="posted">مُرحّل</option><option value="reversed">معكوس</option><option value="cancelled">ملغى</option>
        </select>
      </Toolbar>

      {list.isLoading ? <LoadingState rows={8} />
        : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} />
        : list.data!.data.length === 0 ? <EmptyState title="لا توجد مرتجعات" body="أنشئ مرتجعًا من فاتورة." />
        : (
          <>
            <TableShell head={<tr><Th>رقم المرتجع</Th><Th>العميل</Th><Th>التاريخ</Th><Th>الإجمالي</Th><Th>طريقة الرد</Th><Th>الحالة</Th></tr>}>
              {list.data!.data.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50/60">
                  <Td><Link to={`/returns/${r.id}`} className="font-bold text-teal-700 hover:underline">{r.return_number}</Link></Td>
                  <Td>{r.customer_name || "—"}</Td>
                  <Td><DateCell value={r.return_date} /></Td>
                  <Td><Money value={r.total_amount} /></Td>
                  <Td>{REFUND_LABEL[r.refund_method] || r.refund_method}</Td>
                  <Td><StatusPill status={r.status} /></Td>
                </tr>
              ))}
            </TableShell>
            <Pagination page={page} totalPages={list.data!.pagination?.totalPages ?? 1} total={list.data!.pagination?.total ?? 0} onPage={setPage} />
          </>
        )}

      {formOpen && <ReturnForm open={formOpen} onClose={() => setFormOpen(false)} presetInvoiceId={presetInvoice} />}
    </div>
  );
}
