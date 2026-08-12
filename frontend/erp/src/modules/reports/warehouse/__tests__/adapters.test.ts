import { describe, expect, it } from "vitest";
import { toPurchaseIntelligenceResult, toWarehouseIntelligenceOverview } from "../adapters";

describe("warehouse intelligence adapters", () => {
  it("maps the live overview contract without turning unavailable values into facts", () => {
    const result = toWarehouseIntelligenceOverview({
      data: {
        kpis: {
          inventoryValueWac: "1250.50", stockQty: "18.5", stockItems: "4",
          purchaseSpend: "800", receivedQty: "12", openPoValue: "300", openPoQty: "5",
          wasteValue: null, wasteQty: null, negativePositions: 2, lowStockPositions: 3, outOfStockPositions: 1,
        },
        stockFlow: [{ type: "sale:out", label: "sale", direction: "out", qty: "8", value: null }],
        costCoverage: { valuedPositions: 10, warehouseWacPositions: 7, itemCostFallbackPositions: 2, missingCostPositions: 1 },
        salesCostBridge: {
          state: "available", netSalesExVat: 1000, cogsSnapshot: 600, grossProfit: 400,
          marginPct: 40, lineCount: 12, costedLineCount: 11, uncostedLineCount: 1,
          uncostedNetAmount: 20, coveragePct: 91.67, includesReturns: false,
        },
      },
      warnings: [{ code: "MISSING_COST", message: "message from server", level: "error" }],
    });

    expect(result.kpis).toMatchObject({ totalQty: 18.5, itemCount: 4, negativeCount: 2, lowCount: 3, outCount: 1 });
    expect(result.kpis.wasteValue).toBeNull();
    expect(result.stockFlow[0]).toMatchObject({ type: "sale:out", direction: "out", qty: 8, value: null });
    expect(result.costCoverage).toMatchObject({ totalStockCount: 10, costedStockCount: 7, estimatedCostStockCount: 2, uncostedStockCount: 1 });
    expect(result.salesCostBridge).toMatchObject({ state: "available", grossProfit: 400, coveragePct: 91.67, includesReturns: false });
    expect(result.warnings[0]?.code).toBe("MISSING_COST");
  });

  it("maps posted GRN line aliases and whole-result totals", () => {
    const result = toPurchaseIntelligenceResult({
      data: [{
        lineId: "L-1", receiptId: "GR-1", receiptNumber: "GRN-14", receiptDate: "2026-08-10",
        poNumber: "PO-9", supplierId: "S-1", supplierName: "Supplier A", warehouseId: "W-1",
        warehouseName: "Main", itemId: "I-1", itemName: "Flour", enteredUnit: "bag",
        baseQty: "25", baseUnitCost: "4.5", netAmount: "112.5", status: "posted",
      }],
      totals: { baseQty: 25, netAmount: 112.5, knownVatAmount: 0, knownGrossAmount: 0, missingVatLines: 1 },
      pagination: { page: 1, pageSize: 50, total: 1, totalPages: 1 },
      warnings: [{ code: "GRN_NET_COST", message: "server copy", level: "info" }],
    });

    expect(result.rows[0]).toMatchObject({
      id: "L-1", purchaseId: "GR-1", documentNumber: "PO-9", date: "2026-08-10",
      qty: 25, unit: "bag", unitCost: 4.5, netAmount: 112.5,
      vatAmount: null, grossAmount: null,
    });
    expect(result.totals.qty).toBe(25);
    expect(result.totals).toMatchObject({ vatAmount: null, grossAmount: null, knownVatAmount: 0, missingVatLines: 1 });
    expect(result.pagination.total).toBe(1);
  });
});
