import { useState } from "react";
import { Plus } from "lucide-react";
import { Button, PageHeader, ConfirmDialog } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatDate } from "@/shared/lib";
import { useT, translateApiError } from "@/i18n";
import { useCan } from "@/app/providers";
import {
  useReceipts,
  useApproveReceipt,
  useCancelReceipt,
  usePayments,
  useApprovePayment,
  useCancelPayment,
} from "../api";
import { Money, StatusPill } from "../components";
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
  const t = useT();
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
    { id: "number", header: t("banking.shared.number"), accessor: (r) => r.number, sortable: true },
    {
      id: "date",
      header: t("banking.shared.date"),
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
    { id: "channel", header: t("banking.vouchers.channel"), accessor: (r) => r.channel },
    {
      id: "amount",
      header: t("banking.shared.amount"),
      numeric: true,
      accessor: (r) => r.amount,
      cell: (r) => <Money value={r.amount} tone={amountTone} />,
    },
    { id: "createdBy", header: t("banking.vouchers.createdBy"), accessor: (r) => r.createdByName || "—", defaultHidden: true },
    {
      id: "status",
      header: t("common.status"),
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
              <Plus className="h-4 w-4" /> {t("banking.vouchers.newBtn")}
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
        searchPlaceholder={t("banking.vouchers.searchPlaceholder")}
        initialSort={{ columnId: "number", dir: "desc" }}
        emptyTitle={t("banking.vouchers.emptyTitle")}
        rowActions={(r) =>
          r.status === "draft" ? (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="primary" onClick={() => { setActionError(null); setPending({ kind: "approve", row: r }); }}>
                {t("banking.shared.approve")}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => { setActionError(null); setPending({ kind: "cancel", row: r }); }}>
                {t("common.cancel")}
              </Button>
            </div>
          ) : null
        }
      />

      <ConfirmDialog
        open={!!pending}
        title={pending?.kind === "approve" ? t("banking.vouchers.approveTitle") : t("banking.vouchers.cancelTitle")}
        description={
          pending?.kind === "approve"
            ? t("banking.vouchers.approveDesc", { number: pending.row.number })
            : pending
              ? t("banking.vouchers.cancelDesc", { number: pending.row.number })
              : ""
        }
        tone={pending?.kind === "cancel" ? "danger" : "primary"}
        confirmLabel={pending?.kind === "approve" ? t("banking.shared.approveAndPost") : t("banking.vouchers.cancelTitle")}
        cancelLabel={t("common.back")}
        processing={busy}
        error={actionError}
        onConfirm={run}
        onClose={() => setPending(null)}
      />
    </div>
  );
}

export function ReceiptsPage() {
  const t = useT();
  const listQuery = useReceipts();
  const approve = useApproveReceipt();
  const cancel = useCancelReceipt();
  const rows: VoucherRow[] = (listQuery.data ?? []).map((r) => ({
    id: r.id,
    number: r.receiptNumber,
    date: r.receiptDate,
    party: r.sourceName,
    partyKind: r.sourceType,
    channel: r.destinationType === "cash" ? t("banking.shared.cashLabel") : t("banking.shared.bankLabel"),
    amount: r.amount,
    status: r.status,
    createdByName: r.createdByName,
    hasManualGl: r.hasManualGl,
  }));

  return (
    <VoucherRegister
      kind="receipt"
      eyebrow={t("banking.shared.eyebrow")}
      title={t("banking.receipts.title")}
      subtitle={t("banking.receipts.subtitle")}
      partyHeader={t("banking.shared.source")}
      amountTone="text-emerald-600"
      rows={rows}
      isLoading={listQuery.isLoading}
      error={listQuery.error}
      onRetry={() => listQuery.refetch()}
      approve={(id, cb) =>
        approve.mutate(id, {
          onSuccess: (res) => (res && res.success === false ? cb.onError(translateApiError(new Error(res.error), t)) : cb.onDone()),
          onError: (e) => cb.onError(translateApiError(e, t)),
        })
      }
      cancel={(id, cb) =>
        cancel.mutate(id, {
          onSuccess: (res) => (res && res.success === false ? cb.onError(translateApiError(new Error(res.error), t)) : cb.onDone()),
          onError: (e) => cb.onError(translateApiError(e, t)),
        })
      }
    />
  );
}

export function PaymentsPage() {
  const t = useT();
  const listQuery = usePayments();
  const approve = useApprovePayment();
  const cancel = useCancelPayment();
  const rows: VoucherRow[] = (listQuery.data ?? []).map((p) => ({
    id: p.id,
    number: p.paymentNumber,
    date: p.paymentDate,
    party: p.recipientName,
    partyKind: p.recipientType,
    channel: p.sourceType === "cash" ? t("banking.shared.cashLabel") : t("banking.shared.bankLabel"),
    amount: p.amount,
    status: p.status,
    createdByName: p.createdByName,
    hasManualGl: p.hasManualGl,
  }));

  return (
    <VoucherRegister
      kind="payment"
      eyebrow={t("banking.shared.eyebrow")}
      title={t("banking.payments.title")}
      subtitle={t("banking.payments.subtitle")}
      partyHeader={t("banking.shared.beneficiary")}
      amountTone="text-rose-600"
      rows={rows}
      isLoading={listQuery.isLoading}
      error={listQuery.error}
      onRetry={() => listQuery.refetch()}
      approve={(id, cb) =>
        approve.mutate(id, {
          onSuccess: (res) => (res && res.success === false ? cb.onError(translateApiError(new Error(res.error), t)) : cb.onDone()),
          onError: (e) => cb.onError(translateApiError(e, t)),
        })
      }
      cancel={(id, cb) =>
        cancel.mutate(id, {
          onSuccess: (res) => (res && res.success === false ? cb.onError(translateApiError(new Error(res.error), t)) : cb.onDone()),
          onError: (e) => cb.onError(translateApiError(e, t)),
        })
      }
    />
  );
}
