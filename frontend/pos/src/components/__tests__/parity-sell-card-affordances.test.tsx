/**
 * Parity — بطاقات الأصناف (close/w25-sell-ui): the live qty badge, selection
 * ring, inline − button and the «مُخصَّص» price-source chip on product cards,
 * pinned against legacy public/pos/app.js:
 *   product-card-qty-badge   qty-display + .selected card (app.js:398-403, 449)
 *   product-card-inline-dec  decFromCart − button on in-cart cards (app.js:448)
 *   product-card-custom-badge «مُخصَّص» chip (app.js:410-412)
 * ProductGrid is pure props — rendered directly (unwindowed path).
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import type { Catalog } from "@/lib/types";
import { ProductGrid } from "../ProductGrid";
import { makeCatalog } from "./parityTestkit";

function renderGrid(opts: {
  catalog?: Catalog;
  cartQty?: Record<string, number>;
  onAdd?: (i: unknown) => void;
  onDecrement?: (i: unknown) => void;
} = {}) {
  const onAdd = opts.onAdd ?? vi.fn();
  const onDecrement = opts.onDecrement ?? vi.fn();
  render(
    <ProductGrid
      catalog={opts.catalog ?? makeCatalog()}
      loading={false}
      category={null}
      query=""
      onAdd={onAdd as never}
      cartQty={opts.cartQty}
      onDecrement={onDecrement as never}
    />,
  );
  return { onAdd, onDecrement };
}

beforeEach(() => cleanup());

describe("product-card-qty-badge — live quantity + selection ring", () => {
  it("an item NOT in the cart shows no badge and no − button", () => {
    renderGrid({ cartQty: {} });
    expect(screen.queryByTestId("card-qty-badge")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /إنقاص/ })).not.toBeInTheDocument();
  });

  it("an in-cart item shows its live qty badge; other cards stay clean", () => {
    renderGrid({ cartQty: { M1: 3 } });
    const badges = screen.getAllByTestId("card-qty-badge");
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent("3");
    // the badge belongs to the شاي مغربي card (^-anchored: «إنقاص شاي مغربي» is the − button)
    const card = screen.getByRole("button", { name: /^شاي مغربي/ }).closest("div")!;
    expect(within(card as HTMLElement).getByTestId("card-qty-badge")).toBe(badges[0]);
  });

  it("the in-cart card carries the selection ring class; others do not", () => {
    renderGrid({ cartQty: { M1: 1 } });
    expect(screen.getByRole("button", { name: /^شاي مغربي/ }).className).toContain("ring-2");
    expect(screen.getByRole("button", { name: /^طاجين لحم/ }).className).not.toContain("ring-2");
  });
});

describe("product-card-inline-dec — the − button decrements THAT item", () => {
  it("− calls onDecrement with the card's item and never fires onAdd", () => {
    const { onAdd, onDecrement } = renderGrid({ cartQty: { M1: 2 } });
    fireEvent.click(screen.getByRole("button", { name: "إنقاص شاي مغربي" }));
    expect(onDecrement).toHaveBeenCalledTimes(1);
    expect((onDecrement as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ id: "M1" });
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("tapping the card body still adds (the − is a sibling, not a nested button)", () => {
    const { onAdd } = renderGrid({ cartQty: { M1: 2 } });
    fireEvent.click(screen.getByRole("button", { name: /^شاي مغربي/ }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });
});

describe("product-card-custom-badge — «مُخصَّص» when a price list drives the price", () => {
  it("a priceSource item shows the chip; plain items do not", () => {
    const catalog = makeCatalog();
    catalog.items[0] = { ...catalog.items[0]!, priceSource: "قائمة التطبيقات" };
    renderGrid({ catalog });
    expect(screen.getAllByText("مُخصَّص")).toHaveLength(1);
  });

  it("no priceSource anywhere → no chip", () => {
    renderGrid();
    expect(screen.queryByText("مُخصَّص")).not.toBeInTheDocument();
  });
});
