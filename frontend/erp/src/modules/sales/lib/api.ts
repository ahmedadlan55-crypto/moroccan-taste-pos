// Order-to-Cash API surface. Thin typed wrappers over the SHARED apiClient
// (@/shared/api) — SD3 rewired this off the sales app's local api-client onto the
// unified client. Every MUTATION carries a fresh Idempotency-Key (safe retry) and,
// where a version is known, an If-Match header (optimistic concurrency → 409 on
// stale). Endpoints, request shapes and business logic are UNCHANGED.
import { apiClient, type RequestOptions } from "@/shared/api";
import type {
  Customer, Customer360, CustomerStatement, Dashboard, DataResponse, Invoice, ListResponse,
  MutationResponse, Payment, SalesReturn,
} from "./types";

const B = "/order-to-cash";

export function newIdempotencyKey(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* fall through */ }
  return "idem-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

function mutHeaders(version?: number | null): Record<string, string> {
  const h: Record<string, string> = { "Idempotency-Key": newIdempotencyKey() };
  if (version !== undefined && version !== null) h["If-Match"] = String(version);
  return h;
}

type Params = RequestOptions["params"];

export const o2cApi = {
  // ── dashboard ──
  dashboard: (signal?: AbortSignal) => apiClient.get<DataResponse<Dashboard>>(`${B}/dashboard`, { signal }),

  // ── customers ──
  customers: (params: Params, signal?: AbortSignal) => apiClient.get<ListResponse<Customer>>(`${B}/customers`, { params, signal }),
  customerSearch: (params: Params, signal?: AbortSignal) => apiClient.get<ListResponse<Customer>>(`${B}/customers/search`, { params, signal }),
  customer: (id: string, signal?: AbortSignal) => apiClient.get<DataResponse<Customer>>(`${B}/customers/${id}`, { signal }),
  customer360: (id: string, signal?: AbortSignal) => apiClient.get<DataResponse<Customer360>>(`${B}/customers/${id}/360`, { signal }),
  customerStatement: (id: string, params: Params, signal?: AbortSignal) => apiClient.get<DataResponse<CustomerStatement>>(`${B}/customers/${id}/statement`, { params, signal }),
  createCustomer: (body: unknown) => apiClient.post<MutationResponse>(`${B}/customers`, body, { headers: mutHeaders() }),
  updateCustomer: (id: string, body: unknown) => apiClient.put<MutationResponse>(`${B}/customers/${id}`, body, { headers: mutHeaders() }),
  deactivateCustomer: (id: string) => apiClient.post<MutationResponse>(`${B}/customers/${id}/deactivate`, {}, { headers: mutHeaders() }),
  activateCustomer: (id: string) => apiClient.post<MutationResponse>(`${B}/customers/${id}/activate`, {}, { headers: mutHeaders() }),
  mergePreview: (id: string, target: string, signal?: AbortSignal) => apiClient.get<DataResponse<unknown>>(`${B}/customers/${id}/merge-preview`, { params: { target }, signal }),
  mergeCustomer: (id: string, targetId: string) => apiClient.post<MutationResponse>(`${B}/customers/${id}/merge`, { targetId }, { headers: mutHeaders() }),

  // ── invoices ──
  invoices: (params: Params, signal?: AbortSignal) => apiClient.get<ListResponse<Invoice>>(`${B}/invoices`, { params, signal }),
  invoice: (id: string, signal?: AbortSignal) => apiClient.get<DataResponse<Invoice>>(`${B}/invoices/${id}`, { signal }),
  createInvoice: (body: unknown) => apiClient.post<MutationResponse>(`${B}/invoices`, body, { headers: mutHeaders() }),
  issueInvoice: (id: string, version?: number, body?: unknown) => apiClient.post<MutationResponse>(`${B}/invoices/${id}/issue`, body ?? {}, { headers: mutHeaders(version) }),
  cancelInvoice: (id: string, version?: number) => apiClient.post<MutationResponse>(`${B}/invoices/${id}/cancel`, {}, { headers: mutHeaders(version) }),

  // ── payments ──
  payments: (params: Params, signal?: AbortSignal) => apiClient.get<ListResponse<Payment>>(`${B}/payments`, { params, signal }),
  payment: (id: string, signal?: AbortSignal) => apiClient.get<DataResponse<Payment>>(`${B}/payments/${id}`, { signal }),
  createPayment: (body: unknown) => apiClient.post<MutationResponse>(`${B}/payments`, body, { headers: mutHeaders() }),
  approvePayment: (id: string, version?: number) => apiClient.post<MutationResponse>(`${B}/payments/${id}/approve`, {}, { headers: mutHeaders(version) }),
  postPayment: (id: string, version?: number, body?: unknown) => apiClient.post<MutationResponse>(`${B}/payments/${id}/post`, body ?? {}, { headers: mutHeaders(version) }),
  allocatePayment: (id: string, body: unknown) => apiClient.post<MutationResponse>(`${B}/payments/${id}/allocate`, body, { headers: mutHeaders() }),
  reversePayment: (id: string, version?: number) => apiClient.post<MutationResponse>(`${B}/payments/${id}/reverse`, {}, { headers: mutHeaders(version) }),
  cancelPayment: (id: string, version?: number) => apiClient.post<MutationResponse>(`${B}/payments/${id}/cancel`, {}, { headers: mutHeaders(version) }),

  // ── returns ──
  returns: (params: Params, signal?: AbortSignal) => apiClient.get<ListResponse<SalesReturn>>(`${B}/returns`, { params, signal }),
  salesReturn: (id: string, signal?: AbortSignal) => apiClient.get<DataResponse<SalesReturn>>(`${B}/returns/${id}`, { signal }),
  createReturn: (body: unknown) => apiClient.post<MutationResponse>(`${B}/returns`, body, { headers: mutHeaders() }),
  approveReturn: (id: string, version?: number) => apiClient.post<MutationResponse>(`${B}/returns/${id}/approve`, {}, { headers: mutHeaders(version) }),
  postReturn: (id: string, version?: number) => apiClient.post<MutationResponse>(`${B}/returns/${id}/post`, {}, { headers: mutHeaders(version) }),
  reverseReturn: (id: string, version?: number) => apiClient.post<MutationResponse>(`${B}/returns/${id}/reverse`, {}, { headers: mutHeaders(version) }),
  cancelReturn: (id: string, version?: number) => apiClient.post<MutationResponse>(`${B}/returns/${id}/cancel`, {}, { headers: mutHeaders(version) }),

  // ── reports + reconcile ──
  reportTypes: (signal?: AbortSignal) => apiClient.get<ListResponse<{ type: string }>>(`${B}/reports`, { signal }),
  report: (type: string, params: Params, signal?: AbortSignal) => apiClient.get<ListResponse<Record<string, unknown>>>(`${B}/reports/${type}`, { params, signal }),
  reconcile: (signal?: AbortSignal) => apiClient.get<DataResponse<{ pass: boolean; checks: { name: string; pass: boolean; detail: string; severity: string }[] }>>(`${B}/reconcile`, { signal }),
};
