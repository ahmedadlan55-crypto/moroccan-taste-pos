// The receivables & collections report catalogue — ONE declarative table that
// the directory, the generic page and the CSV export all read.
//
// WHY THE COLUMN LABELS LIVE HERE AND NOT ON THE SERVER
//   `GET /api/order-to-cash/reports/:type` returns a `columns[]` whose `label`
//   is a hard-coded Arabic string ('المؤشر', 'العميل', 'الصافي' — see
//   services/order-to-cash/O2CReportingService.js). Rendering those would print
//   Arabic headers on an English screen, so the SCREEN owns its labels as i18n
//   keys and the server's `columns` are treated as what they actually are: the
//   CSV contract, consumed only by `/reports/:type/export`, which builds the
//   file from that same array server-side. Nothing here restates the CSV header.
//
// A ROW VALUE CAN ALSO BE ARABIC
//   Two reports return their row LABELS from the server as Arabic literals —
//   sales-summary's `metric` and data-quality's `issue` — because the row set is
//   the report's own vocabulary rather than customer data. Those literals are
//   business DATA keyed by the server, so they are mapped to i18n keys through
//   the vocabularies below (same precedent as the inventory report's StatusPill,
//   which classifies server-produced Arabic status text without rendering it).
//   An unmapped literal falls through to the raw server text: a new server row
//   shows up untranslated rather than disappearing.
//
// EVERY DESTINATION IS UNDER /reports/receivables/<id>. There is no link out of
// the reports section and no same-page anchor.
import type { ComponentType } from "react";
import {
  BarChart3,
  Boxes,
  CalendarClock,
  ClipboardCheck,
  GitCompareArrows,
  PackageSearch,
  ReceiptText,
  RotateCcw,
  Scale,
  ShieldCheck,
  Store,
  UserRoundSearch,
  WalletCards,
} from "lucide-react";
import type { Capability } from "@/shared/permissions";
import type { ReportDirectoryTone } from "../components/ReportDirectory";

export type ReceivablesReportId =
  | "sales-summary"
  | "sales-by-customer"
  | "sales-by-product"
  | "sales-by-channel"
  | "sales-by-cashier"
  | "ar-aging"
  | "open-invoices"
  | "collections"
  | "unallocated-payments"
  | "credit-exposure"
  | "returns"
  | "zatca-status"
  | "data-quality";

export type ReceivablesGroupId =
  | "salesAnalysis"
  | "receivables"
  | "returns"
  | "taxCompliance"
  | "dataQuality";

/**
 * Which date controls the report actually honours.
 *   period → `from`/`to`   asOf → `asOf`   none → a current-state snapshot
 * Sending a filter the query ignores would put a control on screen that changes
 * nothing, so the page renders exactly the controls named here.
 */
export type ReceivablesFilterKind = "period" | "asOf" | "none";

/** How a cell is rendered. `money` is the house `<Num>` cell. */
export type ReceivablesCellFormat = "text" | "money" | "qty" | "count" | "date";

/** A server-produced value set that has a frontend translation table. */
export type ReceivablesVocabulary = "metric" | "issue" | "zatcaStatus" | "refundMethod";

export interface ReceivablesColumn {
  /** Key on the server's row object. */
  key: string;
  /** i18n path under `receivablesReports.columns`. */
  labelKey: string;
  format: ReceivablesCellFormat;
  /**
   * Server `totals` key that fills this column's <tfoot> cell. The footer is
   * ALWAYS the server's number — nothing on this screen sums rows.
   */
  totalsKey?: string;
  /** Translate the cell's own value through a vocabulary below. */
  vocabulary?: ReceivablesVocabulary;
  /**
   * Take this cell's FORMAT from the vocabulary term resolved for another
   * column of the same row. Used once: sales-summary is a metric/value pair in
   * which one row is an invoice COUNT and the rest are money.
   */
  formatFrom?: string;
}

export interface ReceivablesReportDef {
  id: ReceivablesReportId;
  /** camelCase segment under `receivablesReports.reports`. */
  i18nKey: string;
  group: ReceivablesGroupId;
  icon: ComponentType<{ className?: string }>;
  filter: ReceivablesFilterKind;
  /** Capability ON TOP of `ar_reports.view`. Existing caps only — none added. */
  cap?: Capability;
  /** First column is the statement's label column; the rest are its measures. */
  columns: ReceivablesColumn[];
}

export interface ReceivablesGroupDef {
  id: ReceivablesGroupId;
  icon: ComponentType<{ className?: string }>;
  tone: ReportDirectoryTone;
  reports: ReceivablesReportId[];
}

/** Gates the whole section; `data-quality` and the export add one each. */
export const RECEIVABLES_VIEW_CAP: Capability = "ar_reports.view";
export const RECEIVABLES_EXPORT_CAP: Capability = "o2c.export";

/** Every destination in this section. Never leaves /reports. */
export function receivablesReportPath(id: ReceivablesReportId): string {
  return `/reports/receivables/${id}`;
}

export const RECEIVABLES_ROOT = "/reports/receivables";

// ── vocabularies ────────────────────────────────────────────────────────────
// Key = the exact literal the server emits. Value = the i18n leaf under
// `receivablesReports.values.<vocabulary>` plus, where the row is not money,
// the format its measure column must use.

export interface ReceivablesTerm {
  key: string;
  format?: ReceivablesCellFormat;
}

const METRIC_TERMS: Record<string, ReceivablesTerm> = {
  "عدد الفواتير": { key: "invoiceCount", format: "count" },
  "صافي المبيعات": { key: "netSales" },
  "الضريبة": { key: "vat" },
  "الإجمالي": { key: "total" },
  "المرتجعات": { key: "returns" },
  "صافي المبيعات بعد المرتجعات": { key: "netAfterReturns" },
  "المُحصّل": { key: "collected" },
  "المتبقّي (ذمم)": { key: "outstanding" },
};

const ISSUE_TERMS: Record<string, ReceivablesTerm> = {
  "عملاء B2B/B2G بدون رقم ضريبي": { key: "b2bWithoutVat" },
  "فواتير مفتوحة بلا تاريخ استحقاق": { key: "openWithoutDueDate" },
  "فواتير برصيد سالب": { key: "negativeBalance" },
  "دفعات مُرحّلة غير مخصّصة": { key: "unallocatedPostedPayments" },
  "فواتير بانتظار زاتكا": { key: "pendingZatca" },
};

/** ar_documents.zatca_status ENUM (db/migrations/order-to-cash/schema.js). */
const ZATCA_TERMS: Record<string, ReceivablesTerm> = {
  pending: { key: "pending" },
  submitted: { key: "submitted" },
  accepted: { key: "accepted" },
  rejected: { key: "rejected" },
  not_required: { key: "notRequired" },
};

/** sales_returns.refund_method ENUM. */
const REFUND_TERMS: Record<string, ReceivablesTerm> = {
  cash: { key: "cash" },
  bank: { key: "bank" },
  ar_reduction: { key: "arReduction" },
  customer_deposit: { key: "customerDeposit" },
};

const VOCABULARIES: Record<ReceivablesVocabulary, Record<string, ReceivablesTerm>> = {
  metric: METRIC_TERMS,
  issue: ISSUE_TERMS,
  zatcaStatus: ZATCA_TERMS,
  refundMethod: REFUND_TERMS,
};

/** The term for a raw server value, or null when the server said something new. */
export function receivablesTerm(
  vocabulary: ReceivablesVocabulary,
  value: unknown,
): ReceivablesTerm | null {
  if (typeof value !== "string") return null;
  return VOCABULARIES[vocabulary][value] ?? null;
}

// ── the thirteen ────────────────────────────────────────────────────────────

export const RECEIVABLES_REPORTS: ReceivablesReportDef[] = [
  {
    id: "sales-summary",
    i18nKey: "salesSummary",
    group: "salesAnalysis",
    icon: BarChart3,
    filter: "period",
    // No <tfoot>: this report's rows ARE the totals, and a footer under them
    // would restate one of its own lines as if it summed the others.
    columns: [
      { key: "metric", labelKey: "metric", format: "text", vocabulary: "metric" },
      { key: "value", labelKey: "value", format: "money", formatFrom: "metric" },
    ],
  },
  {
    id: "sales-by-customer",
    i18nKey: "salesByCustomer",
    group: "salesAnalysis",
    icon: UserRoundSearch,
    filter: "period",
    columns: [
      { key: "customer_name", labelKey: "customer", format: "text" },
      { key: "invoices", labelKey: "invoices", format: "count" },
      { key: "net", labelKey: "net", format: "money", totalsKey: "net" },
      { key: "vat", labelKey: "vat", format: "money" },
      { key: "total", labelKey: "total", format: "money", totalsKey: "total" },
    ],
  },
  {
    id: "sales-by-product",
    i18nKey: "salesByProduct",
    group: "salesAnalysis",
    icon: PackageSearch,
    filter: "period",
    columns: [
      { key: "description", labelKey: "item", format: "text" },
      { key: "qty", labelKey: "qty", format: "qty" },
      { key: "net", labelKey: "net", format: "money", totalsKey: "net" },
      { key: "vat", labelKey: "vat", format: "money" },
    ],
  },
  {
    id: "sales-by-channel",
    i18nKey: "salesByChannel",
    group: "salesAnalysis",
    icon: Boxes,
    filter: "period",
    columns: [
      { key: "channel_id", labelKey: "channel", format: "text" },
      { key: "invoices", labelKey: "invoices", format: "count" },
      { key: "net", labelKey: "net", format: "money" },
      { key: "total", labelKey: "total", format: "money", totalsKey: "total" },
    ],
  },
  {
    id: "sales-by-cashier",
    i18nKey: "salesByCashier",
    group: "salesAnalysis",
    icon: Store,
    filter: "period",
    columns: [
      { key: "cashier", labelKey: "cashier", format: "text" },
      { key: "invoices", labelKey: "invoices", format: "count" },
      { key: "total", labelKey: "total", format: "money", totalsKey: "total" },
    ],
  },
  {
    id: "ar-aging",
    i18nKey: "arAging",
    group: "receivables",
    icon: CalendarClock,
    filter: "asOf",
    columns: [
      { key: "customer_name", labelKey: "customer", format: "text" },
      { key: "current", labelKey: "bucketCurrent", format: "money", totalsKey: "current" },
      { key: "d1_30", labelKey: "bucket1_30", format: "money", totalsKey: "d1_30" },
      { key: "d31_60", labelKey: "bucket31_60", format: "money", totalsKey: "d31_60" },
      { key: "d61_90", labelKey: "bucket61_90", format: "money", totalsKey: "d61_90" },
      { key: "d91_120", labelKey: "bucket91_120", format: "money", totalsKey: "d91_120" },
      { key: "d120_plus", labelKey: "bucket120Plus", format: "money", totalsKey: "d120_plus" },
      { key: "total", labelKey: "total", format: "money", totalsKey: "total" },
    ],
  },
  {
    id: "open-invoices",
    i18nKey: "openInvoices",
    group: "receivables",
    icon: ReceiptText,
    filter: "none",
    columns: [
      { key: "document_number", labelKey: "invoice", format: "text" },
      { key: "customer_name", labelKey: "customer", format: "text" },
      { key: "issue_date", labelKey: "issueDate", format: "date" },
      { key: "due_date", labelKey: "dueDate", format: "date" },
      { key: "total_amount", labelKey: "total", format: "money" },
      { key: "paid_amount", labelKey: "paid", format: "money" },
      { key: "balance_amount", labelKey: "balance", format: "money", totalsKey: "balance" },
    ],
  },
  {
    id: "collections",
    i18nKey: "collections",
    group: "receivables",
    icon: WalletCards,
    filter: "period",
    columns: [
      { key: "payment_number", labelKey: "voucher", format: "text" },
      { key: "customer_name", labelKey: "customer", format: "text" },
      { key: "payment_date", labelKey: "date", format: "date" },
      { key: "amount", labelKey: "amount", format: "money", totalsKey: "total" },
      { key: "allocated_amount", labelKey: "allocated", format: "money" },
      { key: "unapplied_amount", labelKey: "unallocated", format: "money" },
    ],
  },
  {
    id: "unallocated-payments",
    i18nKey: "unallocatedPayments",
    group: "receivables",
    icon: GitCompareArrows,
    filter: "none",
    columns: [
      { key: "payment_number", labelKey: "voucher", format: "text" },
      { key: "customer_name", labelKey: "customer", format: "text" },
      { key: "payment_date", labelKey: "date", format: "date" },
      { key: "unapplied_amount", labelKey: "unallocated", format: "money", totalsKey: "total" },
    ],
  },
  {
    id: "credit-exposure",
    i18nKey: "creditExposure",
    group: "receivables",
    icon: Scale,
    filter: "none",
    columns: [
      { key: "name", labelKey: "customer", format: "text" },
      { key: "credit_limit", labelKey: "creditLimit", format: "money" },
      { key: "exposure", labelKey: "exposure", format: "money", totalsKey: "exposure" },
      { key: "available", labelKey: "available", format: "money" },
    ],
  },
  {
    id: "returns",
    i18nKey: "returns",
    group: "returns",
    icon: RotateCcw,
    filter: "period",
    columns: [
      { key: "return_number", labelKey: "returnNumber", format: "text" },
      { key: "customer_name", labelKey: "customer", format: "text" },
      { key: "return_date", labelKey: "date", format: "date" },
      { key: "subtotal", labelKey: "net", format: "money" },
      { key: "vat_amount", labelKey: "vat", format: "money" },
      { key: "total_amount", labelKey: "total", format: "money", totalsKey: "total" },
      { key: "refund_method", labelKey: "refundMethod", format: "text", vocabulary: "refundMethod" },
    ],
  },
  {
    id: "zatca-status",
    i18nKey: "zatcaStatus",
    group: "taxCompliance",
    icon: ShieldCheck,
    filter: "none",
    columns: [
      { key: "zatca_status", labelKey: "zatcaStatus", format: "text", vocabulary: "zatcaStatus" },
      { key: "n", labelKey: "documents", format: "count", totalsKey: "count" },
      { key: "total", labelKey: "total", format: "money" },
    ],
  },
  {
    id: "data-quality",
    i18nKey: "dataQuality",
    group: "dataQuality",
    icon: ClipboardCheck,
    filter: "none",
    cap: "o2c.data_quality",
    columns: [
      { key: "issue", labelKey: "issue", format: "text", vocabulary: "issue" },
      { key: "count", labelKey: "count", format: "count", totalsKey: "totalIssues" },
    ],
  },
];

export const RECEIVABLES_GROUPS: ReceivablesGroupDef[] = [
  {
    id: "salesAnalysis",
    icon: BarChart3,
    tone: "teal",
    reports: ["sales-summary", "sales-by-customer", "sales-by-product", "sales-by-channel", "sales-by-cashier"],
  },
  {
    id: "receivables",
    icon: WalletCards,
    tone: "blue",
    reports: ["ar-aging", "open-invoices", "collections", "unallocated-payments", "credit-exposure"],
  },
  { id: "returns", icon: RotateCcw, tone: "rose", reports: ["returns"] },
  { id: "taxCompliance", icon: ShieldCheck, tone: "violet", reports: ["zatca-status"] },
  { id: "dataQuality", icon: ClipboardCheck, tone: "amber", reports: ["data-quality"] },
];

export const RECEIVABLES_REPORT_BY_ID: Record<string, ReceivablesReportDef | undefined> =
  Object.fromEntries(RECEIVABLES_REPORTS.map((r) => [r.id, r]));
