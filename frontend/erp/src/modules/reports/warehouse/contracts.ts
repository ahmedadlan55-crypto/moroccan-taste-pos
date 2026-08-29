export interface WarehouseIntelligenceFilters {
  from: string;
  to: string;
  warehouseId?: string;
  q?: string;
  supplierId?: string;
  itemId?: string;
  page?: number;
  pageSize?: number;
  sort?: "date" | "receipt" | "supplier" | "item" | "warehouse" | "quantity" | "unitCost" | "value";
  dir?: "asc" | "desc";
}

export interface WarehouseIntelligenceKpis {
  inventoryValueWac: number;
  totalQty: number;
  itemCount: number;
  purchaseSpend: number;
  receivedQty: number;
  openPoValue: number;
  openPoQty: number;
  wasteValue: number | null;
  wasteQty: number | null;
  negativeCount: number;
  lowCount: number;
  outCount: number;
  supplierCount: number;
  costedStockCount: number;
  estimatedCostStockCount: number;
}

export interface SalesCostBridge {
  state: "available" | "permission_denied" | "unavailable" | string;
  basis: string | null;
  netSalesExVat: number | null;
  cogsSnapshot: number | null;
  grossProfit: number | null;
  marginPct: number | null;
  lineCount: number | null;
  costedLineCount: number | null;
  uncostedLineCount: number | null;
  uncostedNetAmount: number | null;
  coveragePct: number | null;
  includesReturns: boolean;
  netSalesBeforeReturnsExVat?: number | null;
  returnsNetExVat?: number | null;
  cogsBeforeReturnsSnapshot?: number | null;
  reversedCogs?: number | null;
  unprovenReturnCostLineCount?: number | null;
}

export interface SupplierPurchaseSummary {
  supplierId: string;
  supplierName: string;
  spend: number;
  receivedQty: number;
  documentCount: number;
}

export interface PurchaseTrendPoint {
  period: string;
  spend: number;
  receivedQty: number;
}

export interface StockFlowPoint {
  type: string;
  label: string;
  direction?: "in" | "out" | string;
  qty: number;
  value: number | null;
}

export interface CostCoverage {
  costedStockCount: number;
  estimatedCostStockCount: number;
  uncostedStockCount: number;
  totalStockCount: number;
  costedPct: number;
  estimatedPct: number;
  uncostedPct: number;
}

export interface IntelligenceWarning {
  code: string;
  message: string;
  level: "info" | "warning" | "error";
}

export interface WarehouseIntelligenceOverview {
  kpis: WarehouseIntelligenceKpis;
  purchaseBySupplier: SupplierPurchaseSummary[];
  purchaseTrend: PurchaseTrendPoint[];
  stockFlow: StockFlowPoint[];
  costCoverage: CostCoverage;
  salesCostBridge: SalesCostBridge;
  warnings: IntelligenceWarning[];
  generatedAt: string | null;
}

export interface PurchaseIntelligenceRow {
  id: string;
  purchaseId: string;
  documentNumber: string;
  receiptNumber: string;
  date: string;
  supplierId: string;
  supplierName: string;
  itemId: string;
  itemName: string;
  sku: string;
  warehouseId: string;
  warehouseName: string;
  qty: number;
  unit: string;
  unitCost: number;
  netAmount: number;
  vatAmount: number | null;
  grossAmount: number | null;
  status: string;
}

export interface PurchaseIntelligenceResult {
  rows: PurchaseIntelligenceRow[];
  totals: {
    qty: number;
    netAmount: number;
    vatAmount: number | null;
    grossAmount: number | null;
    knownVatAmount: number;
    knownGrossAmount: number;
    missingVatLines: number;
  };
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  warnings: IntelligenceWarning[];
}

export interface InventoryAccountingReconciliationRow {
  warehouseId: string | null;
  warehouseName: string;
  positiveValue: number;
  negativeValue: number;
  subledgerValue: number;
  glBalance: number;
  difference: number;
  stockPositions: number;
  wacPositions: number;
  fallbackPositions: number;
  missingCostPositions: number;
  negativePositions: number;
  orphanStockPositions: number;
  negativeCostPositions: number;
}

export interface InventoryAccountingReconciliation {
  rows: InventoryAccountingReconciliationRow[];
  summary: Omit<InventoryAccountingReconciliationRow, "warehouseId" | "warehouseName"> & {
    unallocatedGlValue: number;
    warehouseDimensionDifferenceCount: number;
    maxWarehouseDimensionDifference: number;
    state: "reconciled" | "not_reconciled" | string;
    blockers: string[];
    tolerance: number;
  };
  measurement: {
    inventorySystem: string;
    accountingBasisState: string;
    perpetualReconciliationReady: boolean;
    costFormula: string;
    currentOnly: boolean;
    inventoryControlAccount: { role: string; accountId: string | null; code: string };
    includesRecoverableVat: boolean;
    includesLandedCost: boolean;
  };
  ias2Readiness: {
    carryingAmount: number;
    carryingAmountReady: boolean;
    byInventoryClass: { state: string; reason: string };
    nrvAndWriteDowns: { state: string; reason: string };
    writeDownReversals: { state: string; reason: string };
    pledgedInventory: { state: string; reason: string };
    fairValueLessCostsToSell: { state: string; reason: string };
  };
  warnings: IntelligenceWarning[];
}

export interface GrniReconciliationRow {
  receiptId: string;
  receiptNumber: string;
  receiptDate: string;
  warehouseId: string | null;
  warehouseName: string;
  supplierId: string | null;
  supplierName: string;
  ageDays: number;
  receivedValue: number;
  invoicedValue: number;
  returnedBeforeInvoiceValue: number;
  outstandingValue: number;
}

export interface GrniReconciliation {
  rows: GrniReconciliationRow[];
  detail: { shown: number; totalOpenReceipts: number; truncated: boolean; limit: number };
  aging: { current: number; d30: number; d60: number; d90: number; d90plus: number; negative: number; total: number };
  reconciliation: {
    operationalOutstanding: number;
    glBalance: number | null;
    difference: number | null;
    state: "reconciled" | "not_reconciled" | string;
    blockers: string[];
    grniAccount: { role: string; accountId: string | null; code: string };
    currentOnly: boolean;
  };
  warnings: IntelligenceWarning[];
}

// ── Inventory performance ───────────────────────────────────────────────────
// The measured half of the control centre. `null` is load-bearing throughout:
// a metric whose denominator is missing is null, never 0, so the UI is forced
// to render "—" instead of a number the reader cannot tell apart from a real
// zero. Do not widen these to `number` "for convenience".

export type AbcClass = "A" | "B" | "C";
export type XyzClass = "X" | "Y" | "Z";
export type AgeingBucket = "0_30" | "31_60" | "61_90" | "91_180" | "over_180" | "never";

export interface InventoryPerformanceKpis {
  consumptionValue: number;
  consumptionQty: number;
  consumedSkus: number;
  openingValue: number;
  closingValue: number;
  onHandValue: number;
  onHandQty: number;
  averageInventoryValue: number;
  /** null when there is no valued inventory at either end of the period. */
  turnoverRatio: number | null;
  annualizedTurnover: number | null;
  daysOnHand: number | null;
  deadStockValue: number;
  deadStockItems: number;
  deadStockPct: number | null;
  /** null on an empty catalogue — 0% would read as a total stock-out. */
  availabilityPct: number | null;
  stockedPositions: number;
  outOfStockPositions: number;
  valuationBasis: string;
}

export interface ConsumedItemRow {
  itemId: string;
  name: string;
  nameEn: string | null;
  sku: string | null;
  category: string;
  unit: string;
  qty: number;
  value: number;
  movements: number;
  share: number;
  cumulativeShare: number;
  abcClass: AbcClass;
  /** null below the minimum observations — one bucket is not a demand pattern. */
  cv: number | null;
  xyzClass: XyzClass | null;
  onHandQty: number;
  daysOfCover: number | null;
}

export interface AbcClassSummary {
  abcClass: AbcClass;
  items: number;
  qty: number;
  value: number;
  sharePct: number;
  itemSharePct: number;
}

export interface BestSellerRow {
  key: string;
  name: string;
  category: string;
  qty: number;
  revenue: number;
  cost: number;
  grossProfit: number;
  /** null on zero revenue — a margin needs something to be a margin OF. */
  marginPct: number | null;
  orders: number;
  share: number;
}

export interface ConsumptionTrendPoint {
  bucket: string;
  inQty: number;
  outQty: number;
  inValue: number;
  outValue: number;
  netQty: number;
}

export interface CategoryMixRow {
  category: string;
  qty: number;
  value: number;
  items: number;
  share: number;
}

export interface WarehouseMixRow {
  warehouseId: string;
  name: string;
  code: string;
  qty: number;
  value: number;
}

export interface AgeingRow {
  bucket: AgeingBucket;
  items: number;
  qty: number;
  value: number;
  sharePct: number;
}

export interface InventoryPerformance {
  period: { from: string; to: string; days: number; bucket: "day" | "week" };
  kpis: InventoryPerformanceKpis;
  topConsumed: ConsumedItemRow[];
  abcSummary: AbcClassSummary[];
  abcItemCount: number;
  topSelling: { state: string; rows: BestSellerRow[] };
  consumptionTrend: ConsumptionTrendPoint[];
  categoryMix: CategoryMixRow[];
  warehouseMix: WarehouseMixRow[];
  ageing: AgeingRow[];
  warnings: IntelligenceWarning[];
}
