/**
 * The product card, as the cashier and the customer both read it.
 *
 * Three complaints from the owner, on the day he was running the register:
 *
 *  1. «لا تميز لي المنتجات المنتهية من المستودع فجميع المنتجات معتمدة علي
 *     وصفات وليست مخزون فعلي» — the 86 board marked nearly the whole grid
 *     «Out» and dimmed it. That verdict is computed from RAW STOCK, and every
 *     sellable row on this menu is built from a recipe, so it was wrong about
 *     almost everything on screen. A warning that is usually wrong teaches the
 *     reader to ignore the one time it is right.
 *
 *  2. «اريد السعر يظهر علي الصنف بشكل شامل الضريبة» — the card printed the
 *     stored price, which is tax-EXCLUSIVE for every menu row: 13.04 on the
 *     card, 15.00 in the cart. Two numbers for one product, on one screen.
 *
 *  3. «اتفقنا علي تصميم فيه الصورة وتحته الاسم، ليه حاطط لي التصميم القديم» —
 *     the image block rendered only for items that HAD an image, so a menu with
 *     no photos uploaded fell back to a text-only card. Same component, two
 *     different-looking designs, depending on data.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ProductGrid } from "../ProductGrid";
import type { Catalog, CatalogItem } from "@/lib/types";

afterEach(cleanup);

const TEA: CatalogItem = {
  id: "M1",
  name: "شاي مغربي",
  price: 13.04, // NET — rings up at 15.00 with 15% VAT
  category: "مشروبات",
  active: true,
  taxCategory: "S",
};

/** An item whose stored price ALREADY contains VAT — must not be grossed twice. */
const INCLUSIVE: CatalogItem = { ...TEA, id: "M2", name: "صنف شامل", price: 15, taxInclusive: true };

/** Zero-rated — VAT must not be invented for it. */
const ZERO: CatalogItem = { ...TEA, id: "M3", name: "صنف معفى", price: 20, taxCategory: "Z" };

function makeCatalog(items: CatalogItem[], vatRate = 15): Catalog {
  return {
    items,
    categories: ["مشروبات"],
    vatRate,
    maxCashierDiscountPct: 10,
    identity: null,
    serverTime: "2026-07-28T10:00:00Z",
  };
}

function renderGrid(catalog: Catalog) {
  return render(
    <ProductGrid catalog={catalog} loading={false} category={null} query="" onAdd={vi.fn()} />,
  );
}

// The expected strings below lost their ".00" when the card moved from fmt2 to
// fmtPrice. Menu prices are now tuned so the VAT-inclusive amount lands on a
// whole riyal (scripts/round-prices-to-whole-riyal.js), and printing "15.00"
// for an item that costs exactly fifteen riyals is halala noise on a till
// screen. A price that is NOT whole still shows its halalas — see the last
// case here, which is the guard against hiding a fraction behind a display
// round (that would recreate the very screen-vs-invoice gap this file exists
// to close).
describe("the price on the card is the price the customer pays", () => {
  it("adds VAT to a tax-exclusive row (13.04 → 15)", () => {
    renderGrid(makeCatalog([TEA]));
    expect(screen.getByText("15")).toBeInTheDocument();
    expect(screen.queryByText("13.04")).not.toBeInTheDocument();
  });

  it("leaves a tax-inclusive row alone — never grossed twice", () => {
    renderGrid(makeCatalog([INCLUSIVE]));
    expect(screen.getByText("15")).toBeInTheDocument();
  });

  it("invents no VAT for a zero-rated item", () => {
    renderGrid(makeCatalog([ZERO]));
    expect(screen.getByText("20")).toBeInTheDocument();
  });

  it("follows the SERVER's rate, not a hardcoded 15", () => {
    renderGrid(makeCatalog([{ ...TEA, price: 100 }], 5));
    expect(screen.getByText("105")).toBeInTheDocument();
  });

  it("an untuned stored price still reaches the card as a whole riyal", () => {
    // 16.00 NET → 18.40 → the till sells it at 18. The card no longer depends
    // on anyone having tuned the stored price first: rounding happens in the
    // register's own math (cartMath.wholeUnitGross), so the shelf is right
    // whatever the database holds — and the invoice charges the same 18.
    renderGrid(makeCatalog([{ ...TEA, price: 16 }]));
    expect(screen.getByText("18")).toBeInTheDocument();
    expect(screen.queryByText("18.40")).not.toBeInTheDocument();
  });
});

describe("every card has the same shape: image on top, name beneath", () => {
  it("reserves the image slot even when the item has no photo", () => {
    renderGrid(makeCatalog([TEA]));
    const thumb = screen.getByTestId("product-thumb");
    expect(thumb).toBeInTheDocument();
    // A quiet placeholder rather than an empty grey box.
    expect(within(thumb).getByText("ش")).toBeInTheDocument();
  });

  it("gives every card in a mixed grid the same slot", () => {
    renderGrid(makeCatalog([TEA, INCLUSIVE, ZERO]));
    expect(screen.getAllByTestId("product-thumb")).toHaveLength(3);
  });
});

describe("no raw-stock verdict is painted on a recipe-built menu", () => {
  it("renders no out-of-stock pip at all", () => {
    renderGrid(makeCatalog([TEA, INCLUSIVE, ZERO]));
    expect(screen.queryByTestId("stock-pip")).not.toBeInTheDocument();
  });

  it("does not dim any card", () => {
    const { container } = renderGrid(makeCatalog([TEA]));
    expect(container.querySelector(".opacity-50, .grayscale")).toBeNull();
  });
});
