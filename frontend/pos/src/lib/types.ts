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

export interface CatalogItem {
  id: string;
  name: string;
  price: number;
  category: string;
  active: boolean;
  taxCategory: TaxCategory;
}

export interface Catalog {
  items: CatalogItem[];
  categories: string[];
  vatRate: number;
  maxCashierDiscountPct: number;
  serverTime: string;
}

export interface CartLine {
  menuId: string;
  name: string;
  qty: number;
  unitPrice: number;
  lineDiscount: number;
  vatCategory: TaxCategory;
  notes: string | null;
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
  customerName: string | null;
  customerPhone: string | null;
  lines: CartLine[];
  /** Last version acknowledged by the server; null = never synced (create). */
  serverVersion: number | null;
  invoiceNumber: string | null;
  saleId: string | null;
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
