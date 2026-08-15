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

  "data-quality": {
    id: "data-quality",
    labelKey: "warehouseIntelligence.reports.purchaseDataQuality.label",
    descriptionKey: "warehouseIntelligence.reports.purchaseDataQuality.description",
    icon: ScanSearch,
    tone: "teal",
    // The endpoint accepts 'finance.reports.view' OR 'procurement.data_quality'.
    // Only the first exists in the client capability catalog, so that is what is
    // declared: hiding the row from a data-quality-only user is conservative,
    // and widening a guard to match is expressly not this module's business.
    capsAny: ["finance.reports.view"],
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
  { id: "receiving", titleKey: `${G}.receiving`, icon: FileCheck2, reports: ["receiving-variance", "three-way-match", "price-variance"] },
  { id: "payables", titleKey: `${G}.payables`, icon: Wallet, reports: ["ap-aging", "supplier-statement"] },
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
