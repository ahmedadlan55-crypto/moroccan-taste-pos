// Per-report column + filter config (Phase 2B). Drives the generic report
// table (ReportDetailPage). Column keys match the DTO fields the backend
// returns; filters list which controls the filter bar renders. Sort keys must
// match the backend SORT_WHITELIST.

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
    type: "stock-balance", label: "رصيد المخزون الحالي",
    columns: [
      { key: "name", label: "الصنف", sortKey: "name" },
      { key: "category", label: "الفئة", sortKey: "category" },
      { key: "warehouseName", label: "المستودع", sortKey: "warehouse" },
      { key: "qty", label: "الكمية", format: "qty", sortKey: "qty" },
      { key: "avgCost", label: "تكلفة الوحدة", format: "currency" },
      { key: "value", label: "القيمة", format: "currency", sortKey: "value" },
      { key: "reorderPoint", label: "حد الطلب", format: "number" },
      { key: "status", label: "الحالة", format: "status" },
    ],
    filters: ["category", "status", "q"],
    totals: [{ key: "totalValue", label: "إجمالي القيمة", format: "currency" }, { key: "totalQty", label: "إجمالي الكمية", format: "qty" }, { key: "rows", label: "عدد الصفوف", format: "number" }],
    defaultSort: { sort: "value", dir: "desc" },
  },
  valuation: {
    type: "valuation", label: "تقييم المخزون",
    columns: [
      { key: "name", label: "المستودع", sortKey: "name" },
      { key: "code", label: "الكود", sortKey: "warehouse" },
      { key: "itemCount", label: "عدد الأصناف", format: "number" },
      { key: "totalQty", label: "الكمية", format: "qty", sortKey: "qty" },
      { key: "totalValue", label: "القيمة (WAC)", format: "currency", sortKey: "value" },
      { key: "estimatedValue", label: "منها تقديري", format: "currency" },
    ],
    filters: [],
    totals: [{ key: "totalValue", label: "إجمالي القيمة", format: "currency" }, { key: "estimatedValue", label: "تقديري", format: "currency" }, { key: "itemCount", label: "الأصناف", format: "number" }],
    defaultSort: { sort: "value", dir: "desc" },
  },
  movements: {
    type: "movements", label: "دفتر حركات المخزون",
    columns: [
      { key: "date", label: "التاريخ", format: "datetime", sortKey: "date" },
      { key: "itemName", label: "الصنف", sortKey: "item" },
      { key: "typeLabel", label: "النوع", format: "status", sortKey: "type" },
      { key: "qty", label: "الكمية", format: "qty", sortKey: "qty" },
      { key: "reason", label: "السبب" },
      { key: "username", label: "المستخدم" },
      { key: "warehouseName", label: "المستودع" },
    ],
    filters: ["dateRange", "type", "q"],
    totals: [{ key: "count", label: "عدد الحركات", format: "number" }, { key: "inQty", label: "وارد", format: "qty" }, { key: "outQty", label: "صادر", format: "qty" }],
    defaultSort: { sort: "date", dir: "desc" },
  },
  "low-stock": {
    type: "low-stock", label: "المنخفض والنافد والسالب",
    columns: [
      { key: "name", label: "الصنف", sortKey: "name" },
      { key: "warehouseName", label: "المستودع" },
      { key: "qty", label: "الكمية", format: "qty", sortKey: "qty" },
      { key: "minStock", label: "الحد الأدنى", format: "number" },
      { key: "severityLabel", label: "الحالة", format: "status" },
      { key: "reorderQty", label: "كمية الطلب", format: "qty", sortKey: "reorder" },
      { key: "reorderValue", label: "قيمة الطلب", format: "currency", sortKey: "value" },
    ],
    filters: ["category", "q"],
    totals: [{ key: "negativeCount", label: "سالب", format: "number" }, { key: "outCount", label: "نافد", format: "number" }, { key: "lowCount", label: "منخفض", format: "number" }, { key: "totalReorderValue", label: "قيمة إعادة الطلب", format: "currency" }],
  },
  "warehouse-compare": {
    type: "warehouse-compare", label: "مقارنة المستودعات",
    columns: [
      { key: "name", label: "المستودع", sortKey: "name" },
      { key: "code", label: "الكود" },
      { key: "type", label: "النوع" },
      { key: "itemCount", label: "الأصناف", format: "number", sortKey: "items" },
      { key: "totalQty", label: "الكمية", format: "qty", sortKey: "qty" },
      { key: "totalValue", label: "القيمة", format: "currency", sortKey: "value" },
      { key: "lowCount", label: "منخفض", format: "number" },
      { key: "outCount", label: "نافد", format: "number" },
      { key: "negativeCount", label: "سالب", format: "number" },
    ],
    filters: [],
    totals: [{ key: "totalValue", label: "إجمالي القيمة", format: "currency" }, { key: "itemCount", label: "الأصناف", format: "number" }, { key: "warehouseCount", label: "المستودعات", format: "number" }],
    defaultSort: { sort: "value", dir: "desc" },
  },
  transfers: {
    type: "transfers", label: "التحويلات والكميات المتبقية",
    columns: [
      { key: "number", label: "الرقم", sortKey: "number" },
      { key: "date", label: "التاريخ", format: "date", sortKey: "date" },
      { key: "fromName", label: "من" },
      { key: "toName", label: "إلى" },
      { key: "statusLabel", label: "الحالة", format: "status", sortKey: "status" },
      { key: "issued", label: "مُصدر", format: "qty" },
      { key: "received", label: "مُستلم", format: "qty" },
      { key: "remaining", label: "متبقٍ", format: "qty", sortKey: "remaining" },
    ],
    filters: ["dateRange", "status"],
    totals: [{ key: "count", label: "عدد التحويلات", format: "number" }, { key: "inTransitRemaining", label: "متبقٍ قيد النقل", format: "qty" }],
    defaultSort: { sort: "date", dir: "desc" },
  },
  "receipts-issues": {
    type: "receipts-issues", label: "الاستلامات والصرف",
    columns: [
      { key: "number", label: "الرقم", sortKey: "number" },
      { key: "date", label: "التاريخ", format: "date", sortKey: "date" },
      { key: "fromName", label: "من (صرف)" },
      { key: "toName", label: "إلى (استلام)" },
      { key: "statusLabel", label: "الحالة", format: "status", sortKey: "status" },
      { key: "value", label: "القيمة", format: "currency", sortKey: "value" },
    ],
    filters: ["dateRange", "status"],
    totals: [{ key: "count", label: "العدد", format: "number" }, { key: "totalValue", label: "إجمالي القيمة", format: "currency" }],
    defaultSort: { sort: "date", dir: "desc" },
  },
  adjustments: {
    type: "adjustments", label: "التعديلات وسجل الاعتماد",
    columns: [
      { key: "id", label: "الرقم" },
      { key: "date", label: "التاريخ", format: "datetime", sortKey: "date" },
      { key: "warehouseName", label: "المستودع" },
      { key: "reasonLabel", label: "السبب", sortKey: "reason" },
      { key: "statusLabel", label: "الحالة", format: "status", sortKey: "status" },
      { key: "itemsCount", label: "الأصناف", format: "number" },
      { key: "totalCost", label: "التكلفة", format: "currency", sortKey: "value" },
      { key: "approvedBy", label: "اعتمد بواسطة" },
      { key: "approvedAt", label: "تاريخ الاعتماد", format: "datetime" },
    ],
    filters: ["dateRange", "status"],
    totals: [{ key: "count", label: "العدد", format: "number" }, { key: "totalCost", label: "إجمالي التكلفة", format: "currency" }, { key: "pending", label: "بانتظار", format: "number" }, { key: "approved", label: "معتمد", format: "number" }],
    defaultSort: { sort: "date", dir: "desc" },
  },
  stocktakes: {
    type: "stocktakes", label: "الجرد وفروقات الجرد",
    columns: [
      { key: "id", label: "الرقم" },
      { key: "date", label: "التاريخ", format: "datetime", sortKey: "date" },
      { key: "warehouseName", label: "المستودع" },
      { key: "statusLabel", label: "الحالة", format: "status" },
      { key: "itemsCount", label: "الأصناف", format: "number", sortKey: "items" },
      { key: "totalVariance", label: "إجمالي الفرق", format: "currency", sortKey: "variance" },
    ],
    filters: ["dateRange"],
    totals: [{ key: "count", label: "عدد المحاضر", format: "number" }, { key: "totalVariance", label: "إجمالي الفرق", format: "currency" }],
    defaultSort: { sort: "date", dir: "desc" },
  },
  "no-movement": {
    type: "no-movement", label: "الأصناف عديمة الحركة",
    columns: [
      { key: "name", label: "الصنف", sortKey: "name" },
      { key: "category", label: "الفئة" },
      { key: "qty", label: "الكمية", format: "qty", sortKey: "qty" },
      { key: "value", label: "القيمة", format: "currency", sortKey: "value" },
      { key: "lastMovement", label: "آخر حركة", format: "datetime", sortKey: "last" },
      { key: "daysSince", label: "أيام بلا حركة", format: "number" },
    ],
    filters: ["category", "window"],
    totals: [{ key: "count", label: "عدد الأصناف", format: "number" }, { key: "totalValue", label: "القيمة الراكدة", format: "currency" }],
    defaultSort: { sort: "value", dir: "desc" },
  },
  expiry: {
    type: "expiry", label: "انتهاء الصلاحية",
    columns: [
      { key: "itemName", label: "الصنف", sortKey: "item" },
      { key: "warehouseName", label: "المستودع" },
      { key: "batch", label: "الدفعة" },
      { key: "qtyRemaining", label: "المتبقي", format: "qty", sortKey: "qty" },
      { key: "unitCost", label: "تكلفة الوحدة", format: "currency" },
      { key: "value", label: "القيمة", format: "currency", sortKey: "value" },
      { key: "expiryDate", label: "تاريخ الانتهاء", format: "date", sortKey: "expiry" },
      { key: "daysToExpiry", label: "أيام متبقية", format: "number" },
      { key: "statusLabel", label: "الحالة", format: "status" },
    ],
    filters: ["q"],
    totals: [{ key: "count", label: "عدد الدفعات", format: "number" }, { key: "totalValue", label: "القيمة المعرّضة", format: "currency" }],
    defaultSort: { sort: "expiry", dir: "asc" },
  },
  "data-quality": {
    type: "data-quality", label: "جودة البيانات والتكلفة التقديرية",
    columns: [
      { key: "label", label: "المؤشر" },
      { key: "count", label: "العدد", format: "number", sortKey: "count" },
      { key: "note", label: "ملاحظة" },
    ],
    filters: [],
    totals: [{ key: "metrics", label: "عدد المؤشرات", format: "number" }],
  },
};

export const REPORT_LIST = Object.values(REPORTS);
