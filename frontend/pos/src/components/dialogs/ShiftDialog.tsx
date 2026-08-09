/**
 * ShiftDialog — open a shift, review the V2 summary, and run the close flow:
 * GET /api/shifts/closing-data-v3/:shiftId → per-method counted inputs →
 * live variance rows (green/red) → POST /api/shifts/close-v3 → result.
 * Shift open/close REQUIRE a connection (forbidden offline by design).
 *
 * close/b2-pos-daily additions (legacy parity, public/pos/app.js):
 *  • physical cash count by denomination (the full SAMA set _v3CashDenoms
 *    :5537 — 500…0.05) feeding the cash method's counted figure; the counted
 *    rows are ALSO submitted so the server persists the breakdown
 *    (shift_close_denominations) that the Z-report prints.
 *  • BLIND COUNT (:5530, anti-anchoring/anti-fraud): expected amounts and
 *    variances stay HIDDEN until the cashier ticks «أنهيت العدّ» — otherwise
 *    the till is "counted" to match the screen. Close stays locked until the
 *    reveal happened AND something was actually counted.
 *  • variance-note gate (:5767) — a non-zero total variance requires a ≥10
 *    char explanation before the close button unlocks.
 *  • Z-report after close + X-report from an open shift, printed thermally
 *    via GET /api/shifts/:id/full-report (Authorization header attached by
 *    the api client) → buildShiftReportHtml → printHtml.
 *  • WhatsApp share of the Z totals (wa.me) — legacy shareShiftReportWhatsApp.
 *
 * i18n (bilingual-i18n-images): every visible string routes through useT();
 * the three module-level pure helpers below (closeGate, buildShiftWhatsAppText,
 * the status/method label lookups) take an OPTIONAL `t` so shiftClose.test.ts
 * keeps calling them with their original positional args and gets the exact
 * same literal Arabic back (default = ar dictionary) — the live dialog always
 * passes `t`. See i18n/dictionaries/{ar,en}/shiftDialog.ts.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Banknote, CheckCircle2, Clock3, Lock, MessageCircle, Printer } from "lucide-react";
import { usePos } from "@/state/store";
import { closingDataV3, closeShiftV3, listShiftMovements, shiftFullReport, shiftSummary, type ShiftMovementTotals } from "@/lib/api";
import { round2 } from "@/lib/cartMath";
import { fmt2, fmtInt } from "@/lib/format";
import { buildShiftReportHtml, printHtml, resolvePaperWidth } from "@/lib/receipt";
import type { ClosingDataV3, CloseV3Result, ShiftSummary } from "@/lib/types";
import { useT, useLang } from "@/i18n/I18nProvider";
import { translateApiError } from "@/i18n/errorCodes";
import { shiftDialog as shiftDialogAr } from "@/i18n/dictionaries/ar/shiftDialog";
import { Dialog } from "../Dialog";
import { Numpad } from "../Numpad";
import { Button, cn, ErrorBanner, Money, Skeleton } from "../ui";
import { CashMovementDialog } from "./CashMovementDialog";

type Mode = "info" | "closing" | "closed";

/** t() shape, kept local so this file's module-level pure helpers have no
 *  hard dependency on the scaffold's exported type name — same convention as
 *  RequisitionsDialog's shrStatusLabel/TFunction. */
type TFunction = (path: string, vars?: Record<string, string | number>) => string;

// Status/method maps — values are i18n dotted-paths under shiftDialog.*, not
// literal text (mirrors RequisitionsDialog's SHR_STATUS_LABELS).
export const SHIFT_STATUS_LABELS: Record<string, string> = {
  open: "shiftDialog.status.open",
  held: "shiftDialog.status.held",
  submitted: "shiftDialog.status.submitted",
  completed: "shiftDialog.status.completed",
  voided: "shiftDialog.status.voided",
};
function shiftStatusLabel(status: string, t: TFunction): string {
  const path = SHIFT_STATUS_LABELS[status];
  return path ? t(path) : status;
}

export const SHIFT_METHOD_LABELS: Record<string, string> = {
  cash: "shiftDialog.method.cash",
  card: "shiftDialog.method.card",
  credit: "shiftDialog.method.credit",
};
function shiftMethodLabel(method: string, t: TFunction): string {
  const path = SHIFT_METHOD_LABELS[method];
  return path ? t(path) : method;
}

/** The full SAMA circulating set — mirrors legacy state._v3CashDenoms
 *  (public/pos/app.js:5537): notes 500…5, coins 2/1 SAR + 50/25/10/5 halalas. */
export const CASH_DENOMS = [500, 200, 100, 50, 20, 10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05] as const;

/** Sum a {denomValue: count} map into SAR. Blank / NaN / negative counts are
 *  ignored; the result is rounded to the halala. */
export function denomTotal(counts: Record<string, string | number>): number {
  let total = 0;
  for (const d of CASH_DENOMS) {
    const n = Number(counts[String(d)]);
    if (Number.isFinite(n) && n > 0) total += d * Math.floor(n);
  }
  return round2(total);
}

/**
 * The close-button lock (legacy _scLockClose/_scUnlockClose :5793-5812 +
 * variance gate :5767): blind-count reveal first, then something counted, then
 * a non-zero variance needs a ≥10-char explanation. Pure so the gate matrix is
 * unit-testable. `t` is optional — omitted (as shiftClose.test.ts does) falls
 * back to the literal ar dictionary text; the live dialog always passes `t`.
 */
export function closeGate(
  revealed: boolean,
  countEntered: boolean,
  totalVariance: number,
  notes: string,
  t?: TFunction,
): { locked: boolean; reason?: string } {
  const tr = (path: string, fallback: string) => (t ? t(path) : fallback);
  if (!revealed) return { locked: true, reason: tr("shiftDialog.gate.needsReveal", shiftDialogAr.gate.needsReveal) };
  if (!countEntered) return { locked: true, reason: tr("shiftDialog.gate.needsCount", shiftDialogAr.gate.needsCount) };
  if (totalVariance !== 0 && notes.trim().length < 10) {
    return { locked: true, reason: tr("shiftDialog.gate.needsNote", shiftDialogAr.gate.needsNote) };
  }
  return { locked: false };
}

/** Plain-text Z summary for the wa.me share (legacy shareShiftReportWhatsApp,
 *  public/pos/app.js:2872). Pure so it is unit-testable. `t` optional — same
 *  default-to-Arabic contract as closeGate above. */
export function buildShiftWhatsAppText(res: CloseV3Result, username: string, t?: TFunction): string {
  const w = t
    ? {
        title: t("shiftDialog.whatsapp.title"),
        cashier: t("shiftDialog.whatsapp.cashier"),
        orderCount: t("shiftDialog.whatsapp.orderCount"),
        expected: t("shiftDialog.whatsapp.expected"),
        counted: t("shiftDialog.whatsapp.counted"),
        variance: t("shiftDialog.whatsapp.variance"),
        lineExpectedPrefix: t("shiftDialog.whatsapp.lineExpectedPrefix"),
        currency: t("shiftDialog.currency"),
      }
    : { ...shiftDialogAr.whatsapp, currency: shiftDialogAr.currency };

  const lines: string[] = [
    `${w.title} ${res.shiftId ?? ""}`,
    `${w.cashier} ${username}`,
    `${w.orderCount} ${res.orderCount ?? 0}`,
    `${w.expected} ${fmt2(res.expectedTotal ?? 0)} ${w.currency}`,
    `${w.counted} ${fmt2(res.actualTotal ?? 0)} ${w.currency}`,
    `${w.variance} ${(res.variance ?? 0) > 0 ? "+" : ""}${fmt2(res.variance ?? 0)} ${w.currency}`,
  ];
  for (const b of res.breakdown ?? []) {
    lines.push(`• ${b.nameAr || b.name}: ${fmt2(b.actual)} (${w.lineExpectedPrefix} ${fmt2(b.expected)})`);
  }
  return lines.join("\n");
}

export function ShiftDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const lang = useLang();
  const { shiftId, engineStatus, openShiftNow, openingShift, onShiftClosed, pushToast, catalog, user } = usePos();
  const online = engineStatus.online;
  const [mode, setMode] = useState<Mode>("info");
  const [summary, setSummary] = useState<ShiftSummary | null>(null);
  const [closing, setClosing] = useState<ClosingDataV3 | null>(null);
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [denoms, setDenoms] = useState<Record<string, string>>({});
  /** Opening float entered on the "no open shift" screen (الرصيد الافتتاحي) —
   *  the real cash the cashier puts in the drawer before selling. */
  const [openingFloatInput, setOpeningFloatInput] = useState("");
  /** Blind-count reveal (legacy scToggleReveal): expected/variance stay hidden
   *  until the cashier declares the physical count finished. */
  const [revealed, setRevealed] = useState(false);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [result, setResult] = useState<CloseV3Result | null>(null);
  /** The shift being/just closed — the context shiftId nulls after close, but
   *  the Z-report still needs the id. */
  const [closedShiftId, setClosedShiftId] = useState<string | null>(null);
  /**
   * W2-A — till cash movements. CashMovementDialog is opened from HERE rather
   * than from App.tsx's `overlayOpen`: ShiftDialog is already an overlay, the
   * movement only ever makes sense against the shift this dialog is showing,
   * and nesting it here needs no new global flag (App.tsx is another owner's
   * file). The dialog is rendered as a SIBLING of <Dialog>, not inside it, so
   * only one focus trap is ever live.
   */
  const [movementOpen, setMovementOpen] = useState(false);
  const [movementTotals, setMovementTotals] = useState<ShiftMovementTotals | null>(null);

  // Reset only fires when the dialog is freshly opened — NOT on every
  // shiftId/online change while it's already open. confirmClose() sets
  // mode="closed" + result + closedShiftId, then calls onShiftClosed()
  // which nulls the context's shiftId; that shiftId change used to be a
  // dependency here too, which re-ran this same reset and immediately wiped
  // mode back to "info" before the cashier ever saw the Z-report screen.
  useEffect(() => {
    if (!open) return;
    setMode("info");
    setError(null);
    setResult(null);
    setNotes("");
    setCounted({});
    setDenoms({});
    setOpeningFloatInput("");
    setRevealed(false);
    setClosedShiftId(null);
    setSummary(null);
    setMovementOpen(false);
    setMovementTotals(null);
  }, [open]);

  // W2-A — the shift's approved movements. Read separately from
  // closing-data-v3 (which also returns them) so the «info» screen can show the
  // net BEFORE the close flow starts, and so a movement recorded mid-dialog
  // refreshes without re-running the whole closing-data fetch.
  const reloadMovements = useCallback(async () => {
    if (!shiftId || !online) return;
    try {
      const res = await listShiftMovements(shiftId);
      setMovementTotals(res.totals ?? null);
    } catch {
      // Non-fatal: the figure is informational here — the SERVER is the
      // authority on expected cash and already folded these in.
      setMovementTotals(null);
    }
  }, [shiftId, online]);

  useEffect(() => {
    if (!open) return;
    void reloadMovements();
  }, [open, reloadMovements]);

  // Separate from the reset above: (re)fetch the shift summary whenever the
  // dialog is open and a real shiftId/online state is available. This must
  // NOT touch mode/result/closedShiftId, since it also fires when shiftId
  // becomes null right after a close (it just no-ops in that case).
  useEffect(() => {
    if (!open || !shiftId || !online) return;
    shiftSummary(shiftId)
      .then((r) => setSummary(r.data))
      .catch(() => setSummary(null));
  }, [open, shiftId, online]);

  async function startClosing() {
    if (!shiftId) return;
    setBusy(true);
    setError(null);
    try {
      const data = await closingDataV3(shiftId);
      if (data.error) throw new Error(data.error);
      setClosing(data);
      setCounted(Object.fromEntries(data.methods.map((m) => [String(m.id), ""])));
      setDenoms({});
      setRevealed(false);
      setMode("closing");
    } catch (e) {
      setError(translateApiError(e, t));
    } finally {
      setBusy(false);
    }
  }

  const cashMethod = useMemo(
    () => closing?.methods.find((m) => String(m.groupType ?? "").toLowerCase() === "cash") ?? null,
    [closing],
  );
  const denomSum = useMemo(() => denomTotal(denoms), [denoms]);
  const denomsUsed = denomSum > 0;

  // The counted denominations DRIVE the cash method figure (legacy: the cash
  // count comes only from the physical grid). Manual entry still works while
  // the grid is untouched.
  useEffect(() => {
    if (!cashMethod || !denomsUsed) return;
    const key = String(cashMethod.id);
    setCounted((c) => (c[key] === String(denomSum) ? c : { ...c, [key]: String(denomSum) }));
  }, [denomSum, denomsUsed, cashMethod]);

  const varianceRows = useMemo(() => {
    if (!closing) return [];
    return closing.methods.map((m) => {
      const actual = Number(counted[String(m.id)]) || 0;
      return { method: m, actual, variance: round2(actual - (m.expectedAmount || 0)) };
    });
  }, [closing, counted]);

  const totalExpected = closing?.expectedTotal ?? 0;
  const totalActual = round2(varianceRows.reduce((s, r) => s + r.actual, 0));
  const totalVariance = round2(totalActual - totalExpected);

  // Something was actually counted — a blank sheet must not close a shift.
  const countEntered = denomsUsed || varianceRows.some((r) => counted[String(r.method.id)] !== "");
  const gate = closeGate(revealed, countEntered, totalVariance, notes, t);
  const closeLocked = gate.locked;
  const closeLockReason = gate.reason;
  const varianceNeedsNote = revealed && totalVariance !== 0 && notes.trim().length < 10;

  async function confirmClose() {
    if (!shiftId || !closing || closeLocked) return;
    setBusy(true);
    setError(null);
    try {
      // Counted denomination rows (only counts > 0). Server-side these override
      // the cash paymentTotals entry with their sum — which IS the sum we put
      // there (the grid drives both), and sending them persists the breakdown
      // for the Z-report (shift_close_denominations).
      const denominations = CASH_DENOMS.filter((d) => (Number(denoms[String(d)]) || 0) > 0).map((d) => ({
        value: d,
        count: Math.floor(Number(denoms[String(d)])),
        kind: (d >= 5 ? "note" : "coin") as "note" | "coin",
      }));
      const res = await closeShiftV3({
        shiftId,
        // The server IGNORES this numerically (it reads the stored float under
        // the row lock) — we echo the closing-data value for request-shape
        // parity with clients that still send it. Never a client-authored money
        // input.
        openingFloat: closing.openingFloat ?? 0,
        denominations,
        paymentTotals: Object.fromEntries(varianceRows.map((r) => [String(r.method.id), r.actual])),
        notes: notes.trim(),
      });
      if (!res.success) throw new Error(res.error || t("shiftDialog.closeFailed"));
      setClosedShiftId(shiftId);
      setResult(res);
      setMode("closed");
      onShiftClosed();
      pushToast("success", t("shiftDialog.closeSuccessToast"));
    } catch (e) {
      setError(translateApiError(e, t));
    } finally {
      setBusy(false);
    }
  }

  /** Fetch the full report and print it thermally. mode X = open shift. */
  async function printReport(reportMode: "X" | "Z", id: string | null) {
    if (!id) return;
    setPrinting(true);
    try {
      const rep = await shiftFullReport(id);
      const ok = printHtml(
        buildShiftReportHtml(rep, { mode: reportMode, paperWidth: resolvePaperWidth(catalog), language: lang }),
      );
      if (!ok) pushToast("error", t("shiftDialog.printBlocked"));
    } catch (e) {
      pushToast("error", translateApiError(e, t) || t("shiftDialog.reportLoadFailed"));
    } finally {
      setPrinting(false);
    }
  }

  function shareWhatsApp() {
    if (!result) return;
    const text = buildShiftWhatsAppText(result, user?.username ?? "", t);
    window.open("https://wa.me/?text=" + encodeURIComponent(text), "_blank", "noopener");
  }

  return (
    <>
      <Dialog open={open} onClose={onClose} title={t("shiftDialog.dialogTitle")} widthClass="max-w-5xl" locked={busy}>
      {!shiftId && mode !== "closed" ? (
        <div
          data-testid="shift-open-workspace"
          className="grid items-stretch gap-4 py-2 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-5"
        >
          <section className="flex min-h-64 flex-col justify-between overflow-hidden rounded-2xl bg-ink p-5 text-start text-white sm:p-7">
            <div>
              <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-white/10">
                <Clock3 className="h-6 w-6 text-teal-300" aria-hidden />
              </span>
              <p className="mt-5 text-xl font-extrabold">{t("shiftDialog.noShift.title")}</p>
              <p className="mt-2 max-w-xl text-sm font-bold leading-6 text-slate-300">{t("shiftDialog.noShift.subtitle")}</p>
            </div>
            <div className="mt-6 rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
              <p className="text-xs font-bold text-slate-300">{t("shiftDialog.noShift.openingFloatLabel")}</p>
              <Money
                value={`${fmt2(Number(openingFloatInput) || 0)} ${t("shiftDialog.currency")}`}
                className="mt-1 block text-3xl font-extrabold text-white"
              />
            </div>
          </section>

          {/* Opening float — real cash the drawer starts with. The desktop
              workspace keeps the keypad in a dedicated, repeatable touch zone. */}
          <section className="rounded-2xl border border-slate-200 bg-slate-50/80 p-3 shadow-sm sm:p-4">
            <div className="mb-2 flex items-center justify-between rounded-xl bg-white px-3 py-2 shadow-sm">
              <span className="text-xs font-bold text-slate-400">{t("shiftDialog.noShift.amountLabel")}</span>
              <Money
                value={`${fmt2(Number(openingFloatInput) || 0)} ${t("shiftDialog.currency")}`}
                className="text-base font-extrabold text-ink"
              />
            </div>
            <Numpad value={openingFloatInput} onChange={setOpeningFloatInput} />
            <Button
              variant="saffron"
              size="lg"
              className="mt-3 min-h-14 w-full shadow-lg shadow-amber-900/10"
              onClick={() => openShiftNow(round2(Number(openingFloatInput) || 0))}
              loading={openingShift}
              disabled={!online}
              title={online ? undefined : t("shiftDialog.noShift.openOfflineTooltip")}
            >
              {t("shiftDialog.noShift.openButton")}
            </Button>
            {!online ? <p className="mt-2 text-center text-[11px] font-bold text-amber-700">{t("shiftDialog.noShift.offlineNote")}</p> : null}
          </section>
        </div>
      ) : null}

      {shiftId && mode === "info" ? (
        <div data-testid="shift-info-workspace">
          <div className="mb-4 flex items-center justify-between gap-4 rounded-2xl bg-ink px-4 py-4 text-white sm:px-5">
            <p className="text-xs font-bold text-slate-300">{t("shiftDialog.info.currentShiftLabel")}</p>
            <p className="text-xl font-extrabold text-white">
              <Money value={shiftId} />
            </p>
          </div>

          {online ? (
            summary ? (
              <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <p className="mb-2 text-xs font-extrabold text-slate-500">{t("shiftDialog.info.byStatusHeading")}</p>
                  {Object.keys(summary.byStatus).length === 0 ? (
                    <p className="text-xs text-slate-400">{t("shiftDialog.info.noOrdersYet")}</p>
                  ) : (
                    <ul className="space-y-1 text-sm">
                      {Object.entries(summary.byStatus).map(([status, v]) => (
                        <li key={status} className="flex justify-between">
                          <span className="font-bold text-slate-600">{shiftStatusLabel(status, t)}</span>
                          <span className="font-extrabold text-ink">
                            <Money value={fmtInt(v.count)} /> · <Money value={fmt2(v.amount)} /> {t("shiftDialog.currency")}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <p className="mb-2 text-xs font-extrabold text-slate-500">{t("shiftDialog.info.completedByMethodHeading")}</p>
                  {Object.keys(summary.completedByMethod).length === 0 ? (
                    <p className="text-xs text-slate-400">{t("shiftDialog.info.noPaymentsYet")}</p>
                  ) : (
                    <ul className="space-y-1 text-sm">
                      {Object.entries(summary.completedByMethod).map(([method, amount]) => (
                        <li key={method} className="flex justify-between">
                          <span className="font-bold text-slate-600">{shiftMethodLabel(method, t)}</span>
                          <span className="font-extrabold text-ink">
                            <Money value={fmt2(amount)} /> {t("shiftDialog.currency")}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            ) : (
              <div className="mb-4 grid grid-cols-2 gap-3">
                <Skeleton className="h-24" />
                <Skeleton className="h-24" />
              </div>
            )
          ) : null}

          {/* W2-A — the drawer's ± so far, shown on the shift screen itself so a
              cashier can see the adjustment before ever starting the close. */}
          {movementTotals && movementTotals.count > 0 ? (
            <div className="mb-3 flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
              <span className="text-xs font-extrabold text-slate-500">{t("shiftDialog.info.cashMovementNetLabel")}</span>
              <Money
                value={`${movementTotals.net > 0 ? "+" : ""}${fmt2(movementTotals.net)} ${t("shiftDialog.currency")}`}
                className="text-sm font-extrabold text-ink"
              />
            </div>
          ) : null}

          {error ? <ErrorBanner message={error} /> : null}

          <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-3">
          <Button
            variant="secondary"
            className="min-h-14 w-full"
            onClick={() => setMovementOpen(true)}
            disabled={!online}
            title={online ? t("shiftDialog.info.cashMovementTooltip") : t("shiftDialog.info.cashMovementOfflineTooltip")}
          >
            <Banknote className="h-4 w-4" aria-hidden />
            {t("shiftDialog.info.cashMovementButton")}
          </Button>

          <Button
            variant="secondary"
            className="min-h-14 w-full"
            onClick={() => void printReport("X", shiftId)}
            loading={printing}
            disabled={!online}
            title={online ? t("shiftDialog.info.xReportTooltip") : t("shiftDialog.info.xReportOfflineTooltip")}
          >
            <Printer className="h-4 w-4" aria-hidden />
            {t("shiftDialog.info.xReportButton")}
          </Button>

          <Button
            variant="dark"
            size="lg"
            className="min-h-14 w-full"
            onClick={() => void startClosing()}
            loading={busy}
            disabled={!online}
            title={online ? t("shiftDialog.info.closeShiftTooltip") : t("shiftDialog.info.closeShiftOfflineTooltip")}
          >
            <Lock className="h-4 w-4" aria-hidden />
            {t("shiftDialog.info.closeShiftButton")}
          </Button>
          </div>
          {!online ? (
            <p className="mt-2 text-center text-[11px] font-bold text-amber-700">{t("shiftDialog.info.closeOfflineNote")}</p>
          ) : null}
        </div>
      ) : null}

      {mode === "closing" && closing ? (
        <div data-testid="shift-closing-workspace">
          <p className="mb-3 rounded-2xl bg-ink px-4 py-3 text-xs font-bold leading-5 text-slate-200">
            {t("shiftDialog.closing.countInstructionsPrefix")} <span className="num">{fmtInt(closing.orderCount)}</span>{" "}
            {t("shiftDialog.closing.invoiceCountSuffix")}
          </p>

          {/* Read-only opening float — recorded at open time and folded into the
              cash «المتوقع» server-side. NOT editable: the server ignores any
              client float for money math. */}
          {(closing.openingFloat ?? 0) > 0 ? (
            <div className="mb-3 flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
              <span className="text-xs font-extrabold text-slate-500">{t("shiftDialog.closing.openingFloatInClosing")}</span>
              <Money
                value={`${fmt2(closing.openingFloat ?? 0)} ${t("shiftDialog.currency")}`}
                className="text-sm font-extrabold text-ink"
              />
            </div>
          ) : null}

          {/* W2-A — the OTHER term inside the cash «المتوقع». Read-only for the
              same reason the float is: the server recomputes it under the shift
              row lock and any client number would be advisory at best. Shown so
              the cashier can reconcile the expected figure line by line instead
              of seeing it move for no visible reason. */}
          {movementTotals && movementTotals.count > 0 ? (
            <div className="mb-3 flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
              <span className="min-w-0">
                <span className="block text-xs font-extrabold text-slate-500">{t("shiftDialog.closing.movementsInClosing")}</span>
                <span className="block text-[10px] font-bold text-slate-400">
                  {t("shiftDialog.closing.movementsBreakdown", {
                    in: fmt2(movementTotals.payIn),
                    out: fmt2(movementTotals.payOut),
                  })}
                </span>
              </span>
              <Money
                value={`${movementTotals.net > 0 ? "+" : ""}${fmt2(movementTotals.net)} ${t("shiftDialog.currency")}`}
                className="shrink-0 text-sm font-extrabold text-ink"
              />
            </div>
          ) : null}

          {/* ── Physical cash count — the SAMA denomination grid ── */}
          {cashMethod ? (
            <details className="mb-3 rounded-2xl border border-slate-200" open>
              <summary className="cursor-pointer select-none px-3 py-2.5 text-xs font-extrabold text-slate-600">
                {t("shiftDialog.closing.cashDenomHeading")}{" "}
                {denomsUsed ? (
                  <span className="ms-1 rounded-lg bg-teal-50 px-2 py-0.5 text-teal-700">
                    <Money value={fmt2(denomSum)} /> {t("shiftDialog.currency")}
                  </span>
                ) : null}
              </summary>
              <div className="grid grid-cols-3 gap-1.5 px-3 pb-3 sm:grid-cols-5 lg:grid-cols-7" data-testid="denom-grid">
                {CASH_DENOMS.map((d) => {
                  const key = String(d);
                  const count = Number(denoms[key]) || 0;
                  const face = d < 1 ? `${Math.round(d * 100)} ${t("shiftDialog.halala")}` : `${d} ${t("shiftDialog.currency")}`;
                  return (
                    <label key={key} className="rounded-xl border border-slate-200 p-1.5 text-center">
                      <span className="block text-[10px] font-extrabold text-slate-500">
                        <span className="num">{face}</span>
                        <span className="ms-1 text-slate-300">
                          {d >= 5 ? t("shiftDialog.closing.denomNote") : t("shiftDialog.closing.denomCoin")}
                        </span>
                      </span>
                      <input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        step={1}
                        value={denoms[key] ?? ""}
                        onChange={(e) => setDenoms((v) => ({ ...v, [key]: e.target.value }))}
                        onFocus={(e) => e.target.select()}
                        placeholder="0"
                        aria-label={t("shiftDialog.closing.denomCountAriaLabel", { face })}
                        className="field num mt-1 h-9 w-full px-1 text-center text-sm"
                        dir="ltr" /* LTR forced: numeric/phone - do not remove, see i18n plan */
                      />
                      <span className="num block pt-0.5 text-[10px] font-bold text-slate-400">
                        {count > 0 ? fmt2(d * count) : "0.00"}
                      </span>
                    </label>
                  );
                })}
              </div>
            </details>
          ) : null}

          <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white px-3 shadow-sm">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-[11px] font-extrabold text-slate-400">
                  <th className="py-2 text-start">{t("shiftDialog.table.method")}</th>
                  <th className="py-2 text-start">{t("shiftDialog.table.counted")}</th>
                  {revealed ? <th className="py-2 text-start">{t("shiftDialog.table.expected")}</th> : null}
                  {revealed ? <th className="py-2 text-start">{t("shiftDialog.table.variance")}</th> : null}
                </tr>
              </thead>
              <tbody>
                {varianceRows.map(({ method: m, actual, variance }) => {
                  const key = String(m.id);
                  const touched = counted[key] !== "";
                  const isCashDriven = denomsUsed && cashMethod != null && String(cashMethod.id) === key;
                  return (
                    <tr key={key} className="border-b border-slate-100">
                      <td className="py-2 font-extrabold text-ink">
                        {m.nameAr || m.name}
                        {isCashDriven ? (
                          <span className="ms-1 text-[10px] font-bold text-teal-600">{t("shiftDialog.closing.cashDrivenBadge")}</span>
                        ) : null}
                      </td>
                      <td className="py-2 pe-2">
                        <input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step="0.01"
                          value={counted[key] ?? ""}
                          onChange={(e) => setCounted((c) => ({ ...c, [key]: e.target.value }))}
                          placeholder="0.00"
                          readOnly={isCashDriven}
                          aria-label={`${t("shiftDialog.closing.countedAriaLabelPrefix")} ${m.nameAr || m.name}`}
                          className={cn("field num w-32", isCashDriven && "bg-slate-50 text-slate-500")}
                          dir="ltr" /* LTR forced: numeric/phone - do not remove, see i18n plan */
                        />
                      </td>
                      {revealed ? (
                        <td className="py-2">
                          <Money value={fmt2(m.expectedAmount || 0)} className="font-bold text-slate-500" />
                        </td>
                      ) : null}
                      {revealed ? (
                        <td className="py-2">
                          <Money
                            value={`${variance > 0 ? "+" : ""}${fmt2(variance)}`}
                            className={cn(
                              "font-extrabold",
                              !touched && variance === 0
                                ? "text-slate-300"
                                : variance === 0
                                  ? "text-teal-600"
                                  : variance > 0
                                    ? "text-teal-600"
                                    : "text-red-600",
                            )}
                          />
                          {actual > 0 || touched ? null : (
                            <span className="ms-1 text-[10px] text-slate-300">{t("shiftDialog.closing.notCountedBadge")}</span>
                          )}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="text-sm font-extrabold">
                  <td className="py-2.5 text-ink">{t("shiftDialog.table.total")}</td>
                  <td className="py-2.5">
                    <Money value={fmt2(totalActual)} />
                  </td>
                  {revealed ? (
                    <td className="py-2.5">
                      <Money value={fmt2(totalExpected)} />
                    </td>
                  ) : null}
                  {revealed ? (
                    <td className="py-2.5">
                      <Money
                        value={`${totalVariance > 0 ? "+" : ""}${fmt2(totalVariance)}`}
                        className={totalVariance === 0 ? "text-teal-600" : totalVariance > 0 ? "text-teal-600" : "text-red-600"}
                      />
                    </td>
                  ) : null}
                </tr>
              </tfoot>
            </table>
          </div>

          {/* ── Blind-count reveal gate (legacy scToggleReveal :5815) ── */}
          <label className="mt-3 flex cursor-pointer items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
            <input
              type="checkbox"
              checked={revealed}
              onChange={(e) => setRevealed(e.target.checked)}
              className="h-4 w-4 accent-teal-600"
            />
            <span className="text-xs font-extrabold text-slate-700">{t("shiftDialog.closing.revealLabel")}</span>
          </label>
          {!revealed ? (
            <p className="mt-1 text-[11px] font-bold text-slate-400">{t("shiftDialog.closing.revealHint")}</p>
          ) : null}

          {revealed && closing.unmatchedTotal > 0 ? (
            <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-800">
              {t("shiftDialog.closing.unmatchedWarningPrefix")} <Money value={fmt2(closing.unmatchedTotal)} />{" "}
              {t("shiftDialog.currency")} {t("shiftDialog.closing.unmatchedWarningSuffix")}
            </p>
          ) : null}

          <label className="mt-3 block">
            <span className="mb-1 block text-[11px] font-extrabold text-slate-500">
              {t("shiftDialog.closing.notesLabel")}
              {totalVariance !== 0 ? (
                <span className="ms-1 text-red-600">{t("shiftDialog.closing.varianceNoteHint")}</span>
              ) : null}
            </span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className={cn("field min-h-[4.5rem] py-2", varianceNeedsNote && "border-red-300")}
            />
          </label>

          {error ? (
            <div className="mt-3">
              <ErrorBanner message={error} />
            </div>
          ) : null}

          <div className="sticky bottom-0 z-10 -mx-3 mt-4 flex gap-2 border-t border-slate-200 bg-white/95 px-3 py-3 backdrop-blur sm:-mx-4 sm:px-4">
            <Button variant="secondary" className="flex-1" onClick={() => setMode("info")} disabled={busy}>
              {t("common.back")}
            </Button>
            <Button
              variant="dark"
              className="flex-[2]"
              onClick={() => void confirmClose()}
              loading={busy}
              disabled={closeLocked}
              title={closeLockReason}
            >
              <Lock className="h-4 w-4" aria-hidden />
              {closeLocked && !busy ? closeLockReason : t("shiftDialog.closing.confirmButton")}
            </Button>
          </div>
        </div>
      ) : null}

      {mode === "closed" && result ? (
        <div className="flex flex-col items-center gap-4 py-2 text-center" data-testid="shift-z-summary">
          <div className="flex w-full items-center gap-3 rounded-2xl bg-teal-50 px-4 py-3 text-start">
            <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white shadow-sm">
              <CheckCircle2 className="h-7 w-7 text-teal-500" aria-hidden />
            </span>
            <p className="text-lg font-extrabold text-ink">{t("shiftDialog.closed.title")}</p>
          </div>
          <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-3">
            <div className="rounded-2xl border border-slate-200 bg-white p-3 text-start shadow-sm">
              <p className="text-[11px] font-bold text-slate-400">{t("shiftDialog.table.expected")}</p>
              <Money value={`${fmt2(result.expectedTotal ?? 0)} ${t("shiftDialog.currency")}`} className="text-lg font-extrabold text-ink" />
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-3 text-start shadow-sm">
              <p className="text-[11px] font-bold text-slate-400">{t("shiftDialog.table.actual")}</p>
              <Money value={`${fmt2(result.actualTotal ?? 0)} ${t("shiftDialog.currency")}`} className="text-lg font-extrabold text-ink" />
            </div>
            <div className={cn("rounded-2xl border p-3 text-start shadow-sm", (result.variance ?? 0) === 0 ? "border-teal-200 bg-teal-50" : "border-red-200 bg-red-50")}>
              <p className="text-[11px] font-bold text-slate-400">{t("shiftDialog.table.variance")}</p>
              <Money
                value={`${(result.variance ?? 0) > 0 ? "+" : ""}${fmt2(result.variance ?? 0)} ${t("shiftDialog.currency")}`}
                className={cn("text-lg font-extrabold", (result.variance ?? 0) === 0 ? "text-teal-700" : "text-red-700")}
              />
            </div>
          </div>
          <div className="w-full overflow-x-auto rounded-2xl border border-slate-200 bg-white px-3 shadow-sm">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-[11px] font-extrabold text-slate-400">
                  <th className="py-2 text-start">{t("shiftDialog.table.method")}</th>
                  <th className="py-2 text-start">{t("shiftDialog.table.expected")}</th>
                  <th className="py-2 text-start">{t("shiftDialog.table.actual")}</th>
                  <th className="py-2 text-start">{t("shiftDialog.table.variance")}</th>
                </tr>
              </thead>
              <tbody>
                {(result.breakdown ?? []).map((b) => (
                  <tr key={String(b.id)} className="border-b border-slate-100">
                    <td className="py-1.5 text-start font-bold text-slate-600">{b.nameAr || b.name}</td>
                    <td className="py-1.5 text-start">
                      <Money value={fmt2(b.expected)} />
                    </td>
                    <td className="py-1.5 text-start">
                      <Money value={fmt2(b.actual)} />
                    </td>
                    <td className="py-1.5 text-start">
                      <Money
                        value={`${b.variance > 0 ? "+" : ""}${fmt2(b.variance)}`}
                        className={b.variance === 0 ? "text-teal-600" : b.variance > 0 ? "text-teal-600" : "text-red-600"}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid w-full grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => void printReport("Z", closedShiftId)} loading={printing}>
              <Printer className="h-4 w-4" aria-hidden />
              {t("shiftDialog.closed.printZButton")}
            </Button>
            <Button variant="secondary" onClick={shareWhatsApp}>
              <MessageCircle className="h-4 w-4" aria-hidden />
              {t("shiftDialog.closed.shareWhatsAppButton")}
            </Button>
          </div>
          <Button variant="primary" size="lg" className="w-full" onClick={onClose}>
            {t("shiftDialog.closed.doneButton")}
          </Button>
        </div>
      ) : null}
      </Dialog>

      {/* W2-A — sibling of <Dialog>, never a child: two live <Dialog>s would
          stack two focus traps and two body scroll locks. */}
      <CashMovementDialog
        open={movementOpen && !!shiftId}
        shiftId={shiftId}
        online={online}
        onClose={() => setMovementOpen(false)}
        onRecorded={(totals) => {
          setMovementTotals(totals);
          // A movement changes the expected cash the close screen is showing —
          // re-fetch it rather than patching the number client-side, so the
          // grid stays exactly what the server will reconcile against.
          if (mode === "closing" && shiftId) {
            void closingDataV3(shiftId).then((data) => { if (!data.error) setClosing(data); }).catch(() => {});
          }
        }}
      />
    </>
  );
}
