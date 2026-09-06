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
  /** Where the goods are going. Dropped by the old mapper, so the list could
   *  not say which branch an order served. */
  branchId: string;
  branchName: string;
  warehouseId: string;
  warehouseName: string;
  /** The branch request this PO was converted from, when there was one. */
  requisitionId: string;
  requisitionNumber: string;
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
    branchId: str(r.branch_id),
    branchName: str(r.branch_name),
    warehouseId: str(r.warehouse_id),
    warehouseName: str(r.warehouse_name),
    requisitionId: str(r.requisition_id),
    requisitionNumber: str(r.requisition_number),
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

// ── Landed cost — receipt charges ────────────────────────────────────────────
// Contract (routes/procurement/receipts.js): POST /receipts and
// PUT /receipts/:id/charges carry `charges[]`; GET /receipts/:id answers with
// `charges`, `chargesTotal`, `landedTotal` and, per line, `landedChargeAmount`
// + `landedUnitCost`.
//
// A landed figure that is null means "no charges on this receipt" — or a
// server that predates landed cost and never sent the field. Either way the UI
// prints "—". It is NEVER coerced to 0: a zero landed unit cost reads as a real
// cost of nothing, and a zero charges total reads as "no charges" even when the
// truth is "the server did not say".

export const RECEIPT_CHARGE_TYPES = ["freight", "customs", "insurance", "handling", "other"] as const;
export type ReceiptChargeType = (typeof RECEIPT_CHARGE_TYPES)[number];
export const CHARGE_ALLOCATION_METHODS = ["value", "qty"] as const;
export type ChargeAllocationMethod = (typeof CHARGE_ALLOCATION_METHODS)[number];
export type ReceiptChargeStatus = "accrued" | "invoiced";

export function isReceiptChargeType(v: unknown): v is ReceiptChargeType {
  return (RECEIPT_CHARGE_TYPES as readonly string[]).includes(String(v));
}

/** What travels to the server — POST /receipts `charges[]` and PUT /receipts/:id/charges. */
export interface ReceiptChargeInput {
  chargeType: ReceiptChargeType;
  description?: string;
  supplierId?: string | null;
  /** Net of VAT, > 0. */
  amount: number;
  /** >= 0, defaults to 0 server-side. */
  vatAmount?: number;
  /** Defaults to "value" server-side. */
  allocationMethod?: ChargeAllocationMethod;
}

export interface ReceiptCharge {
  id: string;
  chargeType: ReceiptChargeType;
  description: string;
  supplierId: string | null;
  supplierName: string;
  amount: number;
  vatAmount: number;
  allocationMethod: ChargeAllocationMethod;
  status: ReceiptChargeStatus;
  supplierInvoiceId: string | null;
}

function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
// The contract is camelCase. The snake_case fallback is deliberate: a raw
// `SELECT *` row leaking through an `any`-typed adapter has blanked a screen
// before (lot genealogy), so the reader tolerates both — camel wins.
function pick(r: Record<string, unknown>, camel: string, snake: string): unknown {
  return r[camel] !== undefined ? r[camel] : r[snake];
}

export function toReceiptCharge(r: Record<string, unknown>): ReceiptCharge {
  const type = pick(r, "chargeType", "charge_type");
  return {
    id: str(r.id),
    chargeType: isReceiptChargeType(type) ? type : "other",
    description: str(r.description),
    supplierId: str(pick(r, "supplierId", "supplier_id")) || null,
    supplierName: str(pick(r, "supplierName", "supplier_name")),
    amount: num(r.amount),
    vatAmount: num(pick(r, "vatAmount", "vat_amount")),
    allocationMethod: pick(r, "allocationMethod", "allocation_method") === "qty" ? "qty" : "value",
    status: r.status === "invoiced" ? "invoiced" : "accrued",
    supplierInvoiceId: str(pick(r, "supplierInvoiceId", "supplier_invoice_id")) || null,
  };
}

export interface ReceiptLine {
  id: string;
  poLineId: string;
  itemId: string;
  itemName: string;
  enteredQty: number;
  enteredUnitCode: string;
  baseQty: number;
  /** Goods cost per base unit — what the PO priced, before any charge. */
  baseUnitCost: number;
  lineTotal: number;
  lotNo: string;
  expiryDate: string;
  /** This line's share of the receipt's charges. null = no charges. */
  landedChargeAmount: number | null;
  /** (line_total + landedChargeAmount) / base_qty. null = no charges, NOT 0. */
  landedUnitCost: number | null;
}
export function toReceiptLine(r: Record<string, unknown>): ReceiptLine {
  return {
    id: str(r.id),
    poLineId: str(r.po_line_id),
    itemId: str(r.item_id),
    itemName: str(r.item_name, str(r.item_id)),
    enteredQty: num(r.entered_qty),
    enteredUnitCode: str(r.entered_unit_code),
    baseQty: num(r.base_qty),
    baseUnitCost: num(r.base_unit_cost),
    lineTotal: num(r.line_total),
    lotNo: str(r.lot_no),
    expiryDate: str(r.expiry_date),
    landedChargeAmount: numOrNull(pick(r, "landedChargeAmount", "landed_charge_amount")),
    landedUnitCost: numOrNull(pick(r, "landedUnitCost", "landed_unit_cost")),
  };
}

/** GET /receipts/:id — the header row plus its lines and charges. */
export interface PurchaseReceipt extends Receipt {
  /** Goods value net of VAT — the base the uplift is measured against. */
  subtotal: number;
  vatAmount: number;
  lines: ReceiptLine[];
  /** null = the envelope carried no `charges` at all (a server without landed cost). */
  charges: ReceiptCharge[] | null;
  chargesTotal: number | null;
  landedTotal: number | null;
}
export function toPurchaseReceipt(r: Record<string, unknown>): PurchaseReceipt {
  const lines = Array.isArray(r.lines) ? (r.lines as Record<string, unknown>[]) : [];
  const charges = Array.isArray(r.charges) ? (r.charges as Record<string, unknown>[]).map(toReceiptCharge) : null;
  return {
    ...toReceipt(r),
    subtotal: num(r.subtotal),
    vatAmount: num(r.vat_amount),
    lines: lines.map(toReceiptLine),
    charges,
    chargesTotal: numOrNull(pick(r, "chargesTotal", "charges_total")),
    landedTotal: numOrNull(pick(r, "landedTotal", "landed_total")),
  };
}

// ── Allocation — the SAME rule the server posts with ─────────────────────────
// by "value" = share of line_total; by "qty" = share of base_qty; 4-dp rounding
// with the rounding residual placed on the largest line, so the allocated
// amounts sum EXACTLY to the charge. The form previews with this so what the
// user sees before submitting is what the warehouse WAC will receive.

/** Trim binary-float noise to 4 dp without lying about precision. */
export function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

export interface AllocatableLine {
  key: string;
  lineTotal: number;
  baseQty: number;
}
export interface ChargeAllocationInput {
  amount: number;
  allocationMethod: ChargeAllocationMethod;
}
export interface AllocatedLine {
  landedChargeAmount: number | null;
  landedUnitCost: number | null;
}
export interface ReceiptChargeAllocation {
  byKey: Record<string, AllocatedLine>;
  goodsTotal: number;
  chargesTotal: number;
  landedTotal: number;
}

/**
 * One charge over the lines, in line order. Returns null when there is nothing
 * to share on (no lines, or every weight is zero) — an allocation that cannot
 * be made is not an allocation of zero.
 */
export function allocateCharge(amount: number, method: ChargeAllocationMethod, lines: AllocatableLine[]): number[] | null {
  const weights = lines.map((l) => Math.max(0, method === "qty" ? num(l.baseQty) : num(l.lineTotal)));
  const basis = weights.reduce((a, b) => a + b, 0);
  if (lines.length === 0 || !(basis > 0)) return null;
  const shares = weights.map((w) => round4((amount * w) / basis));
  const residual = round4(amount - shares.reduce((a, b) => a + b, 0));
  if (residual !== 0) {
    // Largest weight takes the residual; the first of equals wins so the
    // result is deterministic for the server to reproduce.
    let largest = 0;
    weights.forEach((w, i) => { if (w > weights[largest]) largest = i; });
    shares[largest] = round4(shares[largest] + residual);
  }
  return shares;
}

/**
 * Every charge over every line. A line's landed figures are null when the
 * receipt has no charges, or when none of them could be allocated (see
 * allocateCharge); landedUnitCost is also null for a line with no base qty.
 */
export function allocateReceiptCharges(lines: AllocatableLine[], charges: ChargeAllocationInput[]): ReceiptChargeAllocation {
  const goodsTotal = round4(lines.reduce((s, l) => s + num(l.lineTotal), 0));
  const chargesTotal = round4(charges.reduce((s, c) => s + num(c.amount), 0));
  const perLine: Array<number | null> = lines.map(() => null);
  for (const c of charges) {
    const shares = allocateCharge(num(c.amount), c.allocationMethod, lines);
    if (!shares) continue;
    shares.forEach((share, i) => { perLine[i] = round4((perLine[i] ?? 0) + share); });
  }
  const byKey: Record<string, AllocatedLine> = {};
  lines.forEach((l, i) => {
    const charge = perLine[i];
    const baseQty = num(l.baseQty);
    byKey[l.key] = {
      landedChargeAmount: charge,
      landedUnitCost: charge == null || !(baseQty > 0) ? null : round4((num(l.lineTotal) + charge) / baseQty),
    };
  });
  return { byKey, goodsTotal, chargesTotal, landedTotal: round4(goodsTotal + chargesTotal) };
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
  requisitionsPending: number;
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
    requisitionsPending: num(r.requisitionsPending),
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
