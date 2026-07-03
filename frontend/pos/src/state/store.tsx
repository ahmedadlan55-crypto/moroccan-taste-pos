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
import { currentUser, isSupervisor } from "@/lib/auth";
import { loadCatalog } from "@/lib/catalogCache";
import { openShift as apiOpenShift, findOpenShift } from "@/lib/api";
import { getEngine, type EngineStatus, type OfflineEngine } from "@/lib/offline";
import { cartTotals } from "@/lib/cartMath";
import { ulid } from "@/lib/ulid";
import type {
  AuthUser,
  Catalog,
  CatalogItem,
  CartTotals,
  DiscountType,
  LocalOrder,
  OrderType,
} from "@/lib/types";

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
  refetchCatalog: () => void;

  shiftId: string | null;
  shiftLoading: boolean;
  openShiftNow: () => void;
  openingShift: boolean;
  onShiftClosed: () => void;

  cart: LocalOrder;
  totals: CartTotals;
  addItem: (item: CatalogItem) => void;
  /** Line ops address lines by INDEX — two lines may share a menuId
   *  (e.g. one with kitchen notes, one without). */
  setQty: (index: number, qty: number) => void;
  removeLine: (index: number) => void;
  setLineNotes: (index: number, notes: string | null) => void;
  setLineDiscount: (index: number, amount: number) => void;
  setOrderType: (t: OrderType) => void;
  setTableNo: (t: string | null) => void;
  setDiscount: (type: DiscountType | null, value: number, name: string | null) => void;
  setCustomer: (name: string | null, phone: string | null) => void;
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

  // ── Catalog ────────────────────────────────────────────────────────────────
  const catalogQuery = useQuery({
    queryKey: ["catalog"],
    queryFn: loadCatalog,
    enabled: !!user,
    refetchInterval: 5 * 60_000,
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

  const addItem = useCallback(
    (item: CatalogItem) =>
      mutate((c) => {
        const existing = c.lines.find((l) => l.menuId === item.id && !l.notes && !l.lineDiscount);
        if (existing) {
          return {
            ...c,
            lines: c.lines.map((l) => (l === existing ? { ...l, qty: l.qty + 1 } : l)),
          };
        }
        return {
          ...c,
          lines: [
            ...c.lines,
            {
              menuId: item.id,
              name: item.name,
              qty: 1,
              unitPrice: item.price,
              lineDiscount: 0,
              vatCategory: item.taxCategory,
              notes: null,
            },
          ],
        };
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
            : c.lines.map((l, i) => (i === index ? { ...l, qty } : l)),
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
  const setCustomer = useCallback(
    (name: string | null, phone: string | null) => mutate((c) => ({ ...c, customerName: name, customerPhone: phone })),
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

  const value: PosContextValue = {
    user,
    supervisor: isSupervisor(user),
    deviceId,
    engine,
    engineStatus,
    catalog: catalogQuery.data?.catalog ?? null,
    catalogLoading: catalogQuery.isLoading,
    catalogError: catalogQuery.isError ? (catalogQuery.error as Error).message : null,
    refetchCatalog: () => void catalogQuery.refetch(),
    shiftId,
    shiftLoading: shiftQuery.isLoading,
    openShiftNow: () => openShiftMutation.mutate(),
    openingShift: openShiftMutation.isPending,
    onShiftClosed,
    cart,
    totals,
    addItem,
    setQty,
    removeLine,
    setLineNotes,
    setLineDiscount,
    setOrderType,
    setTableNo,
    setDiscount,
    setCustomer,
    setNote,
    startNewOrder,
    loadOrderDoc,
    toasts,
    pushToast,
    dismissToast,
  };

  return <PosContext.Provider value={value}>{children}</PosContext.Provider>;
}

export function usePos(): PosContextValue {
  const ctx = useContext(PosContext);
  if (!ctx) throw new Error("usePos must be used inside <PosProvider>");
  return ctx;
}
