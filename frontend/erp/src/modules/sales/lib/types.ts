// Order-to-Cash DTOs — the shapes returned by /api/order-to-cash. Kept minimal +
// permissive (optional fields) since the backend envelope is the source of truth.
// Ported verbatim from the standalone O2C app (frontend/sales) — domain contract,
// no shared-kit equivalent.

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ListResponse<T> {
  success: boolean;
  data: T[];
  pagination?: Pagination;
  totals?: Record<string, number>;
  columns?: ReportColumn[];
  generatedAt?: string;
  asOf?: string;
}

export interface DataResponse<T> {
  success: boolean;
  data: T;
  generatedAt?: string;
}

export interface MutationResponse {
  success: boolean;
  data?: unknown;
  documentNumber?: string | null;
  status?: string | null;
  version?: number | null;
  journalId?: string | null;
  journalIds?: string[];
  affectedValue?: number;
  affectedStock?: unknown[];
  warnings?: string[];
  generatedAt?: string;
}

export interface Customer {
  id: string;
  name: string;
  nameEn?: string | null;
  phone?: string | null;
  vatNumber?: string | null;
  vatRegistered?: boolean;
  email?: string | null;
  address?: string | null;
  city?: string | null;
  street?: string | null;
  buildingNumber?: string | null;
  district?: string | null;
  additionalNo?: string | null;
  postalCode?: string | null;
  defaultRevenueAccountId?: string | null;
  defaultRevenueCostCenterId?: string | null;
  customerType: "B2C" | "B2B" | "B2G";
  creditLimit: number;
  balance: number;
  paymentTerms: string;
  creditDays: number;
  brandId?: string | null;
  isActive: boolean;
  mergedIntoId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  derived?: { invoiced: number; paid: number; arBalance: number };
}

export interface Invoice {
  id: string;
  document_number: string;
  document_type: "invoice" | "debit_note" | "credit_note";
  source_type: string;
  customer_id?: string | null;
  customer_name?: string | null;
  issue_date: string;
  due_date?: string | null;
  subtotal: number;
  vat_amount: number;
  total_amount: number;
  paid_amount: number;
  balance_amount: number;
  status: string;
  zatca_status: string;
  zatca_uuid?: string | null;
  zatca_qr_base64?: string | null;
  /** PNG data URL rendered server-side from the persisted TLV. */
  zatca_qr_data_url?: string | null;
  zatca_icv?: number | null;
  previous_invoice_hash?: string | null;
  /** Seller identity decoded from the TLV — frozen at stamp time. */
  seller?: ZatcaSellerSnapshot | null;
  gl_journal_id?: string | null;
  version: number;
  lines?: InvoiceLine[];
}

export interface InvoiceLine {
  id: string;
  description?: string | null;
  entered_qty: number;
  /** Already returned across non-cancelled/non-reversed returns. The server bounds
   *  new returns by entered_qty − this (OVER_RETURN); a return form must use the
   *  same number or it will offer a quantity the server refuses. */
  returned_qty?: number;
  base_qty: number;
  unit_price: number;
  discount_amount: number;
  vat_category: string;
  vat_rate: number | null;
  net_amount: number;
  vat_amount: number;
  gross_amount: number;
}

export interface Payment {
  id: string;
  payment_number: string;
  customer_id?: string | null;
  customer_name?: string | null;
  payment_date: string;
  payment_method: string;
  destination_type: "cash" | "bank";
  amount: number;
  allocated_amount: number;
  unapplied_amount: number;
  status: string;
  is_advance?: number;
  journal_id?: string | null;
  version: number;
  allocations?: Allocation[];
}

export interface Allocation {
  id: string;
  payment_id: string;
  ar_document_id: string;
  allocated_amount: number;
  reversed?: number;
}

export interface SalesOrder {
  id: string;
  order_number: string;
  customer_id?: string | null;
  customer_name?: string | null;
  order_date: string;
  total_amount: number;
  is_credit_sale?: number;
  status: string;
  invoice_id?: string | null;
  version: number;
  lines?: unknown[];
  timeline?: TimelineEvent[];
}

/** One inv_item the return puts back on the shelf. A POS line sells a menu item;
 *  these are the recipe components that actually left stock, snapshotted at
 *  checkout and scaled to the returned fraction. */
export interface SalesReturnLineComponent {
  id: string;
  return_line_id: string;
  component_seq: number;
  // 'semi' was a dead enum member: nothing ever wrote it — the modern path for
  // a semi-finished item is an ordinary recipe component (source 'recipe').
  source: "recipe" | "imported" | "combo";
  inv_item_id?: string | null;
  inv_item_name?: string | null;
  warehouse_id?: string | null;
  restored_base_qty: number;
  unit_code?: string | null;
  total_cost: number;
}

export interface SalesReturnLine {
  id: string;
  original_line_id?: string | null;
  item_id?: string | null;
  menu_id?: string | null;
  description?: string | null;
  sold_qty: number;
  previously_returned_qty: number;
  return_qty: number;
  vat_category: string;
  vat_rate?: number | null;
  net_amount: number;
  vat_amount: number;
  gross_amount: number;
  cost_snapshot: number;
  warehouse_id?: string | null;
  /** 1 = the goods physically come back. Per-line: a sealed drink is restockable,
   *  the identical-priced burger beside it is not. */
  restock: number;
  components?: SalesReturnLineComponent[];
}

/** The seller block decoded from the persisted TLV — the identity frozen at
 *  stamp time. ar_documents has no seller columns; re-reading live settings at
 *  print time would drift after a company rename. */
export interface ZatcaSellerSnapshot {
  sellerName?: string;
  vatNumber?: string;
  timestamp?: string;
  total?: string;
  vat?: string;
}

/** The Type-381 document a posted return produces. */
export interface SalesReturnCreditNote {
  id: string;
  document_number: string;
  issue_date: string;
  subtotal?: number;
  vat_amount?: number;
  total_amount: number;
  status: string;
  zatca_status: string;
  zatca_uuid?: string | null;
  zatca_qr_base64?: string | null;
  /** PNG data URL rendered server-side — clients never encode QRs. */
  zatca_qr_data_url?: string | null;
  previous_invoice_hash?: string | null;
  zatca_icv?: number | null;
  customer_name?: string | null;
  original_document_number?: string | null;
  seller?: ZatcaSellerSnapshot | null;
}

export interface SalesReturn {
  id: string;
  return_number: string;
  original_ar_document_id?: string | null;
  customer_id?: string | null;
  customer_name?: string | null;
  return_date: string;
  subtotal: number;
  vat_amount: number;
  total_amount: number;
  /** The document's proportional cost. NOT what reverses in the GL — only the
   *  restocked components do that. */
  cost_total: number;
  refund_method: string;
  status: string;
  credit_note_id?: string | null;
  version: number;
  lines?: SalesReturnLine[];
  creditNote?: SalesReturnCreditNote | null;
}

export interface TimelineEvent {
  id?: string;
  event_type: string;
  from_status?: string | null;
  to_status?: string | null;
  actor_username?: string | null;
  gl_journal_id?: string | null;
  created_at: string;
}

export interface ReportColumn {
  key: string;
  label: string;
}

export interface Customer360 {
  customer: Customer;
  balance: number;
  creditExposure: { creditLimit: number; exposure: number; available: number; utilizationPct: number | null; paymentTerms: string; creditDays: number; isActive: boolean };
  openInvoices: { count: number; balance: number };
  collections: { count: number; total: number };
  unappliedCredit: number;
  firstDeal?: string | null;
  lastDeal?: string | null;
  recentSales: Invoice[];
  returns: SalesReturn[];
  topProducts: { itemId?: string | null; menuId?: string | null; description?: string | null; qty: number; net: number }[];
  aging: { asOf: string; buckets: Record<string, number>; openCount: number; total: number };
  warnings: string[];
  generatedAt: string;
}

export interface Dashboard {
  today: { count: number; total: number };
  monthToDate: { total: number };
  openAr: { count: number; total: number };
  overdueAr: { count: number; total: number };
  unallocatedPayments: { count: number; total: number };
  topExposure: { customerId?: string | null; customerName?: string | null; balance: number }[];
}

export interface StatementLine {
  date: string;
  ref: string;
  kind: string;
  amount: number;
  balance: number;
}

export interface CustomerStatement {
  customerId: string;
  from: string;
  to: string;
  opening: number;
  closing: number;
  lines: StatementLine[];
}
