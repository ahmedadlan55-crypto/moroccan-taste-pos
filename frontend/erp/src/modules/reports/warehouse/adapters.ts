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
