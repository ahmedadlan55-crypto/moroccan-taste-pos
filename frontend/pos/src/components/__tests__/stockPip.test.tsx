/**
 * لوحة النفاد / the 86 board — the availability pip on the product card.
 *
 * Three contracts are pinned here, in order of how expensive they are to get
 * wrong:
 *   1. DEGRADATION. No availability data → fall back to warehouseQty; no
 *      warehouseQty either → say NOTHING. A grid that greys out the menu
 *      because an endpoint 404'd is worse than no 86 board at all.
 *   2. WARN, NEVER BLOCK. An out-of-stock card is muted, not disabled, and
 *      still calls onAdd.
 *   3. THE VIRTUALIZER CONTRACT. The pip is an absolutely-positioned <span>
 *      sibling, so it adds no button to a row and cannot change a card's
 *      measured height.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { Catalog, CatalogItem, MenuAvailabilityMap } from "@/lib/types";
import { ProductGrid } from "../ProductGrid";
import {
  LOW_WAREHOUSE_QTY,
  OUT_OF_STOCK_CARD_CLASS,
  publishAvailability,
  resolveStockState,
} from "../StockPip";

const item = (over: Partial<CatalogItem> = {}): CatalogItem => ({
  id: "M1",
  name: "شاي مغربي",
  price: 23,
  category: "مشروبات",
  active: true,
  taxCategory: "S",
  ...over,
});

const avail = (over: Partial<MenuAvailabilityMap[string]> = {}) => ({
  mode: "mto",
  makeable: 5,
  isOutOfStock: false,
  isLowStock: false,
  blockerCount: 0,
  hasRecipe: true,
  ...over,
});

beforeEach(() => {
  cleanup();
  publishAvailability(null);
});
afterEach(() => publishAvailability(null));

// ── 1. resolveStockState — the whole degradation policy, pure ───────────────
describe("resolveStockState — the recipe answer wins, warehouseQty is the fallback", () => {
  it("prefers the SERVER's recipe verdict over the item's own stock figure", () => {
    // The dish has plenty of "stock" but an ingredient ran out. In a kitchen
    // the ingredient is the truth — that is the entire reason this endpoint
    // exists instead of reading warehouseQty.
    const map = { M1: avail({ isOutOfStock: true, makeable: 0, blockerCount: 1 }) };
    expect(resolveStockState(item({ warehouseQty: 99 }), map)).toMatchObject({
      level: "out",
      source: "availability",
    });
  });

  it("reports low with the makeable count", () => {
    const map = { M1: avail({ isLowStock: true, makeable: 2 }) };
    expect(resolveStockState(item(), map)).toEqual({ level: "low", count: 2, source: "availability" });
  });

  it("says nothing when the server says the item is fine", () => {
    expect(resolveStockState(item({ warehouseQty: 1 }), { M1: avail() }).level).toBe("ok");
  });

  it("NEVER derives 86 from makeable:0 — a recipe-less row reports 0 by construction", () => {
    // routes/menu.js returns mode 'mto_no_recipe' with makeable 0 and BOTH
    // flags absent. Deriving out-of-stock from `makeable` here would grey out
    // most of a menu that has no BOMs configured.
    const map = { M1: avail({ mode: "mto_no_recipe", makeable: 0, hasRecipe: false }) };
    expect(resolveStockState(item(), map).level).toBe("ok");
  });
});

describe("resolveStockState — silent degrade when the endpoint gave nothing", () => {
  it("a null map falls back to warehouseQty", () => {
    expect(resolveStockState(item({ warehouseQty: 0 }), null)).toMatchObject({ level: "out", source: "warehouseQty" });
    expect(resolveStockState(item({ warehouseQty: LOW_WAREHOUSE_QTY }), null)).toMatchObject({
      level: "low",
      source: "warehouseQty",
    });
    expect(resolveStockState(item({ warehouseQty: 50 }), null).level).toBe("ok");
  });

  it("an item the map does not cover ALSO falls back (the route is LIMIT 500)", () => {
    expect(resolveStockState(item({ id: "M9", warehouseQty: 0 }), { M1: avail() })).toMatchObject({
      level: "out",
      source: "warehouseQty",
    });
  });

  it("no availability AND no warehouseQty → no opinion at all, never a warning", () => {
    // A recipe item legitimately has no stock figure. Inventing "out of stock"
    // for it would 86 the menu on a hunch.
    expect(resolveStockState(item({ warehouseQty: null }), null)).toEqual({ level: "ok", count: null, source: "none" });
    expect(resolveStockState(item({}), null).level).toBe("ok");
    expect(resolveStockState(item({ warehouseQty: undefined }), {}).level).toBe("ok");
  });
});

// ── 2. Rendering + warn-never-block ─────────────────────────────────────────
const CATALOG: Catalog = {
  items: [
    item({ id: "M1", name: "شاي مغربي" }),
    item({ id: "M2", name: "طاجين لحم", category: "أطباق" }),
  ],
  categories: ["مشروبات", "أطباق"],
  vatRate: 15,
  maxCashierDiscountPct: 10,
  serverTime: new Date(0).toISOString(),
};

function renderGrid(onAdd = vi.fn()) {
  return render(<ProductGrid catalog={CATALOG} loading={false} category={null} query="" onAdd={onAdd} />);
}



/**
 * THE GRID NO LONGER PAINTS THIS VERDICT.
 *
 * The blocks that used to live here rendered the pip THROUGH ProductGrid and
 * asserted the «نفد» pill, the muted card, and the overlay geometry. They were
 * correct about the component and wrong about the shop: the verdict is computed
 * from RAW STOCK, and on this menu every sellable row is built from a recipe, so
 * it marked nearly the whole grid unavailable while every one of those items was
 * sellable. The owner, running the register, asked for it to stop.
 *
 * resolveStockState and StockPip stay tested above and remain in the tree for a
 * menu that actually sells shelf goods. What is pinned now is the absence.
 */
describe("the product grid paints no raw-stock verdict", () => {
  it("renders no pip even when the board says an item is out", () => {
    publishAvailability({ M1: { mode: "mto", makeable: 0, isOutOfStock: true, isLowStock: false, blockerCount: 1, hasRecipe: true }, M2: avail() });
    renderGrid();
    expect(screen.queryByTestId("stock-pip")).not.toBeInTheDocument();
  });

  it("renders no pip when the board says an item is low", () => {
    publishAvailability({ M1: { mode: "mto", makeable: 2, isOutOfStock: false, isLowStock: true, blockerCount: 0, hasRecipe: true }, M2: avail() });
    renderGrid();
    expect(screen.queryByTestId("stock-pip")).not.toBeInTheDocument();
  });

  it("leaves the card fully legible — no dimming, no greyscale", () => {
    publishAvailability({ M1: { mode: "mto", makeable: 0, isOutOfStock: true, isLowStock: false, blockerCount: 1, hasRecipe: true } });
    const { container } = renderGrid();
    expect(container.querySelector(OUT_OF_STOCK_CARD_CLASS.split(" ").map((c) => "." + c).join(", "))).toBeNull();
  });

  it("still adds the item when tapped — the sell path is untouched", () => {
    publishAvailability({ M1: { mode: "mto", makeable: 0, isOutOfStock: true, isLowStock: false, blockerCount: 1, hasRecipe: true } });
    const onAdd = vi.fn();
    renderGrid(onAdd);
    fireEvent.click(screen.getByRole("button", { name: /شاي مغربي/ }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });
});
