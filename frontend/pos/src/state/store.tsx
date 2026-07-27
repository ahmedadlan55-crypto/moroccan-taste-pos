/**
 * PosProvider — central state: auth, catalog (offline-cached), shift, the
 * active cart (a LocalOrder doc, saved local-first through the engine), the
 * offline engine status, and toasts. One provider, one hook: usePos().
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Undo2, X } from "lucide-react";
import { currentUser, getToken, isSupervisor } from "@/lib/auth";
import { fetchEffectiveCaps, posCan as posCanBase, type EffectiveCaps } from "@/lib/capabilities";
import { CatalogError, loadCatalog, type LoadedCatalog } from "@/lib/catalogCache";
import { idbPut } from "@/lib/idb";
import { openShift as apiOpenShift, fetchMenuAvailabilityBulk, findOpenShift, getServerFlags } from "@/lib/api";
import { getEngine, type EngineStatus, type OfflineEngine } from "@/lib/offline";
import { useLocalizedName, useOptionalT, useT } from "@/i18n/I18nProvider";
import { cartTotals, DEFAULT_VAT_RATE_PCT } from "@/lib/cartMath";
import { pruneQuickPicks, recordPick } from "@/lib/quickPicks";
import { getAvailabilitySnapshot, publishAvailability, resolveStockState } from "@/components/StockPip";
import { ulid } from "@/lib/ulid";
import { ComboDialog, type ComboFinalizeResult } from "@/components/dialogs/ComboDialog";
import type {
  AuthUser,
  Catalog,
  CatalogItem,
  CatalogUnit,
  CartLine,
  ComboDef,
  CartTotals,
  DiscountType,
  LocalOrder,
  MenuAvailabilityMap,
  OrderType,
  SalesChannel,
} from "@/lib/types";

// ── Phase U — unit-of-measure helpers ───────────────────────────────────────
const round6 = (n: number) => Math.round((n + Number.EPSILON) * 1e6) / 1e6;
function pickUnit(item: CatalogItem, unitCode?: string | null): CatalogUnit | null {
  const units = item.units || [];
  if (!units.length) return null; // single-unit item → no unit metadata
  if (unitCode) return units.find((u) => u.unitCode === unitCode) || units.find((u) => u.isBase) || null;
  return units.find((u) => u.isBase) || null;
}
function buildCartLine(item: CatalogItem, unit: CatalogUnit | null, enteredQty: number): CartLine {
  const factor = unit ? Number(unit.factor) || 1 : 1;
  return {
    menuId: item.id, name: item.name, nameEn: item.nameEn ?? null, qty: enteredQty, unitPrice: item.basePrice ?? item.price,
    lineDiscount: 0, vatCategory: item.taxCategory,
    // Snapshot the tax convention WITH the price. Without it the register
    // treated every price as VAT-inclusive while the server adds VAT on top
    // for these rows, so the checkout was rejected as a total mismatch.
    taxInclusive: item.taxInclusive === true,
    notes: null,
    enteredUnitId: unit ? unit.unitId : null, enteredUnitCode: unit ? unit.unitCode : null,
    enteredUnitName: unit ? unit.unitName : item.baseUnitName || null,
    conversionFactorSnapshot: factor, baseQty: round6(enteredQty * factor),
  };
}
// recompute baseQty for a line whose entered qty (or factor) changed
function withBase(l: CartLine, patch: Partial<CartLine>): CartLine {
  const merged = { ...l, ...patch };
  const factor = Number(merged.conversionFactorSnapshot) || 1;
  return { ...merged, baseQty: round6((Number(merged.qty) || 0) * factor) };
}

// ── Device id (stable per browser/terminal) ──────────────────────────────────
const DEVICE_KEY = "pos_v2_device_id";
function getDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = "DEV-" + ulid();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return "DEV-unknown";
  }
}

// ── Sales channel (قناة البيع) — close/w25-sell-ui ──────────────────────────
// The selected channel survives reloads (legacy kept pos_active_channel_id the
// same way). null = the implicit base channel «الأساسي».
const CHANNEL_KEY = "pos_v2_channel_id";
function getStoredChannelId(): string | null {
  try {
    return localStorage.getItem(CHANNEL_KEY) || null;
  } catch {
    return null;
  }
}

// ── Last known open shift (offline cold-boot survival) ──────────────────────
// The open-shift QUERY is gated on `engineStatus.online`, so an offline cold
// boot leaves shiftId null forever — and startNewOrder() then stamps every new
// cart with a null shiftId. The FIRST order of such a boot survived only by
// accident (it is restored from IndexedDB with its own stored shiftId); from
// the SECOND order on, payment died. Remembering the last shift the server
// confirmed is open closes that hole.
//
// This is a CACHE, never authority: routes/sales.js re-validates the shift at
// replay, so a stale id fails loudly at sync (shift_not_found / shift_closed /
// shift_owner_mismatch) instead of silently booking into the wrong shift.
const SHIFT_KEY = "pos_v2_last_open_shift_id";

/** Shape-validated read: anything that is not a sane, non-empty id is ignored. */
function getStoredShiftId(): string | null {
  try {
    const raw = localStorage.getItem(SHIFT_KEY);
    if (typeof raw !== "string") return null;
    const id = raw.trim();
    // A shift id is a short opaque token. Bound it so a corrupted/oversized
    // entry (or something else's key collision) can never ride into a payload.
    if (!id || id.length > 64) return null;
    return id;
  } catch {
    return null; // private mode / storage disabled — behave as if never seen
  }
}

/** Persist (or clear) the last server-confirmed open shift. Never throws. */
function rememberShiftId(id: string | null): void {
  try {
    if (id && typeof id === "string" && id.trim() && id.trim().length <= 64) {
      localStorage.setItem(SHIFT_KEY, id.trim());
    } else {
      localStorage.removeItem(SHIFT_KEY);
    }
  } catch {
    /* private mode — the id just won't survive a reload */
  }
}

/**
 * A catalog load that also says WHICH channel's prices it actually carries.
 * `loadCatalogForChannel` degrades to the base/cached copy when a channel fetch
 * fails; without these two fields that degradation was invisible — the selector
 * kept showing the channel as active while the register sold at BASE prices.
 */
export interface ChannelLoadedCatalog extends LoadedCatalog {
  /** The channel whose prices this copy actually carries. null = base prices. */
  servedChannelId: string | null;
  /** A channel WAS selected but its price list could not be served. */
  channelPricesUnavailable: boolean;
}

/**
 * Channel-aware catalog load.
 *   base (null)      → the ETag+IndexedDB path in catalogCache, unchanged.
 *   selected channel → plain fetch of /api/pos/v2/catalog?channelId=… with the
 *     POS token (api.ts/catalogCache belong to parallel streams). On success the
 *     copy is written through to the SAME IndexedDB slot catalogCache reads, so
 *     an offline boot serves the LAST-FETCHED channel — the cache is NOT keyed
 *     per channel (documented at docs/pos-parity-map.json offline-channel-menu-cache).
 *   any failure      → loadCatalog() fallback (the cached copy — possibly another
 *     channel's prices, surfaced by the existing stale/age machinery — because
 *     selling through an outage beats a blank grid). An old server simply
 *     ignores ?channelId= and returns the base catalog: same behavior as today.
 *
 * THE FALLBACK IS NOW VISIBLE (defect 5). It used to `catch { return
 * loadCatalog() }` and hand back `fromCache:false, stale:false` — a clean bill
 * of health for a copy that is NOT the channel's price list. The selector went
 * on showing «هنقرستيشن» as the active channel while every line rang up at BASE
 * price, and nothing anywhere said so. The result now states which channel's
 * prices it actually carries, so the UI can stop claiming the channel is live.
 *
 * A 401 is deliberately NOT degraded: loadCatalog() rethrows SESSION_EXPIRED,
 * which must reach the cashier as "sign in again", not as a pricing footnote.
 */
async function loadCatalogForChannel(channelId: string | null): Promise<ChannelLoadedCatalog> {
  if (!channelId) {
    const base = await loadCatalog();
    return { ...base, servedChannelId: null, channelPricesUnavailable: false };
  }
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`/api/pos/v2/catalog?channelId=${encodeURIComponent(channelId)}`, { headers });
    if (!res.ok) {
      // Surfaced as a real, coded error so the 401 branch below can see it —
      // an expired session must never masquerade as "channel prices missing".
      throw new CatalogError(
        res.status === 401 ? "SESSION_EXPIRED" : "CATALOG_LOAD_FAILED",
        `HTTP ${res.status}`,
      );
    }
    const data = (await res.json()) as Catalog;
    const savedAt = Date.now();
    // Write-through (etag null: the next base load does a full 200 refetch
    // rather than trusting a channel-priced copy against the base ETag).
    await idbPut("catalog", "catalog", { data, etag: null, savedAt }).catch(() => undefined);
    return { catalog: data, fromCache: false, savedAt, ageMs: 0, stale: false, servedChannelId: channelId, channelPricesUnavailable: false };
  } catch (e) {
    if (e instanceof CatalogError && e.code === "SESSION_EXPIRED") throw e;
    // Keep the till alive on whatever we have — but say out loud that these are
    // NOT the selected channel's prices.
    const fallback = await loadCatalog();
    return { ...fallback, servedChannelId: null, channelPricesUnavailable: true };
  }
}

function newLocalOrder(shiftId: string | null, deviceId: string): LocalOrder {
  const now = Date.now();
  return {
    id: ulid(),
    status: "open",
    orderType: "takeaway",
    tableNo: null,
    shiftId,
    deviceId,
    discountType: null,
    discountValue: 0,
    discountName: null,
    note: null,
    customerId: null,
    customerName: null,
    customerPhone: null,
    lines: [],
    serverVersion: null,
    invoiceNumber: null,
    saleId: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * An affordance carried BY a toast — "تراجع" on a removed cart line, and any
 * future one-tap recovery. Passing one to pushToast() is the ONLY difference
 * from a plain toast; every existing call site is untouched.
 */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: number;
  kind: "success" | "error" | "info";
  message: string;
  /** Present ⇒ this toast is rendered by the provider's own action stack (see
   *  ActionToastStack below), NOT by <Toasts/>. The two channels are kept
   *  disjoint on purpose so no toast can ever be painted twice. */
  action?: ToastAction;
}

/** Plain toasts auto-dismiss in 5s; an actionable one gets longer, because the
 *  cashier has to READ it and then decide to undo. */
const TOAST_TTL_MS = 5000;
const ACTION_TOAST_TTL_MS = 8000;

/**
 * Bottom-centre snackbar for toasts that carry an action.
 *
 * WHY IT IS NOT IN <Toasts/>: components/Toasts.tsx is owned by a concurrent
 * stream this change may not touch, and a message rendered by both surfaces
 * would appear twice. Bottom-centre is also the conventional home for an undo
 * snackbar, so it never fights the top toast stack for the same pixels. The
 * offset clears the mobile cart bar (<768px) and drops to a plain inset from md.
 */
function ActionToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  const t = useT();
  if (!toasts.length) return null;
  return (
    <div
      data-testid="action-toasts"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-[65] flex flex-col items-center gap-2 px-4 md:bottom-4"
      aria-live="polite"
      aria-label={t("toasts.aria.actionRegion")}
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className="toast-in pointer-events-auto flex w-full max-w-md items-center gap-2.5 rounded-2xl bg-ink px-4 py-3 text-white shadow-lift"
        >
          <p className="flex-1 text-sm font-bold leading-snug">{toast.message}</p>
          {toast.action ? (
            <button
              type="button"
              onClick={() => {
                toast.action?.onClick();
                onDismiss(toast.id);
              }}
              className="btn-press flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl bg-white/15 px-3 text-sm font-extrabold text-white hover:bg-white/25"
            >
              <Undo2 className="h-4 w-4" aria-hidden />
              {toast.action.label}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            aria-label={t("toasts.aria.dismiss")}
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg opacity-60 hover:bg-white/10 hover:opacity-100"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * PURE. Put `line` back at `index`, clamped into range — the cart may have
 * shrunk further (or grown) between the removal and the undo tap, and splicing
 * past the end would silently move the line to the bottom of the order.
 * Restores the WHOLE snapshot, so notes, lineDiscount and comboChoices come
 * back exactly as they were.
 */
export function restoreLineAt(lines: CartLine[], line: CartLine, index: number): CartLine[] {
  const next = lines.slice();
  next.splice(Math.max(0, Math.min(index, next.length)), 0, line);
  return next;
}

export interface PosContextValue {
  user: AuthUser | null;
  supervisor: boolean;
  /** Effective capability set from GET /api/auth/permissions/me (Owner J).
   *  null until the query resolves (or when there's no user yet) — callers
   *  should use `posCan()` below rather than reading this directly. */
  caps: EffectiveCaps | null;
  /** Capability-aware permission check with a role-fallback for the handful
   *  of actions this app already role-gates (see lib/capabilities.ts). Never
   *  narrows what isSupervisor()-based checks already allow. */
  posCan: (capId: string) => boolean;
  deviceId: string;
  engine: OfflineEngine;
  engineStatus: EngineStatus;

  catalog: Catalog | null;
  catalogLoading: boolean;
  /** A t()-able i18n PATH (`errors.SESSION_EXPIRED` / `errors.CATALOG_OFFLINE` /
   *  `errors.CATALOG_LOAD_FAILED`) — NOT a raw `.message`. Always resolves in
   *  both dictionaries, so `t(catalogError)` is a real actionable sentence. */
  catalogError: string | null;
  /** The RAW thrown error (a `CatalogError` carrying `.code`) for call sites
   *  that want `translateApiError(e, t)`. null when the load succeeded. */
  catalogErrorObject: unknown;
  /** Serving a cached catalog we could not confirm is current — prices may be out of date. */
  catalogStale: boolean;
  /** Age of the served catalog copy in ms (null = fresh or unknown). */
  catalogAgeMs: number | null;
  refetchCatalog: () => void;

  /** The VAT rate the SERVER shipped (settings.VATRate, percent — e.g. 15).
   *  Falls back to DEFAULT_VAT_RATE_PCT only until the catalog resolves.
   *  EVERY cartMath call outside this provider must pass it, or the figure the
   *  cashier reads disagrees with the one the server charges. */
  vatRatePct: number;

  /** Owner sales channels from the catalog ([] on an old server → no selector). */
  channels: SalesChannel[];
  /** Selected channel id (persisted); null = the implicit base «الأساسي».
   *  This is the cashier's PREFERENCE — it is NOT proof those prices loaded. */
  channelId: string | null;
  /** The channel whose prices the catalog on screen ACTUALLY carries (null =
   *  base prices). Render the "active channel" affordance from THIS, not from
   *  `channelId`: they differ exactly when a channel fetch failed. */
  activeChannelId: string | null;
  /** `channelId` is set but its price list could not be served — the grid is
   *  showing base/cached prices. The UI must not present the channel as active. */
  channelPricesUnavailable: boolean;
  /** Switch channel: refetches the catalog with ?channelId= WITHOUT touching the
   *  cart (legacy preserved the cart across switches — V5.7.11). */
  setChannel: (id: string | null) => void;

  shiftId: string | null;
  shiftLoading: boolean;
  /** Open a shift with an optional opening float (الرصيد الافتتاحي). Callers
   *  that pass no float open with 0 (backward compatible). */
  openShiftNow: (openingFloat?: number) => void;
  openingShift: boolean;
  onShiftClosed: () => void;

  cart: LocalOrder;
  totals: CartTotals;
  /** Add an item, optionally in a specific unit (base if omitted). */
  addItem: (item: CatalogItem, unitCode?: string | null) => void;
  /** Card − affordance: decrement one unit of this item — targets the line a
   *  repeated card tap would grow (clean/no-notes first, else the last line of
   *  the item). Removing the last unit removes the line (cart-dec-line). */
  decrementItem: (itemId: string) => void;
  /** Line ops address lines by INDEX — two lines may share a menuId
   *  (e.g. one with kitchen notes, one without). */
  setQty: (index: number, qty: number) => void;
  /** Change a line's unit (re-freezes the factor, recomputes baseQty). */
  setLineUnit: (index: number, unit: CatalogUnit) => void;
  removeLine: (index: number) => void;
  setLineNotes: (index: number, notes: string | null) => void;
  setLineDiscount: (index: number, amount: number) => void;
  setOrderType: (t: OrderType) => void;
  setTableNo: (t: string | null) => void;
  setDiscount: (type: DiscountType | null, value: number, name: string | null) => void;
  setCustomer: (name: string | null, phone: string | null) => void;
  setCustomerRef: (cust: { id: string; name: string | null; phone: string | null } | null) => void;
  /** Order-to-Cash enabled on the server (read from /api/version). When true the
   *  POS shows the searchable customer picker + enforces credit-needs-customer. */
  o2cEnabled: boolean;
  setNote: (note: string | null) => void;
  startNewOrder: () => void;
  loadOrderDoc: (doc: LocalOrder) => void;

  /** Plain toasts — what <Toasts/> renders. Never carries an action. */
  toasts: Toast[];
  /**
   * Push a toast. The optional third argument attaches a ONE-TAP action
   * ({label, onClick}); such a toast is routed to the provider's own bottom
   * snackbar instead of the plain stack, so nothing is rendered twice.
   * Every pre-existing two-argument call site behaves exactly as before.
   */
  pushToast: (kind: Toast["kind"], message: string, action?: ToastAction) => void;
  dismissToast: (id: number) => void;

  /**
   * Recipe/BOM-driven availability (the 86 board). null/absent = the endpoint is
   * unavailable or not fetched yet; every consumer degrades to warehouseQty.
   *
   * OPTIONAL on purpose: the product grid does NOT read it from here (it is
   * prop-driven and is rendered without a provider by several specs — it
   * subscribes to the snapshot in components/StockPip instead). Keeping the
   * field optional means the shared parity test-kit's makeCtx() needs no edit,
   * which matters while other streams are editing that same file.
   */
  availability?: MenuAvailabilityMap | null;
}

const PosContext = createContext<PosContextValue | null>(null);

let toastSeq = 0;

export function PosProvider({ children }: { children: ReactNode }) {
  const [user] = useState<AuthUser | null>(() => currentUser());
  const deviceId = useMemo(getDeviceId, []);
  const engine = useMemo(getEngine, []);
  const queryClient = useQueryClient();

  const engineStatus = useSyncExternalStore(
    useCallback((cb: () => void) => engine.subscribe(cb), [engine]),
    () => engine.getStatus(),
  );

  // The engine is a singleton constructed OUTSIDE the React tree (getEngine()),
  // so it cannot call useT() itself — hand it the live translator here (null
  // in tests that render PosProvider without an ancestor I18nProvider; the
  // engine falls back to a safe identity translator in that case). Re-runs on
  // every language switch so queued-op toasts translate into whichever
  // language is active at flush time.
  const t = useOptionalT();
  useEffect(() => {
    if (t) engine.setTranslator(t);
  }, [engine, t]);

  // This provider's OWN strings (undo, 86-board warning). useT() always resolves
  // — outside an I18nProvider it falls back to the base (ar) dictionary — so
  // unlike the engine's translator above it is never null. Held in refs so the
  // cart callbacks below stay referentially stable across a language switch.
  const tr = useT();
  const tn = useLocalizedName();
  const trRef = useRef(tr);
  trRef.current = tr;
  const tnRef = useRef(tn);
  tnRef.current = tn;

  // ── Toasts ─────────────────────────────────────────────────────────────────
  // TWO disjoint channels: plain toasts (rendered by <Toasts/>) and actionable
  // ones (rendered by ActionToastStack, mounted at the bottom of this provider).
  // Routing on `action` rather than filtering one shared list is what guarantees
  // a message can never be painted by both surfaces.
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [actionToasts, setActionToasts] = useState<Toast[]>([]);
  const pushToast = useCallback((kind: Toast["kind"], message: string, action?: ToastAction) => {
    const id = ++toastSeq;
    if (action) {
      // Only ever two on screen: an undo the cashier can no longer place in time
      // is worse than no undo at all.
      setActionToasts((t) => [...t.slice(-1), { id, kind, message, action }]);
      setTimeout(() => setActionToasts((t) => t.filter((x) => x.id !== id)), ACTION_TOAST_TTL_MS);
      return;
    }
    setToasts((t) => [...t.slice(-3), { id, kind, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), TOAST_TTL_MS);
  }, []);
  const dismissToast = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
    setActionToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  // ── Catalog (channel-aware) ────────────────────────────────────────────────
  const [channelId, setChannelId] = useState<string | null>(getStoredChannelId);
  const setChannel = useCallback((id: string | null) => {
    setChannelId(id);
    try {
      if (id) localStorage.setItem(CHANNEL_KEY, id);
      else localStorage.removeItem(CHANNEL_KEY);
    } catch {
      /* private mode — the selection just won't survive a reload */
    }
    // Deliberately NOT touching the cart: switching channels preserves it
    // (legacy V5.7.11 — «Switching channels NEVER clears the cart»).
  }, []);

  const catalogQuery = useQuery({
    queryKey: ["catalog", channelId ?? "base"],
    queryFn: () => loadCatalogForChannel(channelId),
    enabled: !!user,
    refetchInterval: 5 * 60_000,
    // Keep the previous channel's catalog on screen while the new one loads —
    // a switch must never blank the grid mid-shift.
    placeholderData: (prev) => prev,
  });

  // ── لوحة النفاد / the 86 board ──────────────────────────────────────────────
  // Recipe/BOM-driven availability, fetched ALONGSIDE the catalog (never as part
  // of it: the catalog is ETag-cached for offline boot and must not be
  // invalidated by a stock figure that changes every minute).
  //
  // IT DEGRADES SILENTLY, BY CONSTRUCTION. The queryFn swallows EVERY failure
  // and resolves to null instead of rejecting: an old server with no such route
  // answers 404, a hardened deployment could answer 403, and offline it throws
  // outright. None of those are the cashier's problem — the grid simply falls
  // back to CatalogItem.warehouseQty and nothing is shown as unavailable that we
  // cannot prove. Because it never rejects there is also no retry storm, no
  // error toast, and no unhandled rejection: the next refetchInterval tick just
  // tries again in case the server came back.
  const availabilityQuery = useQuery({
    queryKey: ["menu-availability"],
    queryFn: async (): Promise<MenuAvailabilityMap | null> => {
      try {
        return (await fetchMenuAvailabilityBulk()) ?? null;
      } catch {
        return null; // 404 / 403 / offline / malformed — no opinion, no noise
      }
    },
    enabled: !!user && engineStatus.online,
    // Stock moves on a different clock than the menu: often enough that a 86'd
    // item greys out within a couple of orders, rarely enough that a busy till
    // is not walking every recipe in the database on the cashier's behalf.
    refetchInterval: 90_000,
    staleTime: 60_000,
    retry: false,
  });
  const availability: MenuAvailabilityMap | null = availabilityQuery.data ?? null;
  // Publish to the module snapshot the product grid subscribes to. The grid is
  // deliberately prop-driven (and rendered provider-less by several specs), so
  // this is how it learns without every host having to thread a prop.
  useEffect(() => {
    publishAvailability(availability);
  }, [availability]);

  // ── Effective capabilities (Owner J) ────────────────────────────────────────
  // Same gating pattern as catalogQuery above: no point fetching before there's
  // a logged-in user (an unauthenticated GET would just 401).
  const capsQuery = useQuery({
    queryKey: ["effective-caps", user?.username],
    queryFn: fetchEffectiveCaps,
    enabled: !!user,
    staleTime: 5 * 60_000,
  });
  const caps: EffectiveCaps | null = capsQuery.data ?? null;
  const posCan = useCallback((capId: string) => posCanBase(caps, user?.role ?? "", capId), [caps, user?.role]);

  // ── Shift ──────────────────────────────────────────────────────────────────
  const shiftQuery = useQuery({
    queryKey: ["open-shift", user?.username],
    queryFn: () => findOpenShift(user!.username),
    enabled: !!user && engineStatus.online,
    refetchInterval: 2 * 60_000,
  });
  const queryShiftId = shiftQuery.data ?? null;
  const shiftResolved = shiftQuery.isSuccess;

  // Last shift the SERVER confirmed open, mirrored to localStorage. Seeded from
  // storage so an offline cold boot has an id before (in fact, without ever) the
  // query runs — `enabled` is gated on engineStatus.online, so offline it never
  // resolves at all and `queryShiftId` stays null forever.
  const [persistedShiftId, setPersistedShiftId] = useState<string | null>(getStoredShiftId);
  useEffect(() => {
    if (!shiftResolved) return; // offline / still loading — keep what we remember
    rememberShiftId(queryShiftId); // a resolved null means "no open shift" → clear
    setPersistedShiftId(queryShiftId);
  }, [shiftResolved, queryShiftId]);

  // Once the server has spoken it is the ONLY authority — including when it says
  // null (the shift was closed elsewhere), which must not be overridden by a
  // stale remembered id. Before that (offline, or the very first paint) the
  // remembered id is strictly better than null.
  const shiftId = shiftResolved ? queryShiftId : (queryShiftId ?? persistedShiftId);

  const openShiftMutation = useMutation({
    mutationFn: apiOpenShift,
    onSuccess: (res) => {
      queryClient.setQueryData(["open-shift", user?.username], res.shiftId);
      pushToast("success", "تم فتح الوردية");
    },
    onError: (e: Error) => pushToast("error", e.message || "تعذّر فتح الوردية"),
  });

  const onShiftClosed = useCallback(() => {
    queryClient.setQueryData(["open-shift", user?.username], null);
    void queryClient.invalidateQueries({ queryKey: ["open-shift"] });
  }, [queryClient, user?.username]);

  // ── Cart (LocalOrder doc) ──────────────────────────────────────────────────
  const [cart, setCart] = useState<LocalOrder>(() => newLocalOrder(null, deviceId));
  const skipNextSave = useRef(true); // initial mount / doc loads don't re-save
  const restoredRef = useRef(false);

  // Restore the most recent open local doc once (page refresh survival).
  useEffect(() => {
    if (!user || restoredRef.current) return;
    restoredRef.current = true;
    void engine.latestOpenOrder().then((doc) => {
      if (doc) {
        skipNextSave.current = true;
        setCart(doc);
      }
    });
  }, [engine, user]);

  // Keep the cart's shiftId aligned with the live shift — but only once the
  // shift query actually resolved (offline keeps whatever the doc stored).
  useEffect(() => {
    if (!shiftResolved) return;
    setCart((c) => (c.shiftId === shiftId ? c : { ...c, shiftId, updatedAt: Date.now() }));
  }, [shiftId, shiftResolved]);

  // Local-first persistence: every cart change lands in IndexedDB instantly;
  // the engine debounces the 'upsert' op (600ms) and flushes when online.
  useEffect(() => {
    if (skipNextSave.current) {
      skipNextSave.current = false;
      return;
    }
    void engine.saveCart(cart);
  }, [cart, engine]);

  // Engine events → toasts + conflict swap (server copy won; work on the draft).
  useEffect(() => {
    return engine.onEvent((e) => {
      if (e.type === "toast") pushToast(e.kind, e.message);
      if (e.type === "conflict") {
        void engine.getOrder(e.draftId).then((draft) => {
          if (!draft) return;
          setCart((current) => {
            if (current.id !== e.originalId) return current;
            skipNextSave.current = true;
            return draft;
          });
        });
      }
    });
  }, [engine, pushToast]);

  const mutate = useCallback((fn: (c: LocalOrder) => LocalOrder) => {
    setCart((c) => ({ ...fn(c), updatedAt: Date.now() }));
  }, []);

  // Latest cart, readable from a callback WITHOUT putting `cart` in its dep list
  // (these callbacks are handed to memoised children). Assigned during render
  // from this render's own state, so it is never stale by a full commit.
  const cartRef = useRef(cart);
  cartRef.current = cart;

  // ── Undo a removed line (close/w1b-undo) ───────────────────────────────────
  // Removing a line was instant, silent and irreversible — while voiding a whole
  // order demands a typed reason. Every removal path funnels through here, so
  // the trash button, the stepper's qty→0, the card's inline − and the new
  // QtyPad's "set 0" all get the SAME one-tap recovery.
  //
  // The snapshot is the whole CartLine, so notes, lineDiscount and comboChoices
  // come back with it — a rebuilt-from-scratch line would silently drop the
  // kitchen note the customer asked for.
  const offerUndoRemoval = useCallback(
    (line: CartLine, index: number) => {
      const tt = trRef.current;
      const name = tnRef.current(line.name, line.nameEn);
      pushToast("info", tt("cartPanel.undo.removed", { name }), {
        label: tt("cartPanel.undo.action"),
        onClick: () => mutate((c) => ({ ...c, lines: restoreLineAt(c.lines, line, index) })),
      });
    },
    [pushToast, mutate],
  );

  // ── 86-board warning (close/w1b-stock) ─────────────────────────────────────
  // WARN, NEVER BLOCK: the add always happens. One toast per item per session
  // (this Set) so a cashier ringing up ten of a low item is not buried in
  // notifications. Living in the STORE rather than on the card means a barcode
  // scan and the App-level scan handler warn too, for free.
  const stockWarnedRef = useRef<Set<string>>(new Set());
  const warnIfUnavailable = useCallback(
    (item: CatalogItem) => {
      if (stockWarnedRef.current.has(item.id)) return;
      if (resolveStockState(item, getAvailabilitySnapshot()).level !== "out") return;
      stockWarnedRef.current.add(item.id);
      pushToast("info", trRef.current("productGrid.stock.addedOutOfStock", { name: tnRef.current(item.name, item.nameEn) }));
    },
    [pushToast],
  );

  // ── Combos (العروض) — close/w25-combos ─────────────────────────────────────
  // Tapping a combo card must open the CHOOSER, not add directly (legacy
  // openComboChooser). The pending item + its definition (from the cached
  // catalog payload — works offline for free) drive the ComboDialog rendered
  // below; confirm freezes the picks into the cart line.
  const [comboItem, setComboItem] = useState<CatalogItem | null>(null);
  const catalogCombos = catalogQuery.data?.catalog?.combos;
  const findComboDef = useCallback(
    (item: CatalogItem): ComboDef | null => {
      const list = catalogCombos ?? [];
      return list.find((c) => c.menuId === item.id) ?? list.find((c) => c.id === item.id) ?? null;
    },
    [catalogCombos],
  );
  const comboDef = comboItem ? findComboDef(comboItem) : null;

  const addItem = useCallback(
    (item: CatalogItem, unitCode?: string | null) => {
      // Combo interception: open the chooser instead of adding. Missing
      // definition (stale cache from a pre-combos server) → say so, add nothing
      // — silently charging a combo without its picks is the one wrong answer.
      warnIfUnavailable(item);
      if (item.isCombo) {
        if (!findComboDef(item)) {
          pushToast("error", "خيارات العرض غير متوفرة — حدّث القائمة عند الاتصال");
          return;
        }
        setComboItem(item);
        return;
      }
      // Popularity tally for «الأكثر مبيعًا» — recorded where a line is actually
      // created, never on the combo INTERCEPT above (that only opens a chooser
      // the cashier may still cancel). Local-only; see lib/quickPicks.ts.
      recordPick(item.id);
      mutate((c) => {
        const unit = pickUnit(item, unitCode);
        const code = unit ? unit.unitCode : null;
        // Merge only into a line of the SAME item AND unit (a carton line and a
        // piece line of the same product stay separate) with no notes/discount —
        // AND the same effective price: legacy's cart-line key was «id +
        // effective price + modifiers» (app.js:400), so after a channel switch
        // re-prices the catalog, a new add opens a NEW line at the new price
        // instead of silently selling more units at the old frozen price.
        const effectivePrice = item.basePrice ?? item.price;
        const existing = c.lines.find(
          (l) =>
            l.menuId === item.id &&
            (l.enteredUnitCode ?? null) === code &&
            l.unitPrice === effectivePrice &&
            !l.notes &&
            !l.lineDiscount,
        );
        if (existing) {
          return { ...c, lines: c.lines.map((l) => (l === existing ? withBase(l, { qty: l.qty + 1 }) : l)) };
        }
        return { ...c, lines: [...c.lines, buildCartLine(item, unit, 1)] };
      });
    },
    [mutate, findComboDef, pushToast, warnIfUnavailable],
  );

  // Chooser confirm → ONE cart line with the frozen picks. comboChoices rides
  // for the server; the human summary lands in `notes` so the cart panel and
  // the kitchen ticket show the choices with no extra plumbing. Identical
  // picks stack (legacy stacked by modifiers key); any difference — choices,
  // notes, discount — keeps its own line.
  const confirmCombo = useCallback(
    (result: ComboFinalizeResult) => {
      const item = comboItem;
      setComboItem(null);
      if (!item) return;
      recordPick(item.id); // the combo really is being sold now
      mutate((c) => {
        const key = JSON.stringify(result.comboChoices);
        const existing = c.lines.find(
          (l) =>
            l.menuId === item.id &&
            l.comboChoices != null &&
            JSON.stringify(l.comboChoices) === key &&
            (l.notes ?? null) === result.notesSummary &&
            !l.lineDiscount,
        );
        if (existing) {
          return { ...c, lines: c.lines.map((l) => (l === existing ? withBase(l, { qty: l.qty + 1 }) : l)) };
        }
        const line: CartLine = {
          ...buildCartLine(item, null, 1),
          unitPrice: result.unitPrice, // combo price + picked priceDeltas, frozen
          notes: result.notesSummary,
          comboChoices: result.comboChoices,
        };
        return { ...c, lines: [...c.lines, line] };
      });
    },
    [comboItem, mutate],
  );

  // Legacy decFromCart (app.js:448) decremented the card's matching cart line.
  // Preference order mirrors addItem's merge target so + and − act on the SAME
  // line: a clean line (no notes / no discount) of the item first, else the
  // LAST line of the item. qty 1 → the line goes away entirely.
  const decrementItem = useCallback(
    (itemId: string) => {
      // The SAME preference order the updater below uses, evaluated against the
      // committed cart, purely to decide whether this decrement REMOVES a line
      // (and to snapshot it for undo). The updater keeps its own self-contained
      // lookup so the actual mutation logic is byte-for-byte unchanged.
      const lines = cartRef.current.lines;
      let removedIdx = lines.findIndex((l) => l.menuId === itemId && !l.notes && !l.lineDiscount);
      if (removedIdx === -1) {
        for (let i = lines.length - 1; i >= 0; i--) {
          if (lines[i]!.menuId === itemId) {
            removedIdx = i;
            break;
          }
        }
      }
      const removed = removedIdx !== -1 && lines[removedIdx]!.qty <= 1 ? { ...lines[removedIdx]! } : null;

      mutate((c) => {
        let idx = c.lines.findIndex((l) => l.menuId === itemId && !l.notes && !l.lineDiscount);
        if (idx === -1) {
          for (let i = c.lines.length - 1; i >= 0; i--) {
            if (c.lines[i]!.menuId === itemId) {
              idx = i;
              break;
            }
          }
        }
        if (idx === -1) return c;
        const target = c.lines[idx]!;
        if (target.qty <= 1) return { ...c, lines: c.lines.filter((_, i) => i !== idx) };
        return { ...c, lines: c.lines.map((l, i) => (i === idx ? withBase(l, { qty: l.qty - 1 }) : l)) };
      });

      if (removed) offerUndoRemoval(removed, removedIdx);
    },
    [mutate, offerUndoRemoval],
  );

  const setQty = useCallback(
    (index: number, qty: number) => {
      // qty ≤ 0 removes the line (the QtyPad's "set 0" rides this exact path).
      const removed = qty <= 0 ? cartRef.current.lines[index] : undefined;
      mutate((c) => ({
        ...c,
        lines:
          qty <= 0
            ? c.lines.filter((_, i) => i !== index)
            : c.lines.map((l, i) => (i === index ? withBase(l, { qty }) : l)),
      }));
      if (removed) offerUndoRemoval({ ...removed }, index);
    },
    [mutate, offerUndoRemoval],
  );

  const setLineUnit = useCallback(
    (index: number, unit: CatalogUnit) =>
      mutate((c) => ({
        ...c,
        lines: c.lines.map((l, i) =>
          i === index
            ? withBase(l, {
                enteredUnitId: unit.unitId, enteredUnitCode: unit.unitCode, enteredUnitName: unit.unitName,
                conversionFactorSnapshot: Number(unit.factor) || 1,
              })
            : l,
        ),
      })),
    [mutate],
  );

  const removeLine = useCallback(
    (index: number) => {
      const removed = cartRef.current.lines[index];
      mutate((c) => ({ ...c, lines: c.lines.filter((_, i) => i !== index) }));
      if (removed) offerUndoRemoval({ ...removed }, index);
    },
    [mutate, offerUndoRemoval],
  );

  const setLineNotes = useCallback(
    (index: number, notes: string | null) =>
      mutate((c) => ({ ...c, lines: c.lines.map((l, i) => (i === index ? { ...l, notes } : l)) })),
    [mutate],
  );

  const setLineDiscount = useCallback(
    (index: number, amount: number) =>
      mutate((c) => ({
        ...c,
        lines: c.lines.map((l, i) => (i === index ? { ...l, lineDiscount: Math.max(0, amount) } : l)),
      })),
    [mutate],
  );

  const setOrderType = useCallback(
    (t: OrderType) => mutate((c) => ({ ...c, orderType: t, tableNo: t === "dine_in" ? c.tableNo : null })),
    [mutate],
  );
  const setTableNo = useCallback((t: string | null) => mutate((c) => ({ ...c, tableNo: t })), [mutate]);
  const setDiscount = useCallback(
    (type: DiscountType | null, value: number, name: string | null) =>
      mutate((c) => ({ ...c, discountType: type, discountValue: type ? Math.max(0, value) : 0, discountName: type ? name : null })),
    [mutate],
  );
  // Free-text customer (legacy path / O2C off): manual edits clear any linked id.
  const setCustomer = useCallback(
    (name: string | null, phone: string | null) => mutate((c) => ({ ...c, customerName: name, customerPhone: phone, customerId: null })),
    [mutate],
  );
  // Linked customer (O2C): a real customerId + display name/phone from the picker.
  const setCustomerRef = useCallback(
    (cust: { id: string; name: string | null; phone: string | null } | null) =>
      mutate((c) => ({ ...c, customerId: cust ? cust.id : null, customerName: cust ? cust.name : null, customerPhone: cust ? cust.phone : null })),
    [mutate],
  );
  const setNote = useCallback((note: string | null) => mutate((c) => ({ ...c, note })), [mutate]);

  // Every new cart must carry a shift id or its checkout is dead on arrival.
  // Three sources, best first: the live/remembered shift, then the doc we are
  // replacing — offline that LAST fallback is what the first restored order of
  // the boot was carrying, and it is the only reason order #1 ever worked.
  // Reading `prev` inside the updater keeps the cart out of the dep list.
  const startNewOrder = useCallback(() => {
    skipNextSave.current = false; // the new empty doc still saves locally
    setCart((prev) => newLocalOrder(shiftId ?? persistedShiftId ?? prev.shiftId, deviceId));
  }, [shiftId, persistedShiftId, deviceId]);

  const loadOrderDoc = useCallback((doc: LocalOrder) => {
    skipNextSave.current = true;
    setCart(doc);
  }, []);

  // The rate comes from the SERVER (settings.VATRate, shipped on the catalog).
  // It used to be hardcoded 0.15 inside cartMath while /api/sales read the
  // setting, so an owner changing the rate desynced the register from the books
  // with no visible symptom until a sale was refused.
  // Exposed on the context (`vatRatePct`) because the footer was the ONLY place
  // that had it: the per-line amounts and the discount dialog's preview each
  // called cartMath with no rate and silently got the 15% default, so on a
  // non-15% tenant every line and the whole preview disagreed with the total
  // right beneath them — and with what the server actually charges.
  // Keep the local top-sellers tally honest: an item the owner deleted or
  // deactivated must not keep a slot on the pinned chip (or hand the grid a
  // ghost id). Guarded on a NON-EMPTY catalog — pruning against the empty
  // placeholder that exists while the catalog loads would wipe the whole tally.
  const catalogItems = catalogQuery.data?.catalog?.items;
  useEffect(() => {
    if (!catalogItems || catalogItems.length === 0) return;
    pruneQuickPicks(new Set(catalogItems.filter((i) => i.active).map((i) => i.id)));
  }, [catalogItems]);

  const vatRatePct = catalogQuery.data?.catalog?.vatRate ?? DEFAULT_VAT_RATE_PCT;
  const totals = useMemo(
    () => cartTotals(cart.lines, cart.discountType ? { type: cart.discountType, value: cart.discountValue } : null, vatRatePct),
    [cart.lines, cart.discountType, cart.discountValue, vatRatePct],
  );

  // A channel is "active" only when its OWN price list is on screen. A failed
  // channel fetch degrades to base/cached prices; `channelId` (the cashier's
  // persisted preference) deliberately survives that, so the two disagree
  // exactly when the UI must stop advertising the channel.
  const channelPricesUnavailable = catalogQuery.data?.channelPricesUnavailable ?? false;
  const activeChannelId = catalogQuery.data?.servedChannelId ?? null;

  // A t()-able PATH, never a raw `.message`. CatalogError carries the code;
  // anything else (a bare TypeError from fetch) resolves to the generic load
  // failure, so this is always a key that exists in both dictionaries.
  const catalogError = catalogQuery.isError
    ? `errors.${catalogQuery.error instanceof CatalogError ? catalogQuery.error.code : "CATALOG_LOAD_FAILED"}`
    : null;

  // Order-to-Cash server flag (read once, cached). Drives the customer picker.
  const flagsQuery = useQuery({
    queryKey: ["pos-server-flags"],
    queryFn: () => getServerFlags(),
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const o2cEnabled = flagsQuery.data?.orderToCash === true;

  const value: PosContextValue = {
    user,
    supervisor: isSupervisor(user),
    caps,
    posCan,
    deviceId,
    engine,
    engineStatus,
    catalog: catalogQuery.data?.catalog ?? null,
    catalogLoading: catalogQuery.isLoading,
    catalogError,
    catalogErrorObject: catalogQuery.isError ? catalogQuery.error : null,
    catalogStale: catalogQuery.data?.stale ?? false,
    catalogAgeMs: catalogQuery.data?.ageMs ?? null,
    refetchCatalog: () => void catalogQuery.refetch(),
    vatRatePct,
    channels: catalogQuery.data?.catalog.channels ?? [],
    channelId,
    activeChannelId,
    channelPricesUnavailable,
    setChannel,
    shiftId,
    shiftLoading: shiftQuery.isLoading,
    openShiftNow: (openingFloat?: number) => openShiftMutation.mutate(openingFloat),
    openingShift: openShiftMutation.isPending,
    onShiftClosed,
    cart,
    totals,
    addItem,
    decrementItem,
    setQty,
    setLineUnit,
    removeLine,
    setLineNotes,
    setLineDiscount,
    setOrderType,
    setTableNo,
    setDiscount,
    setCustomer,
    setCustomerRef,
    o2cEnabled,
    setNote,
    startNewOrder,
    loadOrderDoc,
    toasts,
    pushToast,
    dismissToast,
    availability,
  };

  return (
    <PosContext.Provider value={value}>
      {children}
      {/* Actionable toasts (undo). Mounted by the provider for the same reason
          the combo chooser is: every host of the store gets the affordance with
          zero wiring — including the mobile bottom sheet, where a cart-side
          undo would otherwise be invisible. */}
      <ActionToastStack toasts={actionToasts} onDismiss={dismissToast} />
      {/* Combo chooser — mounted by the provider (addItem owns the intercept),
          so every host of the store gets the flow with zero wiring. */}
      <ComboDialog
        open={comboItem != null && comboDef != null}
        combo={comboDef}
        basePrice={comboItem ? (comboItem.basePrice ?? comboItem.price) : undefined}
        onClose={() => setComboItem(null)}
        onConfirm={confirmCombo}
      />
    </PosContext.Provider>
  );
}

export function usePos(): PosContextValue {
  const ctx = useContext(PosContext);
  if (!ctx) throw new Error("usePos must be used inside <PosProvider>");
  return ctx;
}
