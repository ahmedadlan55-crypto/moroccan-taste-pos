import { useEffect, useMemo, useState } from "react";
import { PackageCheck } from "lucide-react";
import { Button, FullPageFlow, Spinner } from "@/shared/ui";
import { formatQty } from "@/shared/lib";
import { useT } from "@/i18n";
import type { TransferLine } from "@/modules/inventory/lib/adapters/transfer.adapter";

export interface ReceiveLineInputValue { id: string; qtyReceived: number; }

// Full-page receiving workspace — cumulative partial receipt (§III.6). Two modes:
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
  const t = useT();
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
    <FullPageFlow
      open={open}
      onClose={onClose}
      title={t("inventoryRest.transfers.receive.title")}
      description={t("inventoryRest.transfers.receive.desc")}
      eyebrow={t("inventoryRest.transfers.receive.eyebrow")}
      icon={PackageCheck}
      size="sm"
      dismissable={!processing}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={processing}>{t("common.cancel")}</Button>
          <Button
            variant="primary"
            disabled={!canConfirm}
            onClick={() => onConfirm(mode === "all" ? undefined : partialItems)}
          >
            {processing ? <><Spinner className="h-4 w-4" /> {t("inventoryRest.transfers.receive.processing")}</> : t("inventoryRest.transfers.receive.confirm")}
          </Button>
        </>
      }
    >
      <section className="surface p-5 sm:p-6 lg:p-8">
              {/* Mode toggle */}
              <div className="flex gap-2 rounded-2xl bg-slate-100 p-1.5">
                <button type="button" onClick={() => setMode("all")}
                  className={`min-h-10 flex-1 rounded-xl border px-3 text-xs font-extrabold transition ${mode === "all" ? "border-teal-600 bg-teal-600 text-white" : "border-slate-200 bg-white text-slate-600"}`}>
                  {t("inventoryRest.transfers.receive.modeAll")}
                </button>
                <button type="button" onClick={() => setMode("partial")}
                  className={`min-h-10 flex-1 rounded-xl border px-3 text-xs font-extrabold transition ${mode === "partial" ? "border-teal-600 bg-teal-600 text-white" : "border-slate-200 bg-white text-slate-600"}`}>
                  {t("inventoryRest.transfers.receive.modePartial")}
                </button>
              </div>

              {receivable.length === 0 ? (
                <p className="mt-4 rounded-xl bg-slate-50 p-3 text-center text-sm font-bold text-slate-500">{t("inventoryRest.transfers.receive.nothing")}</p>
              ) : (
                <div className="mt-5 space-y-3">
                  {receivable.map((l) => {
                    const over = (Number(qty[l.id]) || 0) > l.qtyRemaining + 1e-6;
                    return (
                      <div key={l.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
                        <div className="min-w-0">
                          <div className="truncate text-xs font-bold text-slate-800">{l.item.name}</div>
                          <div className="text-[11px] text-slate-400">{t("inventoryRest.transfers.receive.remaining", { qty: formatQty(l.qtyRemaining, l.item.unit) })}</div>
                        </div>
                        {mode === "partial" ? (
                          <div className="text-left">
                            <input
                              type="number" min={0} max={l.qtyRemaining} step="any" disabled={processing}
                              className={`field h-9 w-24 text-center ${over ? "border-rose-400" : ""}`}
                              value={qty[l.id] ?? ""}
                              onChange={(e) => setQty((q) => ({ ...q, [l.id]: e.target.value }))}
                              aria-label={t("inventoryRest.transfers.receive.qtyAria", { name: l.item.name })}
                            />
                            {over && <div className="mt-0.5 text-[10px] font-bold text-rose-600">{t("inventoryRest.transfers.receive.overQty")}</div>}
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

      </section>
    </FullPageFlow>
  );
}
