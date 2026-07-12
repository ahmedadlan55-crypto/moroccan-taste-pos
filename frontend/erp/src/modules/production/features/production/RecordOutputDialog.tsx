import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { PackagePlus } from "lucide-react";
import { Button } from "@/shared/ui";
import { formatCurrency, formatQty } from "@/shared/lib";
import { useProductionMutations } from "@/modules/inventory/lib/hooks/useProduction";
import type { ProductionDetail } from "@/modules/inventory/lib/adapters/production.adapter";
import { ApiError } from "@/shared/api";

// Partial output event: good qty enters the OUTPUT warehouse at
// u = WIP / remainingExpected; waste is expensed in full (5122) and never
// enters stock. A tracked finished product requires a batch number (and an
// expiry date in 'expiry' mode).
export function RecordOutputDialog({
  open, detail, trackingMode, onClose, onDone,
}: {
  open: boolean;
  detail: ProductionDetail;
  trackingMode: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { recordOutput } = useProductionMutations();
  const [goodQty, setGoodQty] = useState("");
  const [wasteQty, setWasteQty] = useState("");
  const [wasteReason, setWasteReason] = useState("");
  const [batchNumber, setBatchNumber] = useState("");
  const [expiryDate, setExpiryDate] = useState("");

  const o = detail.order;
  const remaining = Math.max(o.qtyPlanned - o.qtyProduced - o.qtyWaste, 0);

  useEffect(() => {
    if (!open) return;
    setGoodQty(remaining > 0 ? String(remaining) : "");
    setWasteQty(""); setWasteReason("");
    setBatchNumber(o.batchNumber ?? ""); setExpiryDate("");
    recordOutput.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const good = Number(goodQty) || 0;
  const waste = Number(wasteQty) || 0;
  const tracked = trackingMode !== "none";
  const projectedUnit = useMemo(() => {
    const rem = Math.max(o.qtyPlanned - o.qtyProduced - o.qtyWaste, good + waste);
    return rem > 0 ? o.wipBalance / rem : 0;
  }, [o, good, waste]);

  const invalid =
    good + waste <= 0
    || (waste > 0 && wasteReason.trim().length < 3)
    || (tracked && good > 0 && !batchNumber.trim())
    || (trackingMode === "expiry" && good > 0 && !expiryDate);

  const errMsg = recordOutput.error instanceof ApiError ? recordOutput.error.message : recordOutput.error?.message ?? null;

  async function submit() {
    await recordOutput.mutateAsync({
      id: o.id,
      goodQty: good,
      wasteQty: waste || undefined,
      wasteReason: waste > 0 ? wasteReason.trim() : undefined,
      batchNumber: tracked ? batchNumber.trim() : undefined,
      expiryDate: trackingMode === "expiry" ? expiryDate : undefined,
      expectedVersion: o.version,
    });
    onDone();
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[70] bg-slate-950/40" onClick={() => !recordOutput.isPending && onClose()} aria-hidden="true" />
          <motion.div
            initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 16 }}
            role="dialog" aria-modal="true" aria-label="تسجيل إنتاج"
            className="fixed inset-x-3 top-[10vh] z-[80] mx-auto max-h-[80vh] max-w-xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl"
          >
            <div className="flex items-center gap-2">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-50 text-emerald-700"><PackagePlus className="h-5 w-5" /></span>
              <div>
                <h3 className="text-lg font-extrabold text-slate-900">تسجيل إنتاج — {o.number}</h3>
                <p className="text-xs font-medium text-slate-500">
                  المنجز {formatQty(o.qtyProduced)} + هدر {formatQty(o.qtyWaste)} من مخطط {formatQty(o.qtyPlanned, o.productUnit)} · WIP {formatCurrency(o.wipBalance)}
                </p>
              </div>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="block text-xs font-bold text-slate-500">
                الكمية الجيدة (تدخل {o.outputWarehouseName})
                <input type="number" min="0" step="any" dir="ltr" className="field mt-1 w-full tabular-nums" value={goodQty} onChange={(e) => setGoodQty(e.target.value)} aria-label="الكمية الجيدة" />
              </label>
              <label className="block text-xs font-bold text-slate-500">
                كمية الهدر (تُصرف كمصروف — لا تدخل المخزون)
                <input type="number" min="0" step="any" dir="ltr" className="field mt-1 w-full tabular-nums" value={wasteQty} onChange={(e) => setWasteQty(e.target.value)} aria-label="كمية الهدر" />
              </label>
              {waste > 0 && (
                <label className="block text-xs font-bold text-slate-500 sm:col-span-2">
                  سبب الهدر (إلزامي)
                  <input className="field mt-1 w-full" value={wasteReason} onChange={(e) => setWasteReason(e.target.value)} placeholder="مثال: كسر أثناء التعبئة" aria-label="سبب الهدر" />
                  {o.allowedScrapPct > 0 && (
                    <span className="mt-1 block text-[11px] font-medium text-amber-600">
                      السماحية {o.allowedScrapPct}% من المخطط — تجاوزها يتطلب مديرًا.
                    </span>
                  )}
                </label>
              )}
              {tracked && (
                <label className="block text-xs font-bold text-slate-500">
                  رقم دفعة المنتج (إلزامي)
                  <input className="field mt-1 w-full" value={batchNumber} onChange={(e) => setBatchNumber(e.target.value)} aria-label="رقم الدفعة" />
                </label>
              )}
              {trackingMode === "expiry" && (
                <label className="block text-xs font-bold text-slate-500">
                  تاريخ الصلاحية (إلزامي)
                  <input type="date" className="field mt-1 w-full" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} aria-label="تاريخ الصلاحية" />
                </label>
              )}
            </div>

            {(good + waste) > 0 && (
              <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                <PreviewCell label="تكلفة الوحدة المتوقعة" value={formatCurrency(projectedUnit)} />
                <PreviewCell label="قيمة الجيد" value={formatCurrency(good * projectedUnit)} />
                <PreviewCell label="قيمة الهدر (مصروف)" value={formatCurrency(waste * projectedUnit)} tone={waste > 0 ? "rose" : undefined} />
              </div>
            )}

            {errMsg && <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{errMsg}</p>}

            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose} disabled={recordOutput.isPending}>إغلاق</Button>
              <Button variant="primary" disabled={recordOutput.isPending || invalid} onClick={() => void submit()}>
                {recordOutput.isPending ? "جارٍ التسجيل…" : "تسجيل الإنتاج"}
              </Button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function PreviewCell({ label, value, tone }: { label: string; value: string; tone?: "rose" }) {
  return (
    <div className={`rounded-xl border p-2 ${tone === "rose" ? "border-rose-200 bg-rose-50" : "border-slate-200 bg-slate-50"}`}>
      <div className="text-[10px] font-bold text-slate-400">{label}</div>
      <div className={`mt-0.5 text-sm font-extrabold tabular-nums ${tone === "rose" ? "text-rose-700" : "text-slate-900"}`}>{value}</div>
    </div>
  );
}
