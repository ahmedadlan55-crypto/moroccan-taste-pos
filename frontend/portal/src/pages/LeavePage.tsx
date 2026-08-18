// الإجازات — balances, request history, and a new request.
//
// The balance guard lives on the SERVER and is transactional: my-leave-request
// locks the balance row FOR UPDATE and subtracts already-pending days before
// deciding (routes/hr.js:2532). This screen therefore does NOT pre-validate the
// balance — a client-side check would either duplicate that logic and drift, or
// pass a request the server is about to refuse for a reason the client cannot
// see (someone else's approval landing a second earlier). It validates only what
// it alone can know: that both dates are present and in order.
import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  Sheet,
  statusTone,
} from "@/components/ui";
import { useToast } from "@/components/Toasts";
import { useStatusLabel, useT } from "@/i18n";
import { useLeaveBalances, useLeaveRequests, useLeaveTypes, useSubmitLeave } from "@/lib/queries";
import { formatDate, formatNumber, toYmd } from "@/lib/format";

export function LeavePage() {
  const t = useT();
  const toast = useToast();
  const statusLabel = useStatusLabel();
  const balances = useLeaveBalances();
  const requests = useLeaveRequests();
  const [sheetOpen, setSheetOpen] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <Card title={t("leave.balances")}>
        {balances.isLoading ? (
          <LoadingState />
        ) : balances.isError ? (
          <ErrorState error={balances.error} onRetry={() => void balances.refetch()} />
        ) : (balances.data ?? []).length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="flex flex-col gap-3">
            {(balances.data ?? []).map((b, i) => {
              const entitled = Number(b.entitled_days ?? 0);
              const remaining = Number(b.remaining_days ?? 0);
              // Guard the divide: an entitlement of 0 must render an empty bar,
              // not NaN% width (which silently collapses the element).
              const pct = entitled > 0 ? Math.max(0, Math.min(100, (remaining / entitled) * 100)) : 0;
              return (
                <li key={String(b.leave_type_id ?? i)}>
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate text-xs font-extrabold text-slate-700">
                      {b.leaveTypeName || b.name || "—"}
                    </span>
                    <span className="num shrink-0 text-xs font-extrabold text-slate-900">
                      {formatNumber(remaining)}
                      <span className="text-slate-400"> / {formatNumber(entitled)}</span>
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full rounded-full bg-teal-500" style={{ width: `${pct}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card
        title={t("leave.myRequests")}
        bodyClassName="px-0 py-0"
        action={
          <Button
            variant="secondary"
            onClick={() => setSheetOpen(true)}
            className="min-h-9 px-2.5 text-[11px]"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {t("leave.newRequest")}
          </Button>
        }
      >
        {requests.isLoading ? (
          <LoadingState />
        ) : requests.isError ? (
          <ErrorState error={requests.error} onRetry={() => void requests.refetch()} />
        ) : (requests.data ?? []).length === 0 ? (
          <EmptyState message={t("leave.noRequests")} />
        ) : (
          <ul>
            {(requests.data ?? []).map((r) => (
              <li
                key={String(r.id)}
                className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-extrabold text-slate-800">
                    {r.leaveTypeName || "—"}
                  </p>
                  <p className="num mt-0.5 text-[11px] font-bold text-slate-400">
                    {formatDate(r.start_date)} → {formatDate(r.end_date)} ·{" "}
                    {formatNumber(r.days_count)} {t("common.days")}
                  </p>
                </div>
                <Badge tone={statusTone(r.status)}>{statusLabel(r.status)}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <LeaveRequestSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onSubmitted={() => {
          setSheetOpen(false);
          toast.success(t("leave.submitted"));
        }}
      />
    </div>
  );
}

function LeaveRequestSheet({
  open,
  onClose,
  onSubmitted,
}: {
  open: boolean;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const t = useT();
  const toast = useToast();
  // Only fetch the type list once the sheet is actually opened — most sessions
  // never open it, and this is a phone on a restaurant's Wi-Fi.
  const types = useLeaveTypes(open);
  const submit = useSubmitLeave();

  const today = useMemo(() => toYmd(new Date()), []);
  const [typeId, setTypeId] = useState("");
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(today);
  const [reason, setReason] = useState("");

  async function onSubmit() {
    if (!typeId) {
      toast.error(t("leave.pickType"));
      return;
    }
    if (end < start) {
      toast.error(t("leave.invalidRange"));
      return;
    }
    try {
      await submit.mutateAsync({ leaveTypeId: typeId, startDate: start, endDate: end, reason });
      setReason("");
      onSubmitted();
    } catch (err) {
      // The server's refusal text carries the real reason — including the exact
      // remaining balance after pending requests. Show it verbatim.
      toast.error(err instanceof Error && err.message ? err.message : t("common.offline"));
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t("leave.newRequest")}
      footer={
        <Button block loading={submit.isPending} onClick={() => void onSubmit()}>
          {submit.isPending ? t("common.saving") : t("leave.submit")}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-extrabold text-slate-600">{t("leave.type")}</span>
          <select className="field" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
            <option value="">{t("leave.pickType")}</option>
            {(types.data ?? []).map((lt) => (
              <option key={String(lt.id)} value={String(lt.id)}>
                {lt.name}
              </option>
            ))}
          </select>
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-extrabold text-slate-600">{t("leave.start")}</span>
            {/* lang="en-GB": the product-wide rule that every date input renders
                dd/mm/yyyy with LATIN digits. An Arabic locale here would print
                Arabic-Indic digits, which this product uses nowhere. */}
            <input
              type="date"
              lang="en-GB"
              className="field"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-extrabold text-slate-600">{t("leave.end")}</span>
            <input
              type="date"
              lang="en-GB"
              className="field"
              value={end}
              min={start}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-extrabold text-slate-600">{t("leave.reason")}</span>
          <textarea
            className="field min-h-24 py-2"
            rows={3}
            placeholder={t("leave.reasonPlaceholder")}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
      </div>
    </Sheet>
  );
}
