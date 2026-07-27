/**
 * لوحة النفاد / the 86 board — a compact availability pip on the product card.
 *
 * THE PROBLEM
 *   `CatalogItem.warehouseQty` is populated by the server and read by NOTHING.
 *   A cashier rings up an item that ran out an hour ago and only finds out when
 *   the server refuses the sale — after the customer has ordered and, on an
 *   offline till, after the queue tries to replay.
 *
 * THE RIGHT SOURCE
 *   In a kitchen a dish is unavailable because an INGREDIENT ran out, not
 *   because the dish carries stock. GET /api/menu/availability/bulk already
 *   walks each menu row's BOM (or the legacy recipe table) and answers exactly
 *   that: makeable / isOutOfStock / isLowStock / blockerCount / hasRecipe.
 *   `warehouseQty` is the FALLBACK for whatever that map doesn't cover.
 *
 * WARN, NEVER BLOCK
 *   The server is the authority and legitimately has no stock figure for many
 *   rows (no recipe, non-stocked item, LIMIT 500 on the bulk route). So:
 *     • no data            → render nothing at all;
 *     • low                → an amber count, still fully sellable;
 *     • out                → a muted card + a «نفد» pill, STILL TAPPABLE.
 *   Tapping an out-of-stock card adds the line and raises one info toast per
 *   item per session (state/store.tsx owns that, so scans warn too).
 *
 * HEIGHT NEUTRALITY (virtualizer contract)
 *   The pip is an ABSOLUTELY POSITIONED sibling of the card's add button — the
 *   same overlay pattern as the combo/«مُخصَّص» badges — and the muted state is
 *   pure opacity/filter. Nothing here can change a card's measured height, so
 *   ProductGrid's row measurements (ROW_ESTIMATE 98 + measureElement) never
 *   shift and the grid cannot scroll-jump. It is a <span>, never a <button>:
 *   the windowing spec pins the number of buttons per row.
 *
 * WHY THE SNAPSHOT LIVES HERE
 *   ProductGrid is deliberately prop-driven and is rendered WITHOUT a
 *   PosProvider by several specs, so it cannot call usePos(). The provider
 *   publishes the fetched map into this tiny external store and the grid reads
 *   it — no host wiring, and a provider-less render simply sees `null` and
 *   falls back to warehouseQty.
 */
import { useSyncExternalStore } from "react";
import { useT } from "@/i18n/I18nProvider";
import { fmtInt } from "@/lib/format";
import type { CatalogItem, MenuAvailabilityMap } from "@/lib/types";

// ── Published availability snapshot ─────────────────────────────────────────
let availability: MenuAvailabilityMap | null = null;
const listeners = new Set<() => void>();

/** Provider → grid. `null` means "no availability data" (endpoint unavailable,
 *  offline, or not fetched yet) and every card degrades to warehouseQty. */
export function publishAvailability(map: MenuAvailabilityMap | null): void {
  if (map === availability) return;
  availability = map;
  for (const l of listeners) l();
}

export function getAvailabilitySnapshot(): MenuAvailabilityMap | null {
  return availability;
}

export function subscribeAvailability(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function useAvailability(): MenuAvailabilityMap | null {
  return useSyncExternalStore(subscribeAvailability, getAvailabilitySnapshot, getAvailabilitySnapshot);
}

// ── Level resolution ────────────────────────────────────────────────────────
export type StockLevel = "ok" | "low" | "out";

export interface StockState {
  level: StockLevel;
  /** Units still available (makeable, or the raw warehouse qty). null = unknown. */
  count: number | null;
  /** Where the verdict came from — drives the tooltip wording. */
  source: "availability" | "warehouseQty" | "none";
}

const OK: StockState = { level: "ok", count: null, source: "none" };

/** At or below this many base units, a plain warehouseQty item reads as low.
 *  Only the FALLBACK path uses it; the server's own isLowStock (menu
 *  min_stock_alert) wins whenever the availability map covers the item. */
export const LOW_WAREHOUSE_QTY = 3;

/**
 * PURE. The whole degradation policy in one place so the card, the store's
 * warning toast and the specs cannot disagree.
 *
 * Deliberately reads the server's BOOLEANS rather than deriving 86 from
 * `makeable`: a menu row with no recipe reports makeable 0 with both flags
 * false, and treating that as out-of-stock would grey out most of the menu.
 */
export function resolveStockState(
  item: Pick<CatalogItem, "id" | "warehouseQty">,
  map: MenuAvailabilityMap | null,
): StockState {
  const entry = map ? map[item.id] : undefined;
  if (entry) {
    if (entry.isOutOfStock) return { level: "out", count: 0, source: "availability" };
    if (entry.isLowStock) {
      return { level: "low", count: Number.isFinite(entry.makeable) ? entry.makeable : null, source: "availability" };
    }
    return OK;
  }
  // Silent degrade: the endpoint 404'd / 403'd / is offline, or this item is not
  // a menu row the bulk call covered.
  const qty = item.warehouseQty;
  if (qty == null || !Number.isFinite(Number(qty))) return OK; // no figure → never warn
  const n = Number(qty);
  if (n <= 0) return { level: "out", count: 0, source: "warehouseQty" };
  if (n <= LOW_WAREHOUSE_QTY) return { level: "low", count: n, source: "warehouseQty" };
  return OK;
}

/** Extra classes the CARD BUTTON wears when the item is unavailable. Pure
 *  paint — no box-model property, so the measured row height is untouched. */
export const OUT_OF_STOCK_CARD_CLASS = "opacity-60 grayscale";

// ── The pip ─────────────────────────────────────────────────────────────────
export interface StockPipProps {
  level: StockLevel;
  count: number | null;
  /** Display name, for the tooltip only. */
  name: string;
}

/**
 * Renders nothing when the item is fine. Bottom-START corner: the inline −
 * button sits bottom-END and the combo / «مُخصَّص» chips sit at the top, so the
 * four overlays never collide.
 */
export function StockPip({ level, count, name }: StockPipProps) {
  const t = useT();
  if (level === "ok") return null;
  if (level === "out") {
    return (
      <span
        data-testid="stock-pip"
        data-stock="out"
        title={t("productGrid.stock.outTitle", { name })}
        className="pointer-events-none absolute bottom-1.5 start-1.5 z-[1] rounded-md bg-slate-700 px-1.5 py-0.5 text-[10px] font-extrabold text-white shadow-sm"
      >
        {t("productGrid.stock.out")}
      </span>
    );
  }
  return (
    <span
      data-testid="stock-pip"
      data-stock="low"
      title={t("productGrid.stock.lowTitle", { count: count ?? 0 })}
      className="num pointer-events-none absolute bottom-1.5 start-1.5 z-[1] rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-extrabold text-amber-800 shadow-sm"
    >
      {count == null ? t("productGrid.stock.low") : fmtInt(count)}
    </span>
  );
}
