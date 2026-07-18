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

async function request<T>(
  path: string,
  opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
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
  if (!res.ok || (body && body.success === false)) {
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

export function postSync(ops: Array<{ opId: string; type: string; orderId?: string; payload: unknown }>): Promise<{
  success: boolean;
  results: SyncResultRow[];
}> {
  return request("/api/pos/v2/sync", { method: "POST", body: { ops } });
}

// ── Shifts (legacy endpoints) ────────────────────────────────────────────────
export function openShift(): Promise<{ success: boolean; shiftId: string }> {
  return request("/api/shifts/open", {
    method: "POST",
    body: { device: { ua: typeof navigator !== "undefined" ? navigator.userAgent : "pos-v2" } },
  });
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
 * The endpoint has NO shift filter, so callers narrow by shiftId themselves
 * (exactly what the legacy POS does at app.js:3300).
 */
export function listSales(params: {
  startDate?: string;
  endDate?: string;
  username?: string;
  paymentMethod?: string;
  customerId?: string;
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
  financials: { openingFloat: number; expectedTotal: number; actualTotal: number; variance: number; unmatched: number };
  methods: ShiftReportMethod[];
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
  items: Array<{ name: string; qty: number; price: number; total: number }>;
  cashierName: string;
  branchName: string;
  branchAddress: string;
  branchCompanyName: string;
  companyName: string;
  taxNumber: string;
  currency: string;
  companyPhone: string;
  companyEmail: string;
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
