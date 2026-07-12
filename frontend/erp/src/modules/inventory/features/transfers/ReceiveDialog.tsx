import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { PackageCheck } from "lucide-react";
import { Button } from "@/shared/ui";
import { Spinner } from "@/shared/ui";
import { formatQty } from "@/shared/lib";
import type { TransferLine } from "@/modules/inventory/lib/adapters/transfer.adapter";

export interface ReceiveLineInputValue { id: string; qtyReceived: number; }

// Receive dialog — cumulative partial receipt (§III.6). Two modes:
//   • "كل المتبقي": send no items → the backend receives every line's remainder.
//   • "كميات محددة": per-line inputs, each capped at that line's remaining.
// Over-receipt / duplicates are still rejected server-side; this just keeps the
// UI honest. Returns `undefined` for receive-all, else the per-line deltas.
export function ReceiveDialog({
  open, lines, processing, error, onClose, onConfirm,
}: {
  open: boolean;
  lines: TransferLine[];
  processing: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (items: ReceiveLineInputValue[] | undefined) => void;
}) {
  const receivable = useMemo(() => lines.filter((l) => l.qtyRemaining > 1e-6), [lines]);
  const [mode, setMode] = useState<"all" | "partial">("all");
  const [qty, setQty] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open) {
      setMode("all");
      const init: Record<string, string> = {};
      receivable.forEach((l) => { init[l.id] = String(l.qtyRemaining); });
      setQty(init);
    }
  }, [open, receivable]);

  const partialItems = useMemo<ReceiveLineInputValue[]>(
    () => receivable
      .map((l) => ({ id: l.id, qtyReceived: Number(qty[l.id]) || 0 }))
      .filter((x) => x.qtyReceived > 0),
    [receivable, qty],
  );
  const anyOver = receivable.some((l) => (Number(qty[l.id]) || 0) > l.qtyRemaining + 1e-6);
  const partialValid = mode === "partial" && partialItems.length > 0 && !anyOver;
  const canConfirm = !processing && (mode === "all" ? receivable.length > 0 : partialValid);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[70] bg-slate-950/40" aria-hidden="true" onClick={() => !processing && onClose()} />
          <div className="fixed inset-0 z-[80] grid place-items-center p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ type: "spring", damping: 26, stiffness: 320 }}
              role="dialog" aria-modal="true" aria-label="استلام التحويل"
              className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl"
            >
              <div className="flex items-start gap-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-teal-50 text-teal-700">
                  <PackageCheck className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="text-lg font-extrabold text-slate-900">استلام التحويل</h2>
                  <p className="mt-1 text-sm font-medium text-slate-500">سجّل الكمية الواردة إلى المستودع الوجهة.</p>
                </div>
              </div>

              {/* Mode toggle */}
              <div className="mt-4 flex gap-1">
                <button type="button" onClick={() => setMode("all")}
                  className={`min-h-10 flex-1 rounded-xl border px-3 text-xs font-extrabold transition ${mode === "all" ? "border-teal-600 bg-teal-600 text-white" : "border-slate-200 bg-white text-slate-600"}`}>
                  استلام كل المتبقي
                </button>
                <button type="button" onClick={() => setMode("partial")}
                  className={`min-h-10 flex-1 rounded-xl border px-3 text-xs font-extrabold transition ${mode === "partial" ? "border-teal-600 bg-teal-600 text-white" : "border-slate-200 bg-white text-slate-600"}`}>
                  كميات محددة
                </button>
              </div>

              {receivable.length === 0 ? (
                <p className="mt-4 rounded-xl bg-slate-50 p-3 text-center text-sm font-bold text-slate-500">لا يوجد ما يُستلَم — كل الأصناف مستلمة.</p>
              ) : (
                <div className="mt-3 max-h-64 space-y-2 overflow-y-auto">
                  {receivable.map((l) => {
                    const over = (Number(qty[l.id]) || 0) > l.qtyRemaining + 1e-6;
                    return (
                      <div key={l.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
                        <div className="min-w-0">
                          <div className="truncate text-xs font-bold text-slate-800">{l.item.name}</div>
                          <div className="text-[11px] text-slate-400">المتبقي: {formatQty(l.qtyRemaining, l.item.unit)}</div>
                        </div>
                        {mode === "partial" ? (
                          <div className="text-left">
                            <input
                              type="number" min={0} max={l.qtyRemaining} step="any" disabled={processing}
                              className={`field h-9 w-24 text-center ${over ? "border-rose-400" : ""}`}
                              value={qty[l.id] ?? ""}
                              onChange={(e) => setQty((q) => ({ ...q, [l.id]: e.target.value }))}
                              aria-label={`كمية ${l.item.name}`}
                            />
                            {over && <div className="mt-0.5 text-[10px] font-bold text-rose-600">يتجاوز المتبقي</div>}
                          </div>
                        ) : (
                          <span className="text-xs font-extrabold text-teal-700">{formatQty(l.qtyRemaining)}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {error && <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{error}</div>}

              <div className="mt-5 flex justify-end gap-2">
                <Button variant="secondary" onClick={onClose} disabled={processing}>إلغاء</Button>
                <Button variant="primary" disabled={!canConfirm}
                  onClick={() => onConfirm(mode === "all" ? undefined : partialItems)}>
                  {processing ? <><Spinner className="h-4 w-4" /> جارٍ المعالجة…</> : "تأكيد الاستلام"}
                </Button>
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}
