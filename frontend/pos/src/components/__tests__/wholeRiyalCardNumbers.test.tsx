/**
 * Regression coverage for the five WRONG NUMBERS that used to appear on a
 * product card, plus the whole-riyal / whole-quantity rules that replaced them.
 *
 * Each block names the defect it pins. Every one of these passed silently
 * before — the numbers were wrong on screen, not throwing — so without these
 * assertions the same bugs reappear the moment someone "simplifies" a helper.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n/I18nProvider";
import { ProductGrid } from "@/components/ProductGrid";
import { parseQtyPrefix } from "@/components/ProductGrid";
import { applyIntegerKey } from "@/components/Numpad";
import { parseQtyInput } from "@/components/QtyPad";
import { LOW_WAREHOUSE_QTY, resolveStockState } from "@/components/StockPip";
import { displayUnitPrice, effectiveUnitPrice } from "@/lib/cartMath";
import { fmtPrice, fmtQty } from "@/lib/format";
import type { Catalog, CatalogItem } from "@/lib/types";

const item = (over: Partial<CatalogItem> = {}): CatalogItem => ({
  id: "M1",
  name: "شاي مغربي",
  price: 15.6522,
  category: "مشروبات",
  active: true,
  taxCategory: "S",
  taxInclusive: false,
  ...over,
});

const catalog = (items: CatalogItem[], vatRate = 15): Catalog =>
  ({ items, categories: ["مشروبات"], vatRate, maxCashierDiscountPct: 20, serverTime: "" }) as Catalog;

const renderGrid = (c: Catalog, cartQty?: Record<string, number>) =>
  render(
    <I18nProvider>
      <ProductGrid catalog={c} loading={false} category={null} query="" onAdd={() => {}} cartQty={cartQty} />
    </I18nProvider>,
  );

// ── Defect 1 — the channel price was discarded ──────────────────────────────
describe("effectiveUnitPrice — the channel price is the one that sells", () => {
  it("uses the RESOLVED price, never the raw basePrice the server also ships", () => {
    // A channel price list resolved this item to 20.00; basePrice is the
    // untouched menu figure. The store read `basePrice ?? price`, and since the
    // server ALWAYS ships basePrice that fallback never fired — the card said
    // 20 and the cart line charged 16.
    expect(effectiveUnitPrice(item({ price: 20, basePrice: 16 }))).toBe(20);
  });

  it("is unaffected when no channel is active (both fields agree)", () => {
    expect(effectiveUnitPrice(item({ price: 16, basePrice: 16 }))).toBe(16);
  });

  it("applies to a combo too — a combo IS a menu row and is channel-priced", () => {
    // The combo chooser was fed `basePrice ?? price` from the same catalog
    // item, so the identical defect reached combo lines.
    expect(effectiveUnitPrice(item({ id: "C1", isCombo: true, price: 45, basePrice: 39 }))).toBe(45);
  });

  it("tolerates a server that ships no basePrice at all", () => {
    expect(effectiveUnitPrice(item({ price: 16, basePrice: undefined }))).toBe(16);
  });
});

// ── Defect 2 — the card advertised the NET price ────────────────────────────
describe("displayUnitPrice — the card shows what the customer pays", () => {
  it("adds VAT to a standard-rated (S) item", () => {
    expect(displayUnitPrice({ price: 15.6522, taxCategory: "S", taxInclusive: false }, 15)).toBe(18);
  });

  it("leaves a zero-rated (Z) item alone — this is why only SOME cards were wrong", () => {
    expect(displayUnitPrice({ price: 18, taxCategory: "Z", taxInclusive: false }, 15)).toBe(18);
  });

  it("does not double-tax a price already stored inclusive", () => {
    expect(displayUnitPrice({ price: 18, taxCategory: "S", taxInclusive: true }, 15)).toBe(18);
  });

  it("honours the owner's configured rate rather than a hardcoded 15", () => {
    expect(displayUnitPrice({ price: 100, taxCategory: "S", taxInclusive: false }, 5)).toBe(105);
  });

  it("renders a standard and a zero-rated card at the SAME whole riyal", () => {
    renderGrid(
      catalog([
        item({ id: "S1", name: "صنف خاضع", price: 15.6522, taxCategory: "S" }),
        item({ id: "Z1", name: "صنف صفري", price: 18, taxCategory: "Z" }),
      ]),
    );
    expect(screen.getByRole("button", { name: /صنف خاضع/ })).toHaveTextContent("18");
    expect(screen.getByRole("button", { name: /صنف صفري/ })).toHaveTextContent("18");
  });
});

// ── Whole riyals — but never a display-only lie ─────────────────────────────
describe("fmtPrice — clean when whole, honest when not", () => {
  it("drops the decimals on a whole riyal", () => {
    expect(fmtPrice(18)).toBe("18");
    expect(fmtPrice(1234)).toBe("1,234");
  });

  it("KEEPS the halalas on a price the rounding sweep could not tune", () => {
    // The one rule that must not be "simplified" away: hiding this behind a
    // display round is the screen-says-18 / invoice-says-18.40 bug itself.
    expect(fmtPrice(18.4)).toBe("18.40");
  });

  it("a row still holding an untuned price shows its fraction on the card", () => {
    renderGrid(catalog([item({ price: 9.57 })]));
    expect(screen.getByRole("button", { name: /شاي مغربي/ })).toHaveTextContent("11.01");
  });
});

// ── Defects 3 + 4 — the qty badge ───────────────────────────────────────────
describe("the cart-quantity badge", () => {
  it("fmtQty never rounds a fraction away", () => {
    // fmtInt turned 0.5 into "1" and 0.4 into "0" — a badge reading zero for an
    // item that was demonstrably in the cart.
    expect(fmtQty(0.5)).toBe("0.5");
    expect(fmtQty(0.4)).toBe("0.4");
    expect(fmtQty(2)).toBe("2");
    expect(fmtQty(14)).toBe("14");
  });

  it("shows the summed BASE units, not a mix of entered units", () => {
    // One carton line (qty 1 × factor 12) + a two-piece line = 14 base units.
    // Summing entered qty reported "3" — three of nothing in particular.
    renderGrid(catalog([item()]), { M1: 14 });
    expect(screen.getByTestId("card-qty-badge")).toHaveTextContent("14");
  });
});

// ── Whole quantities ────────────────────────────────────────────────────────
describe("quantities are whole units", () => {
  it("parseQtyInput refuses a fraction instead of rounding it", () => {
    expect(parseQtyInput("2.5")).toBeNull();
    expect(parseQtyInput("2")).toBe(2);
    expect(parseQtyInput("0")).toBe(0); // the documented remove gesture
  });

  it("parseQtyPrefix refuses a fractional scan multiplier", () => {
    expect(parseQtyPrefix("2.5*7501")).toBeNull();
    expect(parseQtyPrefix("12*7501")).toEqual({ qty: 12, rest: "7501" });
  });

  it("applyIntegerKey drops the decimal point entirely", () => {
    expect(applyIntegerKey("2", ".")).toBe("2");
    expect(applyIntegerKey("", ".")).toBe("");
    expect(applyIntegerKey("0", "5")).toBe("5"); // no leading-zero runs
    expect(applyIntegerKey("12", "3")).toBe("123");
  });
});

// ── Defect 5 — the stock pip ────────────────────────────────────────────────
describe("resolveStockState — the owner's own alert threshold", () => {
  it("warns at the item's configured minStockAlert, not a hardcoded 3", () => {
    const s = resolveStockState({ id: "M1", warehouseQty: 8, minStockAlert: 10 }, null);
    expect(s.level).toBe("low");
    expect(s.count).toBe(8);
    expect(s.source).toBe("warehouseQty");
  });

  it("falls back to LOW_WAREHOUSE_QTY when the owner configured nothing", () => {
    expect(resolveStockState({ id: "M1", warehouseQty: 2, minStockAlert: 0 }, null).level).toBe("low");
    expect(resolveStockState({ id: "M1", warehouseQty: LOW_WAREHOUSE_QTY + 1, minStockAlert: 0 }, null).level).toBe("ok");
  });

  it("the availability map still wins over the warehouse fallback", () => {
    const map = { M1: { mode: "mto", makeable: 4, isOutOfStock: false, isLowStock: true, blockerCount: 0, hasRecipe: true } };
    const s = resolveStockState({ id: "M1", warehouseQty: 500, minStockAlert: 10 }, map);
    expect(s.source).toBe("availability");
    expect(s.count).toBe(4);
  });

  it("labels the pip with its SOURCE so the two numbers are distinguishable", () => {
    renderGrid(catalog([item({ warehouseQty: 8, minStockAlert: 10 })]));
    const pip = screen.getByTestId("stock-pip");
    expect(pip).toHaveAttribute("data-stock-source", "warehouseQty");
    expect(pip).toHaveTextContent("8");
  });
});
