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
  const canManage = useCan(MANAGE);
  const list = useCashClosings();
  const [creating, setCreating] = useState(false);
  const [approving, setApproving] = useState<CashClosing | null>(null);
  const rows = list.data ?? [];

  const columns: ColumnDef<CashClosing>[] = [
    { id: "box", header: "الصندوق", accessor: (r) => r.cashboxName || r.cashboxId },
    { id: "date", header: "التاريخ", accessor: (r) => (r.closingDate ? formatDate(r.closingDate) : "—") },
    { id: "expected", header: "المتوقّع", accessor: (r) => r.expectedBalance, cell: (r) => <Money value={r.expectedBalance} />, numeric: true },
    { id: "counted", header: "المعدود", accessor: (r) => r.countedAmount, cell: (r) => <Money value={r.countedAmount} />, numeric: true },
    { id: "diff", header: "الفرق", accessor: (r) => r.difference, cell: (r) => <Money value={r.difference} signed />, numeric: true },
    {
      id: "status",
      header: "الحالة",
      accessor: (r) => (r.status === "approved" ? "معتمد" : "مسودة"),
      cell: (r) => <StatusBadge tone={r.status === "approved" ? "success" : "neutral"}>{r.status === "approved" ? "معتمد" : "مسودة"}</StatusBadge>,
    },
    {
      id: "act",
      header: "",
      accessor: () => "",
      cell: (r) =>
        canManage && r.status !== "approved" ? (
          <Button variant="secondary" onClick={() => setApproving(r)}>
            <CheckCircle2 className="h-4 w-4" /> اعتماد
          </Button>
        ) : null,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="النقد والبنوك"
        title="إقفال الصندوق"
        subtitle="سجّل المبلغ المعدود مقابل رصيد الدفتر، ورحّل قيد الفرق (عجز/زيادة) عند الاعتماد."
        action={
          canManage ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> إقفال جديد
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
        emptyTitle="لا عمليات إقفال"
        emptyBody="أنشئ عملية إقفال لصندوق."
      />
      {creating && <CreateClosingDialog onClose={() => setCreating(false)} />}
      {approving && <ApproveClosingDialog closing={approving} onClose={() => setApproving(null)} />}
    </div>
  );
}

function CreateClosingDialog({ onClose }: { onClose: () => void }) {
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
    if (!cashboxId) { setError("اختر الصندوق"); return; }
    setError(null);
    create.mutate(
      { cashboxId, closingDate: date, countedAmount: Number(counted) || 0, notes: notes || undefined },
      {
        onSuccess: (res) => {
          if (res && res.success === false) { setError(res.error || "تعذّر الإنشاء"); return; }
          toast({ tone: "success", title: "تم إنشاء الإقفال" });
          onClose();
        },
        onError: (e) => setError(e instanceof Error ? e.message : "تعذّر الإنشاء"),
      },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="إقفال صندوق جديد"
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={create.isPending}>إلغاء</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending}>إنشاء</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="الصندوق" required>
          <Select value={cashboxId} onChange={(e) => setCashboxId(e.target.value)}>
            <option value="">— اختر —</option>
            {(boxes.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </Select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="التاريخ"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="المبلغ المعدود" required><Input value={counted} dir="ltr" onChange={(e) => setCounted(e.target.value)} /></Field>
        </div>
        {cashboxId && (
          <div className="grid grid-cols-3 gap-2 rounded-xl bg-slate-50 px-4 py-3 text-center">
            <div><div className="text-[11px] font-bold text-slate-400">المتوقّع</div><Money value={expected} /></div>
            <div><div className="text-[11px] font-bold text-slate-400">المعدود</div><Money value={Number(counted) || 0} /></div>
            <div><div className="text-[11px] font-bold text-slate-400">الفرق</div><Money value={diff} signed /></div>
          </div>
        )}
        <Field label="ملاحظات"><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{error}</div>}
      </div>
    </Dialog>
  );
}

function ApproveClosingDialog({ closing, onClose }: { closing: CashClosing; onClose: () => void }) {
  const approve = useApproveCashClosing();
  const coa = useCoaAccounts(true);
  const { toast } = useToast();
  const [account, setAccount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const needsAccount = Math.abs(closing.difference) >= 0.01;
  const leaves = (coa.data ?? []).filter((a) => a.isLeaf);

  function submit() {
    if (needsAccount && !account) { setError("اختر حساب فروقات الصندوق"); return; }
    setError(null);
    approve.mutate(
      { id: closing.id, differenceAccountId: account || undefined },
      {
        onSuccess: (res) => {
          if (res && res.success === false) { setError(res.error || "تعذّر الاعتماد"); return; }
          toast({ tone: "success", title: res.journalNumber ? `تم الاعتماد — قيد ${res.journalNumber}` : "تم الاعتماد" });
          onClose();
        },
        onError: (e) => setError(e instanceof Error ? e.message : "تعذّر الاعتماد"),
      },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="اعتماد إقفال الصندوق"
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={approve.isPending}>إلغاء</Button>
          <Button variant="primary" onClick={submit} loading={approve.isPending}>اعتماد وترحيل</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-2 rounded-xl bg-slate-50 px-4 py-3 text-center">
          <div><div className="text-[11px] font-bold text-slate-400">المتوقّع</div><Money value={closing.expectedBalance} /></div>
          <div><div className="text-[11px] font-bold text-slate-400">المعدود</div><Money value={closing.countedAmount} /></div>
          <div><div className="text-[11px] font-bold text-slate-400">الفرق</div><Money value={closing.difference} signed /></div>
        </div>
        {needsAccount ? (
          <Field label="حساب فروقات الصندوق (عجز/زيادة)" required>
            <Select value={account} onChange={(e) => setAccount(e.target.value)}>
              <option value="">— اختر حسابًا —</option>
              {leaves.map((a) => (
                <option key={a.id} value={a.id}>{a.code} — {a.nameAr}</option>
              ))}
            </Select>
          </Field>
        ) : (
          <p className="text-sm font-bold text-emerald-600">لا فرق — سيُعتمد الإقفال دون قيد.</p>
        )}
        {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{error}</div>}
      </div>
    </Dialog>
  );
}

export default CashClosingPage;
