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
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
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
  render(<ProductGrid catalog={CATALOG} loading={false} category={null} query="" onAdd={onAdd} />);
  return onAdd;
}

const cardFor = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });

describe("the pip on the card", () => {
  it("renders NOTHING while everything is fine", () => {
    publishAvailability({ M1: avail(), M2: avail() });
    renderGrid();
    expect(screen.queryByTestId("stock-pip")).not.toBeInTheDocument();
  });

  it("an amber count for a low item, on that card only", () => {
    publishAvailability({ M1: avail({ isLowStock: true, makeable: 3 }) });
    renderGrid();
    const pips = screen.getAllByTestId("stock-pip");
    expect(pips).toHaveLength(1);
    expect(pips[0]).toHaveAttribute("data-stock", "low");
    expect(pips[0]).toHaveTextContent("3");
    expect(pips[0]!.className).toContain("amber");
  });

  it("a «نفد» pill + a muted card when the item is unavailable", () => {
    publishAvailability({ M1: avail({ isOutOfStock: true, makeable: 0 }) });
    renderGrid();
    const pip = screen.getByTestId("stock-pip");
    expect(pip).toHaveAttribute("data-stock", "out");
    expect(pip).toHaveTextContent("نفد");
    for (const cls of OUT_OF_STOCK_CARD_CLASS.split(" ")) {
      expect(cardFor("شاي مغربي").className).toContain(cls);
    }
    expect(cardFor("طاجين لحم").className).not.toContain("grayscale");
  });

  it("degrades to warehouseQty with no availability published at all", () => {
    render(
      <ProductGrid
        catalog={{ ...CATALOG, items: [item({ id: "M1", warehouseQty: 0 })] }}
        loading={false}
        category={null}
        query=""
        onAdd={vi.fn()}
      />,
    );
    expect(screen.getByTestId("stock-pip")).toHaveAttribute("data-stock", "out");
  });
});

describe("WARN, NEVER BLOCK — the server is the authority", () => {
  it("an out-of-stock card is NOT disabled and still adds when tapped", () => {
    publishAvailability({ M1: avail({ isOutOfStock: true, makeable: 0 }) });
    const onAdd = renderGrid();
    const card = cardFor("شاي مغربي");
    expect(card).toBeEnabled();
    fireEvent.click(card);
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd.mock.calls[0]![0]).toMatchObject({ id: "M1" });
  });
});

// ── 3. The virtualizer contract ─────────────────────────────────────────────
describe("the pip cannot disturb the windowed grid", () => {
  it("is a SPAN, not a button — the windowing spec counts buttons per row", () => {
    publishAvailability({ M1: avail({ isOutOfStock: true }), M2: avail({ isLowStock: true, makeable: 1 }) });
    renderGrid();
    for (const pip of screen.getAllByTestId("stock-pip")) {
      expect(pip.tagName).toBe("SPAN");
    }
    // Two items, two cards, and STILL exactly two buttons in the grid.
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("is an absolutely-positioned OVERLAY, so it adds no height to the card", () => {
    publishAvailability({ M1: avail({ isOutOfStock: true }) });
    renderGrid();
    const pip = screen.getByTestId("stock-pip");
    expect(pip.className).toContain("absolute");
    // …and it is a SIBLING of the add button, not a child: nesting it would
    // change the card's accessible name and the parity specs anchor on that.
    expect(within(cardFor("شاي مغربي")).queryByTestId("stock-pip")).toBeNull();
    expect(cardFor("شاي مغربي")).toHaveAccessibleName(/^شاي مغربي/);
  });

  it("the muted class is pure paint — no box-model property", () => {
    // opacity/filter cannot move layout. A padding/border/size change here
    // would make the virtualizer re-measure the row and jump the scroll.
    expect(OUT_OF_STOCK_CARD_CLASS).toBe("opacity-60 grayscale");
  });
});
