import { useState } from "react";
import { Plus } from "lucide-react";
import { Button, PageHeader, ConfirmDialog } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatDate } from "@/shared/lib";
import { useCan } from "@/app/providers";
import {
  useReceipts,
  useApproveReceipt,
  useCancelReceipt,
  usePayments,
  useApprovePayment,
  useCancelPayment,
} from "../api";
import { Money, StatusPill, mapError } from "../components";
import { VoucherForm, VOUCHER_CREATE_CAP, type VoucherKind } from "../vouchers/VoucherForm";

// A normalized voucher row so one register renders both receipts and payments.
interface VoucherRow {
  id: string;
  number: string;
  date: string;
  party: string;
  partyKind: string;
  channel: string;
  amount: number;
  status: string;
  createdByName: string;
  hasManualGl: boolean;
}

type PendingAction = { kind: "approve" | "cancel"; row: VoucherRow } | null;

function VoucherRegister({
  kind,
  eyebrow,
  title,
  subtitle,
  partyHeader,
  amountTone,
  rows,
  isLoading,
  error,
  onRetry,
  approve,
  cancel,
}: {
  kind: VoucherKind;
  eyebrow: string;
  title: string;
  subtitle: string;
  partyHeader: string;
  amountTone: string;
  rows: VoucherRow[];
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  approve: (id: string, cb: { onDone: () => void; onError: (m: string) => void }) => void;
  cancel: (id: string, cb: { onDone: () => void; onError: (m: string) => void }) => void;
}) {
  const canCreate = useCan(VOUCHER_CREATE_CAP);
  const [formOpen, setFormOpen] = useState(false);
  const [pending, setPending] = useState<PendingAction>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  function run(reason: string) {
    void reason;
    if (!pending) return;
    setBusy(true);
    setActionError(null);
    const done = () => {
      setBusy(false);
      setPending(null);
    };
    const fail = (m: string) => {
      setBusy(false);
      setActionError(m);
    };
    if (pending.kind === "approve") approve(pending.row.id, { onDone: done, onError: fail });
    else cancel(pending.row.id, { onDone: done, onError: fail });
  }

  const columns: ColumnDef<VoucherRow>[] = [
    { id: "number", header: "الرقم", accessor: (r) => r.number, sortable: true },
    {
      id: "date",
      header: "التاريخ",
      accessor: (r) => r.date,
      cell: (r) => <span dir="ltr" className="tabular-nums text-slate-600">{formatDate(r.date)}</span>,
    },
    {
      id: "party",
      header: partyHeader,
      accessor: (r) => r.party,
      cell: (r) => (
        <span>
          <span className="font-semibold text-slate-800">{r.party || "—"}</span>{" "}
          <span className="text-[11px] text-slate-400">({r.partyKind})</span>
        </span>
      ),
    },
    { id: "channel", header: "المصدر/الوجهة", accessor: (r) => r.channel },
    {
      id: "amount",
      header: "المبلغ",
      numeric: true,
      accessor: (r) => r.amount,
      cell: (r) => <Money value={r.amount} tone={amountTone} />,
    },
    { id: "createdBy", header: "المُنشئ", accessor: (r) => r.createdByName || "—", defaultHidden: true },
    {
      id: "status",
      header: "الحالة",
      accessor: (r) => r.status,
      cell: (r) => <StatusPill status={r.status} />,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow={eyebrow}
        title={title}
        subtitle={subtitle}
        action={
          canCreate ? (
            <Button variant="primary" onClick={() => setFormOpen(true)}>
              <Plus className="h-4 w-4" /> سند جديد
            </Button>
          ) : undefined
        }
      />

      {canCreate && (
        <VoucherForm kind={kind} open={formOpen} onClose={() => setFormOpen(false)} />
      )}

      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        loading={isLoading}
        error={error}
        onRetry={onRetry}
        searchable
        searchPlaceholder="بحث بالرقم أو الطرف…"
        initialSort={{ columnId: "number", dir: "desc" }}
        emptyTitle="لا توجد سندات"
        rowActions={(r) =>
          r.status === "draft" ? (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="primary" onClick={() => { setActionError(null); setPending({ kind: "approve", row: r }); }}>
                اعتماد
              </Button>
              <Button size="sm" variant="secondary" onClick={() => { setActionError(null); setPending({ kind: "cancel", row: r }); }}>
                إلغاء
              </Button>
            </div>
          ) : null
        }
      />

      <ConfirmDialog
        open={!!pending}
        title={pending?.kind === "approve" ? "اعتماد السند" : "إلغاء السند"}
        description={
          pending?.kind === "approve"
            ? `سيتم اعتماد السند «${pending.row.number}» وترحيل القيد المحاسبي تلقائيًا.`
            : pending
              ? `سيتم إلغاء السند «${pending.row.number}».`
              : ""
        }
        tone={pending?.kind === "cancel" ? "danger" : "primary"}
        confirmLabel={pending?.kind === "approve" ? "اعتماد وترحيل" : "إلغاء السند"}
        cancelLabel="رجوع"
        processing={busy}
        error={actionError}
        onConfirm={run}
        onClose={() => setPending(null)}
      />
    </div>
  );
}

export function ReceiptsPage() {
  const listQuery = useReceipts();
  const approve = useApproveReceipt();
  const cancel = useCancelReceipt();
  const rows: VoucherRow[] = (listQuery.data ?? []).map((r) => ({
    id: r.id,
    number: r.receiptNumber,
    date: r.receiptDate,
    party: r.sourceName,
    partyKind: r.sourceType,
    channel: r.destinationType === "cash" ? "صندوق" : "بنك",
    amount: r.amount,
    status: r.status,
    createdByName: r.createdByName,
    hasManualGl: r.hasManualGl,
  }));

  return (
    <VoucherRegister
      kind="receipt"
      eyebrow="النقد والبنوك"
      title="سندات القبض"
      subtitle="متابعة سندات القبض واعتماد المسودات لترحيل قيودها المحاسبية."
      partyHeader="المصدر"
      amountTone="text-emerald-600"
      rows={rows}
      isLoading={listQuery.isLoading}
      error={listQuery.error}
      onRetry={() => listQuery.refetch()}
      approve={(id, cb) =>
        approve.mutate(id, {
          onSuccess: (res) => (res && res.success === false ? cb.onError(mapError(new Error(res.error))) : cb.onDone()),
          onError: (e) => cb.onError(mapError(e)),
        })
      }
      cancel={(id, cb) =>
        cancel.mutate(id, {
          onSuccess: (res) => (res && res.success === false ? cb.onError(mapError(new Error(res.error))) : cb.onDone()),
          onError: (e) => cb.onError(mapError(e)),
        })
      }
    />
  );
}

export function PaymentsPage() {
  const listQuery = usePayments();
  const approve = useApprovePayment();
  const cancel = useCancelPayment();
  const rows: VoucherRow[] = (listQuery.data ?? []).map((p) => ({
    id: p.id,
    number: p.paymentNumber,
    date: p.paymentDate,
    party: p.recipientName,
    partyKind: p.recipientType,
    channel: p.sourceType === "cash" ? "صندوق" : "بنك",
    amount: p.amount,
    status: p.status,
    createdByName: p.createdByName,
    hasManualGl: p.hasManualGl,
  }));

  return (
    <VoucherRegister
      kind="payment"
      eyebrow="النقد والبنوك"
      title="سندات الصرف"
      subtitle="متابعة سندات الصرف واعتماد المسودات لترحيل قيودها المحاسبية."
      partyHeader="المستفيد"
      amountTone="text-rose-600"
      rows={rows}
      isLoading={listQuery.isLoading}
      error={listQuery.error}
      onRetry={() => listQuery.refetch()}
      approve={(id, cb) =>
        approve.mutate(id, {
          onSuccess: (res) => (res && res.success === false ? cb.onError(mapError(new Error(res.error))) : cb.onDone()),
          onError: (e) => cb.onError(mapError(e)),
        })
      }
      cancel={(id, cb) =>
        cancel.mutate(id, {
          onSuccess: (res) => (res && res.success === false ? cb.onError(mapError(new Error(res.error))) : cb.onDone()),
          onError: (e) => cb.onError(mapError(e)),
        })
      }
    />
  );
}
