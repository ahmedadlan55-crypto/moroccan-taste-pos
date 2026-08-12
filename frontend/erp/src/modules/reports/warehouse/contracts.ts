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
