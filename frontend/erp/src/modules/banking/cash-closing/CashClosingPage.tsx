import { useState } from "react";
import { Plus, CheckCircle2 } from "lucide-react";
import {
  Button,
  Dialog,
  Input,
  Select,
  StatusBadge,
  PageHeader,
  useToast,
} from "@/shared/ui";
import { Field } from "@/shared/forms";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { useCan } from "@/app/providers";
import { formatDate } from "@/shared/lib";
import { useT } from "@/i18n";
import {
  useCashClosings,
  useCreateCashClosing,
  useApproveCashClosing,
  useCashBoxes,
  useCoaAccounts,
  todayISO,
  type CashClosing,
} from "../api";

const MANAGE = "banking.cashclose.manage" as const;

function money(n: number) {
  return (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function Money({ value, signed = false }: { value: number; signed?: boolean }) {
  const n = Number(value) || 0;
  const tone = !signed ? "text-slate-700" : Math.abs(n) < 0.005 ? "text-slate-400" : n > 0 ? "text-emerald-600" : "text-rose-600";
  return <span dir="ltr" className={`tabular-nums font-semibold ${tone}`}>{money(n)}</span>;
}

export function CashClosingPage() {
  const t = useT();
  const canManage = useCan(MANAGE);
  const list = useCashClosings();
  const [creating, setCreating] = useState(false);
  const [approving, setApproving] = useState<CashClosing | null>(null);
  const rows = list.data ?? [];
  const statusLabel = (status: string) => (status === "approved" ? t("status.approved") : t("status.draft"));

  const columns: ColumnDef<CashClosing>[] = [
    { id: "box", header: t("banking.shared.box"), accessor: (r) => r.cashboxName || r.cashboxId },
    { id: "date", header: t("banking.shared.date"), accessor: (r) => (r.closingDate ? formatDate(r.closingDate) : "—") },
    { id: "expected", header: t("banking.shared.expected"), accessor: (r) => r.expectedBalance, cell: (r) => <Money value={r.expectedBalance} />, numeric: true },
    { id: "counted", header: t("banking.shared.counted"), accessor: (r) => r.countedAmount, cell: (r) => <Money value={r.countedAmount} />, numeric: true },
    { id: "diff", header: t("banking.shared.difference"), accessor: (r) => r.difference, cell: (r) => <Money value={r.difference} signed />, numeric: true },
    {
      id: "status",
      header: t("common.status"),
      accessor: (r) => statusLabel(r.status),
      cell: (r) => <StatusBadge tone={r.status === "approved" ? "success" : "neutral"}>{statusLabel(r.status)}</StatusBadge>,
    },
    {
      id: "act",
      header: "",
      accessor: () => "",
      cell: (r) =>
        canManage && r.status !== "approved" ? (
          <Button variant="secondary" onClick={() => setApproving(r)}>
            <CheckCircle2 className="h-4 w-4" /> {t("banking.shared.approve")}
          </Button>
        ) : null,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow={t("banking.shared.eyebrow")}
        title={t("banking.cashClosing.title")}
        subtitle={t("banking.cashClosing.subtitle")}
        action={
          canManage ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> {t("banking.cashClosing.newBtn")}
            </Button>
          ) : undefined
        }
      />
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => list.refetch()}
        emptyTitle={t("banking.cashClosing.emptyTitle")}
        emptyBody={t("banking.cashClosing.emptyBody")}
      />
      {creating && <CreateClosingDialog onClose={() => setCreating(false)} />}
      {approving && <ApproveClosingDialog closing={approving} onClose={() => setApproving(null)} />}
    </div>
  );
}

function CreateClosingDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const boxes = useCashBoxes();
  const create = useCreateCashClosing();
  const { toast } = useToast();
  const [cashboxId, setCashboxId] = useState("");
  const [counted, setCounted] = useState("0");
  const [date, setDate] = useState(todayISO());
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  const box = (boxes.data ?? []).find((b) => b.id === cashboxId);
  const expected = box ? box.balance : 0;
  const diff = (Number(counted) || 0) - expected;

  function submit() {
    if (!cashboxId) { setError(t("banking.cashClosing.form.selectBox")); return; }
    setError(null);
    create.mutate(
      { cashboxId, closingDate: date, countedAmount: Number(counted) || 0, notes: notes || undefined },
      {
        onSuccess: (res) => {
          if (res && res.success === false) { setError(res.error || t("banking.shared.createFailed")); return; }
          toast({ tone: "success", title: t("banking.cashClosing.toast.created") });
          onClose();
        },
        onError: (e) => setError(e instanceof Error ? e.message : t("banking.shared.createFailed")),
      },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("banking.cashClosing.dialogTitle")}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={create.isPending}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending}>{t("banking.shared.create")}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t("banking.shared.box")} required>
          <Select value={cashboxId} onChange={(e) => setCashboxId(e.target.value)}>
            <option value="">{t("banking.shared.selectPlaceholder")}</option>
            {(boxes.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </Select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("banking.shared.date")}><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label={t("banking.cashClosing.countedAmount")} required><Input value={counted} dir="ltr" onChange={(e) => setCounted(e.target.value)} /></Field>
        </div>
        {cashboxId && (
          <div className="grid grid-cols-3 gap-2 rounded-xl bg-slate-50 px-4 py-3 text-center">
            <div><div className="text-[11px] font-bold text-slate-400">{t("banking.shared.expected")}</div><Money value={expected} /></div>
            <div><div className="text-[11px] font-bold text-slate-400">{t("banking.shared.counted")}</div><Money value={Number(counted) || 0} /></div>
            <div><div className="text-[11px] font-bold text-slate-400">{t("banking.shared.difference")}</div><Money value={diff} signed /></div>
          </div>
        )}
        <Field label={t("banking.shared.notes")}><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{error}</div>}
      </div>
    </Dialog>
  );
}

function ApproveClosingDialog({ closing, onClose }: { closing: CashClosing; onClose: () => void }) {
  const t = useT();
  const approve = useApproveCashClosing();
  const coa = useCoaAccounts(true);
  const { toast } = useToast();
  const [account, setAccount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const needsAccount = Math.abs(closing.difference) >= 0.01;
  const leaves = (coa.data ?? []).filter((a) => a.isLeaf);

  function submit() {
    if (needsAccount && !account) { setError(t("banking.cashClosing.selectDiffAccount")); return; }
    setError(null);
    approve.mutate(
      { id: closing.id, differenceAccountId: account || undefined },
      {
        onSuccess: (res) => {
          if (res && res.success === false) { setError(res.error || t("banking.shared.approveFailed")); return; }
          toast({ tone: "success", title: res.journalNumber ? t("banking.cashClosing.approvedWithJournal", { journal: res.journalNumber }) : t("banking.cashClosing.approved") });
          onClose();
        },
        onError: (e) => setError(e instanceof Error ? e.message : t("banking.shared.approveFailed")),
      },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("banking.cashClosing.approveTitle")}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={approve.isPending}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={submit} loading={approve.isPending}>{t("banking.shared.approveAndPost")}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-2 rounded-xl bg-slate-50 px-4 py-3 text-center">
          <div><div className="text-[11px] font-bold text-slate-400">{t("banking.shared.expected")}</div><Money value={closing.expectedBalance} /></div>
          <div><div className="text-[11px] font-bold text-slate-400">{t("banking.shared.counted")}</div><Money value={closing.countedAmount} /></div>
          <div><div className="text-[11px] font-bold text-slate-400">{t("banking.shared.difference")}</div><Money value={closing.difference} signed /></div>
        </div>
        {needsAccount ? (
          <Field label={t("banking.cashClosing.diffAccountLabel")} required>
            <Select value={account} onChange={(e) => setAccount(e.target.value)}>
              <option value="">{t("banking.shared.selectAccount")}</option>
              {leaves.map((a) => (
                <option key={a.id} value={a.id}>{a.code} — {a.nameAr}</option>
              ))}
            </Select>
          </Field>
        ) : (
          <p className="text-sm font-bold text-emerald-600">{t("banking.cashClosing.noDiff")}</p>
        )}
        {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{error}</div>}
      </div>
    </Dialog>
  );
}

export default CashClosingPage;
