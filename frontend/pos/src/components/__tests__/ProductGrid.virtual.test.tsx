/**
 * The grid is windowed — a DOM-count contract, not a vibe.
 *
 * ProductGrid used to `.map()` the whole filtered catalog. The live `menu` table
 * holds ~2,000 rows and routes/pos-v2.js serves it with no LIMIT, so a cashier
 * opening the POS mounted ~2,000 cards × 5 nodes ≈ 10,000 DOM nodes before the
 * first tap. ProductCard is memoised and onAdd is a stable useCallback, so this
 * was never re-render churn — it was mount and layout cost, which only windowing
 * removes.
 *
 * The assertion is a CAP: with 2,000 items, the number of rendered cards stays
 * far below the item count and is bounded by the viewport, not the catalog.
 * "Feels faster" is not a test.
 */
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, beforeAll } from "vitest";
import { ProductGrid } from "../ProductGrid";
import type { Catalog, CatalogItem } from "@/lib/types";

const VIEWPORT_H = 600;

function makeCatalog(n: number): Catalog {
  const items: CatalogItem[] = Array.from({ length: n }, (_, i) => ({
    id: `ITM-${i}`,
    name: `صنف ${i}`,
    price: 10 + (i % 5),
    category: i % 2 === 0 ? "مشروبات" : "أطباق",
    active: true,
    taxCategory: "S",
  })) as CatalogItem[];
  return { items, categories: ["مشروبات", "أطباق"] } as Catalog;
}

/** Mirrors App.tsx exactly, including WHY the scroll element is state rather than
 *  a ref: React attaches the child's refs and runs its effects before the
 *  parent's ref callback, so a ref would still be null when the virtualizer first
 *  reads it — and nothing would re-trigger the read. This test found that; with a
 *  ref, every assertion below fails with an empty grid.
 *
 *  jsdom does no layout, so the viewport must be stubbed. It has to be
 *  offsetWidth/offsetHeight specifically: virtual-core's getRect() reads those,
 *  not getBoundingClientRect, and jsdom reports 0 for them — which the virtualizer
 *  reads as a zero-height viewport and renders nothing. */
function Host({ catalog }: { catalog: Catalog }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  return (
    <div
      ref={(node) => {
        if (node) {
          Object.defineProperty(node, "offsetHeight", { value: VIEWPORT_H, configurable: true });
          Object.defineProperty(node, "offsetWidth", { value: 800, configurable: true });
        }
        setEl(node);
      }}
      style={{ height: VIEWPORT_H, overflowY: "auto" }}
    >
      <ProductGrid catalog={catalog} loading={false} category={null} query="" onAdd={() => {}} scrollElement={el} />
    </div>
  );
}

describe("ProductGrid windowing", () => {
  beforeAll(() => {
    // 800px → the sm: breakpoint → 3 columns, matching the Tailwind classes.
    Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });
  });

  it("renders a bounded number of cards for a 2,000-item catalog", () => {
    render(<Host catalog={makeCatalog(2000)} />);
    const cards = screen.getAllByRole("button");
    // 600px viewport ÷ ~98px rows ≈ 7 rows, + overscan 4 either side, × 3 cols.
    // The cap is deliberately loose — it pins the ORDER of magnitude, so it fails
    // loudly if windowing is removed rather than breaking on a padding tweak.
    expect(cards.length).toBeLessThan(120);
    expect(cards.length).toBeGreaterThan(0);
  });

  it("renders the FIRST items, so the grid is not merely empty", () => {
    render(<Host catalog={makeCatalog(2000)} />);
    expect(screen.getByText("صنف 0")).toBeInTheDocument();
    // Far past the window: present in the data, absent from the DOM. This is the
    // check that would fail if the component quietly rendered everything.
    expect(screen.queryByText("صنف 1999")).not.toBeInTheDocument();
  });

  it("windows by ROW — a 3-column grid keeps whole rows, never partial ones", () => {
    render(<Host catalog={makeCatalog(2000)} />);
    const rows = screen.getAllByTestId("product-row");
    expect(rows.length).toBeGreaterThan(0);
    // Every rendered row except possibly the catalog's last is full.
    rows.forEach((r) => expect(r.querySelectorAll("button").length).toBe(3));
  });

  it("a small catalog still renders every item — windowing must not hide stock", () => {
    render(<Host catalog={makeCatalog(6)} />);
    expect(screen.getAllByRole("button").length).toBe(6);
    expect(screen.getByText("صنف 5")).toBeInTheDocument();
  });

  it("without a scroll element it renders everything rather than nothing", () => {
    // The fallback matters: a blank grid is worse than an unwindowed one.
    render(<ProductGrid catalog={makeCatalog(30)} loading={false} category={null} query="" onAdd={() => {}} />);
    expect(screen.getAllByRole("button").length).toBe(30);
  });
});
