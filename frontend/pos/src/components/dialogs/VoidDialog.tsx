/**
 * VoidDialog — voiding the CURRENT cart requires a reason (server contract:
 * POST /orders/:id/void {reason} is mandatory). Purely-local drafts just
 * evaporate; synced orders queue/send the void op.
 */
import { useEffect, useState } from "react";
import { XCircle } from "lucide-react";
import { useT } from "@/i18n/I18nProvider";
import { Dialog } from "../Dialog";
import { Button } from "../ui";

export function VoidDialog({
  open,
  onClose,
  onConfirm,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  busy: boolean;
}) {
  const t = useT();
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (open) setReason("");
  }, [open]);

  return (
    <Dialog open={open} onClose={onClose} title={t("voidDialog.title")} widthClass="max-w-md" locked={busy}>
      <p className="mb-3 text-sm font-bold text-slate-500">{t("voidDialog.description")}</p>
      <label className="block">
        <span className="mb-1 block text-[11px] font-extrabold text-slate-500">{t("voidDialog.reason.label")}</span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          maxLength={300}
          placeholder={t("voidDialog.reason.placeholder")}
          className="field min-h-[5rem] py-2"
        />
      </label>
      <div className="mt-4 flex gap-2">
        <Button variant="secondary" className="flex-1" onClick={onClose} disabled={busy}>
          {t("voidDialog.actions.cancel")}
        </Button>
        <Button
          variant="danger"
          className="flex-[2]"
          disabled={!reason.trim()}
          loading={busy}
          onClick={() => onConfirm(reason.trim())}
        >
          <XCircle className="h-4 w-4" aria-hidden />
          {t("voidDialog.actions.confirm")}
        </Button>
      </div>
    </Dialog>
  );
}
