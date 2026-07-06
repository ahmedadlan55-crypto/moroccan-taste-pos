// Procurement DTOs + adapters — the ONLY place snake_case from /api/procurement
// is mapped to camelCase for the UI. All numbers/strings are coerced with safe
// fallbacks so a partial backend row never crashes the UI.

function num(v: unknown, d = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function str(v: unknown, d = ""): string {
  return v == null ? d : String(v);
}

export interface Paginated<T> {
  rows: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  totals?: Record<string, number>;
}

export interface Supplier {
  id: string;
  name: string;
  nameEn: string;
  vatNumber: string;
  phone: string;
  email: string;
  city: string;
  paymentTerms: string;
  isActive: boolean;
  apBalance: number;
}
export function toSupplier(r: Record<string, unknown>): Supplier {
  return {
    id: str(r.id),
    name: str(r.name),
    nameEn: str(r.name_en),
    vatNumber: str(r.vat_number),
    phone: str(r.phone),
    email: str(r.email),
    city: str(r.city),
    paymentTerms: str(r.payment_terms, "Cash"),
    isActive: !!Number(r.is_active),
    apBalance: num(r.ap_balance),
  };
}

export type DocStatus = string;

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  supplierId: string;
  supplierName: string;
  poDate: string;
  expectedDate: string;
  status: DocStatus;
  version: number;
  total: number;
  currency: string;
}
export function toOrder(r: Record<string, unknown>): PurchaseOrder {
  return {
    id: str(r.id),
    poNumber: str(r.po_number),
    supplierId: str(r.supplier_id),
    supplierName: str(r.supplier_name),
    poDate: str(r.po_date),
    expectedDate: str(r.expected_date),
    status: str(r.status),
    version: num(r.version, 1),
    total: num(r.total_after_vat),
    currency: str(r.currency, "SAR"),
  };
}

export interface Receipt {
  id: string;
  receiptNumber: string;
  poId: string;
  supplierId: string;
  supplierName: string;
  receiptDate: string;
  warehouseId: string;
  status: DocStatus;
  version: number;
  total: number;
  glJournalId: string;
}
export function toReceipt(r: Record<string, unknown>): Receipt {
  return {
    id: str(r.id),
    receiptNumber: str(r.receipt_number),
    poId: str(r.po_id),
    supplierId: str(r.supplier_id),
    supplierName: str(r.supplier_name_snapshot),
    receiptDate: str(r.receipt_date),
    warehouseId: str(r.warehouse_id),
    status: str(r.status),
    version: num(r.version, 1),
    total: num(r.total),
    glJournalId: str(r.gl_journal_id),
  };
}

export interface SupplierInvoice {
  id: string;
  code: string;
  invoiceNo: string;
  supplierId: string;
  supplierName: string;
  issueDate: string;
  dueDate: string;
  total: number;
  paid: number;
  balance: number;
  matchingStatus: string;
  status: DocStatus;
  version: number;
}
export function toInvoice(r: Record<string, unknown>): SupplierInvoice {
  return {
    id: str(r.id),
    code: str(r.code),
    invoiceNo: str(r.invoice_no),
    supplierId: str(r.supplier_id),
    supplierName: str(r.supplier_name),
    issueDate: str(r.issue_date),
    dueDate: str(r.due_date),
    total: num(r.total_amount),
    paid: num(r.paid_amount),
    balance: num(r.balance_amount),
    matchingStatus: str(r.matching_status, "unmatched"),
    status: str(r.status),
    version: num(r.version, 1),
  };
}

export interface Payment {
  id: string;
  paymentNumber: string;
  supplierId: string;
  amount: number;
  allocated: number;
  method: string;
  status: DocStatus;
  version: number;
  glJournalId: string;
}
export function toPayment(r: Record<string, unknown>): Payment {
  return {
    id: str(r.id),
    paymentNumber: str(r.payment_number),
    supplierId: str(r.supplier_id),
    amount: num(r.amount),
    allocated: num(r.allocated_amount),
    method: str(r.payment_method, "bank"),
    status: str(r.status),
    version: num(r.version, 1),
    glJournalId: str(r.gl_journal_id),
  };
}

export interface PurchaseReturn {
  id: string;
  returnNumber: string;
  supplierId: string;
  phase: string;
  status: DocStatus;
  version: number;
  total: number;
}
export function toReturn(r: Record<string, unknown>): PurchaseReturn {
  return {
    id: str(r.id),
    returnNumber: str(r.return_number),
    supplierId: str(r.supplier_id),
    phase: str(r.phase),
    status: str(r.status),
    version: num(r.version, 1),
    total: num(r.total),
  };
}

export interface ProcurementDashboard {
  purchaseValue: number;
  ordersPendingApproval: number;
  ordersOverdue: number;
  partialReceipts: number;
  unmatchedInvoices: number;
  apDue: number;
  apOverdue: number;
  variances: number;
  recentActivity: Array<{ documentType: string; documentId: string; action: string; actor: string; toStatus: string; createdAt: string }>;
}
export function toDashboard(r: Record<string, unknown>): ProcurementDashboard {
  const acts = Array.isArray(r.recentActivity) ? (r.recentActivity as Record<string, unknown>[]) : [];
  return {
    purchaseValue: num(r.purchaseValue),
    ordersPendingApproval: num(r.ordersPendingApproval),
    ordersOverdue: num(r.ordersOverdue),
    partialReceipts: num(r.partialReceipts),
    unmatchedInvoices: num(r.unmatchedInvoices),
    apDue: num(r.apDue),
    apOverdue: num(r.apOverdue),
    variances: num(r.variances),
    recentActivity: acts.map((a) => ({
      documentType: str(a.document_type),
      documentId: str(a.document_id),
      action: str(a.action),
      actor: str(a.actor),
      toStatus: str(a.to_status),
      createdAt: str(a.created_at),
    })),
  };
}

export function toPaginated<T>(raw: unknown, map: (r: Record<string, unknown>) => T): Paginated<T> {
  const body = (raw ?? {}) as Record<string, unknown>;
  const data = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : [];
  const pg = (body.pagination ?? {}) as Record<string, unknown>;
  return {
    rows: data.map(map),
    page: num(pg.page, 1),
    pageSize: num(pg.pageSize, 25),
    total: num(pg.total, data.length),
    totalPages: num(pg.totalPages, 1),
    totals: (body.totals as Record<string, number>) ?? undefined,
  };
}
