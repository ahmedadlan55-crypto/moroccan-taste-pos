/**
 * Shortage requests (طلب النواقص) + receive materials (استلام مواد) — React
 * parity port of the legacy modals:
 *   public/pos/app.js: openShortageRequest(4634) / shrFilterItems(4665) /
 *   shrAddItem(4691) / shrUpdateDual(4713) / submitShortageRequest(4774) /
 *   shrEditRequest(4570) / shrDeleteRequest(4621) / _shrLoadHistory(4520) /
 *   openReceiveModal(4101) / rcvUpdateQty(4142) / submitReceiveRequest(4149).
 *
 * Two tabs:
 *   (a) طلب نواقص — item search + dual-unit lines, notes, submit (create or
 *       save-edits when a pending request was loaded for editing).
 *   (b) طلباتي والاستلام — my requests with the 7-status pill + rejection
 *       reason; pending → edit/delete; converted → receive with qty
 *       confirmation → POST /api/inventory/receive-request.
 *
 * Persistent cart in localStorage 'pos_shortage_cart' (same key as legacy).
 * Online-only, like the legacy flow.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Boxes, CalendarDays, PackageOpen, PackageSearch, Pencil, Search, Trash2 } from "lucide-react";
import { usePos } from "@/state/store";
import {
  createShortageRequest,
  deleteShortageRequest,
  getInvItems,
  getPurchases,
  getShortageRequest,
  getShortageRequests,
  submitReceiveRequest,
  updateShortageRequest,
  type InvItem,
  type ReceiveLinePayload,
  type ShortageLinePayload,
  type ShortageRequestSummary,
} from "@/lib/api";
import { useT } from "@/i18n/I18nProvider";
import { translateApiError } from "@/i18n/errorCodes";
import type { TFunction } from "@/i18n/types";
import { Dialog } from "../Dialog";
import { Button, EmptyState, ErrorBanner, Skeleton, cn } from "../ui";
import { dualUnitTotal, hasBigUnit, normalizeArabic } from "./StocktakeDialog";

// ── Status map — port of _shrLoadHistory (app.js:4526-4529) ──────────────────
// Values are i18n dotted-paths under requisitionsDialog.status.*, not literal text.
export const SHR_STATUS_LABELS: Record<string, string> = {
  pending: "requisitionsDialog.status.pending",
  approved: "requisitionsDialog.status.approved",
  converted: "requisitionsDialog.status.converted",
  rejected: "requisitionsDialog.status.rejected",
  partially_received: "requisitionsDialog.status.partiallyReceived",
  fully_received: "requisitionsDialog.status.fullyReceived",
  closed: "requisitionsDialog.status.closed",
};
function shrStatusLabel(status: string, t: TFunction): string {
  const path = SHR_STATUS_LABELS[status];
  return path ? t(path) : status;
}
const SHR_STATUS_CLASSES: Record<string, string> = {
  pending: "border-amber-300 bg-amber-50 text-amber-800",
  approved: "border-sky-200 bg-sky-50 text-sky-700",
  converted: "border-teal-200 bg-teal-50 text-teal-700",
  rejected: "border-red-200 bg-red-50 text-red-700",
  partially_received: "border-orange-200 bg-orange-50 text-orange-700",
  fully_received: "border-emerald-200 bg-emerald-50 text-emerald-700",
  closed: "border-slate-200 bg-slate-50 text-slate-500",
};

/** Rejection reason extraction — port of app.js:4558 (/\[رفض: (.+?)\]/). */
export function extractRejectionReason(notes: string | null | undefined): string | null {
  if (!notes) return null;
  const m = notes.match(/\[رفض: (.+?)\]/);
  return m ? m[1] : notes;
}

// ── Persistent cart (same key + line shape as legacy _shrCart) ───────────────
export interface ShrLine {
  id: string;
  name: string;
  unit: string;
  bigUnit: string;
  convRate: number;
  stock: number;
  minStock: number;
  cost: number;
  requestedQty: number;
  _bigInput?: number | "";
  _smallInput?: number | "";
}

const CART_KEY = "pos_shortage_cart";

function loadCart(): ShrLine[] {
  try {
    const raw = JSON.parse(localStorage.getItem(CART_KEY) || "[]") as ShrLine[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}
function saveCart(cart: ShrLine[]) {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
  } catch {
    /* draft just won't survive reload */
  }
}

/** Reverse-split a total qty into big/small inputs — port of shrEditRequest (app.js:4594-4603). */
export function splitDualQty(qty: number, convRate: number, hasBig: boolean): { big: number | ""; small: number | "" } {
  if (!hasBig || qty <= 0) return { big: "", small: qty > 0 ? qty : "" };
  const rate = Number(convRate) || 1;
  let big: number | "" = Math.floor(qty / rate);
  let small: number | "" = qty % rate;
  if (big === 0) big = "";
  if (small === 0 && big !== "") small = "";
  else if (small === 0) small = qty;
  return { big, small };
}

function fmtDateEnGB(d: string): string {
  try {
    return new Date(d).toLocaleDateString("en-GB");
  } catch {
    return "";
  }
}

// ── Receive flow state ────────────────────────────────────────────────────────
interface RcvLine {
  id: string;
  name: string;
  unit: string;
  qty: number;
  unitPrice: number;
  receivedQty: number;
}
interface RcvState {
  requestNumber: string;
  purchaseId: string;
  lines: RcvLine[];
}

type Tab = "new" | "history";

export function RequisitionsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const { user, engineStatus, pushToast } = usePos();
  const online = engineStatus.online;
  const username = user?.username ?? "";

  const [tab, setTab] = useState<Tab>("new");
  const [items, setItems] = useState<InvItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [cart, setCart] = useState<ShrLine[]>(() => loadCart());
  const [notes, setNotes] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingNumber, setEditingNumber] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const [history, setHistory] = useState<ShortageRequestSummary[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);

  const [rcv, setRcv] = useState<RcvState | null>(null);
  const [rcvBusy, setRcvBusy] = useState(false);

  // ── Load inventory items (for the new-request tab) ──────────────────────────
  const fetchItems = useCallback(async () => {
    setLoadError(null);
    setItems(null);
    try {
      const list = await getInvItems();
      setItems(list);
      // Refresh unit/stock data on the draft cart (same as legacy _shrRenderCart).
      setCart((c) => {
        const next = c.map((line) => {
          const fresh = list.find((x) => x.id === line.id);
          if (!fresh) return line;
          return {
            ...line,
            bigUnit: fresh.bigUnit || line.bigUnit || "",
            convRate: Number(fresh.convRate) || Number(line.convRate) || 1,
            unit: fresh.unit || line.unit || "",
            stock: Number(fresh.stock) || 0,
            minStock: Number(fresh.minStock) || 0,
            cost: Number(fresh.cost) || 0,
          };
        });
        saveCart(next);
        return next;
      });
    } catch (e) {
      setLoadError(translateApiError(e, t));
    }
  }, [t]);

  const loadHistory = useCallback(async () => {
    setHistoryError(null);
    setHistory(null);
    try {
      const list = await getShortageRequests();
      // Client-side filter to my own requests — same as legacy app.js:4536.
      setHistory(list.filter((r) => r.username === username));
    } catch (e) {
      setHistoryError(translateApiError(e, t));
      setHistory([]);
    }
  }, [username, t]);

  useEffect(() => {
    if (!open) return;
    setTab("new");
    setRcv(null);
    setQuery("");
    setEditingId(null);
    setEditingNumber("");
    setCart(loadCart()); // draft survives close/reopen (shortage-persistent-cart)
    if (online) void fetchItems();
  }, [open, online, fetchItems]);

  useEffect(() => {
    if (open && online && tab === "history" && !rcv) void loadHistory();
  }, [open, online, tab, rcv, loadHistory]);

  const mutateCart = useCallback((fn: (c: ShrLine[]) => ShrLine[]) => {
    setCart((c) => {
      const next = fn(c);
      saveCart(next);
      return next;
    });
  }, []);

  // ── New-request tab actions ─────────────────────────────────────────────────
  const matches = useMemo(() => {
    if (!items) return [];
    const inCart = new Set(cart.map((c) => c.id));
    const available = items.filter((i) => !inCart.has(i.id));
    const qn = normalizeArabic(query);
    if (!qn) return available;
    return available.filter(
      (i) =>
        normalizeArabic(i.name || "").includes(qn) ||
        normalizeArabic(i.category || "").includes(qn) ||
        normalizeArabic(i.id || "").includes(qn),
    );
  }, [items, cart, query]);

  function addItem(item: InvItem) {
    mutateCart((c) => {
      if (c.some((x) => x.id === item.id)) return c;
      return [
        ...c,
        {
          id: item.id,
          name: item.name,
          unit: item.unit || "",
          bigUnit: item.bigUnit || "",
          convRate: Number(item.convRate) || 1,
          stock: Number(item.stock) || 0,
          minStock: Number(item.minStock) || 0,
          cost: Number(item.cost) || 0,
          requestedQty: 0,
          _bigInput: "",
          _smallInput: "",
        },
      ];
    });
    setQuery("");
  }

  function updateDual(idx: number, bigVal: number | "" | null, smallVal: number | "" | null) {
    mutateCart((c) =>
      c.map((line, i) => {
        if (i !== idx) return line;
        const next = { ...line };
        if (bigVal !== null) next._bigInput = bigVal;
        if (smallVal !== null) next._smallInput = smallVal;
        const total = dualUnitTotal(
          next._bigInput ?? "",
          next._smallInput ?? "",
          next.convRate,
          hasBigUnit(next.bigUnit, next.convRate),
        );
        next.requestedQty = total === "" ? 0 : total;
        return next;
      }),
    );
  }

  function removeLine(idx: number) {
    mutateCart((c) => c.filter((_, i) => i !== idx));
  }

  function clearCart() {
    try {
      localStorage.removeItem(CART_KEY);
    } catch {
      /* ignore */
    }
    setCart([]);
    setEditingId(null);
    setEditingNumber("");
    pushToast("info", t("requisitionsDialog.toast.cartCleared"));
  }

  const validLines = useMemo(() => cart.filter((c) => c.requestedQty > 0), [cart]);

  async function submit() {
    if (!cart.length) return pushToast("error", t("requisitionsDialog.toast.addAtLeastOne"));
    if (!validLines.length) return pushToast("error", t("requisitionsDialog.toast.enterQtyAtLeastOne"));
    const lines: ShortageLinePayload[] = validLines.map((c) => ({
      invItemId: c.id,
      invItemName: c.name,
      unit: c.unit,
      currentQty: c.stock,
      minQty: c.minStock,
      requestedQty: c.requestedQty,
      unitPrice: c.cost,
    }));
    setBusy(true);
    try {
      if (editingId) {
        await updateShortageRequest(editingId, { items: lines, notes: notes.trim() });
        pushToast("success", t("requisitionsDialog.toast.editSaved", { number: editingNumber }).trim());
      } else {
        const r = await createShortageRequest({ items: lines, username, notes: notes.trim() });
        pushToast("success", t("requisitionsDialog.toast.created", { number: r.requestNumber }));
      }
      try {
        localStorage.removeItem(CART_KEY);
      } catch {
        /* ignore */
      }
      setCart([]);
      setNotes("");
      setEditingId(null);
      setEditingNumber("");
      setTab("history");
      void loadHistory();
    } catch (e) {
      pushToast("error", translateApiError(e, t));
    } finally {
      setBusy(false);
    }
  }

  // ── History tab actions ─────────────────────────────────────────────────────
  async function startEdit(row: ShortageRequestSummary) {
    setRowBusyId(row.id);
    try {
      const detail = await getShortageRequest(row.id);
      if (detail.status !== "pending") {
        pushToast("error", t("requisitionsDialog.toast.onlyPendingEditable"));
        return;
      }
      const list = items ?? [];
      const lines: ShrLine[] = (detail.items || []).map((it) => {
        const orig = list.find((x) => x.id === it.invItemId);
        const bigUnit = orig?.bigUnit || "";
        const convRate = Number(orig?.convRate) || 1;
        const hasBig = hasBigUnit(bigUnit, convRate);
        const qty = Number(it.requestedQty) > 0 ? Number(it.requestedQty) : 1; // legacy: default 1 so there is something to edit
        const { big, small } = splitDualQty(qty, convRate, hasBig);
        const total = dualUnitTotal(big, small, convRate, hasBig);
        return {
          id: it.invItemId,
          name: it.invItemName,
          unit: it.unit || "",
          bigUnit,
          convRate,
          stock: Number(it.currentQty) || 0,
          minStock: Number(it.minQty) || 0,
          cost: Number(it.unitPrice) || 0,
          requestedQty: total === "" ? qty : total,
          _bigInput: big,
          _smallInput: small,
        };
      });
      setCart(lines);
      saveCart(lines);
      setNotes(detail.notes || "");
      setEditingId(row.id);
      setEditingNumber(row.requestNumber || "");
      setTab("new");
      pushToast("info", t("requisitionsDialog.toast.loadedForEdit"));
    } catch (e) {
      pushToast("error", translateApiError(e, t));
    } finally {
      setRowBusyId(null);
    }
  }

  async function confirmDelete(row: ShortageRequestSummary) {
    setRowBusyId(row.id);
    try {
      await deleteShortageRequest(row.id);
      pushToast("success", t("requisitionsDialog.toast.deleted", { number: row.requestNumber || "" }).trim());
      setDeletingId(null);
      await loadHistory();
    } catch (e) {
      pushToast("error", translateApiError(e, t));
    } finally {
      setRowBusyId(null);
    }
  }

  // ── Receive flow — port of openReceiveModal (app.js:4101) ───────────────────
  async function openReceive(row: ShortageRequestSummary) {
    setRowBusyId(row.id);
    try {
      const detail = await getShortageRequest(row.id);
      if (detail.status !== "converted" || !detail.poId) {
        pushToast("error", t("requisitionsDialog.toast.notConvertedYet"));
        return;
      }
      const purchases = await getPurchases();
      const pur = purchases.find((p) => p.poId === detail.poId);
      if (!pur) {
        pushToast("error", t("requisitionsDialog.toast.purchaseNotFound"));
        return;
      }
      const lines: RcvLine[] = (pur.items || []).map((it) => ({
        id: it.id || it.itemId || "",
        name: it.name || it.itemName || "",
        unit: it.unit || "",
        qty: Number(it.qty) || 0,
        unitPrice: Number(it.unitPrice ?? it.price) || 0,
        receivedQty: Number(it.qty) || 0,
      }));
      setRcv({ requestNumber: detail.requestNumber || "", purchaseId: pur.id, lines });
    } catch (e) {
      pushToast("error", translateApiError(e, t));
    } finally {
      setRowBusyId(null);
    }
  }

  function rcvUpdateQty(idx: number, val: number | "") {
    setRcv((r) =>
      r
        ? {
            ...r,
            lines: r.lines.map((l, i) => (i === idx ? { ...l, receivedQty: Math.max(0, Number(val) || 0) } : l)),
          }
        : r,
    );
  }

  async function submitReceive() {
    if (!rcv || !rcv.purchaseId || !rcv.lines.length) return;
    const lines: ReceiveLinePayload[] = rcv.lines.map((it) => ({
      invItemId: it.id,
      invItemName: it.name,
      unit: it.unit,
      orderedQty: it.qty,
      receivedQty: it.receivedQty,
      unitPrice: it.unitPrice,
    }));
    setRcvBusy(true);
    try {
      await submitReceiveRequest({ purchaseId: rcv.purchaseId, items: lines, username });
      pushToast("success", t("requisitionsDialog.toast.receiveSubmitted"));
      setRcv(null);
      await loadHistory();
    } catch (e) {
      pushToast("error", translateApiError(e, t));
    } finally {
      setRcvBusy(false);
    }
  }

  // ── Renders ─────────────────────────────────────────────────────────────────

  const offlineBody = (
    <EmptyState
      icon={<PackageSearch className="h-10 w-10" aria-hidden />}
      title={t("requisitionsDialog.offline.title")}
      hint={t("requisitionsDialog.offline.hint")}
    />
  );

  const tabDefs: { key: Tab; label: string }[] = [
    { key: "new", label: t("requisitionsDialog.tabs.new") },
    { key: "history", label: t("requisitionsDialog.tabs.history") },
  ];

  const tabs = (
    <div className="mb-3 grid grid-cols-2 gap-1 rounded-2xl bg-slate-100 p-1" role="tablist" aria-label={t("requisitionsDialog.tabsAriaLabel")}>
      {tabDefs.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={tab === key}
          onClick={() => {
            setTab(key);
            setRcv(null);
          }}
          className={cn(
            "btn-press min-h-11 rounded-xl px-3 text-sm font-extrabold",
            tab === key ? "bg-white text-teal-700 shadow-sm" : "text-slate-500 hover:text-slate-700",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );

  const newTabBody = (
    <div className="flex flex-col gap-3">
      {loadError ? <ErrorBanner message={loadError} onRetry={() => void fetchItems()} /> : null}

      {editingId ? (
        <div className="flex items-center justify-between gap-2 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-2.5">
          <p className="text-xs font-extrabold text-sky-800">
            {t("requisitionsDialog.editingBanner.label")} <span className="num">{editingNumber}</span>
          </p>
          <Button size="sm" variant="ghost" onClick={clearCart}>
            {t("requisitionsDialog.editingBanner.cancel")}
          </Button>
        </div>
      ) : null}

      <div>
        <div className="relative">
          <Search className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("requisitionsDialog.search.placeholder")}
            aria-label={t("requisitionsDialog.search.ariaLabel")}
            className="field min-h-11 w-full"
            disabled={!items}
          />
        </div>
        {items === null && !loadError ? (
          <div className="mt-2 space-y-2">
            <Skeleton className="h-11" />
            <Skeleton className="h-11" />
          </div>
        ) : null}
        {items && query.trim() ? (
          <ul className="scrollbar-thin mt-1 max-h-48 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-sm" role="listbox" aria-label={t("requisitionsDialog.search.resultsAriaLabel")}>
            {matches.length === 0 ? (
              <li className="px-4 py-3 text-center text-xs font-bold text-slate-400">{t("requisitionsDialog.search.noResults")}</li>
            ) : (
              matches.slice(0, 50).map((i) => {
                const low = (Number(i.stock) || 0) <= (Number(i.minStock) || 0);
                return (
                  <li key={i.id}>
                    <button
                      type="button"
                      onClick={() => addItem(i)}
                      className="btn-press flex min-h-11 w-full items-center justify-between gap-2 border-b border-slate-100 px-4 py-2 text-start hover:bg-slate-50"
                    >
                      <span>
                        <span className="block text-sm font-bold text-ink">{i.name}</span>
                        {i.category ? <span className="block text-[11px] text-slate-400">{i.category}</span> : null}
                      </span>
                      <span className={cn("num text-xs font-extrabold", low ? "text-red-500" : "text-emerald-600")}>
                        {Number(i.stock) || 0} {i.unit || ""}
                        {low ? " ⚠" : ""}
                      </span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        ) : null}
      </div>

      {cart.length === 0 ? (
        <EmptyState
          icon={<PackageSearch className="h-10 w-10" aria-hidden />}
          title={t("requisitionsDialog.cart.emptyTitle")}
          hint={t("requisitionsDialog.cart.emptyHint")}
        />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-slate-200">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="bg-slate-50 text-[11px] font-extrabold text-slate-500">
                <th className="px-3 py-2 text-start">{t("requisitionsDialog.cart.table.item")}</th>
                <th className="px-2 py-2 text-center">{t("requisitionsDialog.cart.table.bigQty")}</th>
                <th className="px-2 py-2 text-center">{t("requisitionsDialog.cart.table.bigUnit")}</th>
                <th className="px-2 py-2 text-center">{t("requisitionsDialog.cart.table.smallQty")}</th>
                <th className="px-2 py-2 text-center">{t("requisitionsDialog.cart.table.smallUnit")}</th>
                <th className="px-2 py-2 text-center">{t("requisitionsDialog.cart.table.available")}</th>
                <th className="px-2 py-2 text-center">{t("requisitionsDialog.cart.table.delete")}</th>
              </tr>
            </thead>
            <tbody>
              {cart.map((c, i) => {
                const hasBig = hasBigUnit(c.bigUnit, c.convRate);
                const low = c.stock <= c.minStock;
                return (
                  <tr key={c.id} className="border-t border-slate-100">
                    <td className="px-3 py-2 text-xs font-extrabold text-ink">{c.name}</td>
                    <td className="px-2 py-2 text-center">
                      {hasBig ? (
                        <input
                          type="number"
                          min={0}
                          step={1}
                          inputMode="numeric"
                          value={c._bigInput ?? ""}
                          onChange={(e) => updateDual(i, e.target.value === "" ? "" : Number(e.target.value), null)}
                          placeholder="0"
                          aria-label={t("requisitionsDialog.cart.bigQtyAriaLabel", { name: c.name })}
                          className="field num min-h-11 w-16 text-center font-extrabold"
                        />
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-center text-[11px] font-bold text-slate-500">{hasBig ? c.bigUnit : "—"}</td>
                    <td className="px-2 py-2 text-center">
                      <input
                        type="number"
                        min={0}
                        step={1}
                        inputMode="numeric"
                        value={c._smallInput ?? ""}
                        onChange={(e) => updateDual(i, null, e.target.value === "" ? "" : Number(e.target.value))}
                        placeholder="0"
                        aria-label={t("requisitionsDialog.cart.smallQtyAriaLabel", { name: c.name })}
                        className="field num min-h-11 w-16 text-center font-extrabold"
                      />
                    </td>
                    <td className="px-2 py-2 text-center text-[11px] font-bold text-slate-500">{c.unit || ""}</td>
                    <td className={cn("num px-2 py-2 text-center text-xs font-extrabold", low ? "text-red-500" : "text-emerald-600")}>
                      {c.stock}
                    </td>
                    <td className="px-2 py-2 text-center">
                      <button
                        type="button"
                        onClick={() => removeLine(i)}
                        aria-label={t("requisitionsDialog.cart.deleteLineAriaLabel", { name: c.name })}
                        className="btn-press inline-flex h-11 w-11 items-center justify-center rounded-xl text-red-500 hover:bg-red-50"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <input
        type="text"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder={t("requisitionsDialog.notes.placeholder")}
        aria-label={t("requisitionsDialog.notes.ariaLabel")}
        className="field min-h-11 w-full"
        maxLength={300}
      />
    </div>
  );

  const receiveBody = rcv ? (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => setRcv(null)} disabled={rcvBusy}>
          <ArrowRight className="h-4 w-4" aria-hidden />
          {t("requisitionsDialog.receive.back")}
        </Button>
        <p className="text-sm font-extrabold text-ink">
          {t("requisitionsDialog.receive.heading")} — <span className="num">{rcv.requestNumber}</span>
        </p>
      </div>
      <div className="overflow-x-auto rounded-2xl border border-slate-200">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="bg-slate-50 text-[11px] font-extrabold text-slate-500">
              <th className="px-3 py-2 text-start">{t("requisitionsDialog.receive.table.item")}</th>
              <th className="px-2 py-2 text-center">{t("requisitionsDialog.receive.table.ordered")}</th>
              <th className="px-2 py-2 text-center">{t("requisitionsDialog.receive.table.received")}</th>
              <th className="px-2 py-2 text-center">{t("requisitionsDialog.receive.table.unit")}</th>
              <th className="px-2 py-2 text-center">{t("requisitionsDialog.receive.table.diff")}</th>
            </tr>
          </thead>
          <tbody>
            {rcv.lines.map((it, i) => {
              const diff = it.receivedQty - it.qty;
              return (
                <tr key={`${it.id}-${i}`} className="border-t border-slate-100">
                  <td className="px-3 py-2 text-xs font-extrabold text-ink">{it.name}</td>
                  <td className="num px-2 py-2 text-center font-extrabold text-sky-600">{it.qty}</td>
                  <td className="px-2 py-2 text-center">
                    <input
                      type="number"
                      min={0}
                      step={1}
                      inputMode="numeric"
                      value={it.receivedQty}
                      onChange={(e) => rcvUpdateQty(i, e.target.value === "" ? "" : Number(e.target.value))}
                      aria-label={t("requisitionsDialog.receive.receivedAriaLabel", { name: it.name })}
                      className="field num min-h-11 w-20 text-center font-extrabold"
                    />
                  </td>
                  <td className="px-2 py-2 text-center text-[11px] font-bold text-slate-500">{it.unit}</td>
                  <td
                    className={cn(
                      "num px-2 py-2 text-center font-extrabold",
                      diff === 0 ? "text-slate-500" : diff < 0 ? "text-red-500" : "text-emerald-600",
                    )}
                  >
                    {diff > 0 ? `+${diff}` : diff}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] font-bold text-slate-400">{t("requisitionsDialog.receive.footnote")}</p>
    </div>
  ) : null;

  const historyBody = rcv
    ? receiveBody
    : (
        <div className="flex flex-col gap-2">
          {historyError ? <ErrorBanner message={historyError} onRetry={() => void loadHistory()} /> : null}
          {history === null ? (
            <div className="space-y-2">
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </div>
          ) : history.length === 0 ? (
            <EmptyState icon={<Boxes className="h-10 w-10" aria-hidden />} title={t("requisitionsDialog.history.emptyTitle")} hint={t("requisitionsDialog.history.emptyHint")} />
          ) : (
            <ul className="space-y-2">
              {history.map((r) => {
                const canReceive = r.status === "converted";
                const isPending = r.status === "pending";
                // extractRejectionReason() parses the backend-authored "[رفض: ...]" data tag —
                // DATA, not UI copy; must never be translated (see function definition above).
                const rejection = r.status === "rejected" ? extractRejectionReason(r.notes) : null;
                return (
                  <li key={r.id} className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="num text-sm font-extrabold text-teal-700">{r.requestNumber || ""}</span>
                      <span className={cn("chip text-[11px]", SHR_STATUS_CLASSES[r.status] ?? "border-slate-200 bg-slate-50 text-slate-500")}>
                        {shrStatusLabel(r.status, t)}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-[11px] font-bold text-slate-400">
                      <span className="flex items-center gap-1">
                        <CalendarDays className="h-3.5 w-3.5" aria-hidden />
                        <span className="num">{fmtDateEnGB(r.requestDate)}</span>
                      </span>
                      <span className="flex items-center gap-1">
                        <Boxes className="h-3.5 w-3.5" aria-hidden />
                        <span className="num">{r.totalItems || 0}</span> {t("requisitionsDialog.history.itemsUnit")}
                      </span>
                    </div>
                    {rejection ? (
                      <div className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-xs font-bold text-red-800" role="note">
                        {t("requisitionsDialog.history.rejectionLabel")} {rejection}
                      </div>
                    ) : null}
                    {isPending ? (
                      <div className="mt-2 flex gap-2">
                        <Button size="sm" variant="primary" className="flex-1" loading={rowBusyId === r.id} onClick={() => void startEdit(r)}>
                          <Pencil className="h-3.5 w-3.5" aria-hidden />
                          {t("requisitionsDialog.history.edit")}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={rowBusyId === r.id}
                          onClick={() => setDeletingId(deletingId === r.id ? null : r.id)}
                          aria-label={t("requisitionsDialog.history.deleteAriaLabel", { number: r.requestNumber || "" })}
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                      </div>
                    ) : null}
                    {deletingId === r.id ? (
                      <div className="mt-2 flex items-center justify-between gap-2 rounded-xl bg-red-50 px-3 py-2">
                        <p className="text-xs font-bold text-red-800">
                          {t("requisitionsDialog.history.deleteConfirm", { number: r.requestNumber })}
                        </p>
                        <Button size="sm" variant="danger" loading={rowBusyId === r.id} onClick={() => void confirmDelete(r)}>
                          {t("requisitionsDialog.history.confirmDelete")}
                        </Button>
                      </div>
                    ) : null}
                    {canReceive ? (
                      <Button size="sm" variant="primary" className="mt-2 w-full" loading={rowBusyId === r.id} onClick={() => void openReceive(r)}>
                        <PackageOpen className="h-4 w-4" aria-hidden />
                        {t("requisitionsDialog.history.receiveMaterials")}
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      );

  const footer = !online
    ? null
    : tab === "new"
      ? (
          <div className="flex items-center gap-2">
            <Button variant="danger" size="sm" onClick={clearCart} disabled={!cart.length} title={t("requisitionsDialog.footer.clearCartTitle")}>
              <Trash2 className="h-4 w-4" aria-hidden />
              {t("requisitionsDialog.footer.clearCartLabel")}
            </Button>
            <span className="ms-auto text-[11px] font-bold text-slate-400">{t("requisitionsDialog.footer.autosaveHint")}</span>
            <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={!validLines.length}>
              {editingId ? t("requisitionsDialog.footer.saveEdits") : t("requisitionsDialog.footer.submitNew")} (<span className="num">{validLines.length}</span>)
            </Button>
          </div>
        )
      : rcv
        ? (
            <Button variant="primary" className="w-full" onClick={() => void submitReceive()} loading={rcvBusy}>
              <PackageOpen className="h-4 w-4" aria-hidden />
              {t("requisitionsDialog.footer.submitReceive")}
            </Button>
          )
        : null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("requisitionsDialog.title")}
      widthClass="max-w-3xl"
      footer={footer}
      locked={busy || rcvBusy}
    >
      {!online ? (
        offlineBody
      ) : (
        <>
          {tabs}
          {tab === "new" ? newTabBody : historyBody}
        </>
      )}
    </Dialog>
  );
}
