/**
 * ShiftDialog — open a shift, review the V2 summary, and run the close flow:
 * GET /api/shifts/closing-data-v3/:shiftId → per-method counted inputs →
 * live variance rows (green/red) → POST /api/shifts/close-v3 → result.
 * Shift open/close REQUIRE a connection (forbidden offline by design).
 */
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Clock3, Lock } from "lucide-react";
import { usePos } from "@/state/store";
import { closingDataV3, closeShiftV3, shiftSummary } from "@/lib/api";
import { round2 } from "@/lib/cartMath";
import { fmt2, fmtInt } from "@/lib/format";
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

export function ShiftDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { shiftId, engineStatus, openShiftNow, openingShift, onShiftClosed, pushToast } = usePos();
  const online = engineStatus.online;
  const [mode, setMode] = useState<Mode>("info");
  const [summary, setSummary] = useState<ShiftSummary | null>(null);
  const [closing, setClosing] = useState<ClosingDataV3 | null>(null);
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CloseV3Result | null>(null);

  useEffect(() => {
    if (!open) return;
    setMode("info");
    setError(null);
    setResult(null);
    setNotes("");
    setCounted({});
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
      setMode("closing");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

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

  async function confirmClose() {
    if (!shiftId || !closing) return;
    setBusy(true);
    setError(null);
    try {
      // paymentTotals keyed by String(method.id) — id keys win server-side.
      // denominations stay [] + openingFloat 0 so paymentTotals is the single
      // source of the counted cash (denominations>0 would OVERRIDE it).
      const res = await closeShiftV3({
        shiftId,
        openingFloat: 0,
        denominations: [],
        paymentTotals: Object.fromEntries(varianceRows.map((r) => [String(r.method.id), r.actual])),
        notes: notes.trim(),
      });
      if (!res.success) throw new Error(res.error || "تعذّر إغلاق الوردية");
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
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-[11px] font-extrabold text-slate-400">
                  <th className="py-2 text-start">الطريقة</th>
                  <th className="py-2 text-start">المتوقع</th>
                  <th className="py-2 text-start">المعدود</th>
                  <th className="py-2 text-start">الفرق</th>
                </tr>
              </thead>
              <tbody>
                {varianceRows.map(({ method: m, actual, variance }) => {
                  const key = String(m.id);
                  const touched = counted[key] !== "";
                  return (
                    <tr key={key} className="border-b border-slate-100">
                      <td className="py-2 font-extrabold text-ink">{m.nameAr || m.name}</td>
                      <td className="py-2">
                        <Money value={fmt2(m.expectedAmount || 0)} className="font-bold text-slate-500" />
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
                          aria-label={`المعدود — ${m.nameAr || m.name}`}
                          className="field num w-32"
                          dir="ltr"
                        />
                      </td>
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
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="text-sm font-extrabold">
                  <td className="py-2.5 text-ink">الإجمالي</td>
                  <td className="py-2.5">
                    <Money value={fmt2(totalExpected)} />
                  </td>
                  <td className="py-2.5">
                    <Money value={fmt2(totalActual)} />
                  </td>
                  <td className="py-2.5">
                    <Money
                      value={`${totalVariance > 0 ? "+" : ""}${fmt2(totalVariance)}`}
                      className={totalVariance === 0 ? "text-teal-600" : totalVariance > 0 ? "text-teal-600" : "text-red-600"}
                    />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {closing.unmatchedTotal > 0 ? (
            <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-800">
              مبالغ غير مطابقة لأي طريقة: <Money value={fmt2(closing.unmatchedTotal)} /> ر.س — راجع الإدارة
            </p>
          ) : null}

          <label className="mt-3 block">
            <span className="mb-1 block text-[11px] font-extrabold text-slate-500">ملاحظات الإغلاق</span>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="field min-h-[4.5rem] py-2" />
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
            <Button variant="dark" className="flex-[2]" onClick={() => void confirmClose()} loading={busy}>
              <Lock className="h-4 w-4" aria-hidden />
              تأكيد إغلاق الوردية
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
          <Button variant="primary" size="lg" className="w-full" onClick={onClose}>
            تم
          </Button>
        </div>
      ) : null}
    </Dialog>
  );
}
