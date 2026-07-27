/**
 * Cashier V2 — single-screen POS. RTL, touch-first, offline-first.
 * Layout: ≥1024px three columns (categories | products | cart),
 * 768–1023px two columns (categories as top chips), <768px single column
 * with a bottom cart sheet. Keyboard: F2 search, F4 pay, F9 hold, Esc close.
 */
import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AlertTriangle, ChefHat, Loader2, PauseCircle, ShoppingBasket, Store, Tag } from "lucide-react";
import { usePos } from "@/state/store";
import { clearToken } from "@/lib/auth";
import { listOrders } from "@/lib/api";
import { recordFailure } from "@/lib/failureLog";
import { retryImport } from "@/lib/lazyWithRetry";
import {
  initPwa,
  getPwaStatus,
  subscribePwa,
  applyUpdate,
  autoReloadAlreadyTried,
  markAutoReloadTried,
} from "@/lib/pwa";
import { clearImageCache } from "@/lib/offlineImages";
import { runLegacyDrainOnce, getDrainStatus } from "@/lib/legacyDrain";
import { fmt2, fmtInt } from "@/lib/format";
import { buildKitchenTicketHtml, printHtml, resolvePaperWidth } from "@/lib/receipt";
import { parseQtyPrefix, resolveScan } from "@/components/ProductGrid";
import type { LocalOrder } from "@/lib/types";
import { Header } from "@/components/Header";
import { CategoryRail } from "@/components/CategoryRail";
import { ProductGrid, SearchBox } from "@/components/ProductGrid";
import { CartPanel } from "@/components/CartPanel";
import { Toasts } from "@/components/Toasts";
import { Dialog } from "@/components/Dialog";
// ── EAGER: the sell path ────────────────────────────────────────────────────
// Everything a cashier touches to complete or park a sale stays in the entry
// chunk. These must open with zero network on a till that just went offline
// mid-transaction, and they are opened dozens of times an hour.
import { PaymentDialog } from "@/components/dialogs/PaymentDialog";
import { HeldOrdersDialog } from "@/components/dialogs/HeldOrdersDialog";
import { VoidDialog } from "@/components/dialogs/VoidDialog";
import { DiscountDialog } from "@/components/dialogs/DiscountDialog";
// ── LAZY: the rare dialogs ──────────────────────────────────────────────────
// All fourteen dialogs used to sit in the entry chunk — 327 KB raw / 90 KB
// gzip parsed on first paint on till hardware that is, on a good day, a cheap
// Android tablet. These five are opened once a shift at most (stocktake,
// requisitions, my-invoices, shift open/close, sync report), so they are split
// into their own chunks and fetched on first open.
//
// OFFLINE IS UNAFFECTED: every emitted chunk lands in asset-manifest.json,
// which public/sw.js precaches at install — the code is on the device before
// the cashier ever needs it, it just isn't parsed at boot.
//
// The customer add/history dialogs are also rare, but they are mounted by
// CartPanel/CustomerPicker, not here, so splitting them belongs to that owner.
const ShiftDialog = lazy(() => retryImport(() => import("@/components/dialogs/ShiftDialog")).then((m) => ({ default: m.ShiftDialog })));
const SyncReportDialog = lazy(() => retryImport(() => import("@/components/dialogs/SyncReportDialog")).then((m) => ({ default: m.SyncReportDialog })));
const MyInvoicesDialog = lazy(() => retryImport(() => import("@/components/dialogs/MyInvoicesDialog")).then((m) => ({ default: m.MyInvoicesDialog })));
const StocktakeDialog = lazy(() => retryImport(() => import("@/components/dialogs/StocktakeDialog")).then((m) => ({ default: m.StocktakeDialog })));
const RequisitionsDialog = lazy(() => retryImport(() => import("@/components/dialogs/RequisitionsDialog")).then((m) => ({ default: m.RequisitionsDialog })));
import { PosLogin } from "@/components/PosLogin";
import { Button, ErrorBanner, Money } from "@/components/ui";
import { useLang, useT } from "@/i18n/I18nProvider";

/** Upper bound on a `N*CODE` repeat. `addItem` has no quantity argument, so a
 *  prefix is applied by calling it N times; a mis-scan must not be able to push
 *  hundreds of lines into the cart before anyone can react. */
const SCAN_QTY_MAX = 99;

// ── Document-level barcode capture tuning (see the effect below) ────────────
/** Max gap between two keystrokes that can still belong to ONE scan. A hardware
 *  scanner emits a whole code at 2–10ms per character; sustained sub-50ms
 *  typing is not something a human hand produces for six characters running. */
const SCAN_MAX_GAP_MS = 50;
/** Shortest buffer that may be accepted as a barcode. EAN-8 is the shortest
 *  real symbology in use, so nothing below this is ever eaten. */
const SCAN_MIN_LEN = 6;
/** Hard cap so a stuck key cannot grow the buffer without bound. */
const SCAN_MAX_LEN = 64;
/** Characters a scanner emits. Anything else (space, punctuation, dead keys)
 *  aborts the buffer — a scan is a single uninterrupted alphanumeric run. */
const SCAN_CHAR_RE = /^[0-9A-Za-z*×\-._]$/;
/** Keys that carry no character and must neither extend nor abort a buffer. */
const SCAN_PASSIVE_KEYS = new Set(["Shift", "CapsLock", "AltGraph", "Dead", "Unidentified", "Process"]);

/** Monotonic-ish clock, guarded for environments without `performance`. */
function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

/**
 * "Mount on first open, then stay mounted."
 *
 * Code-splitting a dialog must not also change its LIFECYCLE. Rendering
 * `{open ? <StocktakeDialog/> : null}` would defer the chunk, but it would
 * also unmount the dialog on close and throw away a half-counted stocktake —
 * a behaviour change nobody asked for, dressed up as a bundle win. This defers
 * the chunk and nothing else: before the first open the component is not
 * rendered (so its chunk is never fetched); from the first open onward it stays
 * mounted with `open` driving it, exactly as an eager import did.
 */
function useMountAfterFirstOpen(open: boolean): boolean {
  const [mounted, setMounted] = useState(open);
  // Derived-state-during-render (the documented React 18 pattern): React
  // re-renders this component immediately, before committing, so the child
  // mounts in the SAME paint the flag flipped in — an effect would cost a
  // frame on every first open.
  if (open && !mounted) setMounted(true);
  return mounted;
}

/**
 * A failed chunk fetch must never take the till down.
 *
 * React.lazy REJECTS when its import() fails — a dropped connection, a stale
 * service-worker precache after a deploy, a proxy hiccup. Suspense does not
 * catch that; it propagates to the nearest error boundary, and the nearest one
 * is the app-level crash screen. So on a till with imperfect wifi, tapping a
 * lazily-loaded dialog could blank the whole register mid-service — trading a
 * missing dialog for a lost cart. This boundary keeps the failure local: the
 * sell screen stays exactly where it was and the cashier is told the truth.
 *
 * The retry lives in the IMPORT, not here: `retryImport` re-attempts three
 * times with backoff before React ever sees a rejection, which is what
 * actually covers a deploy's restart window. Once React has a rejected lazy it
 * caches it forever — remounting with a new key replays the same rejection —
 * so an in-place "retry" button would be a lie. By the time this renders, the
 * only honest recoveries are: carry on selling (the cart is untouched, and the
 * sell-path dialogs are all eager), or reload.
 */
interface ChunkBoundaryProps {
  open: boolean;
  label: string;
  failedLabel: string;
  retryLabel: string;
  onClose: () => void;
  closeLabel: string;
  children: ReactNode;
}
class LazyChunkBoundary extends Component<ChunkBoundaryProps, { failed: boolean; attempt: number }> {
  state = { failed: false, attempt: 0 };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    // Deliberately console-only: this is a load failure, not a data failure —
    // there is nothing to record against an order and nothing to reconcile.
    console.error("[pos] dialog chunk failed to load", err);
  }
  render() {
    const { open, label, failedLabel, retryLabel, onClose, closeLabel, children } = this.props;
    if (this.state.failed) {
      if (!open) return null;
      return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/45 p-4" role="alert">
          <div className="flex max-w-sm flex-col gap-3 rounded-2xl bg-white p-5 text-center shadow-lift">
            <p className="text-sm font-bold text-slate-700">{failedLabel}</p>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-press min-h-11 flex-1 rounded-xl bg-teal-600 px-4 text-sm font-bold text-white"
                onClick={() => window.location.reload()}
              >
                {retryLabel}
              </button>
              <button
                type="button"
                className="btn-press min-h-11 flex-1 rounded-xl border border-slate-200 px-4 text-sm font-bold text-slate-700"
                onClick={onClose}
              >
                {closeLabel}
              </button>
            </div>
          </div>
        </div>
      );
    }
    return (
      <Suspense
        key={this.state.attempt}
        fallback={
          open ? (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/45 p-4" role="status" aria-live="polite">
              <div className="flex items-center gap-2 rounded-2xl bg-white px-5 py-4 text-sm font-extrabold text-slate-600 shadow-lift">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                {label}
              </div>
            </div>
          ) : null
        }
      >
        {children}
      </Suspense>
    );
  }
}

/**
 * Suspense boundary for one lazily-loaded dialog. The fallback renders ONLY
 * while that dialog's own flag is true — which is also exactly when
 * `overlayOpen` is true, so the loading state can never be on screen while the
 * shortcut/auto-reload gate believes nothing is open.
 */
function LazyDialogBoundary({
  open,
  label,
  onClose,
  children,
}: {
  open: boolean;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <LazyChunkBoundary
      open={open}
      label={label}
      failedLabel={t("appShell.dialogLoadFailed")}
      retryLabel={t("appShell.dialogRetry")}
      closeLabel={t("appShell.dialogClose")}
      onClose={onClose}
    >
      {children}
    </LazyChunkBoundary>
  );
}

export default function App() {
  const t = useT();
  const lang = useLang();
  const {
    user,
    shiftId,
    catalog,
    catalogLoading,
    catalogError,
    refetchCatalog,
    cart,
    totals,
    addItem,
    decrementItem,
    startNewOrder,
    engine,
    engineStatus,
    pushToast,
    channels,
    channelId,
    setChannel,
    channelPricesUnavailable,
  } = usePos();

  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // The grid windows against this element; it is the one that scrolls, and the
  // grid cannot reach it on its own. STATE, not a ref: React runs the child's
  // effects before this parent's ref callback, so a ref would still be null when
  // the virtualizer first reads it and nothing would re-trigger the read.
  const [gridScrollEl, setGridScrollEl] = useState<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const [payOpen, setPayOpen] = useState(false);
  const [heldOpen, setHeldOpen] = useState(false);
  const [shiftOpen, setShiftOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [discountOpen, setDiscountOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [myInvoicesOpen, setMyInvoicesOpen] = useState(false);
  const [stocktakeOpen, setStocktakeOpen] = useState(false);
  const [requisitionsOpen, setRequisitionsOpen] = useState(false);
  const [heldCount, setHeldCount] = useState(0);
  const [holdBusy, setHoldBusy] = useState(false);
  const [voidBusy, setVoidBusy] = useState(false);
  const [lastHeld, setLastHeld] = useState<LocalOrder | null>(null);
  const [cartSheetOpen, setCartSheetOpen] = useState(false);
  const [drainOpen, setDrainOpen] = useState(false);
  // A cashier switch requested while a shift is open: we open the ShiftDialog so
  // they close/hand over the shift FIRST, then log out once it's closed.
  const [pendingSwitch, setPendingSwitch] = useState(false);
  // Payment was interrupted to open a shift (PaymentDialog's onOpenShift) and
  // must come back once one exists.
  const [pendingPayAfterShift, setPendingPayAfterShift] = useState(false);
  // EVERY overlay in this app must be a term of this union. It gates F2/F4/F9
  // (so a shortcut cannot fire behind a modal) AND the idle PWA auto-reload
  // (so a kiosk cannot reload underneath an open dialog and take the cashier's
  // half-entered stocktake with it). Code-splitting changes nothing here: a
  // lazy dialog's Suspense fallback is on screen exactly while its own flag is
  // true, so the FLAG — never the chunk — is what belongs in this union.
  const overlayOpen = payOpen || heldOpen || shiftOpen || voidOpen || discountOpen
    || syncOpen || myInvoicesOpen || stocktakeOpen || requisitionsOpen || cartSheetOpen || drainOpen;

  // Deferred mounts — see useMountAfterFirstOpen(). Each stays true once its
  // dialog has been opened, so state survives close/reopen exactly as it did
  // when these were eager imports.
  const shiftMounted = useMountAfterFirstOpen(shiftOpen);
  const syncMounted = useMountAfterFirstOpen(syncOpen);
  const myInvoicesMounted = useMountAfterFirstOpen(myInvoicesOpen);
  const stocktakeMounted = useMountAfterFirstOpen(stocktakeOpen);
  const requisitionsMounted = useMountAfterFirstOpen(requisitionsOpen);

  // ── PWA (SW registration + install prompt) + legacy-queue drain ──────────
  useEffect(() => {
    initPwa();
  }, []);

  // ── Idle auto-update ─────────────────────────────────────────────────────
  // A kiosk tab nobody touches must still converge to a new deploy on its
  // own (the header button assumes a human is looking at it). Reload ONLY
  // when nothing can be lost: empty cart, no dialog open, no busy action,
  // sync queue fully drained, and online. The 3s delay + cleanup means any
  // activity (scanning an item, opening a dialog) cancels the pending reload;
  // autoReloadAlreadyTried caps it at one attempt per target so a stale
  // intermediary cache cannot cause a reload loop — the manual button stays.
  const pwa = useSyncExternalStore(subscribePwa, getPwaStatus);
  useEffect(() => {
    if (!pwa.updateReady || !pwa.updateTarget) return; // SW-triggered → manual only
    const idle =
      cart.lines.length === 0 && !overlayOpen && !holdBusy && !voidBusy &&
      engineStatus.queueCount === 0 && engineStatus.online;
    if (!idle) return;
    const target = pwa.updateTarget;
    if (autoReloadAlreadyTried(target)) return;
    const timer = window.setTimeout(() => {
      markAutoReloadTried(target);
      applyUpdate();
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [
    pwa.updateReady, pwa.updateTarget, cart.lines.length, overlayOpen,
    holdBusy, voidBusy, engineStatus.queueCount, engineStatus.online,
  ]);
  useEffect(() => {
    if (!user) return;
    void runLegacyDrainOnce().then((outcome) => {
      if (!outcome || outcome.attempted === 0) return;
      if (outcome.succeeded.length > 0) {
        pushToast("success", t("appShell.toast.legacySynced", { count: outcome.succeeded.length }));
      }
      // A legacy sale that could not be migrated is money the books never saw.
      // The drain dialog below shows it once; the durable log keeps it after
      // the reload that this very dialog often precedes.
      for (const f of outcome.failed) {
        recordFailure({
          id: f.clientOrderId ? `legacy:${f.clientOrderId}` : null,
          kind: "legacy-drain",
          reference: f.clientOrderId,
          message: t(f.error, f.errorVars) || t("appShell.failureLog.legacyDrainFailed"),
          cashier: user.username,
        });
      }
      setDrainOpen(true); // small report: what synced, what stayed
    });
  }, [user, pushToast, t]);

  // ── Durable failure log ──────────────────────────────────────────────────
  // A permanently-failed checkout used to leave exactly two traces, both
  // ephemeral: one toast (gone in 5s — see components/Toasts.tsx) and
  // `engineStatus.lastReport`, a field in memory on the engine singleton that
  // the next flush overwrites and any reload erases. A shift manager arriving
  // later had no way to learn a sale had been lost, which one, or why.
  //
  // `checkout-done{ok:false, queued:false}` is the engine's own "this sale is
  // not coming back" signal (lib/offline.ts — both runCheckoutOp's fail() and
  // failCheckoutAfterPrerequisite emit it). Keyed on `checkout:<orderId>` so a
  // retry that fails again updates the row instead of duplicating it.
  useEffect(() => {
    return engine.onEvent((e) => {
      if (e.type !== "checkout-done" || e.ok || e.queued) return;
      const message = e.error || t("appShell.failureLog.checkoutFailed");
      // Read the stored doc for the money figures: by the time a BACKGROUND
      // flush fails, the cart on screen is usually a different order entirely.
      void engine
        .getOrder(e.orderId)
        .then((doc) => {
          recordFailure({
            id: `checkout:${e.orderId}`,
            kind: "checkout",
            orderId: e.orderId,
            reference: doc?.invoiceNumber ?? e.invoiceNumber ?? null,
            message,
            cashier: user?.username ?? null,
            total: doc ? doc.lines.reduce((s, l) => s + l.qty * l.unitPrice - (l.lineDiscount || 0), 0) : null,
          });
        })
        .catch(() => {
          // IndexedDB unavailable — still record the failure, just without the
          // amount. Losing the total is survivable; losing the record is not.
          recordFailure({ id: `checkout:${e.orderId}`, kind: "checkout", orderId: e.orderId, message, cashier: user?.username ?? null });
        });
    });
  }, [engine, t, user]);

  // ── Held count (badge) ───────────────────────────────────────────────────
  const refreshHeldCount = useCallback(async () => {
    // Runs from a top-level effect that fires on every mount — including the
    // still-unauthenticated first render that shows <PosLogin/> — so without
    // this guard it fired an authenticated GET /pos/v2/orders?status=held
    // before there was any token, throwing a background 401 on the login
    // screen (a real console/network violation this project treats as a
    // hard failure everywhere else).
    if (!user) { setHeldCount(0); return; }
    try {
      const local = await engine.localHeldOrders();
      const ids = new Set(local.map((d) => d.id));
      if (engineStatus.online) {
        try {
          const res = await listOrders({ status: "held" });
          for (const o of res.data) ids.add(o.id);
        } catch {
          /* offline count only */
        }
      }
      setHeldCount(ids.size);
    } catch {
      setHeldCount(0);
    }
  }, [engine, engineStatus.online, user]);

  useEffect(() => {
    void refreshHeldCount();
  }, [refreshHeldCount]);

  // ── Keyboard shortcuts ───────────────────────────────────────────────────
  // The handler used to bail out whenever focus sat in ANY input — but the
  // barcode workflow deliberately parks focus in the SearchBox, so F4 (pay) and
  // F9 (hold) were dead exactly where the cashier needs them. F2/F4/F9 can
  // never be part of typing (they produce no character and we always
  // preventDefault them), so editing state is irrelevant here; only an open
  // overlay still suppresses them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (overlayOpen) return;
      if (e.key !== "F2" && e.key !== "F4" && e.key !== "F9") return;
      e.preventDefault();
      if (e.key === "F2") {
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === "F4") {
        if (cart.lines.length > 0 && !payOpen) setPayOpen(true);
      } else if (e.key === "F9") {
        if (cart.lines.length > 0 && !holdBusy) void holdCurrent();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart.lines.length, holdBusy, overlayOpen, payOpen]);

  // ── Actions ──────────────────────────────────────────────────────────────
  /**
   * Resolve one scanned/typed code and add it to the cart. Honours ProductGrid's
   * `N*CODE` quantity prefix (`12*7501` adds twelve), but ONLY when the
   * REMAINDER actually resolves — otherwise the whole untouched string is
   * retried, so an item whose own name or barcode contains a separator can never
   * be misread as a quantity. Returns false when nothing matched, so both call
   * sites report the same «لا صنف يطابق» toast.
   */
  const addScanned = useCallback(
    (raw: string): boolean => {
      if (!catalog) return false;
      const code = raw.trim();
      if (!code) return false;
      const prefix = parseQtyPrefix(code);
      // addItem has no quantity argument, so only a WHOLE repeat count can be
      // honoured here; a decimal (weighed-goods) prefix falls through to the
      // plain resolve rather than silently rounding the customer's money.
      const repeat =
        prefix && Number.isInteger(prefix.qty) && prefix.qty > 1 && prefix.qty <= SCAN_QTY_MAX ? prefix.qty : 1;
      let hit = repeat > 1 && prefix ? resolveScan(catalog.items, prefix.rest) : null;
      let times = repeat;
      if (!hit) {
        hit = resolveScan(catalog.items, code);
        times = 1;
      }
      if (!hit) return false;
      // a per-unit (carton) barcode adds that unit; otherwise the base unit
      for (let i = 0; i < times; i++) addItem(hit.item, hit.unitCode);
      return true;
    },
    [catalog, addItem],
  );

  const onScanSubmit = useCallback(() => {
    const raw = query;
    if (addScanned(raw)) {
      setQuery("");
      // The scan workflow REQUIRES focus in the SearchBox and nothing ever gave
      // it back, so every shortcut stayed dead for the rest of the sale.
      // Releasing focus after a SUCCESSFUL scan restores F4/F9; a failed lookup
      // deliberately keeps focus so the cashier can correct the text in place.
      searchRef.current?.blur();
    } else if (raw.trim()) {
      pushToast("error", t("appShell.toast.noMatch", { query: raw.trim() }));
    }
  }, [query, addScanned, pushToast, t]);

  // ── Document-level barcode capture ───────────────────────────────────────
  // A scan must land wherever focus happens to be — on a product card, on the
  // body after a blur, on the «المزيد» button — not only inside the SearchBox.
  // Before this, every keystroke of a scan made outside the search field was
  // silently swallowed by whatever had focus.
  //
  // Why this cannot eat a keystroke a human meant:
  //   • it NEVER preventDefaults a printable key — only the terminating Enter
  //     of an already-confirmed scan, so typing is never suppressed;
  //   • it is completely inert while focus is in an input/textarea/select/
  //     contenteditable (where a human's keystrokes are the whole point) and
  //     while any overlay is open;
  //   • acceptance needs ≥6 characters where EVERY inter-keystroke gap is
  //     ≤50ms AND the Enter arrives ≤50ms after the last one — a sustained
  //     >20 chars/second burst terminated by an instant Enter, which is a
  //     hardware scanner, not a hand;
  //   • any modifier, any non-barcode character, or any gap over the threshold
  //     restarts the buffer from scratch.
  const scanBufRef = useRef<{ chars: string; last: number }>({ chars: "", last: 0 });
  useEffect(() => {
    const reset = () => {
      scanBufRef.current = { chars: "", last: 0 };
    };
    const onKey = (e: KeyboardEvent) => {
      if (overlayOpen || e.ctrlKey || e.altKey || e.metaKey) {
        reset();
        return;
      }
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) {
        reset(); // the human is typing — and the SearchBox has its own Enter
        return;
      }
      // A bare modifier press carries no character: a scanner emitting an
      // UPPERCASE code (Code-128) interleaves Shift keydowns, and treating them
      // as "not a barcode character" would break every alphanumeric symbology.
      // Ignoring them can only PRESERVE a buffer, never accept one sooner.
      if (SCAN_PASSIVE_KEYS.has(e.key)) return;
      const now = nowMs();
      const buf = scanBufRef.current;
      if (e.key === "Enter") {
        const fast = buf.last > 0 && now - buf.last <= SCAN_MAX_GAP_MS;
        const code = buf.chars;
        reset();
        if (!fast || code.length < SCAN_MIN_LEN) return; // a human's Enter — leave it alone
        e.preventDefault();
        if (!addScanned(code)) pushToast("error", t("appShell.toast.noMatch", { query: code }));
        return;
      }
      if (e.key.length === 1 && SCAN_CHAR_RE.test(e.key)) {
        const continues = buf.chars.length > 0 && buf.chars.length < SCAN_MAX_LEN && now - buf.last <= SCAN_MAX_GAP_MS;
        scanBufRef.current = { chars: continues ? buf.chars + e.key : e.key, last: now };
        return;
      }
      reset();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [overlayOpen, addScanned, pushToast, t]);

  async function holdCurrent() {
    if (!cart.lines.length) return;
    setHoldBusy(true);
    try {
      const snapshot: LocalOrder = { ...cart, lines: cart.lines.map((l) => ({ ...l })) };
      await engine.holdOrder(snapshot);
      setLastHeld(snapshot);
      startNewOrder();
      pushToast("success", t("appShell.toast.held"));
      void refreshHeldCount();
    } catch (e) {
      pushToast("error", (e as Error).message);
    } finally {
      setHoldBusy(false);
    }
  }

  async function voidCurrent(reason: string) {
    setVoidBusy(true);
    try {
      const snapshot: LocalOrder = { ...cart, lines: cart.lines.map((l) => ({ ...l })) };
      await engine.voidOrder(snapshot, reason);
      startNewOrder();
      setVoidOpen(false);
      pushToast("success", t("appShell.toast.voided"));
    } catch (e) {
      pushToast("error", (e as Error).message);
    } finally {
      setVoidBusy(false);
    }
  }

  // Voiding an already-synced order while OFFLINE is forbidden (the server
  // copy would survive and complete elsewhere) — local unsynced voids are fine.
  const voidDisabledReason =
    !engineStatus.online && cart.serverVersion != null ? t("appShell.voidAction.syncedOfflineDisabled") : null;

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const it of catalog?.items ?? []) {
      if (!it.active) continue;
      counts[it.category] = (counts[it.category] ?? 0) + 1;
    }
    return counts;
  }, [catalog]);

  // ── Sales channel strip (close/w25-sell-ui) ──────────────────────────────
  // The selector renders only when the owner actually has channels (the
  // implicit base «الأساسي» + ≥1 configured channel). An old server sends no
  // channels → nothing renders and the POS behaves exactly as before.
  const showChannelPicker = channels.length >= 1;
  // A persisted id whose channel was deleted server-side degrades to base.
  const activeChannelId = channels.some((c) => c.id === channelId) ? channelId : null;
  // «أسعار من قائمة: X» — shown when any served item carries a priceSource
  // (the server resolved a channel price list over the base price).
  const priceListName = useMemo(() => {
    for (const it of catalog?.items ?? []) if (it.priceSource) return it.priceSource;
    return null;
  }, [catalog]);

  // Live per-item cart quantity → the card qty badge + selection ring + − button.
  const cartQtyByItem = useMemo(() => {
    const m: Record<string, number> = {};
    for (const l of cart.lines) m[l.menuId] = (m[l.menuId] ?? 0) + l.qty;
    return m;
  }, [cart.lines]);

  // Clear the session and return to the login screen (reload re-mounts the
  // provider, which re-reads the now-absent token → PosLogin).
  //
  // Image cache: the catalog/identity payload carries no branchId today (see
  // lib/types.ts Catalog — this POS build has no multi-branch concept exposed
  // to the client), so branch-change detection between logins can't be done
  // cleanly. Clearing the WHOLE offline image cache unconditionally on every
  // logout is the safe default the task calls out for that case: a fresh
  // cashier re-downloads photos on next sync rather than risking a stale/wrong
  // branch's images lingering across a shift handover.
  function performLogout() {
    clearToken();
    // Best-effort: awaited so the reload below doesn't cut the async Cache
    // Storage + IndexedDB cleanup off mid-flight, but never blocks logout on
    // it failing (private-mode / storage errors must still let the cashier out).
    void clearImageCache()
      .catch(() => undefined)
      .finally(() => window.location.reload());
  }

  // Safe cashier switch: NEVER drop an open shift silently. If a shift is open,
  // route through the ShiftDialog's close/handover flow first; the logout only
  // happens once the shift is confirmed closed (handled in ShiftDialog onClose).
  function handleSwitchCashier() {
    if (shiftId) {
      setPendingSwitch(true);
      setShiftOpen(true);
      pushToast("info", t("appShell.toast.closeShiftFirst"));
    } else {
      performLogout();
    }
  }

  // Called when the ShiftDialog closes. If a switch was pending, complete it
  // only when the shift is actually closed (shiftId cleared); otherwise the
  // cashier cancelled — stay signed in.
  function handleShiftDialogClose() {
    setShiftOpen(false);
    if (!pendingSwitch) return;
    if (!shiftId) performLogout();
    else setPendingSwitch(false);
  }

  // ── Payment → open a shift → back to payment ─────────────────────────────
  // The no-shift banner in PaymentDialog used to be a dead end: Confirm was
  // disabled and the cashier had to close the dialog, find the header button,
  // open a shift and rebuild their way back to the same total. `onOpenShift`
  // hands off to the FULL ShiftDialog (the opening float MUST be counted — an
  // inline zero-float open silently corrupts the Z-report) and this brings
  // payment back afterwards.
  //
  // An EFFECT rather than a branch inside handleShiftDialogClose: `shiftId`
  // arrives through a react-query cache write, so a callback closing over the
  // render that OPENED the dialog can still be looking at the stale null. This
  // reads whatever the latest render has.
  function handleOpenShiftFromPayment() {
    setPayOpen(false);
    setPendingPayAfterShift(true);
    setShiftOpen(true);
  }
  useEffect(() => {
    if (!pendingPayAfterShift || shiftOpen) return; // still in the shift dialog
    setPendingPayAfterShift(false);
    // Reopen only if there is now a shift AND still something to charge for.
    // Reopening onto the same dead-end banner would be a worse dead end.
    if (shiftId && cart.lines.length > 0) setPayOpen(true);
  }, [pendingPayAfterShift, shiftOpen, shiftId, cart.lines.length]);

  if (!user) return <PosLogin />;

  const itemCount = cart.lines.reduce((s, l) => s + l.qty, 0);

  const cartPanel = (
    <CartPanel
      heldCount={heldCount}
      onPay={() => setPayOpen(true)}
      onHold={() => void holdCurrent()}
      onOpenHeld={() => setHeldOpen(true)}
      onVoid={() => setVoidOpen(true)}
      onOpenDiscount={() => setDiscountOpen(true)}
      holdBusy={holdBusy}
      voidDisabledReason={voidDisabledReason}
    />
  );

  return (
    <div className="flex h-[100dvh] min-h-[100svh] flex-col overflow-hidden">
      <Toasts />
      <Header
        onOpenShiftDialog={() => setShiftOpen(true)}
        onOpenSyncReport={() => setSyncOpen(true)}
        onOpenMyInvoices={() => setMyInvoicesOpen(true)}
        onOpenStocktake={() => setStocktakeOpen(true)}
        onOpenRequisitions={() => setRequisitionsOpen(true)}
        onOpenDrainReport={() => setDrainOpen(true)}
        onSwitchCashier={handleSwitchCashier}
        onLogout={performLogout}
      />

      <main className="flex min-h-0 flex-1 gap-3 px-3 pb-[calc(5rem+env(safe-area-inset-bottom))] pt-3 md:pb-3">
        {/* Category rail — first column in RTL, ≥1024px only */}
        <aside className="hidden w-44 shrink-0 lg:block" aria-label={t("appShell.aria.categories")}>
          <CategoryRail categories={catalog?.categories ?? []} counts={categoryCounts} active={category} onSelect={setCategory} />
        </aside>

        {/* Products */}
        <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-2.5" aria-label={t("appShell.aria.products")}>
          <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[minmax(12rem,1fr)_auto]">
            <div className="min-w-0">
              <SearchBox ref={searchRef} query={query} onQueryChange={setQuery} onScanSubmit={onScanSubmit} />
            </div>
            {showChannelPicker ? (
              <label className="flex min-w-0 items-center gap-1.5 sm:shrink-0">
                <Store className="h-4 w-4 text-slate-400" aria-hidden />
                <span className="sr-only">{t("appShell.channel.label")}</span>
                <select
                  value={activeChannelId ?? ""}
                  onChange={(e) => setChannel(e.target.value || null)}
                  aria-label={t("appShell.channel.label")}
                  className="field min-h-11 min-w-0 flex-1 text-xs font-extrabold sm:w-auto sm:max-w-[11rem]"
                >
                  <option value="">{t("appShell.channel.base")}</option>
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {/* The escape hatch, and the missing message.
                `channelPricesUnavailable` existed on the context and was rendered
                NOWHERE — the till served base prices while the picker advertised
                a channel, and said nothing at all. That silence is most of why a
                stuck channel read as «مشكلة لا تنحل».
                The button clears the stored preference DIRECTLY rather than
                through the <select>: when the stored id is not in channels[] the
                select already displays «الأساسي», and re-picking the option it is
                already on fires no change event — so the only visible way back
                was, in that state, a no-op. This works whatever the cause:
                deleted channel, empty price list, or a plain outage. */}
            {channelPricesUnavailable ? (
              <div
                data-testid="channel-prices-unavailable"
                role="status"
                className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] font-extrabold text-amber-900 sm:col-span-2"
              >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1">{t("appShell.channel.pricesUnavailable")}</span>
                <button
                  type="button"
                  onClick={() => setChannel(null)}
                  className="btn-press min-h-11 shrink-0 rounded-lg border border-amber-400 bg-white px-3 font-extrabold text-amber-900 hover:bg-amber-100"
                >
                  {t("appShell.channel.backToBase")}
                </button>
              </div>
            ) : null}
            {priceListName ? (
              <span className="flex min-w-0 items-center gap-1.5 rounded-xl border border-teal-200 bg-teal-50 px-3 py-2 text-[11px] font-extrabold text-teal-700 sm:col-span-2 sm:justify-self-end">
                <Tag className="h-3.5 w-3.5" aria-hidden />
                <span className="truncate">{t("appShell.priceList.prefix")} <span className="rounded-md bg-white px-1.5">{priceListName}</span></span>
              </span>
            ) : null}
          </div>
          {/* Horizontal categories under 1024px */}
          <div className="lg:hidden">
            <CategoryRail
              categories={catalog?.categories ?? []}
              counts={categoryCounts}
              active={category}
              onSelect={setCategory}
              horizontal
            />
          </div>
          {catalogError && !catalog ? (
            <ErrorBanner message={t(catalogError)} onRetry={refetchCatalog} />
          ) : (
            <div ref={setGridScrollEl} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
              <ProductGrid
                catalog={catalog}
                loading={catalogLoading}
                category={category}
                query={query}
                onAdd={addItem}
                scrollElement={gridScrollEl}
                cartQty={cartQtyByItem}
                onDecrement={(item) => decrementItem(item.id)}
              />
            </div>
          )}
        </section>

        {/* Cart — side panel from 768px up */}
        <aside className="hidden w-[24rem] shrink-0 md:block xl:w-[26rem]" aria-label={t("appShell.aria.cart")}>
          {cartPanel}
        </aside>
      </main>

      {/* Mobile bottom cart bar + sheet (<768px) */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 px-2.5 pb-[calc(0.625rem+env(safe-area-inset-bottom))] pt-2.5 shadow-lift backdrop-blur md:hidden">
        <Button variant="primary" size="lg" className="w-full" onClick={() => setCartSheetOpen(true)}>
          <ShoppingBasket className="h-5 w-5" aria-hidden />
          {t("appShell.mobileCart.label")} (<Money value={fmtInt(itemCount)} />) — <Money value={fmt2(totals.total)} /> {t("appShell.currency")}
        </Button>
      </div>
      {cartSheetOpen ? (
        <div className="fixed inset-0 z-50 flex h-[100dvh] flex-col bg-ink/45 pt-[env(safe-area-inset-top)] md:hidden" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && setCartSheetOpen(false)}>
          <div className="sheet-in mt-12 flex min-h-0 flex-1 flex-col overflow-hidden rounded-t-2xl bg-canvas px-2.5 pb-[calc(0.625rem+env(safe-area-inset-bottom))] pt-2.5">
            <div className="mb-1 flex justify-center">
              <button
                type="button"
                onClick={() => setCartSheetOpen(false)}
                aria-label={t("appShell.aria.closeCart")}
                className="h-1.5 w-12 rounded-full bg-slate-300"
              />
            </div>
            <div className="min-h-0 flex-1">{cartPanel}</div>
          </div>
        </div>
      ) : null}

      {/* Dialogs — eager (sell path) */}
      <PaymentDialog
        open={payOpen}
        onClose={() => {
          setPayOpen(false);
          setCartSheetOpen(false);
        }}
        onOpenShift={handleOpenShiftFromPayment}
      />
      <HeldOrdersDialog open={heldOpen} onClose={() => setHeldOpen(false)} onCountChange={setHeldCount} />
      <VoidDialog open={voidOpen} onClose={() => setVoidOpen(false)} onConfirm={(r) => void voidCurrent(r)} busy={voidBusy} />
      <DiscountDialog open={discountOpen} onClose={() => setDiscountOpen(false)} />

      {/* Dialogs — lazy (rare). Every flag below is already a term of
          `overlayOpen` above; splitting the code changed the chunk, not the
          gate. */}
      {shiftMounted ? (
        <LazyDialogBoundary open={shiftOpen} label={t("appShell.dialogLoading")} onClose={() => setShiftOpen(false)}>
          <ShiftDialog open={shiftOpen} onClose={handleShiftDialogClose} />
        </LazyDialogBoundary>
      ) : null}
      {syncMounted ? (
        <LazyDialogBoundary open={syncOpen} label={t("appShell.dialogLoading")} onClose={() => setSyncOpen(false)}>
          <SyncReportDialog open={syncOpen} onClose={() => setSyncOpen(false)} />
        </LazyDialogBoundary>
      ) : null}
      {myInvoicesMounted ? (
        <LazyDialogBoundary open={myInvoicesOpen} label={t("appShell.dialogLoading")} onClose={() => setMyInvoicesOpen(false)}>
          <MyInvoicesDialog open={myInvoicesOpen} onClose={() => setMyInvoicesOpen(false)} />
        </LazyDialogBoundary>
      ) : null}
      {stocktakeMounted ? (
        <LazyDialogBoundary open={stocktakeOpen} label={t("appShell.dialogLoading")} onClose={() => setStocktakeOpen(false)}>
          <StocktakeDialog open={stocktakeOpen} onClose={() => setStocktakeOpen(false)} />
        </LazyDialogBoundary>
      ) : null}
      {requisitionsMounted ? (
        <LazyDialogBoundary open={requisitionsOpen} label={t("appShell.dialogLoading")} onClose={() => setRequisitionsOpen(false)}>
          <RequisitionsDialog open={requisitionsOpen} onClose={() => setRequisitionsOpen(false)} />
        </LazyDialogBoundary>
      ) : null}

      {/* Legacy-queue drain report (offline sales queued by the OLD cashier) */}
      <Dialog open={drainOpen} onClose={() => setDrainOpen(false)} title={t("appShell.drain.title")} widthClass="max-w-md">
        {(() => {
          const st = getDrainStatus();
          if (!st.outcome) {
            return (
              <p className="py-4 text-center text-sm font-bold text-slate-500">
                {st.pending > 0
                  ? t("appShell.drain.pending", { count: fmtInt(st.pending) })
                  : t("appShell.drain.noneQueued")}
              </p>
            );
          }
          const { succeeded, failed } = st.outcome;
          return (
            <div className="space-y-3">
              <p className="text-sm font-extrabold text-slate-600">
                {t("appShell.drain.syncedPrefix")} <span className="num">{fmtInt(succeeded.length)}</span> {t("appShell.drain.syncedSuffix")}
                {failed.length > 0 ? (
                  <span className="text-amber-700">{t("appShell.drain.notSyncedSuffix", { count: fmtInt(failed.length) })}</span>
                ) : null}
              </p>
              {succeeded.length > 0 ? (
                <ul className="space-y-1">
                  {succeeded.map((s) => (
                    <li key={s.clientOrderId} className="flex items-center justify-between rounded-xl border border-teal-100 bg-teal-50/50 px-3 py-2 text-xs font-bold text-slate-600">
                      <span className="num" dir="ltr">{s.clientOrderId}</span>
                      <span className="text-teal-600">{t("appShell.drain.rowSucceeded")}{s.orderId ? t("appShell.drain.invoiceRef", { id: s.orderId }) : ""}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {failed.length > 0 ? (
                <ul className="space-y-1">
                  {failed.map((f, i) => (
                    <li key={`${f.clientOrderId ?? "invalid"}-${i}`} className="flex items-center justify-between gap-2 rounded-xl border border-red-100 bg-red-50/50 px-3 py-2 text-xs font-bold text-slate-600">
                      <span className="num" dir="ltr">{f.clientOrderId ?? t("appShell.drain.unknownId")}</span>
                      <span className="text-red-600">{t(f.error, f.errorVars)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })()}
      </Dialog>

      {/* Post-hold kitchen ticket offer */}
      <Dialog open={!!lastHeld} onClose={() => setLastHeld(null)} title={t("appShell.kitchen.title")} widthClass="max-w-sm">
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <PauseCircle className="h-12 w-12 text-saffron-500" aria-hidden />
          <p className="text-sm font-bold text-slate-500">{t("appShell.kitchen.prompt")}</p>
          <div className="grid w-full grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => setLastHeld(null)}>
              {t("appShell.kitchen.later")}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                // Both arguments were being defaulted away: a 58mm English till
                // printed an 80mm ARABIC kitchen ticket, which also made the
                // whole receipt.kitchen.* English namespace unreachable.
                if (lastHeld && !printHtml(buildKitchenTicketHtml(lastHeld, resolvePaperWidth(catalog), lang))) {
                  pushToast("error", t("appShell.toast.printBlocked"));
                }
                setLastHeld(null);
              }}
            >
              <ChefHat className="h-4 w-4" aria-hidden />
              {t("appShell.kitchen.print")}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
