/**
 * Landed cost — the client-side allocation helper and the receipt adapter.
 *
 * The form previews with allocateReceiptCharges what the server will post
 * with lib/procurement/landedCost.js, so the two must agree on the rule:
 *   · by "value" = share of line_total; by "qty" = share of base_qty;
 *   · 4-dp rounding, residual on the LARGEST weight (first on a tie), so the
 *     shares sum EXACTLY to the charge — never 33.3333 × 3 = 99.9999;
 *   · landedUnitCost = (line_total + share) / base_qty;
 *   · null means "no charges" (or nothing to share on) — NEVER 0.
 */
import { describe, expect, it } from "vitest";
import {
  allocateCharge,
  allocateReceiptCharges,
  toPurchaseReceipt,
  toReceiptCharge,
  toReceiptLine,
} from "../procurement.adapter";

const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 1e4) / 1e4;

describe("allocateCharge", () => {
  it("splits by value as the share of line_total", () => {
    const shares = allocateCharge(50, "value", [
      { key: "a", lineTotal: 100, baseQty: 1 },
      { key: "b", lineTotal: 200, baseQty: 1 },
      { key: "c", lineTotal: 700, baseQty: 1 },
    ]);
    expect(shares).toEqual([5, 10, 35]);
  });

  it("splits by qty as the share of base_qty — a different answer from by value", () => {
    const lines = [
      { key: "a", lineTotal: 500, baseQty: 10 },
      { key: "b", lineTotal: 100, baseQty: 30 },
    ];
    expect(allocateCharge(40, "qty", lines)).toEqual([10, 30]);
    expect(allocateCharge(40, "value", lines)).toEqual([33.3333, 6.6667]);
  });

  it("puts the rounding residual on the largest weight so the shares sum EXACTLY", () => {
    // 10 / 7 = 1.4286 → 1.4286 + 7.1429 + 1.4286 = 10.0001: the extra 0.0001
    // comes off the LARGEST line (index 1), not the first.
    const shares = allocateCharge(10, "value", [
      { key: "a", lineTotal: 1, baseQty: 1 },
      { key: "b", lineTotal: 5, baseQty: 1 },
      { key: "c", lineTotal: 1, baseQty: 1 },
    ]);
    expect(shares).toEqual([1.4286, 7.1428, 1.4286]);
    expect(sum(shares ?? [])).toBe(10);
  });

  it("gives the residual to the FIRST of equal weights, deterministically", () => {
    const shares = allocateCharge(100, "value", [
      { key: "a", lineTotal: 1, baseQty: 1 },
      { key: "b", lineTotal: 1, baseQty: 1 },
      { key: "c", lineTotal: 1, baseQty: 1 },
    ]);
    expect(shares).toEqual([33.3334, 33.3333, 33.3333]);
    expect(sum(shares ?? [])).toBe(100);
  });

  it("returns null — not zeros — when there is nothing to share on", () => {
    expect(allocateCharge(10, "value", [])).toBeNull();
    expect(allocateCharge(10, "value", [{ key: "a", lineTotal: 0, baseQty: 5 }])).toBeNull();
    expect(allocateCharge(10, "qty", [{ key: "a", lineTotal: 50, baseQty: 0 }])).toBeNull();
  });

  it("gives a zero-weight line nothing while the rest still sum exactly", () => {
    const shares = allocateCharge(10, "value", [
      { key: "free", lineTotal: 0, baseQty: 3 },
      { key: "a", lineTotal: 1, baseQty: 1 },
      { key: "b", lineTotal: 2, baseQty: 1 },
    ]);
    expect(shares).toEqual([0, 3.3333, 6.6667]);
    expect(sum(shares ?? [])).toBe(10);
  });
});

describe("allocateReceiptCharges", () => {
  const lines = [
    { key: "L1", lineTotal: 840, baseQty: 84 },
    { key: "L2", lineTotal: 160, baseQty: 16 },
  ];

  it("accumulates every charge per line and derives the landed unit cost per BASE unit", () => {
    const out = allocateReceiptCharges(lines, [
      { amount: 100, allocationMethod: "value" }, // 84 / 16
      { amount: 50, allocationMethod: "qty" },    // 42 / 8
    ]);
    expect(out.goodsTotal).toBe(1000);
    expect(out.chargesTotal).toBe(150);
    expect(out.landedTotal).toBe(1150);
    expect(out.byKey.L1).toEqual({ landedChargeAmount: 126, landedUnitCost: 11.5 });   // (840 + 126) / 84
    expect(out.byKey.L2).toEqual({ landedChargeAmount: 24, landedUnitCost: 11.5 });    // (160 + 24) / 16
    expect(sum([out.byKey.L1.landedChargeAmount ?? 0, out.byKey.L2.landedChargeAmount ?? 0])).toBe(150);
  });

  it("leaves every landed figure null when the receipt has no charges", () => {
    const out = allocateReceiptCharges(lines, []);
    expect(out.chargesTotal).toBe(0);
    expect(out.landedTotal).toBe(1000);
    expect(out.byKey.L1).toEqual({ landedChargeAmount: null, landedUnitCost: null });
    expect(out.byKey.L2).toEqual({ landedChargeAmount: null, landedUnitCost: null });
  });

  it("has no unit cost for a line with no base quantity, even when it carries a charge", () => {
    const out = allocateReceiptCharges(
      [{ key: "L1", lineTotal: 100, baseQty: 0 }, { key: "L2", lineTotal: 100, baseQty: 10 }],
      [{ amount: 10, allocationMethod: "value" }],
    );
    expect(out.byKey.L1).toEqual({ landedChargeAmount: 5, landedUnitCost: null });
    expect(out.byKey.L2).toEqual({ landedChargeAmount: 5, landedUnitCost: 10.5 });
  });

  it("skips a charge that cannot be allocated instead of inventing zeros", () => {
    // By qty over lines that have no quantity: nothing to share on → the
    // charge is not spread, and the lines stay "no charge" (null).
    const out = allocateReceiptCharges(
      [{ key: "L1", lineTotal: 100, baseQty: 0 }],
      [{ amount: 10, allocationMethod: "qty" }],
    );
    expect(out.byKey.L1).toEqual({ landedChargeAmount: null, landedUnitCost: null });
  });
});

describe("toPurchaseReceipt — null is not zero", () => {
  const base = {
    id: "GRN-1", receipt_number: "GRN-0001", po_id: "PO-1", supplier_id: "SUP-1", supplier_name_snapshot: "مورد",
    receipt_date: "2026-08-02", warehouse_id: "WH-1", status: "draft", version: 1, subtotal: 840, vat_amount: 126, total: 966,
    lines: [{ id: "L1", po_line_id: "POL-1", item_id: "ITEM-1", item_name: "مادة", entered_qty: 7, entered_unit_code: "كرتون", base_qty: 84, base_unit_cost: 10, line_total: 840 }],
  };

  it("keeps `charges` null when the envelope never carried the field (a server without landed cost)", () => {
    const r = toPurchaseReceipt(base);
    expect(r.charges).toBeNull();
    expect(r.chargesTotal).toBeNull();
    expect(r.landedTotal).toBeNull();
    expect(r.lines[0].landedChargeAmount).toBeNull();
    expect(r.lines[0].landedUnitCost).toBeNull();
    expect(r.subtotal).toBe(840);
  });

  it("maps the contract shape, camelCase first, snake_case as the fallback", () => {
    const r = toPurchaseReceipt({
      ...base,
      charges: [{ id: "C1", chargeType: "customs", description: "جمارك", supplierId: "SUP-9", supplierName: "الجمارك", amount: 84, vatAmount: 12.6, allocationMethod: "qty", status: "invoiced", supplierInvoiceId: "INV-7" }],
      chargesTotal: 84,
      landedTotal: 924,
      lines: [{ ...base.lines[0], landed_charge_amount: 84, landed_unit_cost: 11 }],
    });
    expect(r.charges).toHaveLength(1);
    expect(r.charges?.[0]).toMatchObject({ chargeType: "customs", supplierName: "الجمارك", allocationMethod: "qty", status: "invoiced", supplierInvoiceId: "INV-7", vatAmount: 12.6 });
    expect(r.chargesTotal).toBe(84);
    expect(r.landedTotal).toBe(924);
    expect(r.lines[0].landedChargeAmount).toBe(84);
    expect(r.lines[0].landedUnitCost).toBe(11);
  });

  it("does not coerce an explicit null landed figure to 0, and a 0 the server sent stays 0", () => {
    expect(toReceiptLine({ id: "L1", base_qty: 5, line_total: 50, landedChargeAmount: null, landedUnitCost: null }).landedUnitCost).toBeNull();
    expect(toReceiptLine({ id: "L1", base_qty: 5, line_total: 50, landedChargeAmount: "", landedUnitCost: "" }).landedUnitCost).toBeNull();
    expect(toReceiptLine({ id: "L1", base_qty: 5, line_total: 0, landedChargeAmount: 0, landedUnitCost: 0 }).landedUnitCost).toBe(0);
  });

  it("falls back to a safe charge shape for anything the contract does not name", () => {
    const c = toReceiptCharge({ id: "C9", chargeType: "tariff-x", amount: "12.5", status: "weird", allocationMethod: "by-foot" });
    expect(c.chargeType).toBe("other");
    expect(c.status).toBe("accrued");
    expect(c.allocationMethod).toBe("value");
    expect(c.amount).toBe(12.5);
    expect(c.vatAmount).toBe(0);
    expect(c.supplierId).toBeNull();
    expect(c.supplierInvoiceId).toBeNull();
  });
});
