import { describe, it, expect } from "vitest";
import { lineTotals, cartTotals } from "../cartMath";
import { upsertPayloadFrom } from "../offline";
import { resolveScan } from "@/components/ProductGrid";
import type { CartLine, CatalogItem, LocalOrder } from "../types";

// base=piece (factor 1), major=carton (factor 12)
const CARTON: CatalogItem = {
  id: "P1", name: "شوكولاتة", price: 5, category: "حلويات", active: true, taxCategory: "S",
  basePrice: 5, warehouseQty: 100, barcode: "BASE-1", baseUnitName: "حبة",
  units: [
    { unitId: "IU-B", unitCode: "PCS", unitName: "حبة", isBase: true, factor: 1, barcode: null },
    { unitId: "IU-C", unitCode: "CTN", unitName: "كرتون", isBase: false, factor: 12, barcode: "CTN-1" },
  ],
};

function line(over: Partial<CartLine>): CartLine {
  return { menuId: "P1", name: "شوكولاتة", qty: 1, unitPrice: 5, lineDiscount: 0, vatCategory: "S", notes: null, ...over };
}

describe("cartMath — money uses baseQty (price = factor × base)", () => {
  it("a carton line (1 × factor 12) totals 12 × base price", () => {
    const t = lineTotals(line({ qty: 1, conversionFactorSnapshot: 12, baseQty: 12, unitPrice: 5 }));
    expect(t.gross).toBe(60); // 12 × 5
    // 15% inclusive VAT on 60 → 60 − 60/1.15 = 7.83
    expect(t.vat).toBeCloseTo(7.83, 2);
  });
  it("two cartons → 24 × base price", () => {
    const t = lineTotals(line({ qty: 2, conversionFactorSnapshot: 12, baseQty: 24, unitPrice: 5 }));
    expect(t.gross).toBe(120);
  });
  it("a plain base line (no unit fields) is unchanged: qty × price", () => {
    const t = lineTotals(line({ qty: 3, unitPrice: 5 }));
    expect(t.gross).toBe(15);
  });
  it("cartTotals sums base-qty line grosses", () => {
    const totals = cartTotals([
      line({ qty: 1, conversionFactorSnapshot: 12, baseQty: 12, unitPrice: 5 }), // 60
      line({ menuId: "P2", qty: 3, unitPrice: 10, vatCategory: "Z" }), // 30
    ]);
    expect(totals.subtotal).toBe(90);
  });
});

describe("upsertPayloadFrom — carries the frozen unit for offline/sync", () => {
  const doc = (lines: CartLine[]): LocalOrder => ({
    id: "01ORDERULID0000000000000000", status: "open", orderType: "takeaway", tableNo: null, shiftId: "SH-1",
    deviceId: "d1", discountType: null, discountValue: 0, discountName: null, note: null, customerId: null, customerName: null,
    customerPhone: null, lines, serverVersion: null, invoiceNumber: null, saleId: null, createdAt: 1, updatedAt: 1,
  });
  it("a carton line sends qty=enteredQty + unitFactor + enteredUnitCode + baseQty", () => {
    const p = upsertPayloadFrom(doc([line({ qty: 2, conversionFactorSnapshot: 12, baseQty: 24, enteredUnitCode: "CTN", enteredUnitId: "IU-C", unitPrice: 5 })]));
    const l = (p.lines as Record<string, unknown>[])[0];
    expect(l.qty).toBe(2);
    expect(l.unitFactor).toBe(12);
    expect(l.enteredUnitCode).toBe("CTN");
    expect(l.baseQty).toBe(24);
  });
  it("a plain base line omits unit fields (backward compatible)", () => {
    const p = upsertPayloadFrom(doc([line({ qty: 3, unitPrice: 5, conversionFactorSnapshot: 1, baseQty: 3 })]));
    const l = (p.lines as Record<string, unknown>[])[0];
    expect(l.qty).toBe(3);
    expect(l.unitFactor).toBeUndefined(); // factor 1 → not sent
  });
});

describe("resolveScan — barcode resolves to a unit (offline)", () => {
  const items = [CARTON];
  it("a carton barcode resolves to the carton unit", () => {
    expect(resolveScan(items, "CTN-1")).toEqual({ item: CARTON, unitCode: "CTN" });
  });
  it("the primary (base) barcode resolves to the base unit", () => {
    expect(resolveScan(items, "BASE-1")).toEqual({ item: CARTON, unitCode: null });
  });
  it("an exact catalog id resolves to the base unit", () => {
    expect(resolveScan(items, "P1")).toEqual({ item: CARTON, unitCode: null });
  });
  it("a name substring resolves to the base unit", () => {
    expect(resolveScan(items, "شوكولا")).toEqual({ item: CARTON, unitCode: null });
  });
  it("no match returns null", () => {
    expect(resolveScan(items, "NOPE-999")).toBeNull();
  });
});
