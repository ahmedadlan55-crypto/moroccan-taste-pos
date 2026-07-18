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
import { currentUser, getToken, isSupervisor } from "@/lib/auth";
import { loadCatalog, type LoadedCatalog } from "@/lib/catalogCache";
import { idbPut } from "@/lib/idb";
import { openShift as apiOpenShift, findOpenShift, getServerFlags } from "@/lib/api";
import { getEngine, type EngineStatus, type OfflineEngine } from "@/lib/offline";
import { cartTotals } from "@/lib/cartMath";
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
    menuId: item.id, name: item.name, qty: enteredQty, unitPrice: item.basePrice ?? item.price,
    lineDiscount: 0, vatCategory: item.taxCategory, notes: null,
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
 */
async function loadCatalogForChannel(channelId: string | null): Promise<LoadedCatalog> {
  if (!channelId) return loadCatalog();
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`/api/pos/v2/catalog?channelId=${encodeURIComponent(channelId)}`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as Catalog;
    const savedAt = Date.now();
    // Write-through (etag null: the next base load does a full 200 refetch
    // rather than trusting a channel-priced copy against the base ETag).
    await idbPut("catalog", "catalog", { data, etag: null, savedAt }).catch(() => undefined);
    return { catalog: data, fromCache: false, savedAt, ageMs: 0, stale: false };
  } catch {
    return loadCatalog();
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

export interface Toast {
  id: number;
  kind: "success" | "error" | "info";
  message: string;
}

export interface PosContextValue {
  user: AuthUser | null;
  supervisor: boolean;
  deviceId: string;
  engine: OfflineEngine;
  engineStatus: EngineStatus;

  catalog: Catalog | null;
  catalogLoading: boolean;
  catalogError: string | null;
  /** Serving a cached catalog we could not confirm is current — prices may be out of date. */
  catalogStale: boolean;
  /** Age of the served catalog copy in ms (null = fresh or unknown). */
  catalogAgeMs: number | null;
  refetchCatalog: () => void;

  /** Owner sales channels from the catalog ([] on an old server → no selector). */
  channels: SalesChannel[];
  /** Selected channel id (persisted); null = the implicit base «الأساسي». */
  channelId: string | null;
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

  toasts: Toast[];
  pushToast: (kind: Toast["kind"], message: string) => void;
  dismissToast: (id: number) => void;
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

  // ── Toasts ─────────────────────────────────────────────────────────────────
  const [toasts, setToasts] = useState<Toast[]>([]);
  const pushToast = useCallback((kind: Toast["kind"], message: string) => {
    const id = ++toastSeq;
    setToasts((t) => [...t.slice(-3), { id, kind, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

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

  // ── Shift ──────────────────────────────────────────────────────────────────
  const shiftQuery = useQuery({
    queryKey: ["open-shift", user?.username],
    queryFn: () => findOpenShift(user!.username),
    enabled: !!user && engineStatus.online,
    refetchInterval: 2 * 60_000,
  });
  const shiftId = shiftQuery.data ?? null;

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
  const shiftResolved = shiftQuery.isSuccess;
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
      if (item.isCombo) {
        if (!findComboDef(item)) {
          pushToast("error", "خيارات العرض غير متوفرة — حدّث القائمة عند الاتصال");
          return;
        }
        setComboItem(item);
        return;
      }
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
    [mutate, findComboDef, pushToast],
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
    (itemId: string) =>
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
      }),
    [mutate],
  );

  const setQty = useCallback(
    (index: number, qty: number) =>
      mutate((c) => ({
        ...c,
        lines:
          qty <= 0
            ? c.lines.filter((_, i) => i !== index)
            : c.lines.map((l, i) => (i === index ? withBase(l, { qty }) : l)),
      })),
    [mutate],
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
    (index: number) => mutate((c) => ({ ...c, lines: c.lines.filter((_, i) => i !== index) })),
    [mutate],
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

  const startNewOrder = useCallback(() => {
    skipNextSave.current = false; // the new empty doc still saves locally
    setCart(newLocalOrder(shiftId, deviceId));
  }, [shiftId, deviceId]);

  const loadOrderDoc = useCallback((doc: LocalOrder) => {
    skipNextSave.current = true;
    setCart(doc);
  }, []);

  const totals = useMemo(
    () => cartTotals(cart.lines, cart.discountType ? { type: cart.discountType, value: cart.discountValue } : null),
    [cart.lines, cart.discountType, cart.discountValue],
  );

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
    deviceId,
    engine,
    engineStatus,
    catalog: catalogQuery.data?.catalog ?? null,
    catalogLoading: catalogQuery.isLoading,
    catalogError: catalogQuery.isError ? (catalogQuery.error as Error).message : null,
    catalogStale: catalogQuery.data?.stale ?? false,
    catalogAgeMs: catalogQuery.data?.ageMs ?? null,
    refetchCatalog: () => void catalogQuery.refetch(),
    channels: catalogQuery.data?.catalog.channels ?? [],
    channelId,
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
  };

  return (
    <PosContext.Provider value={value}>
      {children}
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
