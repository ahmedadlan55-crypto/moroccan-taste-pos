import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, Plus, Wallet } from "lucide-react";
import {
  Card,
  Button,
  DetailStat,
  Dialog,
  ErrorState,
  LoadingState,
  StatusBadge,
  safeUserMessage,
  useToast,
} from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatCurrency, formatDate } from "@/shared/lib";
import { peopleApi } from "../../lib/api";
import { qk } from "../../lib/query-keys";
import { statusMeta } from "../../lib/labels";
import { ExpenseDialog } from "./ExpenseDialog";
import type { CustodyExpense, MyCustodyHistoryRow } from "../../lib/types";

// عهدتي — the custody-holder view, port of the standalone /custody portal
// (public/custody/app.js): my active custody bundle (GET /custody/my-custody),
// submit an expense against MY OWN custody (the server verifies ownership),
// request closure (POST /custody/:id/close-request), and the previous-custodies
// history (GET /custody/my-history — legacy loadHistory).

export function MyCustodyTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeNotes, setCloseNotes] = useState("");

  const bundle = useQuery({ queryKey: qk.myCustody(), queryFn: ({ signal }) => peopleApi.myCustody(signal) });
  const history = useQuery({
    queryKey: qk.myCustodyHistory(),
    queryFn: ({ signal }) => peopleApi.myCustodyHistory(signal),
  });

  const requestClose = useMutation({
    mutationFn: () => peopleApi.requestCloseCustody(bundle.data?.custody?.id as string, closeNotes.trim()),
    onSuccess: () => {
      toast({ title: "تم إرسال طلب الإقفال — بانتظار موافقة المدير", tone: "success" });
      setCloseOpen(false);
      setCloseNotes("");
      void qc.invalidateQueries({ queryKey: [...qk.all, "custody"] });
    },
    onError: (e) => toast({ title: "تعذّر إرسال طلب الإقفال", description: safeUserMessage(e), tone: "error" }),
  });

  if (bundle.isLoading) return <LoadingState rows={4} />;
  if (bundle.error) return <ErrorState error={bundle.error} onRetry={() => bundle.refetch()} />;

  const data = bundle.data;
  if (!data || data.error || !data.custody) {
    return (
      <Card className="p-6 text-center">
        <Wallet className="mx-auto h-8 w-8 text-slate-300" aria-hidden="true" />
        <p className="mt-2 text-sm font-bold text-slate-600">{data?.error || "لا توجد عهدة مرتبطة بحسابك"}</p>
      </Card>
    );
  }

  const c = data.custody;
  const active = c.status === "active";
  const meta = statusMeta(c.status);
  const expenses = data.expenses ?? [];

  const columns: ColumnDef<CustodyExpense>[] = [
    { id: "description", header: "البيان", accessor: (r) => r.description || "—" },
    { id: "glAccountName", header: "النوع", accessor: (r) => r.glAccountName || "—", defaultHidden: true },
    { id: "expenseDate", header: "التاريخ", accessor: (r) => r.expenseDate, cell: (r) => formatDate(r.expenseDate), sortable: true },
    { id: "totalWithVat", header: "الإجمالي", accessor: (r) => r.totalWithVat, cell: (r) => formatCurrency(r.totalWithVat), numeric: true, sortable: true },
    {
      id: "status",
      header: "الحالة",
      accessor: (r) => r.status,
      cell: (r) => {
        const m = statusMeta(r.status);
        return <StatusBadge tone={m.tone}>{m.label}</StatusBadge>;
      },
    },
    { id: "rejectionReason", header: "سبب الرفض/الإرجاع", accessor: (r) => r.rejectionReason || "—", defaultHidden: true },
  ];

  const historyColumns: ColumnDef<MyCustodyHistoryRow>[] = [
    { id: "custodyNumber", header: "رقم العهدة", accessor: (r) => r.custodyNumber },
    { id: "createdDate", header: "فُتحت", accessor: (r) => r.createdDate ?? "", cell: (r) => formatDate(r.createdDate) },
    { id: "closeApprovedAt", header: "أُغلقت", accessor: (r) => r.closeApprovedAt ?? "", cell: (r) => (r.closeApprovedAt ? formatDate(r.closeApprovedAt) : "—") },
    { id: "totalTopups", header: "التغذية", accessor: (r) => r.totalTopups, cell: (r) => formatCurrency(r.totalTopups), numeric: true },
    { id: "totalExpenses", header: "المصروفات", accessor: (r) => r.totalExpenses, cell: (r) => formatCurrency(r.totalExpenses), numeric: true },
    { id: "balance", header: "الرصيد", accessor: (r) => r.balance, cell: (r) => formatCurrency(r.balance), numeric: true },
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

  const previous = (history.data ?? []).filter((h) => h.id !== c.id);

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-extrabold text-slate-900">عهدتي — {c.custodyNumber}</h2>
              <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
            </div>
            <p className="mt-0.5 text-xs font-medium text-slate-500">
              {c.userName}
              {data.branchName ? ` — ${data.branchName}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="sm" disabled={!active} onClick={() => setExpenseOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" /> تسجيل مصروف
            </Button>
            <Button variant="secondary" size="sm" disabled={!active} onClick={() => setCloseOpen(true)}>
              <Lock className="h-4 w-4" aria-hidden="true" />
              {c.status === "close_pending" ? "بانتظار الإقفال" : c.status === "closed" ? "العهدة مغلقة" : "طلب إقفال العهدة"}
            </Button>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <DetailStat label="الرصيد" value={formatCurrency(c.balance)} />
          <DetailStat label="إجمالي التغذية" value={formatCurrency(c.totalTopups)} />
          <DetailStat label="إجمالي المصروفات" value={formatCurrency(c.totalExpenses)} />
        </div>
      </Card>

      <section>
        <h3 className="mb-3 text-sm font-extrabold text-slate-800">مصروفات العهدة ({expenses.length})</h3>
        <DataTable
          columns={columns}
          rows={expenses}
          getRowId={(r) => r.id}
          tableId="people.myCustodyExpenses"
          initialPageSize={10}
          emptyTitle="لا توجد مصروفات بعد"
        />
      </section>

      <section>
        <h3 className="mb-3 text-sm font-extrabold text-slate-800">عُهدي السابقة ({previous.length})</h3>
        <DataTable
          columns={historyColumns}
          rows={previous}
          getRowId={(r) => r.id}
          loading={history.isLoading}
          error={history.error}
          onRetry={() => history.refetch()}
          tableId="people.myCustodyHistory"
          initialPageSize={5}
          emptyTitle="لا توجد عهد سابقة"
        />
      </section>

      <ExpenseDialog
        custodyId={c.id}
        expenseAccounts={data.expenseAccounts ?? []}
        open={expenseOpen}
        onClose={() => setExpenseOpen(false)}
      />

      {/* طلب إقفال — the legacy requestClose/confirmClose summary + notes. */}
      <Dialog
        open={closeOpen}
        onClose={() => !requestClose.isPending && setCloseOpen(false)}
        title="طلب إقفال العهدة"
        description="يُرسل الطلب للمدير للاعتماد — تُقفل العهدة وتُسوّى الفروقات بعد الموافقة."
        dismissable={!requestClose.isPending}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCloseOpen(false)} disabled={requestClose.isPending}>
              إلغاء
            </Button>
            <Button variant="danger" loading={requestClose.isPending} onClick={() => requestClose.mutate()}>
              تأكيد طلب الإقفال
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="rounded-xl border border-slate-100 bg-slate-50 p-3 text-sm font-bold text-slate-700">
            <div className="flex justify-between"><span>إجمالي التغذية</span><span dir="ltr">{formatCurrency(c.totalTopups)}</span></div>
            <div className="mt-1 flex justify-between"><span>إجمالي المصروفات</span><span dir="ltr">{formatCurrency(c.totalExpenses)}</span></div>
            <div className="mt-1 flex justify-between border-t border-slate-200 pt-1">
              <span>الرصيد المتبقي</span>
              <span dir="ltr" className={c.balance >= 0 ? "text-emerald-700" : "text-rose-700"}>
                {formatCurrency(c.balance)}
              </span>
            </div>
          </div>
          {c.balance < 0 && (
            <p className="text-xs font-bold text-rose-700">
              تم تجاوز الرصيد — سيتم تسوية الفرق بعد الموافقة.
            </p>
          )}
          {c.balance > 0 && (
            <p className="text-xs font-bold text-emerald-700">
              سيتم استرجاع المبلغ المتبقي بعد الموافقة.
            </p>
          )}
          <label className="block">
            <span className="text-xs font-bold text-slate-600">ملاحظات (اختياري)</span>
            <textarea
              rows={3}
              className="field mt-1 w-full resize-y py-2"
              value={closeNotes}
              onChange={(e) => setCloseNotes(e.target.value)}
            />
          </label>
        </div>
      </Dialog>
    </div>
  );
}
