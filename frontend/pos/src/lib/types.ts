/**
 * Shared domain types for Cashier V2. These mirror the backend contracts in
 * routes/pos-v2.js + lib/posOrderMachine.js EXACTLY — do not "improve" shapes
 * here without changing the server first.
 */

export type TaxCategory = "S" | "Z" | "E" | "O";
export type OrderType = "dine_in" | "takeaway" | "delivery";
export type OrderStatus = "open" | "held" | "submitted" | "completed" | "voided";
export type PayMethod = "cash" | "card" | "credit";
export type DiscountType = "PERCENT" | "FIXED";

/** A sellable unit for a catalog item (base or a major unit like carton). */
export interface CatalogUnit {
  unitId: string | null;
  unitCode: string;
  unitName: string;
  isBase: boolean;
  factor: number; // conversion_to_base: 1 <unit> = factor <base>
  barcode: string | null; // optional per-unit barcode (scan a carton)
}

export interface CatalogItem {
  id: string;
  name: string;
  price: number; // base-unit price (tax-inclusive)
  category: string;
  active: boolean;
  taxCategory: TaxCategory;
  // Phase U — multi-unit selling. `units` is [] for single-unit items (fully
  // backward compatible). basePrice = price; warehouseQty = base availability.
  basePrice?: number;
  warehouseQty?: number | null;
  barcode?: string | null; // primary (base) barcode
  baseUnitName?: string | null;
  units?: CatalogUnit[];
}

/** Owner-configured seller identity, resolved server-side for this cashier's
 *  branch (lib/invoiceIdentity.js). Rides in the catalog because the catalog is
 *  the one payload the client already caches — so an OFFLINE receipt still
 *  prints the real seller, not the browser tab title. */
export interface ReceiptIdentity {
  sellerName: string;
  legalName: string;
  taxNumber: string;
  crNumber: string;
  address: string;
  nationalAddress: string;
  phone: string;
  email: string;
  logo: string;
  currency: string;
  vatRate: number;
  header: string;
  footer: string;
  thankYou: string;
  returnPolicy: string;
  branchName: string;
  branchCompanyName: string;
  brandName: string;
}

/** Which optional blocks the owner wants printed. Server defaults are all-on. */
export interface ReceiptShowFields {
  logo: boolean;
  taxNumber: boolean;
  crNumber: boolean;
  nationalAddress: boolean;
  phone: boolean;
  email: boolean;
  cashier: boolean;
  customer: boolean;
  qr: boolean;
}

export interface Catalog {
  items: CatalogItem[];
  categories: string[];
  vatRate: number;
  maxCashierDiscountPct: number;
  /** null when the server could not resolve it — the receipt then prints what it
   *  has rather than fabricated seller data. */
  identity?: ReceiptIdentity | null;
  receiptShowFields?: ReceiptShowFields;
  serverTime: string;
}

export interface CartLine {
  menuId: string;
  name: string;
  qty: number; // = enteredQty (quantity in the chosen unit; base if none)
  unitPrice: number; // base-unit price
  lineDiscount: number;
  vatCategory: TaxCategory;
  notes: string | null;
  // Phase U — unit-of-measure. Money + stock use baseQty (= qty × factor). The
  // factor is FROZEN at add time. Legacy piece lines: unit = base, factor 1,
  // baseQty = qty. `qty` is the entered quantity shown to the cashier.
  enteredUnitId?: string | null;
  enteredUnitCode?: string | null;
  enteredUnitName?: string | null;
  conversionFactorSnapshot?: number; // frozen factor
  baseQty?: number; // = qty × conversionFactorSnapshot
}

export interface OrderDiscount {
  type: DiscountType;
  value: number;
  name: string | null;
}

export interface CartTotals {
  subtotal: number;
  lineDiscountTotal: number;
  discountAmount: number;
  vatTotal: number;
  netTotal: number;
  total: number;
}

export interface Payment {
  method: PayMethod;
  amount: number;
}

/** Local order document persisted in IndexedDB ('orders' store, key = id). */
export interface LocalOrder {
  id: string; // client ULID — doubles as clientOrderId for /api/sales dedupe
  status: OrderStatus;
  orderType: OrderType;
  tableNo: string | null;
  shiftId: string | null;
  deviceId: string | null;
  discountType: DiscountType | null;
  discountValue: number;
  discountName: string | null;
  note: string | null;
  /** Real linked customer id (Order-to-Cash). null = walk-in / free-text only.
   *  Required for a credit sale when ORDER_TO_CASH_ENABLE is on. */
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  lines: CartLine[];
  /** Last version acknowledged by the server; null = never synced (create). */
  serverVersion: number | null;
  invoiceNumber: string | null;
  saleId: string | null;
  /** Server-rendered ZATCA QR (PNG data-URL), captured at checkout. null for a
   *  queued offline sale — the stamp does not exist until the server sees it,
   *  and the receipt says so instead of printing a fake. */
  zatcaQrDataUrl?: string | null;
  createdAt: number;
  updatedAt: number;
}

export type QueueOpType =
  | "upsert"
  | "hold"
  | "resume"
  | "reopen"
  | "void"
  | "complete"
  | "submit-and-sale";

export interface QueueOp {
  opId: string; // ULID — per-op idempotency key server-side
  type: QueueOpType;
  orderId: string;
  payload: Record<string, unknown>;
  ts: number;
  seq: number; // strict FIFO tiebreaker (same-ms ops)
}

export interface SyncOpReport {
  opId: string;
  type: QueueOpType;
  orderId: string;
  ok: boolean;
  replay?: boolean;
  code?: string;
  error?: string;
}

export interface SyncReport {
  at: number;
  results: SyncOpReport[];
}

export interface ServerOrderLine {
  id: string;
  menuId: string;
  name: string;
  qty: number;
  unitPrice: number;
  lineDiscount: number;
  vatCategory: TaxCategory;
  notes: string | null;
  sort: number;
}

export interface ServerOrder {
  id: string;
  status: OrderStatus;
  orderType: OrderType;
  tableNo: string | null;
  shiftId: string | null;
  username: string;
  deviceId: string | null;
  customerId?: string | null;
  discountType: DiscountType | null;
  discountValue: number;
  discountName: string | null;
  subtotal: number;
  lineDiscountTotal: number;
  discountTotal: number;
  vatTotal: number;
  total: number;
  note: string | null;
  saleId: string | null;
  invoiceNumber: string | null;
  version: number;
  heldAt: string | null;
  updatedAt: string;
  lines: ServerOrderLine[];
}

export interface LegacySalePayload {
  clientOrderId: string;
  [k: string]: unknown;
}

export interface SubmitResult {
  success: boolean;
  data: { id: string; legacyPayload: LegacySalePayload; total: number };
  status: string;
  version: number;
}

export interface SaleResult {
  success: boolean;
  orderId: string;
  invoiceNumber?: string | null;
  idempotent?: boolean;
  error?: string;
  /** The server has ALWAYS returned this block; the type simply never declared
   *  it, so the stamp the customer is entitled to see was dropped on the floor.
   *  qrDataUrl is a server-rendered PNG — the client never encodes QRs. */
  zatca?: {
    uuid: string | null;
    invoiceHash: string | null;
    previousInvoiceHash: string | null;
    qrBase64: string | null;
    qrDataUrl: string | null;
  } | null;
}

export interface ClosingMethod {
  id: number | string;
  name: string;
  nameAr: string | null;
  icon: string | null;
  color: string | null;
  groupType: string | null;
  expectedAmount: number;
}

export interface ClosingDataV3 {
  methods: ClosingMethod[];
  expected: Record<string, number>;
  expectedTotal: number;
  orderCount: number;
  unmatchedTotal: number;
  error?: string;
}

export interface CloseV3Result {
  success: boolean;
  shiftId?: string;
  breakdown?: Array<{
    id: number | string;
    name: string;
    nameAr: string | null;
    groupType: string | null;
    expected: number;
    actual: number;
    variance: number;
  }>;
  expectedTotal?: number;
  actualTotal?: number;
  variance?: number;
  cashCounted?: number;
  orderCount?: number;
  error?: string;
  code?: string;
}

export interface ShiftSummary {
  byStatus: Record<string, { count: number; amount: number }>;
  completedByMethod: Record<string, number>;
}

export interface AuthUser {
  username: string;
  role: string;
}

// ── فواتيري / My Invoices ────────────────────────────────────────────────────
// A row from GET /api/sales (routes/sales.js:1715) — already camelCased by the
// backend. That endpoint has no shift filter, so the legacy POS pulls the day
// and narrows to the active shift client-side; we match that behaviour.

/** ZATCA document type. `cancellation` = voided, `credit_note` = returned. */
export type ZatcaType = "standard" | "simplified" | "credit_note" | "debit_note" | "cancellation";

export interface SaleLineLite {
  name?: string;
  qty?: number;
  price?: number;
  total?: number;
  notes?: string;
}

export interface SaleRow {
  orderId: string;
  date: string;
  total: number;
  payment: string | null;
  username: string;
  items: SaleLineLite[];
  discount: number;
  shiftId: string | null;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  paymentNotes: string | null;
  zatcaType: ZatcaType | null;
  hasCreditNote: boolean;
  invoiceNumber: string | null;
  voidSerial: string | null;
  returnSerial: string | null;
}

/**
 * Credentials for the manager-approval gate on void/return.
 * The server re-authorizes with bcrypt + role — this is a UX shortcut, never
 * the security boundary (routes/sales.js:_requireManagerApproval).
 */
export interface ApproverCredentials {
  approverUsername: string;
  approverPassword: string;
}
