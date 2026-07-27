/**
 * CashMovementDialog — record a cash IN / OUT on the open drawer (حركات نقدية
 * على الدرج), with manager approval.
 *
 * WHY IT EXISTS: a cashier could not record cash in or out during a shift from
 * ANY client. /api/cash is admin/manager-only, and the voucher tables carried no
 * shift reference — so a drop to the safe, a float top-up or petty cash was
 * invisible to the till and the expected-cash figure at close was wrong by
 * exactly those amounts. That is a leading cause of unexplained shift variance.
 *
 * OWNER DECISION: the cashier records the movement, a manager approves it. The
 * approval is a SECOND STEP in this same dialog rather than a nested
 * <ManagerApprovalDialog> — two stacked <Dialog>s would fight over the focus
 * trap and the body scroll lock. The manager's credentials go straight to
 * POST /api/shifts/:id/movements and are verified there with bcrypt against the
 * approval capability; this component never decides whether an approval is
 * valid, it only collects it. Field labels reuse the managerApprovalDialog
 * namespace so the approval vocabulary stays in one place.
 *
 * The amount uses the shared <Numpad> (money grammar) — imported, never forked.
 *
 * i18n: every visible string routes through useT(). See
 * i18n/dictionaries/{ar,en}/cashMovementDialog.ts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, ShieldCheck } from "lucide-react";
import { createShiftMovement, listShiftMovements, type ShiftMovement, type ShiftMovementTotals } from "@/lib/api";
import { round2 } from "@/lib/cartMath";
import { fmt2 } from "@/lib/format";
import { useT } from "@/i18n/I18nProvider";
import { translateApiError } from "@/i18n/errorCodes";
import { Dialog } from "../Dialog";
import { Numpad } from "../Numpad";
import { Button, cn, ErrorBanner, Money, Skeleton } from "../ui";

export type MovementKind = "pay_in" | "pay_out";

/** Preset reasons, as i18n dotted paths (values are NOT literal text) — the
 *  same convention as ShiftDialog's SHIFT_STATUS_LABELS. The chip only fills
 *  the free-text reason field; the server stores whatever text is submitted, so
 *  a cashier is never boxed into a preset. */
export const MOVEMENT_REASON_PRESETS: Record<MovementKind, string[]> = {
  pay_in: ["cashMovementDialog.presets.floatTopUp", "cashMovementDialog.presets.changeFund", "cashMovementDialog.presets.other"],
  pay_out: [
    "cashMovementDialog.presets.safeDrop",
    "cashMovementDialog.presets.pettyCash",
    "cashMovementDialog.presets.supplierCod",
    "cashMovementDialog.presets.other",
  ],
};

/**
 * The submit gate, pure so the matrix is unit-testable without rendering.
 * Step 1 needs a positive amount and a reason; step 2 additionally needs the
 * approver's username and password. Mirrors ShiftDialog's `closeGate`.
 */
export function movementGate(step: "form" | "approve", amount: number, reason: string, approverUsername: string, approverPassword: string): boolean {
  if (!(Number.isFinite(amount) && amount > 0)) return false;
  if (reason.trim().length < 2) return false;
  if (step === "approve") return approverUsername.trim().length > 0 && approverPassword.length > 0;
  return true;
}

export function CashMovementDialog({
  open,
  shiftId,
  online,
  onClose,
  onRecorded,
}: {
  open: boolean;
  shiftId: string | null;
  online: boolean;
  onClose: () => void;
  /** Fired after a successful record so the caller can refresh whatever it
   *  derives from the shift (the close screen's expected figure). */
  onRecorded?: (totals: ShiftMovementTotals) => void;
}) {
  const t = useT();
  const [step, setStep] = useState<"form" | "approve">("form");
  const [kind, setKind] = useState<MovementKind>("pay_out");
  const [amountInput, setAmountInput] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [approverUsername, setApproverUsername] = useState("");
  const [approverPassword, setApproverPassword] = useState("");
  const [movements, setMovements] = useState<ShiftMovement[] | null>(null);
  const [totals, setTotals] = useState<ShiftMovementTotals | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const approverRef = useRef<HTMLInputElement>(null);

  const amount = round2(Number(amountInput) || 0);

  const reload = useCallback(async () => {
    if (!shiftId || !online) return;
    try {
      const res = await listShiftMovements(shiftId);
      setMovements(res.movements ?? []);
      setTotals(res.totals ?? null);
    } catch (e) {
      setMovements([]);
      setError(translateApiError(e, t));
    }
  }, [shiftId, online, t]);

  // Fresh open — never leave a manager's password (or a half-typed amount)
  // sitting in state between openings.
  useEffect(() => {
    if (!open) {
      setApproverPassword("");
      return;
    }
    setStep("form");
    setKind("pay_out");
    setAmountInput("");
    setReason("");
    setNote("");
    setApproverUsername("");
    setApproverPassword("");
    setError(null);
    setMovements(null);
    setTotals(null);
    void reload();
  }, [open, reload]);

  // Focus the approver field when the approval step paints.
  useEffect(() => {
    if (step !== "approve") return undefined;
    const id = setTimeout(() => approverRef.current?.focus(), 50);
    return () => clearTimeout(id);
  }, [step]);

  const presets = useMemo(() => MOVEMENT_REASON_PRESETS[kind], [kind]);
  const canContinue = movementGate("form", amount, reason, approverUsername, approverPassword) && !busy && online;
  const canSubmit = movementGate("approve", amount, reason, approverUsername, approverPassword) && !busy && online;

  async function submit() {
    if (!shiftId || !canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createShiftMovement(shiftId, {
        kind,
        amount,
        reason: reason.trim(),
        note: note.trim() || undefined,
        approverUsername: approverUsername.trim(),
        approverPassword,
      });
      setTotals(res.totals);
      // Wipe the credentials the instant the server has answered.
      setApproverUsername("");
      setApproverPassword("");
      setAmountInput("");
      setReason("");
      setNote("");
      setStep("form");
      await reload();
      onRecorded?.(res.totals);
    } catch (e) {
      setError(translateApiError(e, t));
      // Stay on the approval step so a mistyped password can be retried
      // without re-entering the amount and reason.
      setApproverPassword("");
    } finally {
      setBusy(false);
    }
  }

  const isIn = kind === "pay_in";

  return (
    <Dialog open={open} onClose={onClose} title={t("cashMovementDialog.dialogTitle")} widthClass="max-w-xl" locked={busy}>
      {!online ? (
        <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-800">
          {t("cashMovementDialog.offlineNote")}
        </p>
      ) : null}

      {error ? (
        <div className="mb-3">
          <ErrorBanner message={error} />
        </div>
      ) : null}

      {step === "form" ? (
        <div>
          {/* ── in / out ── */}
          <p className="mb-1 text-xs font-extrabold text-slate-500">{t("cashMovementDialog.kind.label")}</p>
          <div className="mb-1 grid grid-cols-2 gap-2" role="radiogroup" aria-label={t("cashMovementDialog.kind.label")}>
            <button
              type="button"
              role="radio"
              aria-checked={isIn}
              onClick={() => setKind("pay_in")}
              className={cn(
                "btn-press flex min-h-12 items-center justify-center gap-2 rounded-xl border text-sm font-extrabold transition",
                isIn ? "border-teal-500 bg-teal-50 text-teal-700" : "border-slate-200 bg-white text-slate-500",
              )}
            >
              <ArrowDownLeft className="h-4 w-4" aria-hidden />
              {t("cashMovementDialog.kind.payIn")}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={!isIn}
              onClick={() => setKind("pay_out")}
              className={cn(
                "btn-press flex min-h-12 items-center justify-center gap-2 rounded-xl border text-sm font-extrabold transition",
                !isIn ? "border-amber-500 bg-amber-50 text-amber-700" : "border-slate-200 bg-white text-slate-500",
              )}
            >
              <ArrowUpRight className="h-4 w-4" aria-hidden />
              {t("cashMovementDialog.kind.payOut")}
            </button>
          </div>
          <p className="mb-3 text-[11px] font-bold text-slate-400">
            {isIn ? t("cashMovementDialog.kind.payInHint") : t("cashMovementDialog.kind.payOutHint")}
          </p>

          {/* ── amount (shared Numpad) ── */}
          <div className="mb-2 flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
            <span className="text-xs font-bold text-slate-400">{t("cashMovementDialog.form.amountLabel")}</span>
            <Money
              value={`${isIn ? "+" : "−"}${fmt2(amount)} ${t("cashMovementDialog.currency")}`}
              className={cn("text-base font-extrabold", isIn ? "text-teal-600" : "text-amber-700")}
            />
          </div>
          <Numpad value={amountInput} onChange={setAmountInput} className="mb-3" />

          {/* ── reason ── */}
          <label className="block">
            <span className="mb-1 block text-xs font-extrabold text-slate-500">{t("cashMovementDialog.form.reasonLabel")}</span>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("cashMovementDialog.form.reasonPlaceholder")}
              aria-label={t("cashMovementDialog.form.reasonLabel")}
              className="field min-h-11 w-full px-3 text-sm font-bold text-ink"
            />
          </label>
          <p className="mb-1 mt-2 text-[11px] font-extrabold text-slate-400">{t("cashMovementDialog.presets.heading")}</p>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {presets.map((path) => (
              <button
                key={path}
                type="button"
                onClick={() => setReason(t(path))}
                className="btn-press rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-extrabold text-slate-600 transition hover:bg-slate-50"
              >
                {t(path)}
              </button>
            ))}
          </div>

          <label className="mb-3 block">
            <span className="mb-1 block text-xs font-extrabold text-slate-500">{t("cashMovementDialog.form.noteLabel")}</span>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="field min-h-11 w-full px-3 text-sm font-bold text-ink"
            />
          </label>

          <Button
            variant="dark"
            size="lg"
            className="w-full"
            disabled={!canContinue}
            onClick={() => {
              setError(null);
              setStep("approve");
            }}
            title={
              amount <= 0
                ? t("cashMovementDialog.form.amountRequired")
                : reason.trim().length < 2
                  ? t("cashMovementDialog.form.reasonRequired")
                  : undefined
            }
          >
            <ShieldCheck className="h-4 w-4" aria-hidden />
            {t("cashMovementDialog.form.submitButton")}
          </Button>
        </div>
      ) : null}

      {step === "approve" ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-bold text-amber-800">
            <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden />
            {t("managerApprovalDialog.banner")}
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm">
            <p className="text-[11px] font-extrabold text-slate-400">{t("cashMovementDialog.approval.summaryPrefix")}</p>
            <p className="font-extrabold text-ink">
              {isIn ? t("cashMovementDialog.kind.payIn") : t("cashMovementDialog.kind.payOut")} ·{" "}
              <Money value={`${fmt2(amount)} ${t("cashMovementDialog.currency")}`} />
            </p>
            <p className="text-xs font-bold text-slate-500">{reason}</p>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-bold text-slate-500">{t("managerApprovalDialog.fields.usernameLabel")}</span>
            <input
              ref={approverRef}
              type="text"
              value={approverUsername}
              onChange={(e) => setApproverUsername(e.target.value)}
              autoComplete="off"
              className="field min-h-11 px-3 text-sm font-bold text-ink"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-bold text-slate-500">{t("managerApprovalDialog.fields.passwordLabel")}</span>
            <input
              type="password"
              value={approverPassword}
              onChange={(e) => setApproverPassword(e.target.value)}
              autoComplete="off"
              className="field min-h-11 px-3 text-sm font-bold text-ink"
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <Button type="button" variant="secondary" onClick={() => setStep("form")} disabled={busy}>
              {t("cashMovementDialog.approval.back")}
            </Button>
            <Button type="submit" variant="dark" disabled={!canSubmit} loading={busy}>
              {t("cashMovementDialog.approval.confirmButton")}
            </Button>
          </div>
        </form>
      ) : null}

      {/* ── the shift's movements so far ── */}
      <div className="mt-4 border-t border-slate-100 pt-3">
        <p className="mb-2 text-xs font-extrabold text-slate-500">{t("cashMovementDialog.list.heading")}</p>
        {movements == null ? (
          <Skeleton className="h-16" />
        ) : movements.length === 0 ? (
          <p className="text-xs font-bold text-slate-400">{t("cashMovementDialog.list.empty")}</p>
        ) : (
          <>
            <ul className="space-y-1.5" data-testid="movement-list">
              {movements.map((m) => (
                <li key={m.id} className="flex items-start justify-between gap-2 rounded-xl border border-slate-100 px-3 py-2">
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-extrabold text-ink">{m.reason}</span>
                    <span className="block text-[10px] font-bold text-slate-400">
                      {t("cashMovementDialog.list.approvedByPrefix")} {m.approvedBy}
                    </span>
                  </span>
                  <Money
                    value={`${m.kind === "pay_in" ? "+" : "−"}${fmt2(m.amount)}`}
                    className={cn("shrink-0 text-sm font-extrabold", m.kind === "pay_in" ? "text-teal-600" : "text-amber-700")}
                  />
                </li>
              ))}
            </ul>
            {totals ? (
              <div className="mt-2 space-y-0.5 rounded-xl bg-slate-50 px-3 py-2 text-xs font-bold">
                <p className="flex justify-between text-slate-500">
                  <span>{t("cashMovementDialog.list.payInTotal")}</span>
                  <Money value={fmt2(totals.payIn)} />
                </p>
                <p className="flex justify-between text-slate-500">
                  <span>{t("cashMovementDialog.list.payOutTotal")}</span>
                  <Money value={fmt2(totals.payOut)} />
                </p>
                <p className="flex justify-between font-extrabold text-ink">
                  <span>{t("cashMovementDialog.list.netTotal")}</span>
                  <Money value={`${totals.net > 0 ? "+" : ""}${fmt2(totals.net)}`} />
                </p>
              </div>
            ) : null}
          </>
        )}
      </div>

      <Button variant="secondary" className="mt-3 w-full" onClick={onClose} disabled={busy}>
        {t("cashMovementDialog.closeButton")}
      </Button>
    </Dialog>
  );
}
