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
