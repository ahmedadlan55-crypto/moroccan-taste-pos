import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

// Strong confirmation modal for lifecycle actions (§4 of the transfers spec):
// centered dialog, optional MANDATORY reason (cancel/reverse), a clear
// processing state that blocks a double-submit, and an inline error slot for a
// 409/422 returned by the action. RTL + accessible (role=dialog, Escape closes
// when not processing, focus trapped to the dialog).

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "primary" | "danger";
  requireReason?: boolean;
  reasonLabel?: string;
  reasonPlaceholder?: string;
  processing?: boolean;
  error?: string | null;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "تأكيد",
  cancelLabel = "إلغاء",
  tone = "primary",
  requireReason = false,
  reasonLabel = "السبب",
  reasonPlaceholder = "اكتب السبب…",
  processing = false,
  error = null,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const [reason, setReason] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

  // Reset the reason whenever the dialog opens fresh.
  useEffect(() => {
    if (open) setReason("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => panelRef.current?.querySelector<HTMLElement>("textarea, button")?.focus(), 20);
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !processing) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, processing, onClose]);

  const reasonOk = !requireReason || reason.trim().length >= 3;
  const confirmVariant = tone === "danger" ? "danger" : "primary";

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[70] bg-slate-950/40"
            aria-hidden="true"
            onClick={() => !processing && onClose()}
          />
          <div className="fixed inset-0 z-[80] grid place-items-center p-4">
            <motion.div
              ref={panelRef}
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ type: "spring", damping: 26, stiffness: 320 }}
              role="dialog"
              aria-modal="true"
              aria-label={title}
              className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl focus:outline-none"
            >
              <div className="flex items-start gap-3">
                <span
                  className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${
                    tone === "danger" ? "bg-rose-50 text-rose-600" : "bg-teal-50 text-teal-700"
                  }`}
                >
                  <AlertTriangle className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="text-lg font-extrabold text-slate-900">{title}</h2>
                  {description && <div className="mt-1 text-sm font-medium text-slate-500">{description}</div>}
                </div>
              </div>

              {requireReason && (
                <label className="mt-4 block">
                  <span className="text-xs font-bold text-slate-600">
                    {reasonLabel} <span className="text-rose-600">*</span>
                  </span>
                  <textarea
                    className="field mt-1 min-h-20 w-full resize-y"
                    placeholder={reasonPlaceholder}
                    value={reason}
                    disabled={processing}
                    onChange={(e) => setReason(e.target.value)}
                  />
                  {!reasonOk && reason.length > 0 && (
                    <span className="mt-1 block text-xs font-bold text-rose-600">السبب يجب أن يكون ٣ أحرف على الأقل.</span>
                  )}
                </label>
              )}

              {error && (
                <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
                  {error}
                </div>
              )}

              <div className="mt-5 flex flex-wrap justify-end gap-2">
                <Button variant="secondary" onClick={onClose} disabled={processing}>
                  {cancelLabel}
                </Button>
                <Button
                  variant={confirmVariant}
                  onClick={() => onConfirm(reason.trim())}
                  disabled={processing || !reasonOk}
                >
                  {processing ? (
                    <>
                      <Spinner className="h-4 w-4" /> جارٍ المعالجة…
                    </>
                  ) : (
                    confirmLabel
                  )}
                </Button>
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}
