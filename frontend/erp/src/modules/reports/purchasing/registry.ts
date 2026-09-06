// The purchasing report registry — one declaration per REAL backend report.
//
// WHY THIS FILE EXISTS
//   The previous purchasing "reports" were twelve catalogue rows pointing at
//   `?report=X#anchor` on a single workspace page, whose table computed its
//   columns as `Array.from(new Set(rows.flatMap(Object.keys)))`. A derived
//   column cannot be labelled, ordered, formatted, aligned or translated, and
//   it changes shape the moment the data does: an empty result rendered NO
//   columns, and a null-only column silently disappeared from the sheet.
//
//   So every column is declared here: its server key, its i18n label key, how
//   it is formatted and which edge it aligns to. `PurchasingReportPage` renders
//   exactly this and nothing else, which is why one page can serve all nine.
//
// THE CONTRACT WITH routes/procurement/reports.js
//   Read that file before changing anything here. Three of its shapes are NOT
//   uniform and are declared per report rather than special-cased in the page:
//     · `ap-aging` answers with `grandTotal`, not `totals`, and filters on
//       `asOfDate` (a POSITION at a date) instead of a from/to period.
//     · `data-quality` answers with an OBJECT of named checks, not an array of
//       rows — `shape: "checks"` turns it into rows without guessing.
//     · `supplier-statement` REQUIRES `supplierId`; without one the endpoint
//       raises VALIDATION_ERROR, so the page must not call it at all.
//   `capsAny` mirrors that router's `requireAnyCapability` lists: the server is
//   the guard, this only decides whether a row is worth offering.
import type { ComponentType } from "react";
import {
  BadgeDollarSign,
  CalendarClock,
  FileCheck2,
  FileSearch,
  ReceiptText,
  ScanSearch,
  ShieldCheck,
  Ship,
  ShoppingCart,
  Truck,
  UserRoundSearch,
  Wallet,
} from "lucide-react";
import type { Capability } from "@/shared/permissions";
import type { ReportDirectoryTone } from "../components/ReportDirectory";

export const PURCHASING_REPORT_IDS = [
  "open-orders",
  "purchase-analysis",
  "receiving-variance",
  "three-way-match",
  "price-variance",
  "ap-aging",
  "supplier-statement",
  "supplier-performance",
  "landed-cost",
  "tax",
  "data-quality",
] as const;

export type PurchasingReportId = (typeof PURCHASING_REPORT_IDS)[number];

/** How a declared cell is rendered AND exported. Never inferred from the value. */
export type PurchasingColumnFormat =
  | "text"
  | "number"
  | "qty"
  | "money"
  | "signedMoney"
  | "date"
  | "period"
  | "status"
  | "statementType"
  | "checkName";

export interface PurchasingColumn {
  /** Field on the server row. */
  key: string;
  /** i18n key path — resolved with t(), never display text. */
  labelKey: string;
  format: PurchasingColumnFormat;
  /** Logical edge. Numeric columns align to `end` and print tabular + LTR. */
  align: "start" | "end";
  /** Fixed column width, logical units only. */
  width?: string;
}

/** Which controls the filter card renders, and therefore which params are sent. */
export type PurchasingFilterKey = "period" | "asOfDate" | "warehouse" | "supplier";

/**
 * A footer figure. `from` names where it lives in the RESPONSE ENVELOPE, which
 * is the only permitted source: a total recomputed in the browser from a capped
 * or paginated row set is a different number wearing the same label.
 */
export interface PurchasingTotalField {
  key: string;
  from: "totals" | "grandTotal" | "root";
  labelKey: string;
  format: PurchasingColumnFormat;
  /** Print the figure under this column in the paper <tfoot>. */
  column?: string;
}

export interface PurchasingReportDef {
  id: PurchasingReportId;
  labelKey: string;
  descriptionKey: string;
  icon: ComponentType<{ className?: string }>;
  tone: ReportDirectoryTone;
  /** ANY one of these passes the server guard. Mirrors REPORT_READ_CAPS. */
  capsAny: Capability[];
  /** `rows` = array payload; `checks` = named-metric object payload. */
  shape: "rows" | "checks";
  columns: PurchasingColumn[];
  filters: PurchasingFilterKey[];
  /** Server-provided footer figures. `null` = the endpoint returns none. */
  totals: PurchasingTotalField[] | null;
  /**
   * `server-csv` — the endpoint implements `?format=csv` and its file is the
   * authoritative one (the supplier statement's CSV carries the opening-balance
   * row that the JSON keeps in the envelope). `client-rows` — no server CSV
   * exists, so the sheet is built from the declared columns above.
   */
  exportMode: "client-rows" | "server-csv";
  /** Fields that identify a row, joined in order. Falls back to the index. */
  rowIdKeys: string[];
  /** Statement heading wording: a position at a date vs. a flow over a period. */
  heading: "asAt" | "period";
  /** The endpoint 422s without a supplier; the page shows a picker instead. */
  requiresSupplier?: boolean;
  defaultSort?: { columnKey: string; dir: "asc" | "desc" };
}

const C = "warehouseIntelligence.purchasingReports.columns";
const T = "warehouseIntelligence.purchasingReports.totals";
const READ_CAPS: Capability[] = ["finance.reports.view", "procurement.reports"];

export const PURCHASING_REPORTS: Record<PurchasingReportId, PurchasingReportDef> = {
  "open-orders": {
    id: "open-orders",
    labelKey: "warehouseIntelligence.reports.openOrders.label",
    descriptionKey: "warehouseIntelligence.reports.openOrders.description",
    icon: ShoppingCart,
    tone: "violet",
    capsAny: READ_CAPS,
    shape: "rows",
    columns: [
      { key: "po_number", labelKey: `${C}.poNumber`, format: "text", align: "start" },
      { key: "supplier_name", labelKey: `${C}.supplier`, format: "text", align: "start" },
      { key: "po_date", labelKey: `${C}.poDate`, format: "date", align: "start" },
      { key: "expected_date", labelKey: `${C}.expectedDate`, format: "date", align: "start" },
      { key: "status", labelKey: `${C}.status`, format: "status", align: "start" },
      { key: "total_after_vat", labelKey: `${C}.orderTotal`, format: "money", align: "end" },
      { key: "open_qty", labelKey: `${C}.openQty`, format: "qty", align: "end" },
      { key: "remaining_value", labelKey: `${C}.remainingValue`, format: "money", align: "end" },
    ],
    filters: ["period", "warehouse"],
    totals: [
      { key: "count", from: "totals", labelKey: `${T}.orderCount`, format: "number" },
      { key: "value", from: "totals", labelKey: `${T}.remainingValue`, format: "money", column: "remaining_value" },
    ],
    exportMode: "client-rows",
    rowIdKeys: ["id"],
    heading: "period",
    defaultSort: { columnKey: "expected_date", dir: "asc" },
  },

  "purchase-analysis": {
    id: "purchase-analysis",
    labelKey: "warehouseIntelligence.reports.purchaseAnalysis.label",
    descriptionKey: "warehouseIntelligence.reports.purchaseAnalysis.description",
    icon: UserRoundSearch,
    tone: "violet",
    capsAny: READ_CAPS,
    shape: "rows",
    columns: [
      { key: "supplier_name", labelKey: `${C}.supplier`, format: "text", align: "start" },
      { key: "invoices", labelKey: `${C}.invoices`, format: "number", align: "end" },
      { key: "spend", labelKey: `${C}.spend`, format: "money", align: "end" },
    ],
    filters: ["period", "warehouse"],
    totals: [{ key: "spend", from: "totals", labelKey: `${T}.spend`, format: "money", column: "spend" }],
    exportMode: "client-rows",
    rowIdKeys: ["supplier_id", "supplier_name"],
    heading: "period",
    defaultSort: { columnKey: "spend", dir: "desc" },
  },

  "receiving-variance": {
    id: "receiving-variance",
    labelKey: "warehouseIntelligence.reports.receivingVariance.label",
    descriptionKey: "warehouseIntelligence.reports.receivingVariance.description",
    icon: Truck,
    tone: "rose",
    capsAny: READ_CAPS,
    shape: "rows",
    columns: [
      { key: "po_number", labelKey: `${C}.poNumber`, format: "text", align: "start" },
      { key: "po_date", labelKey: `${C}.poDate`, format: "date", align: "start" },
      { key: "item_name", labelKey: `${C}.item`, format: "text", align: "start" },
      { key: "ordered", labelKey: `${C}.ordered`, format: "qty", align: "end" },
      { key: "received", labelKey: `${C}.received`, format: "qty", align: "end" },
      { key: "variance", labelKey: `${C}.qtyVariance`, format: "qty", align: "end" },
    ],
    filters: ["period", "warehouse"],
    totals: null,
    exportMode: "client-rows",
    rowIdKeys: ["po_line_id"],
    heading: "period",
  },

  "three-way-match": {
    id: "three-way-match",
    labelKey: "warehouseIntelligence.reports.threeWayMatch.label",
    descriptionKey: "warehouseIntelligence.reports.threeWayMatch.description",
    icon: FileCheck2,
    tone: "rose",
    capsAny: READ_CAPS,
    shape: "rows",
    columns: [
      { key: "code", labelKey: `${C}.documentCode`, format: "text", align: "start" },
      { key: "invoice_no", labelKey: `${C}.invoiceNo`, format: "text", align: "start" },
      { key: "supplier_name", labelKey: `${C}.supplier`, format: "text", align: "start" },
      { key: "issue_date", labelKey: `${C}.issueDate`, format: "date", align: "start" },
      { key: "matching_status", labelKey: `${C}.matchingStatus`, format: "status", align: "start" },
      { key: "qty_variance", labelKey: `${C}.qtyVariance`, format: "qty", align: "end" },
      { key: "price_variance", labelKey: `${C}.priceVariance`, format: "signedMoney", align: "end" },
    ],
    filters: ["period", "warehouse"],
    totals: null,
    exportMode: "client-rows",
    rowIdKeys: ["invoice_id"],
    heading: "period",
  },

  "price-variance": {
    id: "price-variance",
    labelKey: "warehouseIntelligence.reports.priceVariance.label",
    descriptionKey: "warehouseIntelligence.reports.priceVariance.description",
    icon: BadgeDollarSign,
    tone: "lime",
    capsAny: READ_CAPS,
    shape: "rows",
    columns: [
      { key: "code", labelKey: `${C}.documentCode`, format: "text", align: "start" },
      { key: "invoice_no", labelKey: `${C}.invoiceNo`, format: "text", align: "start" },
      { key: "supplier_name", labelKey: `${C}.supplier`, format: "text", align: "start" },
      { key: "issue_date", labelKey: `${C}.issueDate`, format: "date", align: "start" },
      { key: "matched_qty", labelKey: `${C}.matchedQty`, format: "qty", align: "end" },
      { key: "matched_amount", labelKey: `${C}.matchedAmount`, format: "money", align: "end" },
      { key: "price_variance", labelKey: `${C}.priceVariance`, format: "signedMoney", align: "end" },
    ],
    filters: ["period", "warehouse"],
    totals: null,
    exportMode: "client-rows",
    rowIdKeys: ["match_id"],
    heading: "period",
  },

  "ap-aging": {
    id: "ap-aging",
    labelKey: "warehouseIntelligence.reports.apAging.label",
    descriptionKey: "warehouseIntelligence.reports.apAging.description",
    icon: CalendarClock,
    tone: "amber",
    capsAny: READ_CAPS,
    shape: "rows",
    columns: [
      { key: "supplierName", labelKey: `${C}.supplier`, format: "text", align: "start" },
      { key: "current", labelKey: `${C}.bucketCurrent`, format: "money", align: "end" },
      { key: "d30", labelKey: `${C}.bucket30`, format: "money", align: "end" },
      { key: "d60", labelKey: `${C}.bucket60`, format: "money", align: "end" },
      { key: "d90", labelKey: `${C}.bucket90`, format: "money", align: "end" },
      { key: "d90plus", labelKey: `${C}.bucket90plus`, format: "money", align: "end" },
      { key: "total", labelKey: `${C}.balance`, format: "money", align: "end" },
    ],
    // A POSITION, not a flow: the endpoint reads `asOfDate` and deliberately
    // keeps invoices settled after that date, so a from/to period is meaningless.
    filters: ["asOfDate", "warehouse"],
    totals: [
      { key: "current", from: "grandTotal", labelKey: `${C}.bucketCurrent`, format: "money", column: "current" },
      { key: "d30", from: "grandTotal", labelKey: `${C}.bucket30`, format: "money", column: "d30" },
      { key: "d60", from: "grandTotal", labelKey: `${C}.bucket60`, format: "money", column: "d60" },
      { key: "d90", from: "grandTotal", labelKey: `${C}.bucket90`, format: "money", column: "d90" },
      { key: "d90plus", from: "grandTotal", labelKey: `${C}.bucket90plus`, format: "money", column: "d90plus" },
      { key: "total", from: "grandTotal", labelKey: `${T}.payable`, format: "money", column: "total" },
    ],
    exportMode: "server-csv",
    rowIdKeys: ["supplierId", "supplierName"],
    heading: "asAt",
    defaultSort: { columnKey: "total", dir: "desc" },
  },

  "supplier-statement": {
    id: "supplier-statement",
    labelKey: "warehouseIntelligence.reports.supplierStatement.label",
    descriptionKey: "warehouseIntelligence.reports.supplierStatement.description",
    icon: FileSearch,
    tone: "amber",
    capsAny: READ_CAPS,
    shape: "rows",
    columns: [
      { key: "date", labelKey: `${C}.date`, format: "date", align: "start" },
      { key: "type", labelKey: `${C}.entryType`, format: "statementType", align: "start" },
      { key: "ref", labelKey: `${C}.reference`, format: "text", align: "start" },
      { key: "debit", labelKey: `${C}.debit`, format: "money", align: "end" },
      { key: "credit", labelKey: `${C}.credit`, format: "money", align: "end" },
      { key: "balance", labelKey: `${C}.runningBalance`, format: "signedMoney", align: "end" },
    ],
    filters: ["supplier", "period", "warehouse"],
    totals: [
      { key: "opening", from: "root", labelKey: `${T}.opening`, format: "signedMoney" },
      { key: "debit", from: "totals", labelKey: `${C}.debit`, format: "money", column: "debit" },
      { key: "credit", from: "totals", labelKey: `${C}.credit`, format: "money", column: "credit" },
      { key: "closingBalance", from: "root", labelKey: `${T}.closing`, format: "signedMoney", column: "balance" },
    ],
    exportMode: "server-csv",
    rowIdKeys: ["type", "id"],
    heading: "period",
    requiresSupplier: true,
  },

  tax: {
    id: "tax",
    labelKey: "warehouseIntelligence.reports.inputTax.label",
    descriptionKey: "warehouseIntelligence.reports.inputTax.description",
    icon: ReceiptText,
    tone: "blue",
    capsAny: READ_CAPS,
    shape: "rows",
    columns: [
      { key: "period", labelKey: `${C}.taxPeriod`, format: "period", align: "start" },
      { key: "net", labelKey: `${C}.netPurchases`, format: "money", align: "end" },
      { key: "inputVat", labelKey: `${C}.inputVat`, format: "money", align: "end" },
    ],
    filters: ["period", "warehouse"],
    totals: null,
    exportMode: "client-rows",
    rowIdKeys: ["period"],
    heading: "period",
  },

  // ─── OTIF ────────────────────────────────────────────────────────────────
  // Previously declared unbuildable "because the source data does not exist".
  // `purchase_orders.expected_date` and `po_lines.received_qty` were there all
  // along — which is On-Time and In-Full. A supplier QUALITY rate genuinely
  // has no columns and is reported as unavailable rather than approximated.
  "supplier-performance": {
    id: "supplier-performance",
    labelKey: "warehouseIntelligence.reports.supplierPerformance.label",
    descriptionKey: "warehouseIntelligence.reports.supplierPerformance.description",
    icon: Truck,
    tone: "violet",
    capsAny: READ_CAPS,
    shape: "rows",
    columns: [
      { key: "supplier_name", labelKey: `${C}.supplier`, format: "text", align: "start" },
      { key: "orders", labelKey: `${C}.orders`, format: "number", align: "end" },
      { key: "lines_total", labelKey: `${C}.lines`, format: "number", align: "end" },
      { key: "on_time_pct", labelKey: `${C}.onTimePct`, format: "number", align: "end" },
      { key: "in_full_pct", labelKey: `${C}.inFullPct`, format: "number", align: "end" },
      { key: "otif_pct", labelKey: `${C}.otifPct`, format: "number", align: "end" },
      { key: "avg_delay_days", labelKey: `${C}.avgDelayDays`, format: "number", align: "end" },
      { key: "lines_without_promise", labelKey: `${C}.linesNoPromise`, format: "number", align: "end" },
    ],
    filters: ["period", "warehouse"],
    totals: [
      { key: "lines_total", from: "totals", labelKey: `${C}.lines`, format: "number", column: "lines_total" },
      { key: "on_time_pct", from: "totals", labelKey: `${C}.onTimePct`, format: "number", column: "on_time_pct" },
      { key: "in_full_pct", from: "totals", labelKey: `${C}.inFullPct`, format: "number", column: "in_full_pct" },
      { key: "otif_pct", from: "totals", labelKey: `${C}.otifPct`, format: "number", column: "otif_pct" },
    ],
    exportMode: "client-rows",
    rowIdKeys: ["supplier_id", "supplier_name"],
    heading: "period",
    defaultSort: { columnKey: "otif_pct", dir: "asc" },
  },

  // ─── Landed cost ─────────────────────────────────────────────────────────
  // One row per POSTED receipt in the period: goods net, each charge type,
  // the uplift and the accrued/invoiced split. `uplift_pct` is null when the
  // goods value is zero — the server never fabricates a percentage of nothing
  // — and the declared "number" format prints null as "—", never as 0.
  // The endpoint implements ?format=csv (routes/procurement/reports.js) and
  // its file is the authoritative sheet, exactly like ap-aging's.
  "landed-cost": {
    id: "landed-cost",
    labelKey: "warehouseIntelligence.reports.landedCost.label",
    descriptionKey: "warehouseIntelligence.reports.landedCost.description",
    icon: Ship,
    tone: "lime",
    capsAny: READ_CAPS,
    shape: "rows",
    columns: [
      { key: "receipt_number", labelKey: `${C}.receiptNumber`, format: "text", align: "start" },
      { key: "receipt_date", labelKey: `${C}.receiptDate`, format: "date", align: "start" },
      { key: "supplier_name", labelKey: `${C}.supplier`, format: "text", align: "start" },
      { key: "warehouse_name", labelKey: `${C}.warehouse`, format: "text", align: "start" },
      { key: "lines", labelKey: `${C}.receiptLines`, format: "number", align: "end" },
      { key: "goods_value", labelKey: `${C}.goodsValue`, format: "money", align: "end" },
      { key: "freight", labelKey: `${C}.freight`, format: "money", align: "end" },
      { key: "customs", labelKey: `${C}.customs`, format: "money", align: "end" },
      { key: "insurance", labelKey: `${C}.insurance`, format: "money", align: "end" },
      { key: "handling", labelKey: `${C}.handling`, format: "money", align: "end" },
      { key: "other", labelKey: `${C}.otherCharges`, format: "money", align: "end" },
      { key: "charges_total", labelKey: `${C}.chargesTotal`, format: "money", align: "end" },
      { key: "landed_total", labelKey: `${C}.landedTotal`, format: "money", align: "end" },
      { key: "uplift_pct", labelKey: `${C}.upliftPct`, format: "number", align: "end" },
      { key: "charges_accrued", labelKey: `${C}.chargesAccrued`, format: "money", align: "end" },
      { key: "charges_invoiced", labelKey: `${C}.chargesInvoiced`, format: "money", align: "end" },
    ],
    // `supplier` here is OPTIONAL (no requiresSupplier): the page sends
    // supplierId only when one is picked, and the endpoint narrows on it.
    filters: ["supplier", "period", "warehouse"],
    totals: [
      { key: "receipts", from: "totals", labelKey: `${T}.receipts`, format: "number" },
      { key: "goods_value", from: "totals", labelKey: `${T}.goodsValue`, format: "money", column: "goods_value" },
      { key: "charges_total", from: "totals", labelKey: `${T}.chargesTotal`, format: "money", column: "charges_total" },
      { key: "landed_total", from: "totals", labelKey: `${T}.landedTotal`, format: "money", column: "landed_total" },
      { key: "uplift_pct", from: "totals", labelKey: `${T}.upliftPct`, format: "number", column: "uplift_pct" },
      { key: "charges_accrued", from: "totals", labelKey: `${T}.chargesAccrued`, format: "money", column: "charges_accrued" },
      { key: "charges_invoiced", from: "totals", labelKey: `${T}.chargesInvoiced`, format: "money", column: "charges_invoiced" },
    ],
    exportMode: "server-csv",
    rowIdKeys: ["receipt_id"],
    heading: "period",
    defaultSort: { columnKey: "receipt_date", dir: "desc" },
  },

  "data-quality": {
    id: "data-quality",
    labelKey: "warehouseIntelligence.reports.purchaseDataQuality.label",
    descriptionKey: "warehouseIntelligence.reports.purchaseDataQuality.description",
    icon: ScanSearch,
    tone: "teal",
    // Exactly mirrors DATA_QUALITY_READ_CAPS in the backend. This does not
    // widen access: either capability already passes the server guard.
    capsAny: ["finance.reports.view", "procurement.data_quality"],
    shape: "checks",
    columns: [
      { key: "check", labelKey: `${C}.check`, format: "checkName", align: "start" },
      { key: "count", labelKey: `${C}.exceptions`, format: "number", align: "end" },
    ],
    filters: ["period", "warehouse"],
    totals: null,
    exportMode: "client-rows",
    rowIdKeys: ["check"],
    heading: "period",
  },
};

export interface PurchasingReportGroup {
  id: string;
  titleKey: string;
  icon: ComponentType<{ className?: string }>;
  reports: PurchasingReportId[];
}

const G = "warehouseIntelligence.purchasingReports.groups";

export const PURCHASING_REPORT_GROUPS: PurchasingReportGroup[] = [
  { id: "orders", titleKey: `${G}.orders`, icon: ShoppingCart, reports: ["open-orders", "purchase-analysis"] },
  { id: "receiving", titleKey: `${G}.receiving`, icon: FileCheck2, reports: ["receiving-variance", "three-way-match", "price-variance", "landed-cost"] },
  { id: "payables", titleKey: `${G}.payables`, icon: Wallet, reports: ["ap-aging", "supplier-statement", "supplier-performance"] },
  { id: "tax", titleKey: `${G}.tax`, icon: ReceiptText, reports: ["tax"] },
  { id: "dataQuality", titleKey: `${G}.dataQuality`, icon: ShieldCheck, reports: ["data-quality"] },
];

/** The route a purchasing report row opens. One report, one page, no anchor. */
export function purchasingReportPath(id: PurchasingReportId): string {
  return `/reports/purchasing/${id}`;
}

export function getPurchasingReport(id: string | undefined): PurchasingReportDef | undefined {
  return id && id in PURCHASING_REPORTS ? PURCHASING_REPORTS[id as PurchasingReportId] : undefined;
}
