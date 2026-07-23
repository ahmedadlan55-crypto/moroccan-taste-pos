import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "@/shared/ui";
import { useT } from "@/i18n";

// A small confirmation modal that REQUIRES a reason — used for cancel and reverse
// (§9: "Confirmation وسبب إلزامي للإلغاء والعكس"). Prevents double-submit while
// the mutation is pending, and shows a server error inline.
export function ReasonDialog({
  open,
  title,
  description,
  confirmLabel,
  tone = "danger",
  pending,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  tone?: "danger" | "primary";
  pending?: boolean;
  error?: string | null;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [reason, setReason] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (open) { setReason(""); setTimeout(() => ref.current?.focus(), 50); }
  }, [open]);
  const tooShort = reason.trim().length < 3;
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[70] bg-slate-950/40" onClick={() => !pending && onClose()} aria-hidden="true" />
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className="fixed inset-x-4 top-1/2 z-[80] mx-auto max-w-md -translate-y-1/2 rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl"
          >
            <h3 className="text-lg font-extrabold text-slate-900">{title}</h3>
            {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
            <label className="mt-4 block text-xs font-bold text-slate-500">
              {t("inventoryRest.reasonDialog.reasonLabel")}
              <textarea
                ref={ref}
                className="field mt-1 min-h-24 w-full"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t("inventoryRest.reasonDialog.placeholder")}
                aria-label={t("inventoryRest.reasonDialog.reasonAria")}
              />
            </label>
            {error && <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{error}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose} disabled={pending}>{t("inventoryRest.reasonDialog.cancel")}</Button>
              <Button variant={tone === "danger" ? "danger" : "primary"} disabled={pending || tooShort} onClick={() => onConfirm(reason.trim())}>
                {pending ? t("inventoryRest.reasonDialog.pending") : confirmLabel}
              </Button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
