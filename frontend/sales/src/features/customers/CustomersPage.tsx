import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Plus, Search, UserCog } from "lucide-react";
import { o2cApi } from "@/lib/api";
import { qk } from "@/lib/query-keys";
import { useCan } from "@/app/permission-provider";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { LoadingState, ErrorState, EmptyState } from "@/components/states/States";
import { Money, Toolbar, Pagination, TableShell, Th, Td } from "@/features/_shared/ui";
import { CustomerForm } from "./CustomerForm";
import type { Customer } from "@/lib/types";

const PAGE_SIZE = 25;

export function CustomersPage() {
  const canCreate = useCan("customers.create");
  const canEdit = useCan("customers.edit");
  const [q, setQ] = useState("");
  const [active, setActive] = useState<"" | "true" | "false">("true");
  const [type, setType] = useState("");
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);

  const params = useMemo(() => ({ q, active, type, page, pageSize: PAGE_SIZE, sort: "name", dir: "ASC" }), [q, active, type, page]);
  const list = useQuery({
    queryKey: qk.customers(params),
    queryFn: ({ signal }) => o2cApi.customers(params, signal),
  });

  function openCreate() { setEditing(null); setFormOpen(true); }
  function openEdit(c: Customer) { setEditing(c); setFormOpen(true); }

  return (
    <div>
      <PageHeader
        eyebrow="العملاء"
        title="سجل العملاء"
        subtitle="بحث وتصفية العملاء وإدارة الحدود الائتمانية."
        action={canCreate ? <Button onClick={openCreate}><Plus className="ml-1 h-4 w-4" /> عميل جديد</Button> : undefined}
      />

      <Toolbar>
        <label className="relative min-w-64 flex-1">
          <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            className="field w-full pr-10"
            placeholder="ابحث بالاسم أو الهاتف أو الرقم الضريبي…"
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1); }}
          />
        </label>
        <select className="field" value={active} onChange={(e) => { setActive(e.target.value as typeof active); setPage(1); }}>
          <option value="true">النشطون</option>
          <option value="false">المعطّلون</option>
          <option value="">الكل</option>
        </select>
        <select className="field" value={type} onChange={(e) => { setType(e.target.value); setPage(1); }}>
          <option value="">كل الأنواع</option>
          <option value="B2C">أفراد</option>
          <option value="B2B">شركات</option>
          <option value="B2G">حكومي</option>
        </select>
      </Toolbar>

      {list.isLoading ? (
        <LoadingState rows={8} />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : list.data!.data.length === 0 ? (
        <EmptyState title="لا يوجد عملاء مطابقون" body="جرّب تعديل البحث أو أضف عميلًا جديدًا." action={canCreate ? <Button onClick={openCreate}><Plus className="ml-1 h-4 w-4" /> عميل جديد</Button> : undefined} />
      ) : (
        <>
          <TableShell head={<tr><Th>العميل</Th><Th>الهاتف</Th><Th>النوع</Th><Th>حد الائتمان</Th><Th>الرصيد</Th><Th className="text-left">إجراءات</Th></tr>}>
            {list.data!.data.map((c) => (
              <tr key={c.id} className="hover:bg-slate-50/60">
                <Td>
                  <Link to={`/customers/${c.id}`} className="font-bold text-slate-800 hover:text-teal-700">{c.name}</Link>
                  {!c.isActive && <span className="mr-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">معطّل</span>}
                </Td>
                <Td><span dir="ltr" className="tabular-nums">{c.phone || "—"}</span></Td>
                <Td>{c.customerType}</Td>
                <Td><Money value={c.creditLimit} /></Td>
                <Td><Money value={c.derived?.arBalance ?? c.balance} className="font-bold" /></Td>
                <Td className="text-left">
                  <div className="flex items-center justify-end gap-1">
                    {canEdit && (
                      <button onClick={() => openEdit(c)} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="تعديل" title="تعديل">
                        <UserCog className="h-4 w-4" />
                      </button>
                    )}
                    <Link to={`/customers/${c.id}`} className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-bold text-slate-600 hover:bg-slate-50">360°</Link>
                  </div>
                </Td>
              </tr>
            ))}
          </TableShell>
          <Pagination
            page={page}
            totalPages={list.data!.pagination?.totalPages ?? 1}
            total={list.data!.pagination?.total ?? list.data!.data.length}
            onPage={setPage}
          />
        </>
      )}

      {formOpen && <CustomerForm open={formOpen} onClose={() => setFormOpen(false)} customer={editing} />}
    </div>
  );
}
