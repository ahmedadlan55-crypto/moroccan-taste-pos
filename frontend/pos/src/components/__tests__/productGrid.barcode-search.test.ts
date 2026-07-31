/**
 * Product ask — the search box must match BARCODES, and a typed/wedged quantity
 * prefix must be parseable.
 *
 * `filterItems` matched only id / name / nameEn, so typing (or half-reading) a
 * barcode found nothing at all — the grid looked empty for a product sitting
 * right there, even though `resolveScan` could resolve that exact same string.
 *
 * `resolveScan`'s exact-match precedence (per-unit barcode → primary barcode →
 * id → substring fallback) is DELIBERATELY unchanged, and is re-pinned below:
 * broadening the substring fallback must not let a partial match outrank an
 * exact carton barcode, or scanning a carton would start adding single pieces.
 */
import { describe, expect, it } from "vitest";
import type { CatalogItem } from "@/lib/types";
import { filterItems, parseQtyPrefix, resolveScan } from "../ProductGrid";

const WATER: CatalogItem = {
  id: "M1",
  name: "ماء",
  nameEn: "Water",
  price: 2,
  category: "مشروبات",
  active: true,
  taxCategory: "S",
  barcode: "6281000000017",
  baseUnitName: "حبة",
  units: [
    { unitId: "u1", unitCode: "PCS", unitName: "حبة", isBase: true, factor: 1, barcode: "6281000000017" },
    { unitId: "u2", unitCode: "CTN", unitName: "كرتون", isBase: false, factor: 24, barcode: "7501" },
  ],
};
const TEA: CatalogItem = {
  id: "M2",
  name: "شاي",
  price: 5,
  category: "مشروبات",
  active: true,
  taxCategory: "S",
  barcode: "9999000000001",
};
const OFF: CatalogItem = {
  id: "M3",
  name: "صنف موقوف",
  price: 1,
  category: "مشروبات",
  active: false,
  taxCategory: "S",
  barcode: "1234567890123",
};
const ITEMS = [WATER, TEA, OFF];

describe("filterItems matches barcodes", () => {
  it("THE DEFECT: a full primary barcode used to find nothing", () => {
    expect(filterItems(ITEMS, null, "6281000000017").map((i) => i.id)).toEqual(["M1"]);
  });

  it("a PER-UNIT (carton) barcode finds its item", () => {
    expect(filterItems(ITEMS, null, "7501").map((i) => i.id)).toEqual(["M1"]);
  });

  it("a partially typed / partially read barcode still narrows", () => {
    expect(filterItems(ITEMS, null, "9999000").map((i) => i.id)).toEqual(["M2"]);
  });

  it("an INACTIVE item is still never sellable, barcode or not", () => {
    expect(filterItems(ITEMS, null, "1234567890123")).toEqual([]);
  });

  it("the category filter still applies to a barcode hit", () => {
    expect(filterItems(ITEMS, "أطباق", "7501")).toEqual([]);
    expect(filterItems(ITEMS, "مشروبات", "7501").map((i) => i.id)).toEqual(["M1"]);
  });

  it("name / nameEn / id matching is untouched", () => {
    expect(filterItems(ITEMS, null, "شاي").map((i) => i.id)).toEqual(["M2"]);
    expect(filterItems(ITEMS, null, "water").map((i) => i.id)).toEqual(["M1"]);
    expect(filterItems(ITEMS, null, "M2").map((i) => i.id)).toEqual(["M2"]);
    expect(filterItems(ITEMS, null, "").map((i) => i.id)).toEqual(["M1", "M2"]);
  });

  it("an item with no barcodes at all does not explode", () => {
    const bare: CatalogItem = { id: "M9", name: "بدون", price: 1, category: "c", active: true, taxCategory: "S" };
    expect(filterItems([bare], null, "7501")).toEqual([]);
    expect(filterItems([bare], null, "بدون").map((i) => i.id)).toEqual(["M9"]);
  });
});

describe("resolveScan precedence is UNCHANGED by the broader filter", () => {
  it("an exact per-unit barcode still wins and still adds that unit", () => {
    expect(resolveScan(ITEMS, "7501")).toEqual({ item: WATER, unitCode: "CTN" });
  });

  it("a code that is BOTH the primary and the base unit's barcode resolves to that unit", () => {
    // Step 1 (exact per-unit) legitimately fires before step 2 here, because
    // WATER's base unit declares the same code. Pinned so the broader filter
    // can never reorder these two.
    expect(resolveScan(ITEMS, "6281000000017")).toEqual({ item: WATER, unitCode: "PCS" });
  });

  it("a primary barcode with no per-unit twin resolves to the BASE unit (null)", () => {
    expect(resolveScan(ITEMS, "9999000000001")).toEqual({ item: TEA, unitCode: null });
  });

  it("an exact id resolves to the base unit", () => {
    expect(resolveScan(ITEMS, "M2")).toEqual({ item: TEA, unitCode: null });
  });

  it("a substring falls through to the filter, base unit — including a partial barcode", () => {
    expect(resolveScan(ITEMS, "9999000")).toEqual({ item: TEA, unitCode: null });
  });

  it("no match is still null, and an inactive item is never a hit", () => {
    expect(resolveScan(ITEMS, "nothing-here")).toBeNull();
    expect(resolveScan(ITEMS, "1234567890123")).toBeNull();
    expect(resolveScan(ITEMS, "")).toBeNull();
  });
});

describe("parseQtyPrefix", () => {
  it("accepts every separator the scanners/keyboards emit", () => {
    expect(parseQtyPrefix("12*7501")).toEqual({ qty: 12, rest: "7501" });
    expect(parseQtyPrefix("12x7501")).toEqual({ qty: 12, rest: "7501" });
    expect(parseQtyPrefix("12X7501")).toEqual({ qty: 12, rest: "7501" });
    expect(parseQtyPrefix("12×7501")).toEqual({ qty: 12, rest: "7501" });
  });

  it("tolerates surrounding and internal whitespace", () => {
    expect(parseQtyPrefix("  12 * 7501  ")).toEqual({ qty: 12, rest: "7501" });
  });

  it("REFUSES a decimal quantity — the register sells whole units only", () => {
    // Was "carries a decimal quantity through (weighed goods)". A fractional
    // qty was the last route into a cart line past the QtyPad, and it could not
    // be displayed honestly on the card badge. No prefix → the caller scans the
    // raw query, which finds nothing, which is the correct outcome.
    expect(parseQtyPrefix("1.5*7501")).toBeNull();
    expect(parseQtyPrefix("0.5x7501")).toBeNull();
  });

  it("the rest can be a name, not just a code", () => {
    expect(parseQtyPrefix("3*شاي")).toEqual({ qty: 3, rest: "شاي" });
  });

  it("returns null when there is no well-formed prefix — the caller then scans the raw query", () => {
    expect(parseQtyPrefix("7501")).toBeNull(); // a bare barcode is NOT a prefix
    expect(parseQtyPrefix("12*")).toBeNull(); // nothing to resolve
    expect(parseQtyPrefix("0*7501")).toBeNull(); // adding zero is never meant
    expect(parseQtyPrefix("*7501")).toBeNull();
    expect(parseQtyPrefix("abc*7501")).toBeNull();
    expect(parseQtyPrefix("")).toBeNull();
  });

  it("does not misread a barcode that merely contains a separator-ish char", () => {
    // Leading digits are required, so a code starting with a letter is left alone.
    expect(parseQtyPrefix("x7501")).toBeNull();
  });

  it("is pure — it never mutates its input", () => {
    const q = "12*7501";
    parseQtyPrefix(q);
    expect(q).toBe("12*7501");
  });
});
