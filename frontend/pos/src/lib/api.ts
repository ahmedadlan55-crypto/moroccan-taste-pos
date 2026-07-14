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
