import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, PlusCircle, Receipt, Wallet, XCircle } from "lucide-react";
import {
  Button,
  ConfirmDialog,
  Drawer,
  ErrorState,
  IconButton,
  LoadingState,
  PageHeader,
  Select,
  StatusBadge,
  Tabs,
  safeUserMessage,
  useToast,
} from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatCurrency, formatDate } from "@/shared/lib";
import { useTx } from "@/shared/ui/i18n";
import { useAuth } from "@/app/providers";
import { peopleApi } from "../lib/api";
import { qk } from "../lib/query-keys";
import { statusMeta } from "../lib/labels";
import { CreateCustodyDialog } from "../components/custody/CreateCustodyDialog";
import { TopupDialog } from "../components/custody/TopupDialog";
import { ExpenseDialog } from "../components/custody/ExpenseDialog";
import { MyCustodyTab } from "../components/custody/MyCustodyTab";
import type { Custody, CustodyExpense } from "../lib/types";

// العهد — writes ported from BOTH legacy custody frontends:
//   • public/js/custody.js (admin): إنشاء عهدة، تغذية (with the GL cash/bank
//     picker), اعتماد/رفض المصروف، موافقة التجاوز، اعتماد/رفض الإقفال.
//   • public/custody/app.js (holder portal): تسجيل مصروف على عهدتي + طلب إقفال
//     + سجل العهد — the «عهدتي» tab.
// Visibility mirrors the SERVER's authorization exactly (routes/custody.js):
// the mount allows admin/manager/custody; inside, decision endpoints require
// admin/manager (_custodyRequireAdmin) while holder endpoints verify ownership.
// So: admin/manager see the management tabs; the custody role sees «عهدتي».

type TabKey = "mine" | "custodies" | "expenses" | "approvals";

export function CustodyPage() {
  const t = useTx();
  const { user } = useAuth();
  const role = String(user?.role ?? "").toLowerCase();
  // Mirror routes/custody.js _isAdmin (admin|manager) — NOT the UI-wide
  // developer bypass: the server refuses other roles on decision endpoints.
  const isAdmin = role === "admin" || role === "manager";
  const isHolder = role === "custody";

  const tabs = useMemo(() => {
    const items: { value: TabKey; label: string }[] = [];
    if (isHolder) items.push({ value: "mine", label: t("people.custody.tabs.mine") });
    if (isAdmin) {
      items.push({ value: "custodies", label: t("people.custody.tabs.custodies") });
      items.push({ value: "expenses", label: t("people.custody.tabs.expenses") });
      items.push({ value: "approvals", label: t("people.custody.tabs.approvals") });
    }
    // Any other role that reaches the page (nav is capability-gated) gets the
    // read tabs; the server answers 403 and <ErrorState> surfaces it honestly.
    if (!items.length) {
      items.push({ value: "custodies", label: t("people.custody.tabs.custodies") });
      items.push({ value: "expenses", label: t("people.custody.tabs.expenses") });
    }
    return items;
  }, [isAdmin, isHolder, t]);

  const [tab, setTab] = useState<TabKey>(tabs[0].value);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={t("people.eyebrow")}
        title={t("people.custody.title")}
        subtitle={isHolder ? t("people.custody.subtitleHolder") : t("people.custody.subtitleAdmin")}
      />
      <Tabs items={tabs} value={tab} onChange={(v) => setTab(v as TabKey)} aria-label={t("people.custody.tabsAria")} />
      {tab === "mine" && <MyCustodyTab />}
      {tab === "custodies" && <CustodiesTab canManage={isAdmin} />}
      {tab === "expenses" && <ExpensesTab />}
      {tab === "approvals" && isAdmin && <ApprovalsTab />}
    </div>
  );
}

// ── العُهد (admin list + create/topup/expense row actions) ────────────────────
function CustodiesTab({ canManage }: { canManage: boolean }) {
  const t = useTx();
  const [detailId, setDetailId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [topupFor, setTopupFor] = useState<Custody | null>(null);
  const [expenseFor, setExpenseFor] = useState<Custody | null>(null);

  const query = useQuery({ queryKey: qk.custodies(), queryFn: ({ signal }) => peopleApi.listCustodies(signal) });

  // GL expense accounts for the admin-side expense dialog (the holder tab gets
  // them from /custody/my-custody; the admin reads the chart directly).
  const glAccounts = useQuery({
    queryKey: qk.glAccounts(),
    queryFn: ({ signal }) => peopleApi.listGlAccounts(signal),
    enabled: canManage && !!expenseFor,
  });
  const expenseAccounts = (glAccounts.data ?? [])
    .filter((a) => a.type === "expense")
    .map((a) => ({ id: a.id, code: a.code, name: a.nameAr }));

  const columns: ColumnDef<Custody>[] = [
    { id: "custodyNumber", header: t("people.custody.col.custodyNumber"), accessor: (r) => r.custodyNumber, sortable: true },
    { id: "userName", header: t("people.custody.col.holder"), accessor: (r) => r.userName || "—", sortable: true },
    { id: "balance", header: t("people.custody.col.balance"), accessor: (r) => r.balance, cell: (r) => formatCurrency(r.balance), numeric: true, sortable: true },
    { id: "totalTopups", header: t("people.custody.col.topups"), accessor: (r) => r.totalTopups, cell: (r) => formatCurrency(r.totalTopups), numeric: true },
    { id: "totalExpenses", header: t("people.custody.col.expenses"), accessor: (r) => r.totalExpenses, cell: (r) => formatCurrency(r.totalExpenses), numeric: true },
    {
      id: "createdDate",
      header: t("people.custody.col.openedDate"),
      accessor: (r) => r.createdDate ?? "",
      cell: (r) => formatDate(r.createdDate),
    },
    {
      id: "status",
      header: t("common.status"),
      accessor: (r) => r.status,
      cell: (r) => {
        const m = statusMeta(r.status, t);
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
        searchPlaceholder={t("people.custody.searchCustodies")}
        emptyTitle={t("people.custody.emptyCustodies")}
        exportFilename="custodies.csv"
        onRowClick={(r) => setDetailId(r.id)}
        toolbarActions={
          canManage ? (
            <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
              <Wallet className="h-4 w-4" aria-hidden="true" /> {t("people.custody.createBtn")}
            </Button>
          ) : undefined
        }
        rowActions={
          canManage
            ? (r) => (
                <div className="flex items-center gap-1">
                  <IconButton
                    aria-label={t("people.custody.aria.topup")}
                    title={t("people.custody.aria.topup")}
                    size="sm"
                    variant="ghost"
                    onClick={() => setTopupFor(r)}
                  >
                    <PlusCircle className="h-4 w-4" />
                  </IconButton>
                  <IconButton
                    aria-label={t("people.custody.aria.addExpense")}
                    title={t("people.custody.aria.addExpense")}
                    size="sm"
                    variant="ghost"
                    onClick={() => setExpenseFor(r)}
                  >
                    <Receipt className="h-4 w-4" />
                  </IconButton>
                </div>
              )
            : undefined
        }
      />

      <CustodyDetailDrawer id={detailId} onClose={() => setDetailId(null)} />
      {canManage && (
        <>
          <CreateCustodyDialog open={createOpen} onClose={() => setCreateOpen(false)} />
          <TopupDialog custody={topupFor} onClose={() => setTopupFor(null)} />
          <ExpenseDialog
            custodyId={expenseFor?.id ?? null}
            expenseAccounts={expenseAccounts}
            open={!!expenseFor}
            onClose={() => setExpenseFor(null)}
          />
        </>
      )}
    </>
  );
}

function CustodyDetailDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const t = useTx();
  const query = useQuery({
    queryKey: qk.custody(id ?? ""),
    queryFn: ({ signal }) => peopleApi.custodyExpensesFor(id ?? "", signal),
    enabled: !!id,
  });

  return (
    <Drawer open={!!id} onClose={onClose} title={t("people.custody.detailTitle")} eyebrow={t("people.custody.detailEyebrow")}>
      {query.isLoading && <LoadingState rows={2} />}
      {query.error && <ErrorState error={query.error} onRetry={() => query.refetch()} />}
      {query.data && query.data.length === 0 && (
        <p className="text-sm font-medium text-slate-500">{t("people.custody.detailEmpty")}</p>
      )}
      {query.data && query.data.length > 0 && (
        <ul className="space-y-2">
          {query.data.map((e) => {
            const m = statusMeta(e.status, t);
            return (
              <li key={e.id} className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-extrabold text-slate-800">{e.description || "—"}</div>
                    <div className="mt-0.5 text-xs font-medium text-slate-500">{formatDate(e.expenseDate)}</div>
                  </div>
                  <div className="shrink-0 text-end">
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

// ── المصروفات (read/filter — unchanged) ───────────────────────────────────────
function ExpensesTab() {
  const t = useTx();
  const [status, setStatus] = useState("");
  const params = useMemo(() => (status ? { status } : {}), [status]);
  const query = useQuery({
    queryKey: qk.custodyExpenses(params),
    queryFn: ({ signal }) => peopleApi.listCustodyExpenses(params, signal),
  });

  const columns: ColumnDef<CustodyExpense>[] = [
    { id: "custodyNumber", header: t("people.custody.col.custody"), accessor: (r) => r.custodyNumber || "—", sortable: true },
    { id: "userName", header: t("people.custody.col.holder"), accessor: (r) => r.userName || "—" },
    { id: "description", header: t("people.custody.col.description"), accessor: (r) => r.description || "—" },
    { id: "expenseDate", header: t("people.field.date"), accessor: (r) => r.expenseDate, cell: (r) => formatDate(r.expenseDate), sortable: true },
    { id: "amount", header: t("people.field.amount"), accessor: (r) => r.amount, cell: (r) => formatCurrency(r.amount), numeric: true, sortable: true },
    { id: "vatAmount", header: t("people.custody.col.tax"), accessor: (r) => r.vatAmount, cell: (r) => formatCurrency(r.vatAmount), numeric: true, defaultHidden: true },
    { id: "totalWithVat", header: t("people.custody.col.total"), accessor: (r) => r.totalWithVat, cell: (r) => formatCurrency(r.totalWithVat), numeric: true },
    {
      id: "status",
      header: t("common.status"),
      accessor: (r) => r.status,
      cell: (r) => {
        const m = statusMeta(r.status, t);
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
      searchPlaceholder={t("people.custody.searchExpenses")}
      emptyTitle={t("people.custody.emptyExpenses")}
      exportFilename="custody-expenses.csv"
      filterBar={
        <label className="flex items-center gap-2 text-xs font-bold text-slate-500">
          {t("common.status")}
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="h-10 min-w-36"
            options={[
              { value: "", label: t("common.all") },
              { value: "pending", label: t("people.custody.expensesFilter.pending") },
              { value: "override_pending", label: t("people.custody.expensesFilter.overridePending") },
              { value: "returned", label: t("people.custody.expensesFilter.returned") },
              { value: "approved", label: t("people.custody.expensesFilter.approved") },
              { value: "posted", label: t("people.custody.expensesFilter.posted") },
              { value: "rejected", label: t("people.custody.expensesFilter.rejected") },
            ]}
          />
        </label>
      }
    />
  );
}

// ── الاعتمادات (admin decisions — expenses + close requests) ──────────────────
type ExpDecision = { kind: "approve" | "reject" | "approve-override"; exp: CustodyExpense } | null;
type CloseDecision = { kind: "approve" | "reject"; custody: Custody } | null;

function ApprovalsTab() {
  const t = useTx();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [expDecision, setExpDecision] = useState<ExpDecision>(null);
  const [closeDecision, setCloseDecision] = useState<CloseDecision>(null);

  const pending = useQuery({
    queryKey: qk.custodyPending(),
    queryFn: ({ signal }) => peopleApi.listCustodyPending(signal),
  });
  const custodies = useQuery({ queryKey: qk.custodies(), queryFn: ({ signal }) => peopleApi.listCustodies(signal) });

  const invalidate = () => void qc.invalidateQueries({ queryKey: [...qk.all, "custody"] });

  const decideExpense = useMutation({
    mutationFn: (v: { kind: NonNullable<ExpDecision>["kind"]; id: string; reason: string }) =>
      v.kind === "approve"
        ? peopleApi.approveCustodyExpense(v.id)
        : v.kind === "approve-override"
          ? peopleApi.approveOverrideExpense(v.id)
          : peopleApi.rejectCustodyExpense(v.id, v.reason),
    onSuccess: (_r, v) => {
      toast({
        title:
          v.kind === "approve"
            ? t("people.custody.approvals.expApproveToast")
            : v.kind === "approve-override"
              ? t("people.custody.approvals.expOverrideToast")
              : t("people.custody.approvals.expRejectToast"),
        tone: "success",
      });
      setExpDecision(null);
      invalidate();
    },
    onError: (e) => toast({ title: t("people.toast.actionFailed"), description: safeUserMessage(e, t), tone: "error" }),
  });

  const decideClose = useMutation({
    mutationFn: (v: { kind: NonNullable<CloseDecision>["kind"]; id: string; reason: string }) =>
      v.kind === "approve" ? peopleApi.approveCloseCustody(v.id) : peopleApi.rejectCloseCustody(v.id, v.reason),
    onSuccess: (_r, v) => {
      toast({ title: v.kind === "approve" ? t("people.custody.approvals.closeApproveToast") : t("people.custody.approvals.closeRejectToast"), tone: "success" });
      setCloseDecision(null);
      invalidate();
    },
    onError: (e) => toast({ title: t("people.toast.actionFailed"), description: safeUserMessage(e, t), tone: "error" }),
  });

  // Only the statuses a manager can act on here (the endpoint also returns
  // 'approved' rows for the GL-posting screen — not this tab's decision).
  const actionable = (pending.data ?? []).filter((e) => e.status === "pending" || e.status === "override_pending");
  const closeRequests = (custodies.data ?? []).filter((c) => c.status === "close_pending");

  const expColumns: ColumnDef<CustodyExpense>[] = [
    { id: "custodyNumber", header: t("people.custody.col.custody"), accessor: (r) => r.custodyNumber || "—" },
    { id: "userName", header: t("people.custody.col.holder"), accessor: (r) => r.userName || "—" },
    { id: "description", header: t("people.custody.col.statement"), accessor: (r) => r.description || "—" },
    { id: "glAccountName", header: t("people.custody.col.glType"), accessor: (r) => r.glAccountName || "—", defaultHidden: true },
    { id: "expenseDate", header: t("people.field.date"), accessor: (r) => r.expenseDate, cell: (r) => formatDate(r.expenseDate), sortable: true },
    { id: "totalWithVat", header: t("people.custody.col.total"), accessor: (r) => r.totalWithVat, cell: (r) => formatCurrency(r.totalWithVat), numeric: true, sortable: true },
    {
      id: "status",
      header: t("common.status"),
      accessor: (r) => r.status,
      cell: (r) => {
        const m = statusMeta(r.status, t);
        return <StatusBadge tone={m.tone}>{m.label}</StatusBadge>;
      },
    },
  ];

  const closeColumns: ColumnDef<Custody>[] = [
    { id: "custodyNumber", header: t("people.custody.col.custody"), accessor: (r) => r.custodyNumber },
    { id: "userName", header: t("people.custody.col.holder"), accessor: (r) => r.userName || "—" },
    { id: "totalTopups", header: t("people.custody.col.topupsTotal"), accessor: (r) => r.totalTopups, cell: (r) => formatCurrency(r.totalTopups), numeric: true },
    { id: "totalExpenses", header: t("people.custody.col.expenses"), accessor: (r) => r.totalExpenses, cell: (r) => formatCurrency(r.totalExpenses), numeric: true },
    { id: "balance", header: t("people.custody.col.remainingBalance"), accessor: (r) => r.balance, cell: (r) => formatCurrency(r.balance), numeric: true },
  ];

  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-3 text-sm font-extrabold text-slate-800">{t("people.custody.approvals.expensesTitle", { count: actionable.length })}</h3>
        <DataTable
          columns={expColumns}
          rows={actionable}
          getRowId={(r) => r.id}
          loading={pending.isLoading}
          error={pending.error}
          onRetry={() => pending.refetch()}
          tableId="people.custodyApprovals"
          emptyTitle={t("people.custody.approvals.expensesEmpty")}
          rowActions={(r) => (
            <div className="flex items-center gap-1">
              <IconButton
                aria-label={r.status === "override_pending" ? t("people.custody.aria.approveOverride") : t("people.custody.aria.approve")}
                title={r.status === "override_pending" ? t("people.custody.aria.approveOverride") : t("people.custody.aria.approve")}
                size="sm"
                variant="ghost"
                onClick={() =>
                  setExpDecision({ kind: r.status === "override_pending" ? "approve-override" : "approve", exp: r })
                }
              >
                <CheckCircle2 className="h-4 w-4" />
              </IconButton>
              <IconButton
                aria-label={t("people.custody.aria.reject")}
                title={t("people.custody.aria.reject")}
                size="sm"
                variant="danger"
                onClick={() => setExpDecision({ kind: "reject", exp: r })}
              >
                <XCircle className="h-4 w-4" />
              </IconButton>
            </div>
          )}
        />
      </section>

      <section>
        <h3 className="mb-3 text-sm font-extrabold text-slate-800">{t("people.custody.approvals.closeTitle", { count: closeRequests.length })}</h3>
        <DataTable
          columns={closeColumns}
          rows={closeRequests}
          getRowId={(r) => r.id}
          loading={custodies.isLoading}
          error={custodies.error}
          onRetry={() => custodies.refetch()}
          tableId="people.custodyCloseRequests"
          emptyTitle={t("people.custody.approvals.closeEmpty")}
          rowActions={(r) => (
            <div className="flex items-center gap-1">
              <IconButton
                aria-label={t("people.custody.aria.approveClose")}
                title={t("people.custody.aria.approveClose")}
                size="sm"
                variant="ghost"
                onClick={() => setCloseDecision({ kind: "approve", custody: r })}
              >
                <CheckCircle2 className="h-4 w-4" />
              </IconButton>
              <IconButton
                aria-label={t("people.custody.aria.rejectClose")}
                title={t("people.custody.aria.rejectClose")}
                size="sm"
                variant="danger"
                onClick={() => setCloseDecision({ kind: "reject", custody: r })}
              >
                <XCircle className="h-4 w-4" />
              </IconButton>
            </div>
          )}
        />
      </section>

      {/* Expense decision — reject requires a reason (legacy prompt). */}
      <ConfirmDialog
        open={!!expDecision}
        title={
          expDecision?.kind === "approve"
            ? t("people.custody.approvals.expApproveConfirm")
            : expDecision?.kind === "approve-override"
              ? t("people.custody.approvals.expOverrideConfirm")
              : t("people.custody.approvals.expRejectConfirm")
        }
        description={
          expDecision
            ? `${expDecision.exp.custodyNumber || ""} — ${expDecision.exp.description || ""} (${formatCurrency(expDecision.exp.totalWithVat)})` +
              (expDecision.kind === "approve-override" ? t("people.custody.approvals.overrideMoveNote") : "")
            : ""
        }
        tone={expDecision?.kind === "reject" ? "danger" : "primary"}
        requireReason={expDecision?.kind === "reject"}
        reasonLabel={t("people.custody.approvals.rejectReasonLabel")}
        processing={decideExpense.isPending}
        onClose={() => setExpDecision(null)}
        onConfirm={(reason) =>
          expDecision && decideExpense.mutate({ kind: expDecision.kind, id: expDecision.exp.id, reason })
        }
      />

      {/* Close-request decision — reject requires a reason (legacy prompt). */}
      <ConfirmDialog
        open={!!closeDecision}
        title={closeDecision?.kind === "approve" ? t("people.custody.approvals.closeApproveConfirm") : t("people.custody.approvals.closeRejectConfirm")}
        description={
          closeDecision
            ? t("people.custody.approvals.closeDesc", {
                number: closeDecision.custody.custodyNumber,
                holder: closeDecision.custody.userName,
                balance: formatCurrency(closeDecision.custody.balance),
              })
            : ""
        }
        tone={closeDecision?.kind === "reject" ? "danger" : "primary"}
        requireReason={closeDecision?.kind === "reject"}
        reasonLabel={t("people.custody.approvals.rejectCloseReasonLabel")}
        processing={decideClose.isPending}
        onClose={() => setCloseDecision(null)}
        onConfirm={(reason) =>
          closeDecision && decideClose.mutate({ kind: closeDecision.kind, id: closeDecision.custody.id, reason })
        }
      />
    </div>
  );
}
