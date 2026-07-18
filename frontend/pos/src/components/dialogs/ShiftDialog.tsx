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
 */
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Clock3, Lock, MessageCircle, Printer } from "lucide-react";
import { usePos } from "@/state/store";
import { closingDataV3, closeShiftV3, shiftFullReport, shiftSummary } from "@/lib/api";
import { round2 } from "@/lib/cartMath";
import { fmt2, fmtInt } from "@/lib/format";
import { buildShiftReportHtml, printHtml, resolvePaperWidth } from "@/lib/receipt";
import type { ClosingDataV3, CloseV3Result, ShiftSummary } from "@/lib/types";
import { Dialog } from "../Dialog";
import { Button, cn, ErrorBanner, Money, Skeleton } from "../ui";

type Mode = "info" | "closing" | "closed";

const STATUS_LABELS: Record<string, string> = {
  open: "مفتوح",
  held: "معلق",
  submitted: "قيد الدفع",
  completed: "مكتمل",
  voided: "ملغي",
};

const METHOD_LABELS: Record<string, string> = { cash: "كاش", card: "شبكة", credit: "آجل" };

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

/** Plain-text Z summary for the wa.me share (legacy shareShiftReportWhatsApp,
 *  public/pos/app.js:2872). Pure so it is unit-testable. */
export function buildShiftWhatsAppText(res: CloseV3Result, username: string): string {
  const lines: string[] = [
    `تقرير إغلاق وردية (Z) — ${res.shiftId ?? ""}`,
    `الكاشير: ${username}`,
    `عدد الفواتير: ${res.orderCount ?? 0}`,
    `المتوقع: ${fmt2(res.expectedTotal ?? 0)} ر.س`,
    `المعدود: ${fmt2(res.actualTotal ?? 0)} ر.س`,
    `الفرق: ${(res.variance ?? 0) > 0 ? "+" : ""}${fmt2(res.variance ?? 0)} ر.س`,
  ];
  for (const b of res.breakdown ?? []) {
    lines.push(`• ${b.nameAr || b.name}: ${fmt2(b.actual)} (متوقع ${fmt2(b.expected)})`);
  }
  return lines.join("\n");
}

export function ShiftDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { shiftId, engineStatus, openShiftNow, openingShift, onShiftClosed, pushToast, catalog, user } = usePos();
  const online = engineStatus.online;
  const [mode, setMode] = useState<Mode>("info");
  const [summary, setSummary] = useState<ShiftSummary | null>(null);
  const [closing, setClosing] = useState<ClosingDataV3 | null>(null);
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [denoms, setDenoms] = useState<Record<string, string>>({});
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

  useEffect(() => {
    if (!open) return;
    setMode("info");
    setError(null);
    setResult(null);
    setNotes("");
    setCounted({});
    setDenoms({});
    setRevealed(false);
    setClosedShiftId(null);
    setSummary(null);
    if (shiftId && online) {
      shiftSummary(shiftId)
        .then((r) => setSummary(r.data))
        .catch(() => setSummary(null));
    }
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
      setError((e as Error).message);
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
  // Legacy variance gate (app.js:5767): a non-zero variance must be explained
  // (≥10 chars) before the close button unlocks. Only meaningful post-reveal —
  // before it the cashier cannot even see that a variance exists.
  const varianceNeedsNote = revealed && totalVariance !== 0 && notes.trim().length < 10;
  // Legacy close lock (app.js:5530): reveal first, count something, explain a
  // variance — then the button unlocks.
  const closeLocked = !revealed || !countEntered || varianceNeedsNote;
  const closeLockReason = !revealed
    ? "أنهِ العدّ ثم فعِّل «أنهيت العدّ» أولًا"
    : !countEntered
      ? "أدخل المبالغ المعدودة أولًا"
      : varianceNeedsNote
        ? "اشرح سبب الفرق أولًا (١٠ أحرف على الأقل)"
        : undefined;

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
        openingFloat: 0,
        denominations,
        paymentTotals: Object.fromEntries(varianceRows.map((r) => [String(r.method.id), r.actual])),
        notes: notes.trim(),
      });
      if (!res.success) throw new Error(res.error || "تعذّر إغلاق الوردية");
      setClosedShiftId(shiftId);
      setResult(res);
      setMode("closed");
      onShiftClosed();
      pushToast("success", "أُغلقت الوردية بنجاح");
    } catch (e) {
      setError((e as Error).message);
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
      const ok = printHtml(buildShiftReportHtml(rep, { mode: reportMode, paperWidth: resolvePaperWidth(catalog) }));
      if (!ok) pushToast("error", "المتصفح منع نافذة الطباعة — اسمح بالنوافذ المنبثقة");
    } catch (e) {
      pushToast("error", (e as Error).message || "تعذّر تحميل تقرير الوردية");
    } finally {
      setPrinting(false);
    }
  }

  function shareWhatsApp() {
    if (!result) return;
    const text = buildShiftWhatsAppText(result, user?.username ?? "");
    window.open("https://wa.me/?text=" + encodeURIComponent(text), "_blank", "noopener");
  }

  return (
    <Dialog open={open} onClose={onClose} title="الوردية" widthClass="max-w-2xl" locked={busy}>
      {!shiftId && mode !== "closed" ? (
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <Clock3 className="h-12 w-12 text-slate-300" aria-hidden />
          <p className="text-sm font-extrabold text-slate-600">لا توجد وردية مفتوحة</p>
          <p className="text-xs font-bold text-slate-400">افتح وردية لبدء البيع — الدفع يتطلب وردية مفتوحة</p>
          <Button
            variant="saffron"
            size="lg"
            onClick={openShiftNow}
            loading={openingShift}
            disabled={!online}
            title={online ? undefined : "فتح الوردية يتطلب اتصالًا بالخادم"}
          >
            فتح وردية
          </Button>
          {!online ? <p className="text-[11px] font-bold text-amber-700">غير متاح بلا اتصال</p> : null}
        </div>
      ) : null}

      {shiftId && mode === "info" ? (
        <div>
          <div className="mb-4 rounded-2xl bg-slate-50 px-4 py-3">
            <p className="text-xs font-bold text-slate-400">الوردية الحالية</p>
            <p className="text-lg font-extrabold text-ink">
              <Money value={shiftId} />
            </p>
          </div>

          {online ? (
            summary ? (
              <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-slate-200 p-3">
                  <p className="mb-2 text-xs font-extrabold text-slate-500">طلبات V2 حسب الحالة</p>
                  {Object.keys(summary.byStatus).length === 0 ? (
                    <p className="text-xs text-slate-400">لا طلبات بعد</p>
                  ) : (
                    <ul className="space-y-1 text-sm">
                      {Object.entries(summary.byStatus).map(([status, v]) => (
                        <li key={status} className="flex justify-between">
                          <span className="font-bold text-slate-600">{STATUS_LABELS[status] ?? status}</span>
                          <span className="font-extrabold text-ink">
                            <Money value={fmtInt(v.count)} /> · <Money value={fmt2(v.amount)} /> ر.س
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="rounded-2xl border border-slate-200 p-3">
                  <p className="mb-2 text-xs font-extrabold text-slate-500">المكتمل حسب طريقة الدفع</p>
                  {Object.keys(summary.completedByMethod).length === 0 ? (
                    <p className="text-xs text-slate-400">لا مدفوعات بعد</p>
                  ) : (
                    <ul className="space-y-1 text-sm">
                      {Object.entries(summary.completedByMethod).map(([method, amount]) => (
                        <li key={method} className="flex justify-between">
                          <span className="font-bold text-slate-600">{METHOD_LABELS[method] ?? method}</span>
                          <span className="font-extrabold text-ink">
                            <Money value={fmt2(amount)} /> ر.س
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

          {error ? <ErrorBanner message={error} /> : null}

          <Button
            variant="secondary"
            className="mt-2 w-full"
            onClick={() => void printReport("X", shiftId)}
            loading={printing}
            disabled={!online}
            title={online ? "لقطة منتصف الوردية — المتوقع حسب طريقة الدفع" : "تقرير X يتطلب اتصالًا بالخادم"}
          >
            <Printer className="h-4 w-4" aria-hidden />
            تقرير X — طباعة
          </Button>

          <Button
            variant="dark"
            size="lg"
            className="mt-2 w-full"
            onClick={() => void startClosing()}
            loading={busy}
            disabled={!online}
            title={online ? "بدء إغلاق الوردية" : "إغلاق الوردية يتطلب اتصالًا بالخادم"}
          >
            <Lock className="h-4 w-4" aria-hidden />
            إغلاق الوردية
          </Button>
          {!online ? (
            <p className="mt-2 text-center text-[11px] font-bold text-amber-700">إغلاق الوردية غير متاح بلا اتصال</p>
          ) : null}
        </div>
      ) : null}

      {mode === "closing" && closing ? (
        <div>
          <p className="mb-3 text-xs font-bold text-slate-500">
            أدخل المبالغ المعدودة فعليًا لكل طريقة دفع — <span className="num">{fmtInt(closing.orderCount)}</span> فاتورة في
            الوردية
          </p>

          {/* ── Physical cash count — the SAMA denomination grid ── */}
          {cashMethod ? (
            <details className="mb-3 rounded-2xl border border-slate-200" open>
              <summary className="cursor-pointer select-none px-3 py-2.5 text-xs font-extrabold text-slate-600">
                عدّ النقدية بالفئات (كاش){" "}
                {denomsUsed ? (
                  <span className="ms-1 rounded-lg bg-teal-50 px-2 py-0.5 text-teal-700">
                    <Money value={fmt2(denomSum)} /> ر.س
                  </span>
                ) : null}
              </summary>
              <div className="grid grid-cols-3 gap-1.5 px-3 pb-3 sm:grid-cols-5" data-testid="denom-grid">
                {CASH_DENOMS.map((d) => {
                  const key = String(d);
                  const count = Number(denoms[key]) || 0;
                  const face = d < 1 ? `${Math.round(d * 100)} هللة` : `${d} ر.س`;
                  return (
                    <label key={key} className="rounded-xl border border-slate-200 p-1.5 text-center">
                      <span className="block text-[10px] font-extrabold text-slate-500">
                        <span className="num">{face}</span>
                        <span className="ms-1 text-slate-300">{d >= 5 ? "ورقة" : "عملة"}</span>
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
                        aria-label={`عدد ${face}`}
                        className="field num mt-1 h-9 w-full px-1 text-center text-sm"
                        dir="ltr"
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

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-[11px] font-extrabold text-slate-400">
                  <th className="py-2 text-start">الطريقة</th>
                  <th className="py-2 text-start">المعدود</th>
                  {revealed ? <th className="py-2 text-start">المتوقع</th> : null}
                  {revealed ? <th className="py-2 text-start">الفرق</th> : null}
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
                        {isCashDriven ? <span className="ms-1 text-[10px] font-bold text-teal-600">من عدّ الفئات</span> : null}
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
                          aria-label={`المعدود — ${m.nameAr || m.name}`}
                          className={cn("field num w-32", isCashDriven && "bg-slate-50 text-slate-500")}
                          dir="ltr"
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
                          {actual > 0 || touched ? null : <span className="ms-1 text-[10px] text-slate-300">لم يُعد</span>}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="text-sm font-extrabold">
                  <td className="py-2.5 text-ink">الإجمالي</td>
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
            <span className="text-xs font-extrabold text-slate-700">
              أنهيت العدّ وأدخلت المبالغ — أظهر مقارنة النظام
            </span>
          </label>
          {!revealed ? (
            <p className="mt-1 text-[11px] font-bold text-slate-400">
              المبالغ المتوقعة مخفية أثناء العدّ حتى لا يتأثر العدّ الفعلي بها.
            </p>
          ) : null}

          {revealed && closing.unmatchedTotal > 0 ? (
            <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-800">
              مبالغ غير مطابقة لأي طريقة: <Money value={fmt2(closing.unmatchedTotal)} /> ر.س — راجع الإدارة
            </p>
          ) : null}

          <label className="mt-3 block">
            <span className="mb-1 block text-[11px] font-extrabold text-slate-500">
              ملاحظات الإغلاق
              {totalVariance !== 0 ? <span className="ms-1 text-red-600">— يوجد فرق: اشرح السبب (١٠ أحرف على الأقل)</span> : null}
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

          <div className="mt-4 flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => setMode("info")} disabled={busy}>
              رجوع
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
              {closeLocked && !busy ? closeLockReason : "تأكيد إغلاق الوردية"}
            </Button>
          </div>
        </div>
      ) : null}

      {mode === "closed" && result ? (
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <CheckCircle2 className="h-14 w-14 text-teal-500" aria-hidden />
          <p className="text-lg font-extrabold text-ink">أُغلقت الوردية</p>
          <div className="w-full overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-[11px] font-extrabold text-slate-400">
                  <th className="py-2 text-start">الطريقة</th>
                  <th className="py-2 text-start">المتوقع</th>
                  <th className="py-2 text-start">الفعلي</th>
                  <th className="py-2 text-start">الفرق</th>
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
          <p className="text-sm font-extrabold">
            الفرق الكلي:{" "}
            <Money
              value={`${(result.variance ?? 0) > 0 ? "+" : ""}${fmt2(result.variance ?? 0)}`}
              className={(result.variance ?? 0) === 0 ? "text-teal-600" : (result.variance ?? 0) > 0 ? "text-teal-600" : "text-red-600"}
            />{" "}
            ر.س
          </p>
          <div className="grid w-full grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => void printReport("Z", closedShiftId)} loading={printing}>
              <Printer className="h-4 w-4" aria-hidden />
              طباعة تقرير Z
            </Button>
            <Button variant="secondary" onClick={shareWhatsApp}>
              <MessageCircle className="h-4 w-4" aria-hidden />
              مشاركة واتساب
            </Button>
          </div>
          <Button variant="primary" size="lg" className="w-full" onClick={onClose}>
            تم
          </Button>
        </div>
      ) : null}
    </Dialog>
  );
}
