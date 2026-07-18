/**
 * product-card-combo-badge — the amber «عرض» badge renders ONLY on isCombo
 * cards (legacy parity: public/pos/app.js comboBadge). The badge is decoration;
 * the card's tap still routes through onAdd (the store owns the intercept).
 */
import { render, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProductGrid } from "../ProductGrid";
import type { Catalog, CatalogItem } from "@/lib/types";

const makeItem = (over: Partial<CatalogItem>): CatalogItem =>
  ({ id: "ITM-X", name: "صنف", price: 10, category: "أطباق", active: true, taxCategory: "S", ...over }) as CatalogItem;

// No scrollElement prop → unwindowed render (jsdom does no layout); windowing
// itself is pinned by ProductGrid.virtual.test.tsx and is untouched here.
function renderGrid(items: CatalogItem[], onAdd: (i: CatalogItem) => void = () => {}) {
  const catalog = { items, categories: [...new Set(items.map((i) => i.category))] } as Catalog;
  return render(<ProductGrid catalog={catalog} loading={false} category={null} query="" onAdd={onAdd} />);
}

describe("product-card-combo-badge", () => {
  it("renders «عرض» only on isCombo cards — absent flag and false both stay clean", () => {
    const { getAllByTestId, getByText } = renderGrid([
      makeItem({ id: "M-COMBO", name: "وجبة شاورما", isCombo: true }),
      makeItem({ id: "M-PLAIN", name: "شاي", isCombo: false }),
      makeItem({ id: "M-LEGACY", name: "قهوة" }), // field absent (old cached catalog)
    ]);
    const badges = getAllByTestId("combo-badge");
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toBe("عرض");
    // the badge sits inside the COMBO card's wrapper, not any other card's.
    // (close/w25-sell-ui restructured the card: overlays are SIBLINGS of the
    // add button inside a relative wrapper div — a button cannot nest a button.)
    expect(badges[0].closest("div")?.textContent).toContain("وجبة شاورما");
    expect(getByText("شاي").closest("div")?.querySelector('[data-testid="combo-badge"]')).toBeNull();
  });

  it("a combo card still fires onAdd with the item (chooser interception lives in the store)", () => {
    const onAdd = vi.fn();
    const { getByText } = renderGrid([makeItem({ id: "M-COMBO", name: "وجبة شاورما", isCombo: true })], onAdd);
    fireEvent.click(getByText("وجبة شاورما").closest("button")!);
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd.mock.calls[0][0]).toMatchObject({ id: "M-COMBO", isCombo: true });
  });
});
