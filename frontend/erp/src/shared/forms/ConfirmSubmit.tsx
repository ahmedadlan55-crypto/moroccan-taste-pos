import { useState, type ReactNode } from "react";
import { Button, AlertDialog } from "@/shared/ui";

export interface ConfirmSubmitProps {
  /** Runs after the user confirms. Return a promise to show the busy state. */
  onConfirm: () => void | Promise<unknown>;
  label: ReactNode;
  confirmTitle: string;
  confirmDescription?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "primary" | "danger";
  disabled?: boolean;
}

/**
 * A submit button guarded by an AlertDialog — for dangerous / irreversible form
 * actions (post, reverse, delete). Handles the busy state around an async
 * onConfirm and closes on completion.
 */
export function ConfirmSubmit({
  onConfirm,
  label,
  confirmTitle,
  confirmDescription,
  confirmLabel,
  cancelLabel,
  tone = "danger",
  disabled = false,
}: ConfirmSubmitProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      await onConfirm();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant={tone === "danger" ? "danger" : "primary"}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
      <AlertDialog
        open={open}
        title={confirmTitle}
        description={confirmDescription}
        confirmLabel={confirmLabel}
        cancelLabel={cancelLabel}
        tone={tone}
        processing={busy}
        onConfirm={run}
        onClose={() => !busy && setOpen(false)}
      />
    </>
  );
}
