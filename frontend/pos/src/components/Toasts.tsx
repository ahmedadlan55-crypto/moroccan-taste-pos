/**
 * Toast stack — with ONE asymmetry that matters: a success may vanish on its
 * own, an ERROR may not.
 *
 * THE BUG. `state/store.tsx` treats every toast the same: `setTimeout(… 5000)`
 * drops it, and the push keeps only the last few (`[...t.slice(-3), next]`).
 * So «فشل الدفع» disappeared after five seconds exactly like «تمت الإضافة»,
 * and three quick successes EVICTED the one failure that mattered. On a busy
 * till the only notice a cashier ever got that a sale did not go through was
 * gone before they looked up from the cash drawer.
 *
 * THE FIX, ON THIS SIDE OF THE LINE. The store belongs to another owner, so
 * this component does not depend on the store changing at all: it keeps its own
 * mirror of every error toast it has seen (`sticky` below) and renders errors
 * from the mirror, not from the store array. An error therefore survives both
 * the 5s timer and the eviction cap, and leaves ONLY when the cashier dismisses
 * it. If/when the store also stops auto-dismissing errors, nothing here needs
 * to change — dismissing already clears both sides (`dismissToast` is called
 * either way) and `dismissedIds` stops a store-retained error from being
 * resurrected into the mirror.
 *
 * COLLAPSE. Persistent errors could bury a 390px screen, which would be a worse
 * bug than the one being fixed. So: the newest VISIBLE_ERRORS render in full,
 * the remainder collapse behind one summary row that expands on demand, a
 * «إغلاق كل الأخطاء» control appears as soon as there are two, every message is
 * clamped to four lines, and the whole stack scrolls inside a bounded box
 * instead of growing over the product grid.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Info, X, XCircle } from "lucide-react";
import { useT } from "@/i18n/I18nProvider";
import { usePos, type Toast } from "@/state/store";
import { cn } from "./ui";

const STYLES = {
  success: "border-teal-200 bg-teal-50 text-teal-800",
  error: "border-red-300 bg-red-50 text-red-900",
  info: "border-slate-200 bg-white text-slate-700",
} as const;

const ICONS = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
} as const;

/** Errors rendered in full before the rest collapse into a summary row. Two
 *  already fills roughly a third of a 390×844 screen; past that the cashier can
 *  no longer see what they are selling, which is how a "safety" feature turns
 *  into the outage. */
const VISIBLE_ERRORS = 2;

/** Hard cap on the mirror. A till that has been failing all morning must not
 *  grow an unbounded array; the oldest errors fall off, the newest — the ones
 *  still actionable — stay. */
const MAX_STICKY_ERRORS = 12;

export function Toasts() {
  const t = useT();
  const { toasts, dismissToast } = usePos();

  /** Every error toast seen this session and not yet dismissed, oldest first. */
  const [sticky, setSticky] = useState<Toast[]>([]);
  /** Ids the cashier already dismissed. A store that DOES persist errors would
   *  otherwise keep handing the same toast back, and the mirror would re-adopt
   *  it on the very next render. */
  const dismissedIds = useRef<Set<number>>(new Set());
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const incoming = toasts.filter((toast) => toast.kind === "error" && !dismissedIds.current.has(toast.id));
    if (!incoming.length) return;
    setSticky((prev) => {
      const known = new Set(prev.map((toast) => toast.id));
      // De-duplicated by MESSAGE as well as by id. The store already collapses
      // repeats that overlap in time, but this mirror outlives a store toast's
      // TTL by design, so the same cause recurring on the next 30s flush would
      // otherwise stack a second identical card on top of the first — which is
      // exactly what a failing drain looked like: one wall of red saying one
      // thing. Id-dedup alone cannot see that; these are genuinely new toasts.
      const knownText = new Set(prev.map((toast) => toast.message));
      const added = incoming.filter((toast) => !known.has(toast.id) && !knownText.has(toast.message));
      if (!added.length) return prev; // nothing new — keep the array identity stable
      const next = [...prev, ...added];
      return next.length > MAX_STICKY_ERRORS ? next.slice(next.length - MAX_STICKY_ERRORS) : next;
    });
  }, [toasts]);

  const dismiss = useCallback(
    (id: number) => {
      dismissedIds.current.add(id);
      setSticky((prev) => prev.filter((toast) => toast.id !== id));
      dismissToast(id); // also clear it in the store, in case the store kept it
    },
    [dismissToast],
  );

  const dismissAllErrors = useCallback(() => {
    setSticky((prev) => {
      for (const toast of prev) {
        dismissedIds.current.add(toast.id);
        dismissToast(toast.id);
      }
      return [];
    });
    setExpanded(false);
  }, [dismissToast]);

  // Newest first: the freshest error must never be the one an older one pushes
  // below the fold.
  const errors = [...sticky].reverse();
  // Everything non-error behaves exactly as before — transient, driven entirely
  // by the store's own timer.
  const transient = toasts.filter((toast) => toast.kind !== "error");

  if (!errors.length && !transient.length) return null;

  const shownErrors = expanded ? errors : errors.slice(0, VISIBLE_ERRORS);
  const hiddenErrorCount = errors.length - shownErrors.length;

  return (
    <div
      data-testid="pos-toasts"
      aria-label={t("appShell.toastStack.region")}
      className="scrollbar-thin pointer-events-none fixed inset-x-0 top-3 z-[70] mx-auto flex max-h-[70vh] w-full max-w-md flex-col items-center gap-2 overflow-y-auto px-4"
    >
      {/* Errors — assertive, persistent, dismissible. */}
      {errors.length > 0 ? (
        <div className="flex w-full flex-col gap-2" role="alert" aria-live="assertive">
          {shownErrors.map((toast) => (
            <ToastCard key={toast.id} toast={toast} onDismiss={dismiss} dismissLabel={t("toasts.aria.dismiss")}>
              <span className="mt-1 inline-flex items-center gap-1 rounded-md bg-red-100 px-1.5 py-0.5 text-[10px] font-extrabold text-red-700">
                <AlertTriangle className="h-3 w-3" aria-hidden />
                {t("appShell.toastStack.errorPersists")}
              </span>
            </ToastCard>
          ))}

          {hiddenErrorCount > 0 || expanded ? (
            <button
              type="button"
              data-testid="pos-toasts-more-errors"
              onClick={() => setExpanded((open) => !open)}
              className="pointer-events-auto flex min-h-11 w-full items-center justify-center gap-1.5 rounded-2xl border border-red-200 bg-red-100/70 px-4 text-xs font-extrabold text-red-800 hover:bg-red-100"
            >
              {expanded ? (
                <>
                  <ChevronUp className="h-4 w-4" aria-hidden />
                  {t("appShell.toastStack.hideOlderErrors")}
                </>
              ) : (
                <>
                  <ChevronDown className="h-4 w-4" aria-hidden />
                  {t("appShell.toastStack.showOlderErrors", { count: hiddenErrorCount })}
                </>
              )}
            </button>
          ) : null}

          {errors.length > 1 ? (
            <button
              type="button"
              data-testid="pos-toasts-dismiss-all"
              onClick={dismissAllErrors}
              className="pointer-events-auto flex min-h-11 w-full items-center justify-center gap-1.5 rounded-2xl border border-slate-300 bg-white px-4 text-xs font-extrabold text-slate-600 hover:bg-slate-50"
            >
              <X className="h-4 w-4" aria-hidden />
              {t("appShell.toastStack.dismissAllErrors", { count: errors.length })}
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Success / info — unchanged transient behaviour. */}
      {transient.length > 0 ? (
        <div className="flex w-full flex-col gap-2" aria-live="polite">
          {transient.map((toast) => (
            <ToastCard key={toast.id} toast={toast} onDismiss={dismiss} dismissLabel={t("toasts.aria.dismiss")} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ToastCard({
  toast,
  onDismiss,
  dismissLabel,
  children,
}: {
  toast: Toast;
  onDismiss: (id: number) => void;
  dismissLabel: string;
  children?: ReactNode;
}) {
  const Icon = ICONS[toast.kind];
  return (
    <div
      data-testid={toast.kind === "error" ? "pos-toast-error" : "pos-toast"}
      className={cn(
        "toast-in pointer-events-auto flex w-full items-start gap-2.5 rounded-2xl border px-4 py-3 shadow-lift",
        STYLES[toast.kind],
      )}
      role="status"
    >
      <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        {/* break-words + a line clamp: a 300-character server message must not
            paint over the product grid, but it must still be readable. */}
        <p className="line-clamp-4 break-words text-start text-sm font-bold leading-snug">{toast.message}</p>
        {children}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label={dismissLabel}
        className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg opacity-70 hover:bg-black/5 hover:opacity-100"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
