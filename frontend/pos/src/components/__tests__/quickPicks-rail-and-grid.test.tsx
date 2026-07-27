/**
 * «الأكثر مبيعًا» — the pinned rail chip and the grid filter behind it.
 *
 * On a 2,000-item catalog the cashier had to walk a category or type in the
 * search box for the same six drinks all day. This pins the chip's presence
 * rules, that it rides the EXISTING category channel (so the host needs no new
 * prop), and that the grid honours the tally's RANK rather than catalog order.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { Catalog, CatalogItem } from "@/lib/types";
import { CategoryRail } from "../CategoryRail";
import { ProductGrid, filterItems } from "../ProductGrid";
import { clearQuickPicks, QUICK_PICKS_CATEGORY, recordPick } from "@/lib/quickPicks";

const item = (id: string, name: string, category = "مشروبات", active = true): CatalogItem => ({
  id,
  name,
  price: 10,
  category,
  active,
  taxCategory: "S",
});

const CATALOG: Catalog = {
  items: [
    item("M1", "شاي مغربي"),
    item("M2", "قهوة عربية"),
    item("M3", "طاجين لحم", "أطباق"),
    item("M4", "صنف موقوف", "أطباق", false),
  ],
  categories: ["مشروبات", "أطباق"],
  vatRate: 15,
  maxCashierDiscountPct: 10,
  serverTime: new Date(0).toISOString(),
};

const COUNTS = { مشروبات: 2, أطباق: 1 };

function renderRail(active: string | null = null, onSelect = vi.fn(), horizontal = false) {
  render(
    <CategoryRail
      categories={CATALOG.categories}
      counts={COUNTS}
      active={active}
      onSelect={onSelect}
      horizontal={horizontal}
    />,
  );
  return onSelect;
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  clearQuickPicks();
});

describe("filterItems — the sentinel category", () => {
  it("keeps the TALLY's rank, not catalog order (that is the point of the chip)", () => {
    // M2 outsells M1; the catalog lists M1 first.
    expect(filterItems(CATALOG.items, QUICK_PICKS_CATEGORY, "", ["M2", "M1"]).map((i) => i.id)).toEqual(["M2", "M1"]);
  });

  it("drops an id the catalog no longer serves and never surfaces an inactive one", () => {
    expect(filterItems(CATALOG.items, QUICK_PICKS_CATEGORY, "", ["GONE", "M4", "M1"]).map((i) => i.id)).toEqual(["M1"]);
  });

  it("still composes with the search box", () => {
    expect(filterItems(CATALOG.items, QUICK_PICKS_CATEGORY, "قهوة", ["M1", "M2"]).map((i) => i.id)).toEqual(["M2"]);
  });

  it("reads the live tally when no ranking is injected", () => {
    recordPick("M3");
    recordPick("M3");
    recordPick("M1");
    expect(filterItems(CATALOG.items, QUICK_PICKS_CATEGORY, "").map((i) => i.id)).toEqual(["M3", "M1"]);
  });

  it("leaves every EXISTING category/search behaviour untouched", () => {
    expect(filterItems(CATALOG.items, null, "شاي").map((i) => i.id)).toEqual(["M1"]);
    expect(filterItems(CATALOG.items, "مشروبات", "").map((i) => i.id)).toEqual(["M1", "M2"]);
    expect(filterItems(CATALOG.items, null, "موقوف")).toEqual([]);
  });
});

describe("the pinned chip", () => {
  it("is absent on a till with no history — nothing to pin yet", () => {
    renderRail();
    expect(screen.queryByRole("button", { name: /الأكثر مبيعًا/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /الكل/ })).toBeInTheDocument();
  });

  it("appears FIRST once the till has sold something, carrying its count", () => {
    recordPick("M1");
    recordPick("M2");
    renderRail();
    const chips = screen.getAllByRole("button");
    expect(chips[0]).toHaveAccessibleName(/الأكثر مبيعًا/);
    expect(chips[0]).toHaveTextContent("2");
    expect(chips[1]).toHaveAccessibleName(/الكل/);
  });

  it("selects the sentinel through the SAME onSelect the categories use", () => {
    recordPick("M1");
    const onSelect = renderRail();
    fireEvent.click(screen.getByRole("button", { name: /الأكثر مبيعًا/ }));
    expect(onSelect).toHaveBeenCalledWith(QUICK_PICKS_CATEGORY);
  });

  it("is marked aria-pressed while it is the active filter", () => {
    recordPick("M1");
    renderRail(QUICK_PICKS_CATEGORY);
    expect(screen.getByRole("button", { name: /الأكثر مبيعًا/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /الكل/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("stays visible while ACTIVE even with an empty tally — never a dead end", () => {
    // A prune can empty the tally while the cashier is standing in it. Hiding
    // the chip then would leave a filtered grid with no chip to leave it by.
    renderRail(QUICK_PICKS_CATEGORY);
    expect(screen.getByRole("button", { name: /الأكثر مبيعًا/ })).toBeInTheDocument();
  });

  it("renders identically in the horizontal mobile strip (ONE component, both hosts)", () => {
    recordPick("M1");
    renderRail(null, vi.fn(), true);
    expect(screen.getAllByRole("button")[0]).toHaveAccessibleName(/الأكثر مبيعًا/);
  });
});

describe("the grid under the chip", () => {
  it("shows the top sellers in rank order, offline, with no server call", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    recordPick("M3");
    recordPick("M3");
    recordPick("M1");
    render(
      <ProductGrid catalog={CATALOG} loading={false} category={QUICK_PICKS_CATEGORY} query="" onAdd={vi.fn()} />,
    );
    const names = screen.getAllByRole("button").map((b) => b.textContent);
    expect(names[0]).toContain("طاجين لحم");
    expect(names[1]).toContain("شاي مغربي");
    expect(names).toHaveLength(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("explains itself instead of showing a bare «لا نتائج» when the tally is empty", () => {
    render(
      <ProductGrid catalog={CATALOG} loading={false} category={QUICK_PICKS_CATEGORY} query="" onAdd={vi.fn()} />,
    );
    expect(screen.getByText("لا نتائج")).toBeInTheDocument();
    expect(screen.getByText(/لا مبيعات متكررة بعد/)).toBeInTheDocument();
  });
});
