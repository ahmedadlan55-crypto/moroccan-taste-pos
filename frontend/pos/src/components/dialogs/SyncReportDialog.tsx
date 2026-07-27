/**
 * SyncReportDialog — two tabs on ONE overlay.
 *
 *  «المزامنة»       last flush results (per-op ok/replayed/failed), the queued
 *                   ops count, and a manual "مزامنة الآن" trigger.
 *  «سجل الإخفاقات»  the DURABLE failure log (lib/failureLog.ts).
 *
 * Why the second tab exists: the first one renders `engineStatus.lastReport`,
 * which is a field in memory on the engine singleton. A reload, a kiosk
 * auto-update, or simply the next flush overwriting it erases the only record
 * that a queued sale failed permanently — so a shift manager could not find out
 * WHICH sale was lost or WHY. failureLog.ts persists that to localStorage; this
 * tab is where a human reads it.
 *
 * A tab — deliberately not a new dialog: App.tsx's `overlayOpen` union gates
 * F2/F4/F9 AND the idle PWA auto-reload, and `syncOpen` is already a member of
 * it. Adding a fourteenth overlay would have meant adding a fourteenth term to
 * that union, and a dialog that is open while the union says otherwise can have
 * the kiosk reload underneath the cashier.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { CheckCircle2, CloudOff, RefreshCw, RotateCw, ShieldAlert, Trash2, XCircle } from "lucide-react";
import { useT } from "@/i18n/I18nProvider";
import { usePos } from "@/state/store";
import { fmt2, fmtDateTime, fmtInt, shortRef } from "@/lib/format";
import { clearFailures, MAX_ENTRIES, readFailures, subscribeFailures } from "@/lib/failureLog";
import type { QueueOp } from "@/lib/types";
import { Dialog } from "../Dialog";
import { Button, cn, EmptyState, Money } from "../ui";

type Tab = "sync" | "failures";

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
  const { engine, engineStatus, supervisor, user } = usePos();
  const { online, syncing, queueCount, orphanCount, orphanSaleCount, orphanActors, lastReport } = engineStatus;
  const [pending, setPending] = useState<QueueOp[]>([]);
  const [tab, setTab] = useState<Tab>("sync");
  /** Inline two-step confirm rather than window.confirm — the same pattern the
   *  held-orders void reason uses, and the only one that works on a kiosk. */
  const [confirmClear, setConfirmClear] = useState(false);
  const failures = useSyncExternalStore(subscribeFailures, readFailures);

  const opLabel = (type: string) => {
    const key = OP_LABEL_KEYS[type];
    return key ? t(key) : type;
  };

  useEffect(() => {
    if (open) void engine.queuedOps().then(setPending);
  }, [open, engine, queueCount, syncing]);

  // Every open starts on the sync tab with no armed destructive action.
  useEffect(() => {
    if (!open) return;
    setTab("sync");
    setConfirmClear(false);
  }, [open]);

  return (
    <Dialog open={open} onClose={onClose} title={t("syncReportDialog.title")} widthClass="max-w-lg">
      <div className="mb-4 grid grid-cols-2 gap-1.5 rounded-2xl bg-slate-100 p-1" role="tablist" aria-label={t("syncReportDialog.tabs.ariaLabel")}>
        {(["sync", "failures"] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn(
              "btn-press flex min-h-11 items-center justify-center gap-1.5 rounded-xl px-3 text-xs font-extrabold",
              tab === key ? "bg-white text-ink shadow-sm" : "text-slate-500 hover:text-slate-700",
            )}
          >
            {key === "failures" ? <ShieldAlert className="h-3.5 w-3.5" aria-hidden /> : null}
            {t(`syncReportDialog.tabs.${key}`)}
            {key === "failures" && failures.length > 0 ? (
              <span className="chip border-red-200 bg-red-50 text-red-700">
                <span className="num">{fmtInt(failures.length)}</span>
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {tab === "failures" ? (
        <FailuresTab
          failures={failures}
          supervisor={supervisor}
          confirmClear={confirmClear}
          setConfirmClear={setConfirmClear}
        />
      ) : (
        <>
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

      {/* Withheld ops (lib/offline.ts splitByActor). Explained here in full,
          because the header chip only has room for a count — and because the
          resolution is a PERSON, not a button: nothing this cashier can tap
          will release another cashier's work. Saying so plainly beats the raw
          «هذا الطلب يخص كاشيرًا آخر» the server used to repeat once per op. */}
      {orphanCount > 0 ? (
        <div
          data-testid="orphan-queue-note"
          className="mb-4 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900"
        >
          <p className="font-extrabold">
            {t("syncReportDialog.orphans.heading", { count: orphanCount, who: orphanActors.join("، ") })}
          </p>
          {orphanSaleCount > 0 ? (
            <p className="mt-1 font-bold">{t("syncReportDialog.orphans.sales", { count: orphanSaleCount })}</p>
          ) : null}
          <p className="mt-1 font-bold text-amber-800">{t("syncReportDialog.orphans.howTo")}</p>
        </div>
      ) : null}

      {pending.length > 0 ? (
        <div className="mb-4">
          <p className="mb-2 text-xs font-extrabold text-slate-500">{t("syncReportDialog.queue.heading")}</p>
          <ul className="space-y-1">
            {pending.map((op) => {
              const foreign = !!op.actor && !!user && op.actor !== user.username;
              return (
              <li
                key={op.opId}
                className={cn(
                  "flex items-center justify-between rounded-xl border px-3 py-2 text-xs",
                  foreign ? "border-amber-200 bg-amber-50/60" : "border-slate-100",
                )}
              >
                <span className="font-extrabold text-slate-600">
                  {opLabel(op.type)}
                  <span className="ms-2 font-bold text-slate-400">
                    {t("syncReportDialog.order")} <Money value={shortRef(op.orderId)} />
                  </span>
                  {foreign ? (
                    <span className="ms-2 font-bold text-amber-800">{t("syncReportDialog.orphans.byTag", { who: op.actor ?? "" })}</span>
                  ) : null}
                </span>
                <Money value={fmtDateTime(op.ts)} className="font-bold text-slate-400" />
              </li>
              );
            })}
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
        </>
      )}
    </Dialog>
  );
}

/**
 * The durable log. Read-only for a cashier by design: the whole point is that
 * whoever lost the sale cannot make the evidence disappear. Clearing is gated
 * on `supervisor`, and even then it is a two-tap confirm.
 */
function FailuresTab({
  failures,
  supervisor,
  confirmClear,
  setConfirmClear,
}: {
  failures: ReturnType<typeof readFailures>;
  supervisor: boolean;
  confirmClear: boolean;
  setConfirmClear: (v: boolean) => void;
}) {
  const t = useT();
  return (
    <div data-testid="sync-report-failures">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-extrabold text-slate-600">{t("syncReportDialog.failures.heading")}</p>
          <p className="mt-0.5 text-[11px] font-bold text-slate-400">
            {t("syncReportDialog.failures.hint", { max: MAX_ENTRIES })}
          </p>
        </div>
        {confirmClear ? (
          <div className="flex shrink-0 gap-1.5">
            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                clearFailures();
                setConfirmClear(false);
              }}
            >
              {t("syncReportDialog.failures.clearConfirm")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmClear(false)}>
              {t("syncReportDialog.failures.clearCancel")}
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            className="shrink-0"
            disabled={!supervisor || failures.length === 0}
            title={supervisor ? t("syncReportDialog.failures.clearTitle") : t("syncReportDialog.failures.clearNotAllowed")}
            onClick={() => setConfirmClear(true)}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
            {t("syncReportDialog.failures.clear")}
          </Button>
        )}
      </div>

      {failures.length === 0 ? (
        <EmptyState
          icon={<ShieldAlert className="h-8 w-8" aria-hidden />}
          title={t("syncReportDialog.failures.empty.title")}
          hint={t("syncReportDialog.failures.empty.hint")}
        />
      ) : (
        <ul className="space-y-1.5">
          {failures.map((f) => (
            <li key={f.id} className="rounded-xl border border-red-100 bg-red-50/50 px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                <span className="chip border-red-200 bg-white text-[10px] text-red-700">
                  {t(`syncReportDialog.failures.kind.${f.kind}`)}
                </span>
                <Money value={fmtDateTime(f.at)} className="text-[11px] font-bold text-slate-400" />
              </div>
              <p className="mt-1 break-words text-xs font-extrabold text-red-700">{f.message}</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] font-bold text-slate-400">
                {f.orderId ? (
                  <span>
                    {t("syncReportDialog.failures.order")} <Money value={shortRef(f.orderId)} />
                  </span>
                ) : null}
                {f.reference ? (
                  <span>
                    {t("syncReportDialog.failures.reference")} <Money value={f.reference} />
                  </span>
                ) : null}
                {f.code ? <Money value={f.code} className="rounded bg-white px-1" /> : null}
                {f.total != null ? (
                  <span>
                    <Money value={fmt2(f.total)} /> {t("syncReportDialog.failures.currency")}
                  </span>
                ) : null}
                {f.cashier ? (
                  <span>
                    {t("syncReportDialog.failures.cashier")}: {f.cashier}
                  </span>
                ) : null}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
