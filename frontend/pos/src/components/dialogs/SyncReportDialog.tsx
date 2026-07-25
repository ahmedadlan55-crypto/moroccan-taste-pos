/**
 * SyncReportDialog — last flush results (per-op ok/replayed/failed), queued
 * ops count, and a manual "مزامنة الآن" trigger.
 */
import { useEffect, useState } from "react";
import { CheckCircle2, CloudOff, RefreshCw, RotateCw, XCircle } from "lucide-react";
import { useT } from "@/i18n/I18nProvider";
import { usePos } from "@/state/store";
import { fmtDateTime, fmtInt, shortRef } from "@/lib/format";
import type { QueueOp } from "@/lib/types";
import { Dialog } from "../Dialog";
import { Button, cn, EmptyState, Money } from "../ui";

const OP_LABEL_KEYS: Record<string, string> = {
  upsert: "syncReportDialog.opLabels.upsert",
  hold: "syncReportDialog.opLabels.hold",
  resume: "syncReportDialog.opLabels.resume",
  reopen: "syncReportDialog.opLabels.reopen",
  void: "syncReportDialog.opLabels.void",
  complete: "syncReportDialog.opLabels.complete",
  "submit-and-sale": "syncReportDialog.opLabels.submitAndSale",
};

export function SyncReportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const { engine, engineStatus } = usePos();
  const { online, syncing, queueCount, lastReport } = engineStatus;
  const [pending, setPending] = useState<QueueOp[]>([]);

  const opLabel = (type: string) => {
    const key = OP_LABEL_KEYS[type];
    return key ? t(key) : type;
  };

  useEffect(() => {
    if (open) void engine.queuedOps().then(setPending);
  }, [open, engine, queueCount, syncing]);

  return (
    <Dialog open={open} onClose={onClose} title={t("syncReportDialog.title")} widthClass="max-w-lg">
      <div className="mb-4 flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3">
        <div className="text-sm font-extrabold text-slate-600">
          {online ? t("syncReportDialog.status.online") : (
            <span className="flex items-center gap-1.5 text-amber-800">
              <CloudOff className="h-4 w-4" aria-hidden /> {t("syncReportDialog.status.offline")}
            </span>
          )}
          <p className="mt-0.5 text-[11px] font-bold text-slate-400">
            <span className="num">{fmtInt(queueCount)}</span> {t("syncReportDialog.status.queueLabel")}
          </p>
        </div>
        <Button size="sm" variant="primary" onClick={() => void engine.flush()} loading={syncing} disabled={!online}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          {t("syncReportDialog.sync.now")}
        </Button>
      </div>

      {pending.length > 0 ? (
        <div className="mb-4">
          <p className="mb-2 text-xs font-extrabold text-slate-500">{t("syncReportDialog.queue.heading")}</p>
          <ul className="space-y-1">
            {pending.map((op) => (
              <li key={op.opId} className="flex items-center justify-between rounded-xl border border-slate-100 px-3 py-2 text-xs">
                <span className="font-extrabold text-slate-600">
                  {opLabel(op.type)}
                  <span className="ms-2 font-bold text-slate-400">
                    {t("syncReportDialog.order")} <Money value={shortRef(op.orderId)} />
                  </span>
                </span>
                <Money value={fmtDateTime(op.ts)} className="font-bold text-slate-400" />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="mb-2 text-xs font-extrabold text-slate-500">
        {t("syncReportDialog.lastSync")} {lastReport ? <Money value={fmtDateTime(lastReport.at)} className="font-bold text-slate-400" /> : null}
      </p>
      {!lastReport ? (
        <EmptyState icon={<RotateCw className="h-8 w-8" aria-hidden />} title={t("syncReportDialog.empty.title")} hint={t("syncReportDialog.empty.hint")} />
      ) : (
        <ul className="space-y-1">
          {lastReport.results.map((r) => (
            <li
              key={r.opId}
              className={cn(
                "flex items-center justify-between rounded-xl border px-3 py-2 text-xs",
                r.ok ? "border-teal-100 bg-teal-50/50" : "border-red-100 bg-red-50/50",
              )}
            >
              <span className="flex items-center gap-1.5 font-extrabold text-slate-600">
                {r.ok ? (
                  <CheckCircle2 className="h-4 w-4 text-teal-500" aria-hidden />
                ) : (
                  <XCircle className="h-4 w-4 text-red-500" aria-hidden />
                )}
                {opLabel(r.type)}
                <span className="font-bold text-slate-400">
                  {t("syncReportDialog.order")} <Money value={shortRef(r.orderId)} />
                </span>
                {r.replay ? <span className="chip border-slate-200 bg-white text-slate-400">{t("syncReportDialog.result.replayed")}</span> : null}
              </span>
              <span className={cn("font-bold", r.ok ? "text-teal-600" : "text-red-600")}>
                {r.ok ? t("syncReportDialog.result.succeeded") : r.error || r.code || t("syncReportDialog.result.failed")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
