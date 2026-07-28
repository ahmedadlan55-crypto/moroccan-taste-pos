/**
 * Parity — البيع (sell)/الكتالوج (catalog): category rail, product grid,
 * search box and empty states. Pins the matrix rows:
 *   category-tile-grid, category-tile-all, category-tile-enter,
 *   category-item-count, product-grid-render (see also ProductGrid.virtual),
 *   product-card-price, product-card-inline-add, product-search,
 *   grid-empty-state-cashier, empty-state-diagnostics, boot-sequence (skeleton).
 * No PosProvider needed — these components are prop-driven.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { CategoryRail } from "../CategoryRail";
import { ProductGrid, SearchBox, filterItems } from "../ProductGrid";
import type { Catalog, CatalogItem } from "@/lib/types";

const item = (id: string, name: string, category: string, price = 10, active = true): CatalogItem => ({
  id,
  name,
  price,
  category,
  active,
  taxCategory: "S",
});

const CATALOG: Catalog = {
  items: [
    item("M1", "شاي مغربي", "مشروبات", 23),
    item("M2", "قهوة عربية", "مشروبات", 12),
    item("M3", "طاجين لحم", "أطباق", 86),
    item("M4", "صنف موقوف", "أطباق", 9, false),
  ],
  categories: ["مشروبات", "أطباق"],
  vatRate: 15,
  maxCashierDiscountPct: 10,
  serverTime: new Date(0).toISOString(),
};

beforeEach(() => cleanup());

describe("product-search — filterItems mirrors the legacy client-side filter", () => {
  it("matches by name substring", () => {
    expect(filterItems(CATALOG.items, null, "شاي").map((i) => i.id)).toEqual(["M1"]);
  });
  it("matches by exact id and id substring", () => {
    expect(filterItems(CATALOG.items, null, "m3").map((i) => i.id)).toEqual(["M3"]);
  });
  it("inactive items are unsellable → hidden even when they match", () => {
    expect(filterItems(CATALOG.items, null, "موقوف")).toEqual([]);
  });
  it("category-tile-enter: category narrows the grid", () => {
    expect(filterItems(CATALOG.items, "مشروبات", "").map((i) => i.id)).toEqual(["M1", "M2"]);
  });
  it("search composes with the active category", () => {
    expect(filterItems(CATALOG.items, "أطباق", "شاي")).toEqual([]);
    expect(filterItems(CATALOG.items, "مشروبات", "قهوة").map((i) => i.id)).toEqual(["M2"]);
  });
});

describe("category-tile-all + category-item-count — the rail", () => {
  const counts = { مشروبات: 2, أطباق: 1 };

  it("renders «الكل» with the TOTAL active count plus one chip per category", () => {
    render(<CategoryRail categories={CATALOG.categories} counts={counts} active={null} onSelect={() => {}} />);
    const all = screen.getByRole("button", { name: /الكل/ });
    expect(all).toHaveTextContent("3");
    expect(screen.getByRole("button", { name: /مشروبات/ })).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: /أطباق/ })).toHaveTextContent("1");
  });

  it("selecting a category fires onSelect(cat); «الكل» fires onSelect(null)", () => {
    const onSelect = vi.fn();
    render(<CategoryRail categories={CATALOG.categories} counts={counts} active="مشروبات" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /أطباق/ }));
    expect(onSelect).toHaveBeenCalledWith("أطباق");
    fireEvent.click(screen.getByRole("button", { name: /الكل/ }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("the active chip is marked aria-pressed", () => {
    render(<CategoryRail categories={CATALOG.categories} counts={counts} active="مشروبات" onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /مشروبات/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /أطباق/ })).toHaveAttribute("aria-pressed", "false");
  });
});

describe("product-card-price + product-card-inline-add — the card sells", () => {
  it("each card shows the tax-inclusive price and the WHOLE card adds the item", () => {
    const onAdd = vi.fn();
    // No scrollElement prop → unwindowed render (every card mounts).
    render(<ProductGrid catalog={CATALOG} loading={false} category={null} query="" onAdd={onAdd} />);
    const card = screen.getByRole("button", { name: /شاي مغربي/ });
    // 23.00 NET × 15% = 26.45 GROSS. This assertion used to read "23.00" while
    // its own title said "tax-inclusive" — the name was aspirational and the
    // number was the stored, tax-EXCLUSIVE one. So the card advertised 23.00
    // for an item the cart rang up at 26.45, and a green test said that was
    // correct. It is the owner's complaint, encoded as a passing assertion.
    expect(card).toHaveTextContent("26.45");
    fireEvent.click(card);
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd.mock.calls[0][0].id).toBe("M1");
  });

  it("inactive items get no card at all (nothing stale to tap — ghost guard by construction)", () => {
    render(<ProductGrid catalog={CATALOG} loading={false} category={null} query="" onAdd={() => {}} />);
    expect(screen.queryByText("صنف موقوف")).not.toBeInTheDocument();
  });
});

describe("grid-empty-state-cashier / empty-state-diagnostics — never a blank grid", () => {
  it("no search hits → «لا نتائج» with the try-again hint", () => {
    render(<ProductGrid catalog={CATALOG} loading={false} category={null} query="زنجبيل" onAdd={() => {}} />);
    expect(screen.getByText("لا نتائج")).toBeInTheDocument();
    expect(screen.getByText(/جرّب كلمة أخرى/)).toBeInTheDocument();
  });

  it("an empty category → the no-active-items narrative", () => {
    const empty: Catalog = { ...CATALOG, items: [item("MX", "مخفي", "أطباق", 5, false)] };
    render(<ProductGrid catalog={empty} loading={false} category="أطباق" query="" onAdd={() => {}} />);
    expect(screen.getByText("لا توجد أصناف نشطة في هذا التصنيف")).toBeInTheDocument();
  });

  it("boot-sequence: while the catalog loads, skeleton cards render (no dead screen)", () => {
    const { container } = render(<ProductGrid catalog={null} loading category={null} query="" onAdd={() => {}} />);
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });
});

describe("product-search — the SearchBox entry point", () => {
  it("typing forwards the query; Enter fires the scan-submit resolver", () => {
    const onQueryChange = vi.fn();
    const onScanSubmit = vi.fn();
    render(<SearchBox query="" onQueryChange={onQueryChange} onScanSubmit={onScanSubmit} />);
    const input = screen.getByRole("searchbox", { name: /بحث في الأصناف/ });
    fireEvent.change(input, { target: { value: "شاي" } });
    expect(onQueryChange).toHaveBeenCalledWith("شاي");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onScanSubmit).toHaveBeenCalledTimes(1);
  });

  it("the clear (×) button resets the query", () => {
    const onQueryChange = vi.fn();
    render(<SearchBox query="شاي" onQueryChange={onQueryChange} onScanSubmit={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "مسح البحث" }));
    expect(onQueryChange).toHaveBeenCalledWith("");
  });
});
