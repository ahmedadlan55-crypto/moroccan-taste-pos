import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Dialog } from "./dialog";
import { Button } from "./button";

export interface AlertDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "primary" | "danger";
  processing?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * A focused yes/no confirmation for destructive or irreversible actions.
 * Built on Dialog (focus trap, Esc, portal). For an action that needs a MANDATORY
 * reason, use ConfirmDialog instead.
 */
export function AlertDialog({
  open,
  title,
  description,
  confirmLabel = "تأكيد",
  cancelLabel = "إلغاء",
  tone = "primary",
  processing = false,
  onConfirm,
  onClose,
}: AlertDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      presentation="compact"
      hideClose
      dismissable={!processing}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={processing}>
            {cancelLabel}
          </Button>
          <Button variant={tone === "danger" ? "danger" : "primary"} onClick={onConfirm} loading={processing}>
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
          <h2 className="text-base font-extrabold text-slate-900">{title}</h2>
          {description && <div className="mt-1 text-sm font-medium text-slate-500">{description}</div>}
        </div>
      </div>
    </Dialog>
  );
}
