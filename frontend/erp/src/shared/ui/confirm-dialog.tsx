import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Dialog } from "./dialog";
import { Button } from "./button";

// Strong confirmation modal for lifecycle actions: centered dialog, optional
// MANDATORY reason (cancel/reverse), a clear processing state that blocks a
// double-submit, and an inline error slot for a 409/422 returned by the action.
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

  // Reset the reason whenever the dialog opens fresh.
  useEffect(() => {
    if (open) setReason("");
  }, [open]);

  const reasonOk = !requireReason || reason.trim().length >= 3;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      presentation="compact"
      hideClose
      dismissable={!processing}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={processing}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            onClick={() => onConfirm(reason.trim())}
            disabled={!reasonOk}
            loading={processing}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex items-start gap-3">
        <span
          className={
            tone === "danger"
              ? "grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-rose-50 text-rose-600"
              : "grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-teal-50 text-teal-700"
          }
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
            className="field mt-1 min-h-20 w-full resize-y py-2"
            placeholder={reasonPlaceholder}
            value={reason}
            disabled={processing}
            onChange={(e) => setReason(e.target.value)}
          />
          {!reasonOk && reason.length > 0 && (
            <span className="mt-1 block text-xs font-bold text-rose-600">
              السبب يجب أن يكون 3 أحرف على الأقل.
            </span>
          )}
        </label>
      )}

      {error && (
        <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
          {error}
        </div>
      )}
    </Dialog>
  );
}
