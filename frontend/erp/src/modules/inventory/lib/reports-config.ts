// Per-report column + filter config (Phase 2B). Drives the generic report
// table (ReportDetailPage). Column keys match the DTO fields the backend
// returns; filters list which controls the filter bar renders. Sort keys must
// match the backend SORT_WHITELIST.
//
// i18n: `label` fields hold an i18n PATH (not display text). ReportDetailPage
// resolves them with t(label). The report `label` points at
// inventoryRest.reports.type.<type>; column/total labels point at
// inventoryRest.reports.col.* / inventoryRest.reports.total.* (a few columns
// reuse the generic status.* labels).

export type ColFormat = "text" | "number" | "currency" | "qty" | "date" | "datetime" | "status" | "bool";
export type FilterKey = "dateRange" | "category" | "status" | "type" | "window" | "q";

export interface ReportColumn { key: string; label: string; format?: ColFormat; sortKey?: string; }
export interface TotalDef { key: string; label: string; format?: ColFormat; }
export interface ReportConfig {
  type: string;
  label: string;
  columns: ReportColumn[];
  filters: FilterKey[];
  totals: TotalDef[];
  defaultSort?: { sort: string; dir: "asc" | "desc" };
}

export const REPORTS: Record<string, ReportConfig> = {
  "stock-balance": {
    type: "stock-balance", label: "inventoryRest.reports.type.stock-balance",
    columns: [
      { key: "name", label: "inventoryRest.reports.col.name", sortKey: "name" },
      { key: "category", label: "inventoryRest.reports.col.category", sortKey: "category" },
      { key: "warehouseName", label: "inventoryRest.reports.col.warehouseName", sortKey: "warehouse" },
      { key: "qty", label: "inventoryRest.reports.col.qty", format: "qty", sortKey: "qty" },
      { key: "avgCost", label: "inventoryRest.reports.col.avgCost", format: "currency" },
      { key: "value", label: "inventoryRest.reports.col.value", format: "currency", sortKey: "value" },
      { key: "reorderPoint", label: "inventoryRest.reports.col.reorderPoint", format: "number" },
      { key: "status", label: "inventoryRest.reports.col.status", format: "status" },
    ],
    filters: ["category", "status", "q"],
    totals: [{ key: "totalValue", label: "inventoryRest.reports.total.totalValue", format: "currency" }, { key: "totalQty", label: "inventoryRest.reports.total.totalQty", format: "qty" }, { key: "rows", label: "inventoryRest.reports.total.rows", format: "number" }],
    defaultSort: { sort: "value", dir: "desc" },
  },
  valuation: {
    type: "valuation", label: "inventoryRest.reports.type.valuation",
    columns: [
      { key: "name", label: "inventoryRest.reports.col.warehouseAsName", sortKey: "name" },
      { key: "code", label: "inventoryRest.reports.col.code", sortKey: "warehouse" },
      { key: "itemCount", label: "inventoryRest.reports.col.itemCount", format: "number" },
      { key: "totalQty", label: "inventoryRest.reports.col.totalQty", format: "qty", sortKey: "qty" },
      { key: "totalValue", label: "inventoryRest.reports.col.totalValueWac", format: "currency", sortKey: "value" },
      { key: "estimatedValue", label: "inventoryRest.reports.col.estimatedValue", format: "currency" },
    ],
    filters: [],
    totals: [{ key: "totalValue", label: "inventoryRest.reports.total.totalValue", format: "currency" }, { key: "estimatedValue", label: "inventoryRest.reports.total.estimatedValue", format: "currency" }, { key: "itemCount", label: "inventoryRest.reports.total.itemCount", format: "number" }],
    defaultSort: { sort: "value", dir: "desc" },
  },
  movements: {
    type: "movements", label: "inventoryRest.reports.type.movements",
    columns: [
      { key: "date", label: "inventoryRest.reports.col.date", format: "datetime", sortKey: "date" },
      { key: "itemName", label: "inventoryRest.reports.col.itemName", sortKey: "item" },
      { key: "typeLabel", label: "inventoryRest.reports.col.typeLabel", format: "status", sortKey: "type" },
      { key: "qty", label: "inventoryRest.reports.col.qty", format: "qty", sortKey: "qty" },
      { key: "reason", label: "inventoryRest.reports.col.reason" },
      { key: "username", label: "inventoryRest.reports.col.username" },
      { key: "warehouseName", label: "inventoryRest.reports.col.warehouseName" },
    ],
    filters: ["dateRange", "type", "q"],
    totals: [{ key: "count", label: "inventoryRest.reports.total.count", format: "number" }, { key: "inQty", label: "inventoryRest.reports.total.inQty", format: "qty" }, { key: "outQty", label: "inventoryRest.reports.total.outQty", format: "qty" }],
    defaultSort: { sort: "date", dir: "desc" },
  },
  "low-stock": {
    type: "low-stock", label: "inventoryRest.reports.type.low-stock",
    columns: [
      { key: "name", label: "inventoryRest.reports.col.name", sortKey: "name" },
      { key: "warehouseName", label: "inventoryRest.reports.col.warehouseName" },
      { key: "qty", label: "inventoryRest.reports.col.qty", format: "qty", sortKey: "qty" },
      { key: "minStock", label: "inventoryRest.reports.col.minStock", format: "number" },
      { key: "severityLabel", label: "inventoryRest.reports.col.severityLabel", format: "status" },
      { key: "reorderQty", label: "inventoryRest.reports.col.reorderQty", format: "qty", sortKey: "reorder" },
      { key: "reorderValue", label: "inventoryRest.reports.col.reorderValue", format: "currency", sortKey: "value" },
    ],
    filters: ["category", "q"],
    totals: [{ key: "negativeCount", label: "inventoryRest.reports.total.negativeCount", format: "number" }, { key: "outCount", label: "inventoryRest.reports.total.outCount", format: "number" }, { key: "lowCount", label: "inventoryRest.reports.total.lowCount", format: "number" }, { key: "totalReorderValue", label: "inventoryRest.reports.total.totalReorderValue", format: "currency" }],
  },
  "warehouse-compare": {
    type: "warehouse-compare", label: "inventoryRest.reports.type.warehouse-compare",
    columns: [
      { key: "name", label: "inventoryRest.reports.col.warehouseAsName", sortKey: "name" },
      { key: "code", label: "inventoryRest.reports.col.code" },
      { key: "type", label: "inventoryRest.reports.col.type" },
      { key: "itemCount", label: "inventoryRest.reports.col.itemsCount", format: "number", sortKey: "items" },
      { key: "totalQty", label: "inventoryRest.reports.col.totalQty", format: "qty", sortKey: "qty" },
      { key: "totalValue", label: "inventoryRest.reports.col.value", format: "currency", sortKey: "value" },
      { key: "lowCount", label: "status.low", format: "number" },
      { key: "outCount", label: "status.outOfStock", format: "number" },
      { key: "negativeCount", label: "status.negative", format: "number" },
    ],
    filters: [],
    totals: [{ key: "totalValue", label: "inventoryRest.reports.total.totalValue", format: "currency" }, { key: "itemCount", label: "inventoryRest.reports.total.itemCount", format: "number" }, { key: "warehouseCount", label: "inventoryRest.reports.total.warehouseCount", format: "number" }],
    defaultSort: { sort: "value", dir: "desc" },
  },
  transfers: {
    type: "transfers", label: "inventoryRest.reports.type.transfers",
    columns: [
      { key: "number", label: "inventoryRest.reports.col.number", sortKey: "number" },
      { key: "date", label: "inventoryRest.reports.col.date", format: "date", sortKey: "date" },
      { key: "fromName", label: "inventoryRest.reports.col.fromName" },
      { key: "toName", label: "inventoryRest.reports.col.toName" },
      { key: "statusLabel", label: "inventoryRest.reports.col.statusLabel", format: "status", sortKey: "status" },
      { key: "issued", label: "inventoryRest.reports.col.issued", format: "qty" },
      { key: "received", label: "inventoryRest.reports.col.received", format: "qty" },
      { key: "remaining", label: "inventoryRest.reports.col.remaining", format: "qty", sortKey: "remaining" },
    ],
    filters: ["dateRange", "status"],
    totals: [{ key: "count", label: "inventoryRest.reports.total.countTransfers", format: "number" }, { key: "inTransitRemaining", label: "inventoryRest.reports.total.inTransitRemaining", format: "qty" }],
    defaultSort: { sort: "date", dir: "desc" },
  },
  "receipts-issues": {
    type: "receipts-issues", label: "inventoryRest.reports.type.receipts-issues",
    columns: [
      { key: "number", label: "inventoryRest.reports.col.number", sortKey: "number" },
      { key: "date", label: "inventoryRest.reports.col.date", format: "date", sortKey: "date" },
      { key: "fromName", label: "inventoryRest.reports.col.fromNameIssue" },
      { key: "toName", label: "inventoryRest.reports.col.toNameReceive" },
      { key: "statusLabel", label: "inventoryRest.reports.col.statusLabel", format: "status", sortKey: "status" },
      { key: "value", label: "inventoryRest.reports.col.value", format: "currency", sortKey: "value" },
    ],
    filters: ["dateRange", "status"],
    totals: [{ key: "count", label: "inventoryRest.reports.total.countGeneric", format: "number" }, { key: "totalValue", label: "inventoryRest.reports.total.totalValue", format: "currency" }],
    defaultSort: { sort: "date", dir: "desc" },
  },
  adjustments: {
    type: "adjustments", label: "inventoryRest.reports.type.adjustments",
    columns: [
      { key: "id", label: "inventoryRest.reports.col.id" },
      { key: "date", label: "inventoryRest.reports.col.date", format: "datetime", sortKey: "date" },
      { key: "warehouseName", label: "inventoryRest.reports.col.warehouseName" },
      { key: "reasonLabel", label: "inventoryRest.reports.col.reasonLabel", sortKey: "reason" },
      { key: "statusLabel", label: "inventoryRest.reports.col.statusLabel", format: "status", sortKey: "status" },
      { key: "itemsCount", label: "inventoryRest.reports.col.itemsCount", format: "number" },
      { key: "totalCost", label: "inventoryRest.reports.col.totalCost", format: "currency", sortKey: "value" },
      { key: "approvedBy", label: "inventoryRest.reports.col.approvedBy" },
      { key: "approvedAt", label: "inventoryRest.reports.col.approvedAt", format: "datetime" },
    ],
    filters: ["dateRange", "status"],
    totals: [{ key: "count", label: "inventoryRest.reports.total.countGeneric", format: "number" }, { key: "totalCost", label: "inventoryRest.reports.total.totalCost", format: "currency" }, { key: "pending", label: "inventoryRest.reports.total.pending", format: "number" }, { key: "approved", label: "inventoryRest.reports.total.approved", format: "number" }],
    defaultSort: { sort: "date", dir: "desc" },
  },
  stocktakes: {
    type: "stocktakes", label: "inventoryRest.reports.type.stocktakes",
    columns: [
      { key: "id", label: "inventoryRest.reports.col.id" },
      { key: "date", label: "inventoryRest.reports.col.date", format: "datetime", sortKey: "date" },
      { key: "warehouseName", label: "inventoryRest.reports.col.warehouseName" },
      { key: "statusLabel", label: "inventoryRest.reports.col.statusLabel", format: "status" },
      { key: "itemsCount", label: "inventoryRest.reports.col.itemsCount", format: "number", sortKey: "items" },
      { key: "totalVariance", label: "inventoryRest.reports.col.totalVariance", format: "currency", sortKey: "variance" },
    ],
    filters: ["dateRange"],
    totals: [{ key: "count", label: "inventoryRest.reports.total.countRecords", format: "number" }, { key: "totalVariance", label: "inventoryRest.reports.col.totalVariance", format: "currency" }],
    defaultSort: { sort: "date", dir: "desc" },
  },
  "no-movement": {
    type: "no-movement", label: "inventoryRest.reports.type.no-movement",
    columns: [
      { key: "name", label: "inventoryRest.reports.col.name", sortKey: "name" },
      { key: "category", label: "inventoryRest.reports.col.category" },
      { key: "qty", label: "inventoryRest.reports.col.qty", format: "qty", sortKey: "qty" },
      { key: "value", label: "inventoryRest.reports.col.value", format: "currency", sortKey: "value" },
      { key: "lastMovement", label: "inventoryRest.reports.col.lastMovement", format: "datetime", sortKey: "last" },
      { key: "daysSince", label: "inventoryRest.reports.col.daysSince", format: "number" },
    ],
    filters: ["category", "window"],
    totals: [{ key: "count", label: "inventoryRest.reports.total.countItems", format: "number" }, { key: "totalValue", label: "inventoryRest.reports.total.stagnantValue", format: "currency" }],
    defaultSort: { sort: "value", dir: "desc" },
  },
  expiry: {
    type: "expiry", label: "inventoryRest.reports.type.expiry",
    columns: [
      { key: "itemName", label: "inventoryRest.reports.col.itemName", sortKey: "item" },
      { key: "warehouseName", label: "inventoryRest.reports.col.warehouseName" },
      { key: "batch", label: "inventoryRest.reports.col.batch" },
      { key: "qtyRemaining", label: "inventoryRest.reports.col.qtyRemaining", format: "qty", sortKey: "qty" },
      { key: "unitCost", label: "inventoryRest.reports.col.unitCost", format: "currency" },
      { key: "value", label: "inventoryRest.reports.col.value", format: "currency", sortKey: "value" },
      { key: "expiryDate", label: "inventoryRest.reports.col.expiryDate", format: "date", sortKey: "expiry" },
      { key: "daysToExpiry", label: "inventoryRest.reports.col.daysToExpiry", format: "number" },
      { key: "statusLabel", label: "inventoryRest.reports.col.statusLabel", format: "status" },
    ],
    filters: ["q"],
    totals: [{ key: "count", label: "inventoryRest.reports.total.countExpiry", format: "number" }, { key: "totalValue", label: "inventoryRest.reports.total.exposedValue", format: "currency" }],
    defaultSort: { sort: "expiry", dir: "asc" },
  },
  "data-quality": {
    type: "data-quality", label: "inventoryRest.reports.type.data-quality",
    columns: [
      { key: "label", label: "inventoryRest.reports.col.label" },
      { key: "count", label: "inventoryRest.reports.col.count", format: "number", sortKey: "count" },
      { key: "note", label: "inventoryRest.reports.col.note" },
    ],
    filters: [],
    totals: [{ key: "metrics", label: "inventoryRest.reports.total.metrics", format: "number" }],
  },
};

export const REPORT_LIST = Object.values(REPORTS);
