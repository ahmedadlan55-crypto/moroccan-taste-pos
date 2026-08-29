import type {
  CostCoverage,
  IntelligenceWarning,
  PurchaseIntelligenceResult,
  PurchaseIntelligenceRow,
  PurchaseTrendPoint,
  StockFlowPoint,
  SupplierPurchaseSummary,
  WarehouseIntelligenceKpis,
  WarehouseIntelligenceOverview,
  SalesCostBridge,
  InventoryAccountingReconciliation,
  GrniReconciliation,
  AbcClass,
  AgeingBucket,
  InventoryPerformance,
  XyzClass,
} from "./contracts";

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);
const num = (v: unknown): number => {
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : 0;
};
const str = (v: unknown): string => (v == null ? "" : String(v));
const pick = (r: Obj, ...keys: string[]): unknown => {
  for (const key of keys) if (r[key] !== undefined && r[key] !== null) return r[key];
  return undefined;
};

function warningsFrom(...values: unknown[]): IntelligenceWarning[] {
  const source = values.find(Array.isArray);
  return arr(source).map((w) => ({
    code: str(pick(w, "code", "id")) || "DATA_QUALITY",
    message: str(pick(w, "message", "label")),
    level: (["info", "warning", "error"].includes(str(w.level)) ? str(w.level) : "warning") as IntelligenceWarning["level"],
  })).filter((w) => w.message);
}

function nullableNum(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : null;
}

function kpisFrom(raw: unknown): WarehouseIntelligenceKpis {
  const r = obj(raw);
  return {
    inventoryValueWac: num(r.inventoryValueWac),
    totalQty: num(pick(r, "totalQty", "stockQty")),
    itemCount: num(pick(r, "itemCount", "stockItems")),
    purchaseSpend: num(r.purchaseSpend),
    receivedQty: num(r.receivedQty),
    openPoValue: num(r.openPoValue),
    openPoQty: num(r.openPoQty),
    wasteValue: nullableNum(r.wasteValue),
    wasteQty: nullableNum(r.wasteQty),
    negativeCount: num(pick(r, "negativeCount", "negativePositions")),
    lowCount: num(pick(r, "lowCount", "lowStockPositions")),
    outCount: num(pick(r, "outCount", "outOfStockPositions")),
    supplierCount: num(r.supplierCount),
    costedStockCount: num(pick(r, "costedStockCount", "warehouseWacPositions")),
    estimatedCostStockCount: num(pick(r, "estimatedCostStockCount", "itemCostFallbackPositions")),
  };
}

function supplierFrom(r: Obj): SupplierPurchaseSummary {
  return {
    supplierId: str(pick(r, "supplierId", "supplier_id")),
    supplierName: str(pick(r, "supplierName", "supplier_name", "name")),
    spend: num(pick(r, "spend", "purchaseSpend", "grossAmount", "total")),
    receivedQty: num(pick(r, "receivedQty", "received_qty", "qty", "quantity")),
    documentCount: num(pick(r, "documentCount", "document_count", "orderCount", "invoiceCount")),
  };
}

function trendFrom(r: Obj): PurchaseTrendPoint {
  return {
    period: str(pick(r, "period", "date", "bucket")),
    spend: num(pick(r, "spend", "purchaseSpend", "grossAmount", "total")),
    receivedQty: num(pick(r, "receivedQty", "received_qty", "qty", "quantity")),
  };
}

function flowFrom(r: Obj): StockFlowPoint {
  return {
    type: str(pick(r, "type", "movementType", "movement_type")),
    label: str(pick(r, "label", "name", "typeLabel")),
    direction: str(pick(r, "direction")) || undefined,
    qty: num(pick(r, "qty", "quantity")),
    value: nullableNum(pick(r, "value", "amount")),
  };
}

function coverageFrom(raw: unknown, kpis: WarehouseIntelligenceKpis): CostCoverage {
  const r = obj(raw);
  const costed = num(pick(r, "costedStockCount", "costed_count", "warehouseWacPositions")) || kpis.costedStockCount;
  const estimated = num(pick(r, "estimatedCostStockCount", "estimated_count", "itemCostFallbackPositions")) || kpis.estimatedCostStockCount;
  const uncosted = num(pick(r, "uncostedStockCount", "uncosted_count", "missingCostPositions"));
  const total = num(pick(r, "totalStockCount", "total_count", "valuedPositions")) || costed + estimated + uncosted;
  const pct = (value: number, explicit: unknown) => {
    const n = num(explicit);
    return n || (total > 0 ? (value / total) * 100 : 0);
  };
  return {
    costedStockCount: costed,
    estimatedCostStockCount: estimated,
    uncostedStockCount: uncosted,
    totalStockCount: total,
    costedPct: pct(costed, pick(r, "costedPct", "costed_pct")),
    estimatedPct: pct(estimated, pick(r, "estimatedPct", "estimated_pct")),
    uncostedPct: pct(uncosted, pick(r, "uncostedPct", "uncosted_pct")),
  };
}

function salesCostBridgeFrom(raw: unknown): SalesCostBridge {
  const r = obj(raw);
  return {
    state: str(r.state) || "unavailable",
    basis: str(r.basis) || null,
    netSalesExVat: nullableNum(r.netSalesExVat),
    cogsSnapshot: nullableNum(r.cogsSnapshot),
    grossProfit: nullableNum(r.grossProfit),
    marginPct: nullableNum(r.marginPct),
    lineCount: nullableNum(r.lineCount),
    costedLineCount: nullableNum(r.costedLineCount),
    uncostedLineCount: nullableNum(r.uncostedLineCount),
    uncostedNetAmount: nullableNum(r.uncostedNetAmount),
    coveragePct: nullableNum(r.coveragePct),
    includesReturns: r.includesReturns === true,
    netSalesBeforeReturnsExVat: nullableNum(r.netSalesBeforeReturnsExVat),
    returnsNetExVat: nullableNum(r.returnsNetExVat),
    cogsBeforeReturnsSnapshot: nullableNum(r.cogsBeforeReturnsSnapshot),
    reversedCogs: nullableNum(r.reversedCogs),
    unprovenReturnCostLineCount: nullableNum(r.unprovenReturnCostLineCount),
  };
}

export function toWarehouseIntelligenceOverview(raw: unknown): WarehouseIntelligenceOverview {
  const root = obj(raw);
  const data = obj(root.data);
  const body = Object.keys(data).length ? data : root;
  const kpis = kpisFrom(body.kpis);
  return {
    kpis,
    purchaseBySupplier: arr(body.purchaseBySupplier).map(supplierFrom),
    purchaseTrend: arr(body.purchaseTrend).map(trendFrom),
    stockFlow: arr(body.stockFlow).map(flowFrom),
    costCoverage: coverageFrom(body.costCoverage, kpis),
    salesCostBridge: salesCostBridgeFrom(body.salesCostBridge),
    warnings: warningsFrom(root.warnings, body.warnings, root.dataQualityWarnings),
    generatedAt: str(pick(root, "generatedAt", "generated_at")) || null,
  };
}

function purchaseRowFrom(r: Obj, index: number): PurchaseIntelligenceRow {
  const purchaseId = str(pick(r, "purchaseId", "purchase_id", "orderId", "order_id", "receiptId", "receipt_id"));
  const itemId = str(pick(r, "itemId", "item_id"));
  return {
    id: str(pick(r, "id", "lineId", "line_id")) || `${purchaseId}:${itemId}:${index}`,
    purchaseId,
    documentNumber: str(pick(r, "documentNumber", "document_number", "purchaseNumber", "purchase_number", "orderNumber", "order_number", "poNumber", "po_number", "receiptNumber", "receipt_number")),
    receiptNumber: str(pick(r, "receiptNumber", "receipt_number", "grnNumber", "grn_number")),
    date: str(pick(r, "date", "receivedAt", "received_at", "purchaseDate", "purchase_date", "receiptDate", "receipt_date")),
    supplierId: str(pick(r, "supplierId", "supplier_id")),
    supplierName: str(pick(r, "supplierName", "supplier_name")),
    itemId,
    itemName: str(pick(r, "itemName", "item_name", "name")),
    sku: str(pick(r, "sku", "itemSku", "item_sku")),
    warehouseId: str(pick(r, "warehouseId", "warehouse_id")),
    warehouseName: str(pick(r, "warehouseName", "warehouse_name")),
    qty: num(pick(r, "qty", "quantity", "receivedQty", "received_qty", "baseQty", "base_qty")),
    unit: str(pick(r, "unit", "unitName", "unit_name", "enteredUnit", "entered_unit")),
    unitCost: num(pick(r, "unitCost", "unit_cost", "baseUnitCost", "base_unit_cost")),
    netAmount: num(pick(r, "netAmount", "net_amount", "subtotal")),
    vatAmount: nullableNum(pick(r, "vatAmount", "vat_amount", "taxAmount", "tax_amount")),
    grossAmount: nullableNum(pick(r, "grossAmount", "gross_amount", "totalAmount", "total_amount", "total")),
    status: str(r.status),
  };
}

export function toPurchaseIntelligenceResult(raw: unknown): PurchaseIntelligenceResult {
  const root = obj(raw);
  const payload = root.data;
  const body = obj(payload);
  const rowsRaw = Array.isArray(payload) ? payload : (body.rows ?? body.data);
  const rows = arr(rowsRaw).map(purchaseRowFrom);
  const totalsRaw = obj(root.totals ?? body.totals);
  const paginationRaw = obj(root.pagination ?? body.pagination);
  const total = num(pick(paginationRaw, "total", "count")) || rows.length;
  const pageSize = num(pick(paginationRaw, "pageSize", "page_size", "limit")) || 50;
  const page = num(paginationRaw.page) || 1;
  return {
    rows,
    totals: {
      qty: num(pick(totalsRaw, "qty", "quantity", "receivedQty", "baseQty", "enteredQty")),
      netAmount: num(pick(totalsRaw, "netAmount", "net_amount", "net")),
      vatAmount: nullableNum(pick(totalsRaw, "vatAmount", "vat_amount", "vat")),
      grossAmount: nullableNum(pick(totalsRaw, "grossAmount", "gross_amount", "gross", "total")),
      knownVatAmount: num(pick(totalsRaw, "knownVatAmount", "known_vat_amount", "vatAmount", "vat_amount", "vat")),
      knownGrossAmount: num(pick(totalsRaw, "knownGrossAmount", "known_gross_amount", "grossAmount", "gross_amount", "gross", "total")),
      missingVatLines: num(pick(totalsRaw, "missingVatLines", "missing_vat_lines")),
    },
    pagination: {
      page,
      pageSize,
      total,
      totalPages: num(pick(paginationRaw, "totalPages", "total_pages")) || Math.max(1, Math.ceil(total / pageSize)),
    },
    warnings: warningsFrom(root.warnings, body.warnings, root.dataQualityWarnings),
  };
}

export function toInventoryAccountingReconciliation(raw: unknown): InventoryAccountingReconciliation {
  const root = obj(raw);
  const body = obj(root.data);
  const summary = obj(body.summary);
  const measurement = obj(body.measurement);
  const control = obj(measurement.inventoryControlAccount);
  const readiness = obj(body.ias2Readiness);
  const readinessItem = (key: string) => {
    const item = obj(readiness[key]);
    return { state: str(item.state), reason: str(item.reason) };
  };
  const row = (value: Obj) => ({
    warehouseId: pick(value, "warehouseId", "warehouse_id") == null ? null : str(pick(value, "warehouseId", "warehouse_id")),
    warehouseName: str(pick(value, "warehouseName", "warehouse_name")),
    positiveValue: num(value.positiveValue), negativeValue: num(value.negativeValue),
    subledgerValue: num(value.subledgerValue), glBalance: num(value.glBalance), difference: num(value.difference),
    stockPositions: num(value.stockPositions), wacPositions: num(value.wacPositions),
    fallbackPositions: num(value.fallbackPositions), missingCostPositions: num(value.missingCostPositions),
    negativePositions: num(value.negativePositions), orphanStockPositions: num(value.orphanStockPositions),
    negativeCostPositions: num(value.negativeCostPositions),
  });
  const summaryRow = row(summary);
  return {
    rows: arr(body.rows).map(row),
    summary: {
      positiveValue: summaryRow.positiveValue, negativeValue: summaryRow.negativeValue,
      subledgerValue: summaryRow.subledgerValue, glBalance: summaryRow.glBalance,
      difference: num(summary.difference), stockPositions: summaryRow.stockPositions,
      wacPositions: summaryRow.wacPositions, fallbackPositions: summaryRow.fallbackPositions,
      missingCostPositions: summaryRow.missingCostPositions, negativePositions: summaryRow.negativePositions,
      orphanStockPositions: summaryRow.orphanStockPositions, negativeCostPositions: summaryRow.negativeCostPositions,
      unallocatedGlValue: num(summary.unallocatedGlValue),
      warehouseDimensionDifferenceCount: num(summary.warehouseDimensionDifferenceCount),
      maxWarehouseDimensionDifference: num(summary.maxWarehouseDimensionDifference), state: str(summary.state),
      blockers: Array.isArray(summary.blockers) ? summary.blockers.map(str) : [], tolerance: num(summary.tolerance),
    },
    measurement: {
      inventorySystem: str(measurement.inventorySystem), accountingBasisState: str(measurement.accountingBasisState),
      perpetualReconciliationReady: measurement.perpetualReconciliationReady === true,
      costFormula: str(measurement.costFormula),
      currentOnly: measurement.currentOnly === true,
      inventoryControlAccount: { role: str(control.role), accountId: control.accountId == null ? null : str(control.accountId), code: str(control.code) },
      includesRecoverableVat: measurement.includesRecoverableVat === true,
      includesLandedCost: measurement.includesLandedCost === true,
    },
    ias2Readiness: {
      carryingAmount: num(readiness.carryingAmount), carryingAmountReady: readiness.carryingAmountReady === true,
      byInventoryClass: readinessItem("byInventoryClass"), nrvAndWriteDowns: readinessItem("nrvAndWriteDowns"),
      writeDownReversals: readinessItem("writeDownReversals"), pledgedInventory: readinessItem("pledgedInventory"),
      fairValueLessCostsToSell: readinessItem("fairValueLessCostsToSell"),
    },
    warnings: warningsFrom(root.warnings),
  };
}

export function toGrniReconciliation(raw: unknown): GrniReconciliation {
  const root = obj(raw);
  const body = obj(root.data);
  const aging = obj(body.aging);
  const detail = obj(body.detail);
  const reconciliation = obj(body.reconciliation);
  const account = obj(reconciliation.grniAccount);
  return {
    rows: arr(body.rows).map((value) => ({
      receiptId: str(value.receiptId), receiptNumber: str(value.receiptNumber), receiptDate: str(value.receiptDate),
      warehouseId: value.warehouseId == null ? null : str(value.warehouseId), warehouseName: str(value.warehouseName),
      supplierId: value.supplierId == null ? null : str(value.supplierId), supplierName: str(value.supplierName),
      ageDays: num(value.ageDays), receivedValue: num(value.receivedValue), invoicedValue: num(value.invoicedValue),
      returnedBeforeInvoiceValue: num(value.returnedBeforeInvoiceValue), outstandingValue: num(value.outstandingValue),
    })),
    detail: {
      shown: num(detail.shown), totalOpenReceipts: num(detail.totalOpenReceipts),
      truncated: detail.truncated === true, limit: num(detail.limit),
    },
    aging: {
      current: num(aging.current), d30: num(aging.d30), d60: num(aging.d60), d90: num(aging.d90),
      d90plus: num(aging.d90plus), negative: num(aging.negative), total: num(aging.total),
    },
    reconciliation: {
      operationalOutstanding: num(reconciliation.operationalOutstanding),
      glBalance: nullableNum(reconciliation.glBalance), difference: nullableNum(reconciliation.difference),
      state: str(reconciliation.state), blockers: Array.isArray(reconciliation.blockers) ? reconciliation.blockers.map(str) : [],
      grniAccount: { role: str(account.role), accountId: account.accountId == null ? null : str(account.accountId), code: str(account.code) },
      currentOnly: reconciliation.currentOnly === true,
    },
    warnings: warningsFrom(root.warnings),
  };
}

// ── Inventory performance ───────────────────────────────────────────────────
// `nullableNum` everywhere a metric can legitimately have no value. Reaching
// for `num()` here would coerce every absent denominator to 0 and quietly turn
// "there is no inventory to divide by" into "inventory that never turns" —
// which is the opposite conclusion, on the same screen, with no way to tell.

const ABC_CLASSES = new Set(["A", "B", "C"]);
const XYZ_CLASSES = new Set(["X", "Y", "Z"]);
const AGEING_BUCKETS = new Set(["0_30", "31_60", "61_90", "91_180", "over_180", "never"]);

function abcClass(v: unknown): AbcClass {
  const value = str(v).toUpperCase();
  return (ABC_CLASSES.has(value) ? value : "C") as AbcClass;
}

function xyzClass(v: unknown): XyzClass | null {
  const value = str(v).toUpperCase();
  return XYZ_CLASSES.has(value) ? (value as XyzClass) : null;
}

export function toInventoryPerformance(raw: unknown): InventoryPerformance {
  const root = obj(raw);
  const data = obj(root.data);
  const period = obj(data.period);
  const k = obj(data.kpis);
  const selling = obj(data.topSelling);
  return {
    period: {
      from: str(period.from),
      to: str(period.to),
      days: num(period.days),
      bucket: str(period.bucket) === "week" ? "week" : "day",
    },
    kpis: {
      consumptionValue: num(k.consumptionValue),
      consumptionQty: num(k.consumptionQty),
      consumedSkus: num(k.consumedSkus),
      openingValue: num(k.openingValue),
      closingValue: num(k.closingValue),
      onHandValue: num(k.onHandValue),
      onHandQty: num(k.onHandQty),
      averageInventoryValue: num(k.averageInventoryValue),
      turnoverRatio: nullableNum(k.turnoverRatio),
      annualizedTurnover: nullableNum(k.annualizedTurnover),
      daysOnHand: nullableNum(k.daysOnHand),
      deadStockValue: num(k.deadStockValue),
      deadStockItems: num(k.deadStockItems),
      deadStockPct: nullableNum(k.deadStockPct),
      availabilityPct: nullableNum(k.availabilityPct),
      stockedPositions: num(k.stockedPositions),
      outOfStockPositions: num(k.outOfStockPositions),
      valuationBasis: str(k.valuationBasis),
    },
    topConsumed: arr(data.topConsumed).map((row) => ({
      itemId: str(row.itemId),
      name: str(row.name),
      nameEn: row.nameEn == null ? null : str(row.nameEn),
      sku: row.sku == null ? null : str(row.sku),
      category: str(row.category),
      unit: str(row.unit),
      qty: num(row.qty),
      value: num(row.value),
      movements: num(row.movements),
      share: num(row.share),
      cumulativeShare: num(row.cumulativeShare),
      abcClass: abcClass(row.abcClass),
      cv: nullableNum(row.cv),
      xyzClass: xyzClass(row.xyzClass),
      onHandQty: num(row.onHandQty),
      daysOfCover: nullableNum(row.daysOfCover),
    })),
    abcSummary: arr(data.abcSummary).map((row) => ({
      abcClass: abcClass(row.abcClass),
      items: num(row.items),
      qty: num(row.qty),
      value: num(row.value),
      sharePct: num(row.sharePct),
      itemSharePct: num(row.itemSharePct),
    })),
    abcItemCount: num(data.abcItemCount),
    topSelling: {
      state: str(selling.state) || "unavailable",
      rows: arr(selling.rows).map((row) => ({
        key: str(row.key),
        name: str(row.name),
        category: str(row.category),
        qty: num(row.qty),
        revenue: num(row.revenue),
        cost: num(row.cost),
        grossProfit: num(row.grossProfit),
        marginPct: nullableNum(row.marginPct),
        orders: num(row.orders),
        share: num(row.share),
      })),
    },
    consumptionTrend: arr(data.consumptionTrend).map((row) => ({
      bucket: str(row.bucket),
      inQty: num(row.inQty),
      outQty: num(row.outQty),
      inValue: num(row.inValue),
      outValue: num(row.outValue),
      netQty: num(row.netQty),
    })),
    categoryMix: arr(data.categoryMix).map((row) => ({
      category: str(row.category),
      qty: num(row.qty),
      value: num(row.value),
      items: num(row.items),
      share: num(row.share),
    })),
    warehouseMix: arr(data.warehouseMix).map((row) => ({
      warehouseId: str(row.warehouseId),
      name: str(row.name),
      code: str(row.code),
      qty: num(row.qty),
      value: num(row.value),
    })),
    ageing: arr(data.ageing)
      .map((row) => ({
        bucket: str(row.bucket) as AgeingBucket,
        items: num(row.items),
        qty: num(row.qty),
        value: num(row.value),
        sharePct: num(row.sharePct),
      }))
      .filter((row) => AGEING_BUCKETS.has(row.bucket)),
    warnings: warningsFrom(root.warnings, root.dataQualityWarnings),
  };
}
