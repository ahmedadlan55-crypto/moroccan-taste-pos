/**
 * Shared domain types for Cashier V2. These mirror the backend contracts in
 * routes/pos-v2.js + lib/posOrderMachine.js EXACTLY — do not "improve" shapes
 * here without changing the server first.
 */
import type { DocumentIdentity, DocumentShowFields } from "../../../shared/invoiceTemplate";

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

/** close/w25-sell-ui — a sales channel (قناة بيع) the owner configured. The
 *  implicit base channel «الأساسي» is NOT in the list — the client prepends it.
 *  Absent on an old server → the POS behaves exactly as before (no selector). */
export interface SalesChannel {
  id: string;
  name: string;
}

/** close/w25-sell-ui — an owner-configured payment method riding in the catalog
 *  (pinned contract; absent on an old server → built-in tabs only).
 *  groupType 'other' (or requiresNote) ⇒ checkout REQUIRES a note ≥3 chars
 *  (the server 422s otherwise — the dialog blocks earlier with a counter). */
export interface CatalogPaymentMethod {
  id: number | string;
  name: string;
  nameAr: string | null;
  groupType: string | null;
  requiresNote?: boolean;
}

export interface CatalogItem {
  id: string;
  name: string;
  /** English display name (menu.name_en, served by the catalog). Absent/empty →
   *  the UI falls back to `name`. The receipt ALWAYS uses `name` (Arabic) for
   *  ZATCA compliance. */
  nameEn?: string | null;
  /** Base-unit price AS STORED. Whether it already contains VAT is decided PER
   *  ITEM by `taxInclusive` — it is not a global convention. Every current menu
   *  row is tax-EXCLUSIVE, so the register adds VAT on top to show the
   *  customer-facing price. */
  price: number;
  category: string;
  active: boolean;
  taxCategory: TaxCategory;
  /** menu.is_tax_inclusive — true = `price` already contains VAT; false = VAT is
   *  added on top. Absent (older server that did not ship it) → exclusive,
   *  which is what routes/sales.js computes for every current row. */
  taxInclusive?: boolean;
  /** close/w25-combos — العروض. True on a combo menu item: tapping its card opens
   *  the chooser (ComboDialog) instead of adding directly. The full definition
   *  (fixed components + choice groups) lives in Catalog.combos, keyed by menuId. */
  isCombo?: boolean;
  /** close/w25-sell-ui — price-list name when a channel price overrode the base
   *  price (server-resolved: override → channel price list → base). null/absent
   *  = base price. Drives the «مُخصَّص» card chip + «أسعار من قائمة: X» strip chip. */
  priceSource?: string | null;
  // Phase U — multi-unit selling. `units` is [] for single-unit items (fully
  // backward compatible). basePrice = price; warehouseQty = base availability.
  basePrice?: number;
  warehouseQty?: number | null;
  barcode?: string | null; // primary (base) barcode
  baseUnitName?: string | null;
  units?: CatalogUnit[];
  /** close/d-images — 8-char SHA1 prefix of the stored product image; null/absent
   *  = no image. The blob itself NEVER rides in the catalog: bytes come from
   *  GET /api/pos/v2/item-image/:id (immutable-cached, ?v=imageVersion busts the
   *  cache when the owner edits the image). */
  imageVersion?: string | null;
}

// ── لوحة النفاد / the 86 board (GET /api/menu/availability/bulk) ────────────
// The REAL answer for a kitchen: a dish is unavailable because an INGREDIENT ran
// out, not because the dish itself carries stock. routes/menu.js:1070 walks each
// active menu row's BOM (or the legacy `recipe` table) and reports how many the
// branch can still make. `CatalogItem.warehouseQty` is the fallback for anything
// this map does not cover.
//
// SHAPE PINNED TO THE BULK ROUTE, not to the single-item one: the bulk endpoint
// projects `blockerCount` (a number), NOT the `blockerIngredients` array the
// per-item GET /:id/availability returns. Do not "restore" the array here
// without changing the route.
//
// WARN, NEVER BLOCK: `makeable` is 0 for a menu row with no recipe at all, which
// is why the server leaves isOutOfStock/isLowStock FALSE in that case — and why
// the client must read those flags rather than deriving 86 from `makeable`.
export interface MenuAvailability {
  /** 'mto' (made to order, recipe walked) | 'mto_no_recipe' | future modes. */
  mode: string;
  /** Units the branch can still make from stock on hand. */
  makeable: number;
  isOutOfStock: boolean;
  isLowStock: boolean;
  /** How many ingredients are at zero (0 when nothing blocks). */
  blockerCount: number;
  /** A modern BOM is attached. False also for the legacy `recipe` table path. */
  hasRecipe: boolean;
}

/** menuId → availability. Absent key = the server said nothing about that item. */
export type MenuAvailabilityMap = Record<string, MenuAvailability>;

/** Owner-configured seller identity + the owner's print toggles. Both types now
 *  live in the SHARED invoice template (frontend/shared/invoiceTemplate.ts) so
 *  the POS and ERP apps render the identical document; POS keeps its historical
 *  names via these aliases (zero breakage for every existing importer, and the
 *  names remain usable locally — e.g. in `Catalog` below). Identity rides in the
 *  catalog because the catalog is the one payload the client already caches — so
 *  an OFFLINE receipt still prints the real seller, not the browser tab title. */
export type ReceiptIdentity = DocumentIdentity;
export type ReceiptShowFields = DocumentShowFields;

// ── العروض / Combos (close/w25-combos) ──────────────────────────────────────
// Definitions ride IN the catalog payload (the one payload the client already
// caches), so the chooser works offline for free. The server validates the
// submitted comboChoices at sale time — this is display + UX, never authority.

/** Always-included component, shown read-only in the chooser. */
export interface ComboFixedComponent {
  menuId: string;
  name: string;
  nameEn?: string | null;
  qty: number;
}

/** One pickable option inside a choice group. priceDelta (± SAR, tax-inclusive)
 *  adjusts the combo price when picked; 0 for most options. */
export interface ComboOption {
  menuId: string;
  name: string;
  nameEn?: string | null;
  priceDelta: number;
}

/** A choice group ("اختر مشروبًا"): the cashier must pick ≥ min and ≤ max. */
export interface ComboGroup {
  id: string;
  name: string;
  min: number;
  max: number;
  options: ComboOption[];
}

/** Full combo definition. `menuId` links it to the CatalogItem carrying
 *  isCombo: true; `price` is the combo's own (base) price. */
export interface ComboDef {
  id: string;
  menuId: string;
  name: string;
  /** English combo name (served by the catalog); UI falls back to `name`. */
  nameEn?: string | null;
  price: number;
  fixedComponents: ComboFixedComponent[];
  groups: ComboGroup[];
}

export interface Catalog {
  items: CatalogItem[];
  categories: string[];
  /** Combo definitions (العروض) for the chooser. Absent/[] on servers without
   *  the combos feature — every consumer must tolerate that. */
  combos?: ComboDef[];
  vatRate: number;
  maxCashierDiscountPct: number;
  /** close/w25-sell-ui — owner sales channels (absent/[] on an old server →
   *  the channel selector never renders). */
  channels?: SalesChannel[];
  /** close/w25-sell-ui — owner payment methods (absent on an old server →
   *  the payment dialog shows only the built-in tabs). */
  paymentMethods?: CatalogPaymentMethod[];
  /** null when the server could not resolve it — the receipt then prints what it
   *  has rather than fabricated seller data. */
  identity?: ReceiptIdentity | null;
  receiptShowFields?: ReceiptShowFields;
  serverTime: string;
}

export interface CartLine {
  menuId: string;
  name: string;
  /** English display name, snapshotted at add time. On-screen cart/UI shows this
   *  when the locale is English; the RECEIPT + server payload always use `name`
   *  (Arabic) for ZATCA. Absent → the UI falls back to `name`. */
  nameEn?: string | null;
  qty: number; // = enteredQty (quantity in the chosen unit; base if none)
  unitPrice: number; // base-unit price, in the convention `taxInclusive` names
  lineDiscount: number;
  vatCategory: TaxCategory;
  /** Whether `unitPrice` ALREADY contains VAT (menu.is_tax_inclusive),
   *  snapshotted from the catalog at add time. Absent on carts persisted
   *  before this field existed → treated as EXCLUSIVE, which is what the
   *  server computes for every current menu row. See cartMath.lineTotals. */
  taxInclusive?: boolean;
  notes: string | null;
  // Phase U — unit-of-measure. Money + stock use baseQty (= qty × factor). The
  // factor is FROZEN at add time. Legacy piece lines: unit = base, factor 1,
  // baseQty = qty. `qty` is the entered quantity shown to the cashier.
  enteredUnitId?: string | null;
  enteredUnitCode?: string | null;
  enteredUnitName?: string | null;
  conversionFactorSnapshot?: number; // frozen factor
  baseQty?: number; // = qty × conversionFactorSnapshot
  /** close/w25-combos — frozen at finalize time by the chooser:
   *  { [groupId]: [chosen menuId, …] }. The server validates it at submit.
   *  A human-readable summary of the same picks goes into `notes` so the cart
   *  panel and kitchen ticket show the choices with no extra plumbing.
   *  Absent on normal (non-combo) lines. */
  comboChoices?: Record<string, string[]>;
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
  /** A built-in method OR an owner-configured method NAME sent verbatim
   *  (close/w25-sell-ui pinned contract: checkout payments accept owner-method
   *  names; `string & {}` keeps the built-in literals in autocomplete). */
  method: PayMethod | (string & {});
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
  /** The shift's stored opening float — already folded into the cash method's
   *  expectedAmount server-side; surfaced here for a read-only display row. */
  openingFloat?: number;
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
