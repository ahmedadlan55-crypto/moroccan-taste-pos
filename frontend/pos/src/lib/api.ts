/**
 * API client — thin typed fetch wrapper over the EXACT backend contracts:
 *   /api/pos/v2/*            (routes/pos-v2.js — cart lifecycle, tested 41/41)
 *   /api/sales               (legacy financial write path — ZATCA/GL/stock)
 *   /api/shifts/*            (legacy shifts: open / closing-data-v3 / close-v3)
 * Every request carries Authorization: Bearer <pos_token>.
 */
import { getToken } from "./auth";
import type {
  ApproverCredentials,
  Catalog,
  ClosingDataV3,
  CloseV3Result,
  LegacySalePayload,
  MenuAvailability,
  MenuAvailabilityMap,
  SaleResult,
  SaleRow,
  ServerOrder,
  ShiftSummary,
  SubmitResult,
} from "./types";

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function isVersionConflict(e: unknown): boolean {
  return e instanceof ApiError && e.code === "VERSION_CONFLICT";
}

type Json = Record<string, unknown>;

// Exported so lib/capabilities.ts (GET /api/auth/permissions/me) can reuse the
// exact same Authorization/error-envelope handling as every other call here —
// no parallel fetch wrapper.
//
// `allowPartialSuccess` is a per-call OPT-OUT of the generic `body.success ===
// false` hard-throw — it does NOT relax the `!res.ok` check (a non-2xx status
// always throws, exactly as before). It exists for endpoints whose 2xx
// envelope legitimately carries `success:false` as a PARTIAL-failure report
// (e.g. POST /api/pos/v2/sync — `{success: results.every(r=>r.ok), results}`
// with no top-level error/message) rather than a hard domain error. Without
// it, request() would throw an ApiError whose message falls back to the
// useless literal `HTTP ${res.status}` (there is no error/message field to
// read), and callers have no access to the per-item results to explain what
// actually failed. Only postSync() passes this — every other call site keeps
// throwing on success:false exactly as before.
export async function request<T>(
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    allowPartialSuccess?: boolean;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(opts.body != null ? { "Content-Type": "application/json" } : {}),
    ...(opts.headers ?? {}),
  };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });
  let body: Json | null = null;
  try {
    body = (await res.json()) as Json;
  } catch {
    body = null;
  }
  const isPartialSuccess = opts.allowPartialSuccess && res.ok && body && body.success === false;
  if (!res.ok || (body && body.success === false && !isPartialSuccess)) {
    const code = String(body?.code ?? (res.status === 401 ? "UNAUTHORIZED" : "SERVER_ERROR"));
    const msg = String(body?.error ?? body?.message ?? `HTTP ${res.status}`);
    throw new ApiError(res.status, code, msg);
  }
  return body as T;
}

// ── Catalog (ETag-aware) ─────────────────────────────────────────────────────
export async function fetchCatalog(etag: string | null): Promise<{ status: 200 | 304; data?: Catalog; etag?: string }> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (etag) headers["If-None-Match"] = etag;
  const res = await fetch("/api/pos/v2/catalog", { headers });
  if (res.status === 304) return { status: 304 };
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const b = (await res.json()) as Json;
      msg = String(b.error ?? msg);
    } catch {
      /* keep msg */
    }
    throw new ApiError(res.status, "SERVER_ERROR", msg);
  }
  const body = (await res.json()) as { success: boolean; data: Catalog };
  return { status: 200, data: body.data, etag: res.headers.get("ETag") ?? undefined };
}

// ── Orders lifecycle ─────────────────────────────────────────────────────────
export interface UpsertResult {
  success: boolean;
  created: boolean;
  status: string;
  data: { id: string; version: number; totals: { subtotal: number; discountAmount: number; vatTotal: number; total: number } };
  version: number;
}

export function upsertOrder(body: Json): Promise<UpsertResult> {
  return request<UpsertResult>("/api/pos/v2/orders", { method: "POST", body });
}

export function transition(
  id: string,
  action: "hold" | "resume" | "reopen" | "void",
  body: Json = {},
): Promise<{ success: boolean; data: { id: string }; status: string; version: number }> {
  return request(`/api/pos/v2/orders/${encodeURIComponent(id)}/${action}`, { method: "POST", body });
}

export function submitOrder(id: string, body: Json, idempotencyKey: string): Promise<SubmitResult> {
  return request<SubmitResult>(`/api/pos/v2/orders/${encodeURIComponent(id)}/submit`, {
    method: "POST",
    body,
    headers: { "Idempotency-Key": idempotencyKey },
  });
}

export function completeOrder(
  id: string,
  body: { saleId: string; invoiceNumber?: string | null },
): Promise<{ success: boolean; idempotent: boolean; data: { id: string; saleId: string }; version: number }> {
  return request(`/api/pos/v2/orders/${encodeURIComponent(id)}/complete`, { method: "POST", body });
}

export function listOrders(params: { status?: string; shiftId?: string } = {}): Promise<{ success: boolean; data: ServerOrder[] }> {
  const q = new URLSearchParams();
  if (params.status) q.set("status", params.status);
  if (params.shiftId) q.set("shiftId", params.shiftId);
  const qs = q.toString();
  return request(`/api/pos/v2/orders${qs ? `?${qs}` : ""}`);
}

/** POST the frozen legacy payload EXACTLY as /submit returned it. */
export function postLegacySale(payload: LegacySalePayload): Promise<SaleResult> {
  return request<SaleResult>("/api/sales", { method: "POST", body: payload });
}

// ── Sync (offline batch replay) ──────────────────────────────────────────────
export interface SyncResultRow {
  opId: string;
  ok: boolean;
  replay?: boolean;
  code?: string;
  error?: string;
  result?: Json;
}

/**
 * POST /api/pos/v2/sync — a legitimate PARTIAL-batch-failure envelope:
 * `{success: results.every(r=>r.ok), results}`, HTTP 200 even when some ops
 * failed, and no top-level error/message field. `allowPartialSuccess` tells
 * request() not to hard-throw on `success:false` here — the caller
 * (offline.ts's runSyncBatch) reads `results[]` itself and reports/toasts
 * each failed op using ITS OWN code/error, instead of getting a generic
 * ApiError whose message would otherwise fall back to the literal `HTTP 200`.
 * A real transport/auth failure (non-2xx) still throws exactly as before.
 */
export function postSync(ops: Array<{ opId: string; type: string; orderId?: string; payload: unknown }>): Promise<{
  success: boolean;
  results: SyncResultRow[];
}> {
  return request("/api/pos/v2/sync", { method: "POST", body: { ops }, allowPartialSuccess: true });
}

// ── Shifts (legacy endpoints) ────────────────────────────────────────────────
/** POST /api/shifts/open. `openingFloat` (الرصيد الافتتاحي) is the real cash
 *  placed in the drawer at shift start; sent only when provided so old callers
 *  are unaffected. The server validates + persists it and returns the stored
 *  value (unchanged on an idempotent re-open). */
export function openShift(openingFloat?: number): Promise<{ success: boolean; shiftId: string; openingFloat?: number }> {
  const body: Json = { device: { ua: typeof navigator !== "undefined" ? navigator.userAgent : "pos-v2" } };
  if (openingFloat != null) body.openingFloat = openingFloat;
  return request("/api/shifts/open", { method: "POST", body });
}

/** GET /api/shifts?username=&status=OPEN → raw array (legacy shape, no envelope). */
export async function findOpenShift(username: string): Promise<string | null> {
  const rows = await request<Array<{ id: string; status: string }>>(
    `/api/shifts?username=${encodeURIComponent(username)}&status=OPEN`,
  );
  return Array.isArray(rows) && rows.length ? rows[0].id : null;
}

export function closingDataV3(shiftId: string): Promise<ClosingDataV3> {
  return request<ClosingDataV3>(`/api/shifts/closing-data-v3/${encodeURIComponent(shiftId)}`);
}

/**
 * POST /api/shifts/close-v3 — body per routes/shifts.js (~line 307):
 * { shiftId, openingFloat, denominations:[{value,count,kind}], paymentTotals:{<pmId>: actual}, notes }
 * We key paymentTotals by String(method.id) (id keys win server-side) and send
 * denominations: [] + openingFloat: 0 — NOTE: any cashCounted>0 from
 * denominations/openingFloat OVERRIDES the cash method's paymentTotals entry
 * server-side, so we deliberately count cash via paymentTotals only.
 */
export function closeShiftV3(body: {
  shiftId: string;
  openingFloat: number;
  denominations: Array<{ value: number; count: number; kind: "note" | "coin" }>;
  paymentTotals: Record<string, number>;
  notes: string;
}): Promise<CloseV3Result> {
  return request<CloseV3Result>("/api/shifts/close-v3", { method: "POST", body });
}

export function shiftSummary(shiftId: string): Promise<{ success: boolean; data: ShiftSummary }> {
  return request(`/api/pos/v2/shift-summary/${encodeURIComponent(shiftId)}`);
}

// ── Till cash movements (حركات نقدية على الدرج) ──────────────────────────────
/**
 * A cash-in / cash-out recorded on an OPEN shift — a drop to the safe, a float
 * top-up, petty cash. Before this existed the cashier had no way to record one
 * from any client, and the expected-cash figure at close was wrong by exactly
 * the amounts that moved.
 *
 * Server contract (routes/shifts.js):
 *   GET  /api/shifts/:shiftId/movements  → { success, shiftId, movements, totals }
 *   POST /api/shifts/:shiftId/movements  → { success, movement, totals }
 *
 * Only APPROVED movements are ever returned or counted: the POST records and
 * approves in one atomic step, and every server-side reader filters on the
 * posted voucher status.
 */
export interface ShiftMovement {
  id: string;
  kind: "pay_in" | "pay_out";
  /** Voucher number in the ERP cash sequence (REC-xxxxx / PAY-xxxxx). */
  number: string;
  amount: number;
  reason: string;
  note: string;
  createdBy: string;
  /** The account that AUTHORIZED it — never the cashier, unless the cashier
   *  holds the approval capability themselves. */
  approvedBy: string;
  approvedAt: string | null;
  journalId: string | null;
  date: string | null;
}

export interface ShiftMovementTotals {
  payIn: number;
  payOut: number;
  /** payIn − payOut: the exact ± term now inside the cash «expected» figure. */
  net: number;
  count: number;
}

export function listShiftMovements(
  shiftId: string,
): Promise<{ success: boolean; shiftId: string; movements: ShiftMovement[]; totals: ShiftMovementTotals }> {
  return request(`/api/shifts/${encodeURIComponent(shiftId)}/movements`);
}

/**
 * Record + approve one movement. `approverUsername`/`approverPassword` are the
 * MANAGER's, collected by CashMovementDialog and verified server-side with
 * bcrypt — this client never decides whether an approval is valid, and a caller
 * that holds the approval capability itself may omit them entirely.
 */
export function createShiftMovement(
  shiftId: string,
  body: {
    kind: "pay_in" | "pay_out";
    amount: number;
    reason: string;
    note?: string;
  } & Partial<ApproverCredentials>,
): Promise<{ success: boolean; movement: ShiftMovement & { shiftId: string }; totals: ShiftMovementTotals }> {
  return request(`/api/shifts/${encodeURIComponent(shiftId)}/movements`, {
    method: "POST",
    body: body as unknown as Json,
  });
}

// ── Order-to-Cash: customer search (for the POS customer picker) + flags ──────
export interface PosCustomerHit {
  id: string;
  name: string;
  phone?: string | null;
  vatNumber?: string | null;
  creditLimit?: number;
  balance?: number;
  derived?: { arBalance: number };
  isActive?: boolean;
  paymentTerms?: string;
  creditDays?: number;
}
export interface CustomerSearchResult {
  success: boolean;
  data: PosCustomerHit[];
  pagination?: { page: number; pageSize: number; total: number; totalPages: number };
}

/** GET /api/order-to-cash/customers/search — first page shows instantly (q=''). */
export function searchCustomers(q: string, page = 1): Promise<CustomerSearchResult> {
  const p = new URLSearchParams({ q: q || "", page: String(page), pageSize: "20", active: "true" });
  return request<CustomerSearchResult>(`/api/order-to-cash/customers/search?${p.toString()}`);
}

/** Public /api/version — read the Order-to-Cash flag so the POS shows the real
 *  customer picker (flag ON) vs the legacy name/phone fields (flag OFF). */
export function getServerFlags(): Promise<{ orderToCash?: boolean; posV2?: boolean }> {
  return request<{ orderToCash?: boolean; posV2?: boolean }>("/api/version");
}

// ── فواتيري / My Invoices — void + return ───────────────────────────────────
// Parity with the legacy cashier's "فواتيري" modal (public/pos/app.js:3288).
// All three endpoints are the legacy financial path — there is no /pos/v2
// equivalent, and there must not be: void/return move money and must go
// through the same ZATCA + GL + stock reversal the old POS used.

/**
 * GET /api/sales — returns up to 500 rows, newest first.
 * `shiftId` narrows to a single shift SERVER-SIDE (added by the companion
 * routes/sales.js stream). Older callers that omit it get the legacy behaviour
 * (whole window, narrowed client-side); MyInvoicesDialog now passes it so the
 * server does the filtering instead of pulling the whole day into the browser.
 */
export function listSales(params: {
  startDate?: string;
  endDate?: string;
  username?: string;
  paymentMethod?: string;
  customerId?: string;
  shiftId?: string;
} = {}): Promise<SaleRow[]> {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, String(v));
  const qs = p.toString();
  return request<SaleRow[]>(`/api/sales${qs ? `?${qs}` : ""}`);
}

/**
 * POST /api/sales/:orderId/void — full cancellation (zatca_type='cancellation').
 * Refused by the server when the invoice was already submitted to ZATCA
 * (BR-KSA-08 immutability) — a credit note is the only lawful offset then.
 * `approver` is required for non-privileged roles unless the owner disabled it
 * via settings.RequireManagerApprovalForVoid.
 */
export function voidSale(orderId: string, approver?: ApproverCredentials): Promise<{ success: true }> {
  return request(`/api/sales/${encodeURIComponent(orderId)}/void`, {
    method: "POST",
    body: { ...(approver ?? {}) },
  });
}

/**
 * POST /api/sales/:orderId/return — issues a real ZATCA credit note.
 * Approval is ALWAYS required for non-privileged roles here (money out), with
 * no opt-out — unlike void.
 */
export function returnSale(
  orderId: string,
  reason: string,
  approver?: ApproverCredentials,
): Promise<{ success: true }> {
  return request(`/api/sales/${encodeURIComponent(orderId)}/return`, {
    method: "POST",
    body: { reason, ...(approver ?? {}) },
  });
}
// ═════════════════════════════════════════════════════════════════════════════
// ═══ B1 POS-INVENTORY BLOCK — stocktake (جرد) + shortage requests (طلب      ═══
// ═══ النواقص) + receive materials (استلام مواد).                            ═══
// ═══ Appended as ONE self-contained block at the END of the file by the     ═══
// ═══ close/b1-pos-inventory stream; another stream also appends functions   ═══
// ═══ to this file — keep this block LAST and intact to ease merging.        ═══
// ═══ Contracts mirror public/shared/api-bridge.js + routes/inventory.js.    ═══
// ═════════════════════════════════════════════════════════════════════════════

/** Raw inventory item — GET /api/inventory/items (legacy branch: one row per
 *  item, GLOBAL stock; shape per routes/inventory.js ~1228). */
export interface InvItem {
  id: string;
  name: string;
  category: string;
  kind?: string;
  cost: number;
  stock: number;
  minStock: number;
  unit: string;
  bigUnit: string | null;
  convRate: number;
  active: number | boolean;
}

export function getInvItems(): Promise<InvItem[]> {
  return request<InvItem[]>("/api/inventory/items");
}

/** One counted stocktake line. The legacy payload sends BOTH naming pairs
 *  (systemQty/actualQty and sys/actual) plus diff — the server reads either
 *  (routes/inventory.js ~3660: `item.sys || item.systemQty`). We keep both. */
export interface StocktakeLine {
  id: string;
  name: string;
  unit: string;
  systemQty: number;
  actualQty: number;
  sys: number;
  actual: number;
  diff: number;
}

export interface StocktakeResult {
  success: boolean;
  stocktakeId: string;
  adjustedCount: number;
  totalGainCost: number;
  totalLossCost: number;
  postingWarning: string | null;
}

/** POST /api/inventory/stocktakes — body per public/shared/api-bridge.js:147.
 *  warehouseId/branchId are sent EMPTY on purpose: the server resolves them
 *  from the cashier's profile (v5.10.35) and refuses with an Arabic message
 *  when it can't — we surface that message verbatim. */
export function submitStocktake(items: StocktakeLine[], username: string, notes: string): Promise<StocktakeResult> {
  return request<StocktakeResult>("/api/inventory/stocktakes", {
    method: "POST",
    body: { items, username, notes, warehouseId: "", branchId: "", countDate: null },
  });
}

/** One requested shortage line (POST/PUT body shape, routes/inventory.js ~4539). */
export interface ShortageLinePayload {
  invItemId: string;
  invItemName: string;
  unit: string;
  currentQty: number;
  minQty: number;
  requestedQty: number;
  unitPrice: number;
}

export type ShortageStatus =
  | "pending"
  | "approved"
  | "converted"
  | "rejected"
  | "partially_received"
  | "fully_received"
  | "closed";

export interface ShortageRequestSummary {
  id: string;
  requestNumber: string;
  requestDate: string;
  username: string;
  notes: string | null;
  status: ShortageStatus | string;
  totalItems: number;
  poId: string | null;
}

export interface ShortageRequestDetail extends ShortageRequestSummary {
  items: Array<{
    id: string;
    invItemId: string;
    invItemName: string;
    unit: string;
    currentQty: number;
    minQty: number;
    requestedQty: number;
    unitPrice: number;
  }>;
}

/** POST /api/inventory/shortage-requests → { success, id, requestNumber }.
 *  warehouseId/branchId empty = server resolves from the user's HR profile. */
export function createShortageRequest(body: {
  items: ShortageLinePayload[];
  username: string;
  notes: string;
}): Promise<{ success: boolean; id: string; requestNumber: string }> {
  return request("/api/inventory/shortage-requests", {
    method: "POST",
    body: { ...body, warehouseId: "", branchId: "" },
  });
}

/** PUT /api/inventory/shortage-requests/:id — pending requests only (server-enforced). */
export function updateShortageRequest(
  id: string,
  body: { items: ShortageLinePayload[]; notes: string },
): Promise<{ success: boolean }> {
  return request(`/api/inventory/shortage-requests/${encodeURIComponent(id)}`, { method: "PUT", body });
}

/** DELETE /api/inventory/shortage-requests/:id — pending requests only. */
export function deleteShortageRequest(id: string): Promise<{ success: boolean }> {
  return request(`/api/inventory/shortage-requests/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** GET /api/inventory/shortage-requests → raw array (no envelope). The caller
 *  filters to the current cashier client-side, exactly like legacy app.js:4536. */
export function getShortageRequests(): Promise<ShortageRequestSummary[]> {
  return request<ShortageRequestSummary[]>("/api/inventory/shortage-requests");
}

/** GET /api/inventory/shortage-requests/:id — NOTE: the server answers a
 *  not-found/denied with HTTP 200 + { error } (no success field), which the
 *  generic thrower doesn't catch — normalize that here. */
export async function getShortageRequest(id: string): Promise<ShortageRequestDetail> {
  const data = await request<ShortageRequestDetail & { error?: string }>(
    `/api/inventory/shortage-requests/${encodeURIComponent(id)}`,
  );
  if (data && typeof data.error === "string" && data.error) {
    throw new ApiError(404, "NOT_FOUND", data.error);
  }
  return data;
}

/** Purchase row — GET /api/purchases (routes/purchases.js ~48). Only the
 *  fields the receive flow reads; items_json lines historically used either
 *  id/name/unitPrice or itemId/itemName/price, so both pairs are optional. */
export interface PurchaseRow {
  id: string;
  poId: string | null;
  supplierName: string;
  items: Array<{
    id?: string;
    itemId?: string;
    name?: string;
    itemName?: string;
    unit?: string;
    qty: number;
    unitPrice?: number;
    price?: number;
  }>;
}

export function getPurchases(): Promise<PurchaseRow[]> {
  return request<PurchaseRow[]>("/api/purchases");
}

/** One received line (POST /api/inventory/receive-request body, app.js:4151). */
export interface ReceiveLinePayload {
  invItemId: string;
  invItemName: string;
  unit: string;
  orderedQty: number;
  receivedQty: number;
  unitPrice: number;
}

/** POST /api/inventory/receive-request — stores the counted quantities on the
 *  purchase (receive_status='pending'); an admin approves the stock write. */
export function submitReceiveRequest(body: {
  purchaseId: string;
  items: ReceiveLinePayload[];
  username: string;
}): Promise<{ success: boolean }> {
  return request("/api/inventory/receive-request", { method: "POST", body });
}

// ═══ END B1 POS-INVENTORY BLOCK ══════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════
// APPEND-ONLY BLOCK — close/b2-pos-daily (POS daily-ops parity).
// New endpoints only; nothing above this line was modified.
//   • GET  /api/shifts/:id/full-report      — X/Z thermal report data
//   • GET  /api/sales/invoice/:orderId      — reprint (identity + STAMPED QR)
//   • POST /api/erp/customers               — cashier creates a customer
//   • GET  /api/erp/customers/:id/summary   — customer totals + history
// Note on closeShiftV3 above: the close flow NOW sends the counted
// denominations (value/count/kind) alongside paymentTotals. Server-side,
// denominations>0 override the cash method's paymentTotals entry — the two are
// derived from the SAME grid so they are always equal, and sending the rows is
// what persists the breakdown (shift_close_denominations) that the Z-report
// prints. The older "denominations stay []" note above describes the pre-grid
// behavior and is superseded for callers that pass a real count.
// ═════════════════════════════════════════════════════════════════════════════

/** One method row of GET /api/shifts/:id/full-report (routes/shifts.js:591). */
export interface ShiftReportMethod {
  id: number | string;
  name: string;
  nameAr: string | null;
  icon: string | null;
  color: string | null;
  groupType: string | null;
  expected: number;
  actual: number;
  variance: number;
  count?: number;
}

/** GET /api/shifts/:id/full-report — the X/Z report payload. Token-gated:
 *  request() attaches the Authorization header like every other call here. */
export interface ShiftFullReport {
  shiftId: string;
  status: string;
  cashier: { username: string; name: string; empNo: string };
  branch: { name: string; address: string; companyName: string };
  company: { name: string; nameAr: string; taxNumber: string; currency: string; phone: string; email: string; logo: string };
  times: { start: string | null; end: string | null; durationMs: number | null };
  financials: {
    openingFloat: number;
    expectedTotal: number;
    actualTotal: number;
    variance: number;
    unmatched: number;
    /** Till movements folded into expectedTotal. Optional: a server that
     *  predates the movement feature omits them, and the report renders
     *  exactly as it always did. */
    payIn?: number;
    payOut?: number;
  };
  methods: ShiftReportMethod[];
  /** Itemised drawer movements (approved only) — the X/Z report lists these so
   *  the ± inside «expected» has a printed explanation. Optional for the same
   *  back-compat reason as financials.payIn/payOut above. */
  movements?: ShiftMovement[];
  movementTotals?: ShiftMovementTotals;
  soldItems: Array<{ name: string; qty: number; price: number; total: number }>;
  denominations: Array<{ value: number; kind: string; count: number }>;
  orderCount: number;
  itemsCount: number;
  notes: string;
}

export function shiftFullReport(shiftId: string): Promise<ShiftFullReport> {
  return request<ShiftFullReport>(`/api/shifts/${encodeURIComponent(shiftId)}/full-report`);
}

/**
 * GET /api/sales/invoice/:orderId — everything a REPRINT needs: the frozen
 * seller identity (snapshot-preferred server-side) and the STAMPED ZATCA QR
 * (`zatcaQr.qrDataUrl`, a server-rendered PNG). The client NEVER derives a QR.
 * The route answers `null` on any error (legacy contract) — callers must
 * handle a null resolution.
 */
export interface InvoiceDetail {
  orderId: string;
  date: string;
  payment: string | null;
  totalFinal: number;
  username: string;
  discountName: string | null;
  discountAmount: number;
  lineDiscounts: unknown;
  splitDetails: Array<{ method: string; amount: number }> | null;
  cashTendered: number;
  changeDue: number;
  // lineId = the real ar_document_lines.id for this line (null for a
  // pre-O2C-projection sale, or when O2C is disabled) — ReturnRequestDialog
  // requires it as originalLineId; the array position is rejected server-side.
  items: Array<{ name: string; qty: number; price: number; total: number; lineId: string | null }>;
  // ar_documents.version for this sale's O2C projection — required as
  // expectedVersion on a return create (null under the same conditions as lineId).
  version: number | null;
  /** The PERSON who made this sale, resolved server-side from the sale's OWN
   *  `sales.username` (routes/sales.js → lib/displayName.js: users.full_name →
   *  settings.user_meta → username). A reprint pulled up by a different cashier
   *  therefore still names the original seller. Worst case it IS the login id —
   *  never blank, never fabricated. */
  cashierName: string;
  /** Employee number, when the owner set one in settings.user_meta. Has no
   *  users-table equivalent, so it is '' far more often than not — a consumer
   *  must HIDE the field rather than print "أحمد عدلان, 2004". The server has
   *  always returned it (routes/sales.js response block); it was simply never
   *  declared here, so no screen could reach it. Optional to keep every
   *  existing InvoiceDetail literal (tests, fixtures) compiling. */
  cashierEmpNo?: string;
  branchName: string;
  branchAddress: string;
  branchCompanyName: string;
  companyName: string;
  taxNumber: string;
  currency: string;
  companyPhone: string;
  companyEmail: string;
  /** Brand logo when the sale has one, else the company logo — the server
   *  already resolves that precedence (routes/sales.js:2495). Declared here
   *  because the reprint was rebuilding identity with `logo: ""` and so the
   *  ORIGINAL receipt printed the shop's logo while its own reprint did not. */
  receiptLogo?: string;
  receiptFooter: string;
  crNumber: string;
  nationalAddress: string;
  receiptHeader: string;
  receiptThankYou: string;
  receiptReturnPolicy: string;
  identitySource: "snapshot" | "live";
  brandName: string;
  customerId: string | null;
  customerName: string;
  customerPhone: string;
  paymentNotes: string | null;
  zatcaType: string | null;
  zatcaQr: { qrBase64: string; qrDataUrl: string | null; stored: boolean } | null;
  invoiceNumber: string | null;
  voidSerial: string | null;
  returnSerial: string | null;
}

export function getInvoice(orderId: string): Promise<InvoiceDetail | null> {
  return request<InvoiceDetail | null>(`/api/sales/invoice/${encodeURIComponent(orderId)}`);
}

/**
 * POST /api/erp/customers — the legacy add-customer contract EXACTLY
 * (public/pos/app.js doSave :1808): id:'' means INSERT; the route answers
 * {success:false,error} with HTTP 200 on failure, which request() converts to
 * an ApiError (duplicate-phone messages surface through e.message).
 */
export interface NewCustomerInput {
  name: string;
  phone: string;
  vatNumber?: string;
  customerType?: "B2C" | "B2B" | "B2G";
}

export function createErpCustomer(input: NewCustomerInput, username: string): Promise<{ success: boolean; id: string }> {
  return request<{ success: boolean; id: string }>("/api/erp/customers", {
    method: "POST",
    body: {
      id: "", // empty = INSERT (legacy contract)
      name: input.name,
      nameEn: "",
      vatNumber: input.vatNumber ?? "",
      phone: input.phone,
      email: "",
      address: "",
      city: "",
      customerType: input.customerType ?? "B2C",
      creditLimit: 0,
      gender: "unknown",
      username,
    },
  });
}

/** GET /api/erp/customers/:id/summary — totals strip + recent purchases
 *  (routes/erp/customers.js:233; legacy consumer _posCustomerLoadSummary :1347). */
export interface CustomerSummaryData {
  success: boolean;
  customer: {
    id: string;
    name: string;
    nameEn: string | null;
    phone: string;
    email: string;
    gender: string;
    customerType: string;
    balance: number;
    creditLimit: number;
    createdAt: string;
    isActive: boolean;
  };
  kpi: {
    orderCount: number;
    totalSpent: number;
    avgInvoice: number;
    firstVisit: string | null;
    lastVisit: string | null;
  };
  recentInvoices: Array<{
    id: string;
    invoiceNumber: string | null;
    date: string;
    total: number;
    payment: string;
    zatcaType: string;
    voidSerial: string | null;
    returnSerial: string | null;
    hasCreditNote: boolean;
  }>;
}

export function getCustomerSummary(id: string): Promise<CustomerSummaryData> {
  return request<CustomerSummaryData>(`/api/erp/customers/${encodeURIComponent(id)}/summary`);
}

// ═════════════════════════════════════════════════════════════════════════════
// APPEND-ONLY BLOCK — close2/pos-returns (O2C sales-return raised by the cashier).
// New exports only; nothing above this line was modified EXCEPT listSales gained
// an optional `shiftId` param (server-side shift filtering).
//   • POST /api/order-to-cash/returns  — cashier raises a partial per-line return.
// Contract confirmed by reading the ACTUAL route files:
//   - mount: routes/order-to-cash/index.js → router.use('/returns', ...) under
//     /api/order-to-cash (server.js:639), so the endpoint is
//     POST /api/order-to-cash/returns.
//   - capability: routes/order-to-cash/returns.js requireCapability('returns.create');
//     db/migrations/order-to-cash/capabilities.js ROLE_GRANTS.cashier includes
//     'returns.create' → the cashier may raise (but not approve/post) a return.
//   - body: services/order-to-cash/SalesReturnService.create reads originalSaleId
//     (resolves the original ar_document via source_type='pos' AND source_id),
//     lines[{ originalLineId (=ar_document_lines.id), returnQty, restock }],
//     reason, refundMethod (default 'ar_reduction'). Over-return, tax/cost
//     snapshotting and separation-of-duties are all enforced server-side.
//   - response: 201 with the O2C envelope { success, data, documentNumber,
//     status, version } — a fresh return is status 'draft' / DRAFT-xxxx.
// ═════════════════════════════════════════════════════════════════════════════

export interface SalesReturnLineInput {
  /**
   * The ORIGINAL invoice line's ar_document_lines.id — the server maps a return
   * line against THIS id (SalesReturnService.create: byId[l.id]), not the POS
   * sales_items id. Supplied per-line by the invoice-detail response.
   */
  originalLineId: string;
  returnQty: number;
}

export interface CreateSalesReturnInput {
  /** The POS sale id; the server resolves the original ar_document from it. */
  originalSaleId: string;
  /** Mandatory human reason — surfaced on the credit note / audit trail. */
  reason: string;
  lines: SalesReturnLineInput[];
  /** Defaults to 'ar_reduction' server-side; the cashier dialog never overrides. */
  refundMethod?: string;
}

/**
 * The O2C success envelope for a freshly created return (HTTP 201). A new return
 * is always status 'draft' (documentNumber 'DRAFT-xxxx') — POSTING it (the money
 * movement + credit note) is a separate MANAGER action, so the cashier only ever
 * sees the draft that awaits approval.
 */
export interface SalesReturnCreated {
  success: boolean;
  data: { id: string; status: string; version: number; return_number?: string } & Record<string, unknown>;
  documentNumber: string | null;
  status: string | null;
  version: number | null;
}

/**
 * POST /api/order-to-cash/returns — raise a partial, per-line sales return.
 * `Idempotency-Key` makes a retry safe (the server replays the same draft).
 * `expectedVersion`, when known, rides as `If-Match` — the codebase's optimistic-
 * concurrency convention (lib/order-to-cash/http.js expectedVersionOf reads the
 * if-match header). `restock` is forced FALSE on every line: deciding goods go
 * back on the shelf moves stock + reverses COGS and needs returns.restock, a
 * manager capability the cashier does not hold.
 */
export function createSalesReturn(
  input: CreateSalesReturnInput,
  opts: { idempotencyKey: string; expectedVersion?: number | null },
): Promise<SalesReturnCreated> {
  const headers: Record<string, string> = { "Idempotency-Key": opts.idempotencyKey };
  if (opts.expectedVersion != null) headers["If-Match"] = String(opts.expectedVersion);
  return request<SalesReturnCreated>("/api/order-to-cash/returns", {
    method: "POST",
    body: {
      originalSaleId: input.originalSaleId,
      reason: input.reason,
      refundMethod: input.refundMethod ?? "ar_reduction",
      lines: input.lines.map((l) => ({ originalLineId: l.originalLineId, returnQty: l.returnQty, restock: false })),
    },
    headers,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// APPEND-ONLY BLOCK — close2/stocktake-pro-pos.
// Professional PER-WAREHOUSE stocktake (جرد احترافي) against the v2 system
//   /api/inventory/v2/stocktakes   (routes/inventory-stocktakes.js).
// Replaces the legacy one-shot POST /api/inventory/stocktakes — which compared
// the count against a company-wide stock ROLLUP while the write landed in one
// warehouse — with the create → start → counts → submit lifecycle, so the count
// is reconciled against, and its adjustment lands in, ONE specific warehouse.
// The cashier's role ENDS at submit; a manager approves + posts in the ERP.
// New exports only; nothing above this line was modified.
// ═════════════════════════════════════════════════════════════════════════════

/** RFC-4122 idempotency key (mirrors the ERP useStocktakes uid() helper). */
export function stkIdempotencyKey(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* jsdom / older runtime — fall through */
  }
  return "idem-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Decode the base64url JSON payload of the shared pos_token WITHOUT verifying
 *  the signature (resolution/display only — the server verifies every request).
 *  Mirrors lib/auth.decodeUser, but reads the warehouse claim it doesn't expose. */
function decodeTokenPayload(): Record<string, unknown> | null {
  const token = getToken();
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder("utf-8").decode(bytes)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The cashier's OWN warehouse from the JWT (users.default_warehouse_id — the
 *  exact field the legacy stocktake route resolved server-side). "" when absent. */
export function cashierWarehouseIdFromToken(): string {
  const p = decodeTokenPayload();
  if (!p) return "";
  const w = p.default_warehouse_id ?? p.warehouseId ?? p.warehouse_id;
  return w == null ? "" : String(w);
}

export interface AccessScope {
  success: boolean;
  enforced: boolean;
  role: string;
  allWarehousesAccess: boolean;
  accessibleWarehouses: Array<{ id: string; name: string; code: string; type: string; branchId: string; isActive: boolean }>;
}

/** GET /api/inventory/access-scope — the caller's accessible warehouses. */
export function getInventoryAccessScope(): Promise<AccessScope> {
  return request<AccessScope>("/api/inventory/access-scope");
}

/**
 * Resolve the warehouse a cashier's stocktake must target. Primary source is the
 * JWT default_warehouse_id (authoritative, offline-safe). When that is empty we
 * fall back to the SINGLE warehouse this user is scoped to (access-scope). Returns
 * null when the warehouse can't be determined unambiguously — the caller MUST
 * surface a clear error rather than send an empty warehouseId: the v2 create 422s
 * on a missing warehouse, it does NOT auto-resolve like the legacy route did.
 */
export async function resolveStocktakeWarehouseId(): Promise<string | null> {
  const fromJwt = cashierWarehouseIdFromToken();
  if (fromJwt) return fromJwt;
  try {
    const scope = await getInventoryAccessScope();
    const list = scope.accessibleWarehouses || [];
    if (list.length === 1) return list[0].id;
  } catch {
    /* unresolved → null below */
  }
  return null;
}

/** A single count line for PUT /:id/counts. countedQty is the total already in
 *  the item's BASE unit; the server defaults an entry with no enteredUnitId to
 *  base (lib/itemUnits.resolveLineBase), so a pre-summed dual-unit total lands
 *  1:1 without a UNIT_CONVERSION_CONFLICT. */
export interface StocktakeCountV2 {
  itemId: string;
  countedQty: number;
}

/** The v2 mutation envelope (lib/inventoryTxContract.mutationEnvelope). create
 *  also spreads a legacy top-level {id, number}; transitions carry data.id. */
export interface StocktakeMutationV2 {
  success: boolean;
  data: { id?: string; lines?: number } | null;
  documentNumber: string | null;
  status: string | null;
  version: number | null;
  id?: string;
  number?: string;
}

export interface CreateStocktakeV2Input {
  warehouseId: string;
  itemIds: string[];
  reason?: string;
  scopeType?: "full" | "category" | "items";
  includeZero?: boolean;
  blindCount?: boolean;
}

/** POST /api/inventory/v2/stocktakes — create a draft (Idempotency-Key required
 *  server-side). The POS flow scopes to the EXACT items the cashier counted
 *  (scopeType 'items') with includeZero so a surplus item at 0 system stock
 *  still gets a frozen line at /start. */
export function createStocktakeV2(input: CreateStocktakeV2Input, idempotencyKey: string): Promise<StocktakeMutationV2> {
  return request<StocktakeMutationV2>("/api/inventory/v2/stocktakes", {
    method: "POST",
    body: {
      warehouseId: input.warehouseId,
      scopeType: input.scopeType ?? "items",
      itemIds: input.itemIds,
      includeZero: input.includeZero ?? true,
      blindCount: input.blindCount ?? true,
      reason: input.reason ?? "",
    },
    headers: { "Idempotency-Key": idempotencyKey },
  });
}

/** POST /:id/start — freeze the per-warehouse snapshot (draft → counting). */
export function startStocktakeV2(id: string, expectedVersion: number): Promise<StocktakeMutationV2> {
  return request<StocktakeMutationV2>(`/api/inventory/v2/stocktakes/${encodeURIComponent(id)}/start`, {
    method: "POST",
    body: { expectedVersion },
  });
}

export interface SaveCountsV2Result {
  success: boolean;
  data: { id: string };
  status: string;
  applied: number;
  conflicts: Array<{ lineId: string; itemId: string; itemName: string; code: string; message: string }>;
  aggregates?: unknown;
}

/** PUT /:id/counts — record counted quantities (counting only). This route is
 *  the autosave target and is deliberately NOT version-guarded server-side
 *  (mirrors the ERP saveCounts hook): per-line FOR UPDATE locks + the
 *  status='counting' guard prevent lost updates, and a count sent after the doc
 *  left 'counting' comes back as VERSION_CONFLICT rather than a silent write. */
export function saveStocktakeCountsV2(id: string, counts: StocktakeCountV2[]): Promise<SaveCountsV2Result> {
  return request<SaveCountsV2Result>(`/api/inventory/v2/stocktakes/${encodeURIComponent(id)}/counts`, {
    method: "PUT",
    body: { counts },
  });
}

/** POST /:id/submit — hand the count off for approval (counting → submitted).
 *  This is where the CASHIER's job ENDS; a manager approves + posts in the ERP.
 *  Version-guarded, so a double-submit resolves to VERSION_CONFLICT, never two
 *  submits. */
export function submitStocktakeV2(id: string, expectedVersion: number): Promise<StocktakeMutationV2> {
  return request<StocktakeMutationV2>(`/api/inventory/v2/stocktakes/${encodeURIComponent(id)}/submit`, {
    method: "POST",
    body: { expectedVersion },
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// APPEND-ONLY BLOCK — w1b/86-board. Recipe-driven availability for the grid.
//   • GET /api/menu/availability/bulk  (routes/menu.js:1070)
// New export only; nothing above this line was modified except the type import.
//
// CONTRACT, read off the route itself:
//   - Response is a BARE MAP `{ [menuId]: {mode, makeable, isOutOfStock,
//     isLowStock, blockerCount, hasRecipe} }` — NO {success,data} envelope, and
//     NO array. request() passes a bare 2xx object straight through.
//   - `LIMIT 500` server-side: a bigger menu is partially covered, which is
//     exactly why an absent key means "no opinion", never "out of stock".
//   - Reachable from the cashier portal: middleware/posPortalScope.js allows
//     `GET /menu(/.*)?`, so this path needs no allow-list change.
//   - An older server has no such route → 404 → ApiError. THAT IS EXPECTED, and
//     the caller (state/store.tsx) swallows it and falls back to
//     CatalogItem.warehouseQty. This function is deliberately NOT defensive
//     about transport: it throws like every other call here, and the ONE
//     degradation point lives with the query that owns the fallback.
// ═════════════════════════════════════════════════════════════════════════════

/** Coerce one server row into MenuAvailability, dropping anything malformed.
 *  The map keys are menu ids typed by an owner, so nothing here is trusted. */
function toMenuAvailability(raw: unknown): MenuAvailability | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const makeable = Number(o.makeable);
  return {
    mode: typeof o.mode === "string" ? o.mode : "",
    makeable: Number.isFinite(makeable) ? makeable : 0,
    isOutOfStock: o.isOutOfStock === true,
    isLowStock: o.isLowStock === true,
    blockerCount: Number.isFinite(Number(o.blockerCount)) ? Number(o.blockerCount) : 0,
    hasRecipe: o.hasRecipe === true,
  };
}

/**
 * GET /api/menu/availability/bulk — recipe/BOM-driven availability per menu item.
 * `warehouseId` narrows ingredient stock to one branch store (the route falls
 * back to global inv_items.stock for anything absent from warehouse_stock).
 */
export async function fetchMenuAvailabilityBulk(
  params: { brandId?: string | null; warehouseId?: string | null } = {},
): Promise<MenuAvailabilityMap> {
  const q = new URLSearchParams();
  if (params.brandId) q.set("brandId", params.brandId);
  if (params.warehouseId) q.set("warehouseId", params.warehouseId);
  const qs = q.toString();
  const body = await request<unknown>(`/api/menu/availability/bulk${qs ? `?${qs}` : ""}`);
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const out: MenuAvailabilityMap = {};
  for (const [menuId, row] of Object.entries(body as Record<string, unknown>)) {
    const parsed = toMenuAvailability(row);
    if (parsed) out[menuId] = parsed;
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// APPEND-ONLY BLOCK — W2-B: the three Order-to-Cash reads/writes the cashier
// already HOLDS the capability for but had no way to reach from the till.
// New exports only; nothing above this line was modified.
//
// Contracts confirmed by reading the ROUTE + SERVICE files, not guessed:
//   • GET  /api/order-to-cash/customers/:id/exposure  routes/order-to-cash/customers.js:52
//       requireCapability('customers.view')  → cashier HOLDS it
//       (db/migrations/order-to-cash/capabilities.js ROLE_GRANTS.cashier).
//       Body: H.sendData → { success, data, generatedAt } where data is
//       CreditLimitService.exposure() = { creditLimit, exposure, available,
//       utilizationPct, paymentTerms, creditDays, isActive }.
//   • POST /api/order-to-cash/payments               routes/order-to-cash/payments.js:41
//       requireCapability('payments.create') → cashier HOLDS it.
//       Body read by CustomerPaymentService.create: { customerId (required),
//       customerName, amount (>0), paymentDate, paymentMethod, destinationType
//       ('cash'|'bank'), destinationId, reference, notes, allocations[] }.
//       Creates status 'draft' ONLY — approve/post are separate manager
//       capabilities the cashier does not hold, and are never called here.
//       Envelope: 201 { success, data, documentNumber (payment_number),
//       status, version }. Idempotency-Key makes a retry replay the same draft
//       (events.findPrior on scope customer_payment:create).
//   • GET  /api/order-to-cash/returns                routes/order-to-cash/returns.js:24
//       requireCapability('returns.view')    → cashier HOLDS it.
//       list() selects id, return_number, original_ar_document_id, customer_id,
//       customer_name, return_date, subtotal, vat_amount, total_amount,
//       refund_method, status, credit_note_id, version — snake_case, NOT shaped.
//       NOTE: list() has NO created_by filter, so "the returns I raised" is
//       resolved CLIENT-side against the local ledger below.
//
// DEGRADATION — every one of these is behind ORDER_TO_CASH_ENABLE (server.js:664).
// With the flag off the router is never mounted → 404. With the flag on but the
// cashier-portal allow-list not yet widened (middleware/posPortalScope.js) →
// 403 PERMISSION_DENIED / reason PORTAL_FORBIDDEN. Both are "this till cannot
// do that", never "something broke": callers must route them through
// `isFeatureUnavailable()` and HIDE the affordance rather than show an error.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Is this failure "the feature is not reachable from this till" rather than a
 * real error worth showing the cashier?
 *   404 — ORDER_TO_CASH_ENABLE is off, so /api/order-to-cash is not mounted.
 *   403 — the portal allow-list (or a capability) does not cover the path.
 *   501 — an older server that stubs the route.
 * Anything else (422 validation, 409 conflict, 500) is a REAL failure and must
 * be surfaced verbatim.
 */
export function isFeatureUnavailable(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  return e.status === 403 || e.status === 404 || e.status === 501;
}

// ── 1. Credit exposure, BEFORE the tender ───────────────────────────────────

export interface CustomerExposure {
  creditLimit: number;
  /** Live AR balance already outstanding. */
  exposure: number;
  /** creditLimit − exposure. Negative when the customer is already over. */
  available: number;
  /** null when the limit is 0 (nothing to divide by). */
  utilizationPct: number | null;
  paymentTerms: string | null;
  creditDays: number;
  isActive: boolean;
}

/**
 * GET /api/order-to-cash/customers/:id/exposure — the credit limit against live
 * AR. Read at ATTACH time so the cashier sees the ceiling while the customer is
 * still choosing, instead of meeting CREDIT_LIMIT_EXCEEDED at the tender.
 */
export async function getCustomerExposure(customerId: string): Promise<CustomerExposure> {
  const body = await request<{ data: Partial<CustomerExposure> }>(
    `/api/order-to-cash/customers/${encodeURIComponent(customerId)}/exposure`,
  );
  const d = body?.data ?? {};
  const utilization = Number(d.utilizationPct);
  return {
    creditLimit: Number(d.creditLimit) || 0,
    exposure: Number(d.exposure) || 0,
    available: Number(d.available) || 0,
    utilizationPct: d.utilizationPct == null || !Number.isFinite(utilization) ? null : utilization,
    paymentTerms: d.paymentTerms == null ? null : String(d.paymentTerms),
    creditDays: Number(d.creditDays) || 0,
    isActive: d.isActive !== false,
  };
}

// ── 2. سند قبض — collect a payment on account (DRAFT only) ──────────────────

export interface CustomerPaymentDraftInput {
  customerId: string;
  customerName?: string | null;
  /** Must be > 0 — the service throws VALIDATION_ERROR otherwise. */
  amount: number;
  /** 'cash' | 'bank'. Anything else is coerced to 'cash' server-side. */
  destinationType: "cash" | "bank";
  reference?: string | null;
  notes?: string | null;
}

export interface CustomerPaymentCreated {
  success: boolean;
  data: { id: string; status: string; version: number; payment_number?: string } & Record<string, unknown>;
  documentNumber: string | null;
  status: string | null;
  version: number | null;
}

/**
 * POST /api/order-to-cash/payments — record a collection on account as a DRAFT.
 *
 * The till never approves or posts: `payments.approve` / `payments.post` are
 * sensitive capabilities held by manager/accountant/finance only
 * (capabilities.js ROLE_GRANTS), and the money does not move until a manager
 * posts it. No `allocations` are sent either — deciding WHICH invoices a
 * collection settles is the accountant's call at post time; an empty
 * allocations list makes the draft an advance (is_advance=1) which the manager
 * can then allocate.
 */
export function createCustomerPayment(
  input: CustomerPaymentDraftInput,
  opts: { idempotencyKey: string },
): Promise<CustomerPaymentCreated> {
  return request<CustomerPaymentCreated>("/api/order-to-cash/payments", {
    method: "POST",
    headers: { "Idempotency-Key": opts.idempotencyKey },
    body: {
      customerId: input.customerId,
      customerName: input.customerName ?? null,
      amount: input.amount,
      destinationType: input.destinationType,
      paymentMethod: input.destinationType,
      reference: input.reference || null,
      notes: input.notes || null,
    },
  });
}

// ── 3. Return status + history ──────────────────────────────────────────────

/** One row of GET /api/order-to-cash/returns — the raw snake_case SELECT. */
export interface SalesReturnRow {
  id: string;
  returnNumber: string | null;
  customerName: string | null;
  returnDate: string | null;
  totalAmount: number;
  status: string;
  creditNoteId: string | null;
}

interface RawSalesReturnRow {
  id?: unknown;
  return_number?: unknown;
  customer_name?: unknown;
  return_date?: unknown;
  total_amount?: unknown;
  status?: unknown;
  credit_note_id?: unknown;
}

function toSalesReturnRow(raw: RawSalesReturnRow): SalesReturnRow {
  return {
    id: String(raw.id ?? ""),
    returnNumber: raw.return_number == null ? null : String(raw.return_number),
    customerName: raw.customer_name == null ? null : String(raw.customer_name),
    returnDate: raw.return_date == null ? null : String(raw.return_date),
    totalAmount: Number(raw.total_amount) || 0,
    status: String(raw.status ?? ""),
    creditNoteId: raw.credit_note_id == null ? null : String(raw.credit_note_id),
  };
}

/**
 * GET /api/order-to-cash/returns — the returns window, newest first.
 * The route has no created_by filter, so this is the BRANCH's recent returns;
 * the caller narrows to the ones this till raised via the ledger below.
 */
export async function listSalesReturns(params: { pageSize?: number } = {}): Promise<SalesReturnRow[]> {
  const q = new URLSearchParams({
    page: "1",
    pageSize: String(params.pageSize ?? 100),
    sort: "returnDate",
    dir: "DESC",
  });
  const body = await request<{ data?: RawSalesReturnRow[] }>(`/api/order-to-cash/returns?${q.toString()}`);
  const rows = Array.isArray(body?.data) ? body.data : [];
  return rows.map(toSalesReturnRow);
}

// GET /api/order-to-cash/returns/:id exists too (returns.js:31) and is equally
// within `returns.view`, but nothing here calls it: the list already carries
// every field «مرتجعاتي» shows, and adding a per-row detail fetch would mean
// asking the merge owner to widen the cashier-portal allow-list for a path the
// app does not use. It stays unwired on purpose.

// ── The local "returns I raised" ledger ─────────────────────────────────────
// WHY IT EXISTS: SalesReturnService.list() filters by status / customerId / q —
// there is NO created_by filter and the SELECT does not even project the
// column, so the server cannot answer "the returns THIS cashier raised". The
// till records its own creates (they are its own writes, no new trust needed)
// and intersects them with the server list, which stays the authority on
// STATUS. A ledger entry the server does not return is shown as unknown, never
// as a stale local status.

const RAISED_RETURNS_KEY = "pos_o2c_raised_returns";
const RAISED_RETURNS_CAP = 50;

export interface RaisedReturnRef {
  id: string;
  documentNumber: string | null;
  /** The POS sale the return was raised against. */
  originalSaleId: string;
  /** epoch ms, for newest-first ordering. */
  raisedAt: number;
}

export function listRaisedReturns(): RaisedReturnRef[] {
  try {
    const raw = localStorage.getItem(RAISED_RETURNS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((r) => r as Partial<RaisedReturnRef>)
      .filter((r) => r && typeof r.id === "string" && r.id.length > 0)
      .map((r) => ({
        id: String(r.id),
        documentNumber: r.documentNumber == null ? null : String(r.documentNumber),
        originalSaleId: String(r.originalSaleId ?? ""),
        raisedAt: Number(r.raisedAt) || 0,
      }))
      .sort((a, b) => b.raisedAt - a.raisedAt);
  } catch {
    return []; // private mode / quota / corrupt JSON — never break the dialog
  }
}

/** Append (or refresh) one raised return. Newest first, capped, de-duplicated. */
export function recordRaisedReturn(ref: Omit<RaisedReturnRef, "raisedAt"> & { raisedAt?: number }): void {
  if (!ref?.id) return;
  try {
    const next = [
      { ...ref, raisedAt: ref.raisedAt ?? Date.now() },
      ...listRaisedReturns().filter((r) => r.id !== ref.id),
    ].slice(0, RAISED_RETURNS_CAP);
    localStorage.setItem(RAISED_RETURNS_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable — the feature degrades to "no history", not a crash */
  }
}

/** Test hook — clears the ledger. */
export function _resetRaisedReturns(): void {
  try {
    localStorage.removeItem(RAISED_RETURNS_KEY);
  } catch {
    /* ignore */
  }
}


/**
 * Unwrap the { success, data } envelope.
 *
 * `request()` returns the RAW body (`return body as T`), and this repo uses two
 * response shapes: some routes answer a bare payload (GET /api/inventory/items),
 * others the envelope (routes/stocktake-templates.js `_ok`). Forgetting which is
 * which has already cost a production outage today — the channel catalog stored
 * the envelope as if it were the catalog and emptied the register. So the
 * unwrapping is EXPLICIT and shape-checked here rather than assumed at each call
 * site, and a payload that is neither shape yields the fallback instead of a
 * `.find is not a function` crash inside a dialog.
 */
function unwrapEnvelope<T>(body: unknown, isValid: (v: unknown) => boolean, fallback: T): T {
  if (isValid(body)) return body as T;
  const inner = (body as { data?: unknown } | null)?.data;
  if (isValid(inner)) return inner as T;
  return fallback;
}

// ── نماذج الجرد — saved stocktake templates ─────────────────────────────────
// A named, reusable set of the materials the owner counts periodically. He
// creates it once at the till, then picks it, edits it and reuses it instead of
// re-finding thirty items by hand every cycle.
// Server: routes/stocktake-templates.js, mounted at
// /api/inventory/stocktake-templates (deliberately NOT under /inventory/v2 —
// that prefix is 503'd by the V2 write gate whenever WAREHOUSE_V2_ENABLED is
// off, and a register must still be able to save its own count sheet then).

export interface StocktakeTemplateItem {
  itemId: string;
  name: string;
  unit?: string | null;
}

export interface StocktakeTemplate {
  id: string;
  name: string;
  warehouseId: string | null;
  itemIds: string[];
  items: StocktakeTemplateItem[];
  itemCount: number;
  createdBy: string;
  createdAt: string;
  /** Server-decided, never inferred client-side: yours, or you are a manager. */
  canEdit: boolean;
  canDelete: boolean;
}

/**
 * "Is this the PAYLOAD, or the envelope around it?"
 *
 * `typeof v === "object"` is not enough — `{ success, data }` is an object too,
 * so a loose check happily returns the envelope and the caller reads `undefined`
 * off it. Every payload on these routes carries an `id`; the envelope does not.
 */
const isTemplateObject = (v: unknown): boolean =>
  !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as { id?: unknown }).id === "string";

export async function listStocktakeTemplates(): Promise<StocktakeTemplate[]> {
  const body = await request<unknown>("/api/inventory/stocktake-templates");
  return unwrapEnvelope<StocktakeTemplate[]>(body, Array.isArray, []);
}

export async function createStocktakeTemplate(input: { name: string; itemIds: string[] }): Promise<StocktakeTemplate> {
  const body = await request<unknown>("/api/inventory/stocktake-templates", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return unwrapEnvelope<StocktakeTemplate>(body, isTemplateObject, {} as StocktakeTemplate);
}

export async function updateStocktakeTemplate(
  id: string,
  input: { name?: string; itemIds?: string[] },
): Promise<StocktakeTemplate> {
  const body = await request<unknown>(`/api/inventory/stocktake-templates/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
  return unwrapEnvelope<StocktakeTemplate>(body, isTemplateObject, {} as StocktakeTemplate);
}

export async function deleteStocktakeTemplate(id: string): Promise<{ id: string }> {
  const body = await request<unknown>(`/api/inventory/stocktake-templates/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  return unwrapEnvelope<{ id: string }>(body, isTemplateObject, { id });
}
