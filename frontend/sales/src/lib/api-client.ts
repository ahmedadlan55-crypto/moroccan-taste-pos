// Central API client for the warehouse app.
//
// Responsibilities (per the React blueprint §10):
//   • attach the JWT from storage as `Authorization: Bearer`
//   • normalize every failure into an ApiError (never a silent empty array)
//   • honor AbortSignal for cancellation
//   • surface a request id when the backend returns one
//   • NEVER auto-retry mutations (idempotency is not guaranteed)
//
// Mutations are exposed separately so callers can't accidentally retry them.

import { ApiError, toApiError } from "./api-error";

const TOKEN_KEYS = ["pos_token", "token", "jwt"]; // legacy app stores it under pos_token

export function getToken(): string {
  for (const k of TOKEN_KEYS) {
    const v = typeof localStorage !== "undefined" ? localStorage.getItem(k) : null;
    if (v) return v;
  }
  return "";
}

export interface RequestOptions {
  signal?: AbortSignal;
  params?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
}

function buildUrl(path: string, params?: RequestOptions["params"]): string {
  const base = path.startsWith("/api") ? path : `/api${path.startsWith("/") ? "" : "/"}${path}`;
  if (!params) return base;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") qs.append(k, String(v));
  }
  const s = qs.toString();
  return s ? `${base}?${s}` : base;
}

async function parseBody(res: Response): Promise<unknown> {
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
  try {
    return await res.text();
  } catch {
    return null;
  }
}

async function request<T>(
  method: string,
  path: string,
  opts: RequestOptions & { body?: unknown } = {},
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(opts.headers ?? {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.params), {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
      credentials: "same-origin",
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError({
      kind: "network",
      status: 0,
      message: "تعذّر الاتصال بالخادم — تحقق من الشبكة وحاول مجددًا",
    });
  }

  const requestId = res.headers.get("x-request-id") || undefined;

  if (!res.ok) {
    const body = await parseBody(res);
    const err = toApiError(res.status, body);
    // graft the header request id if the body didn't carry one
    if (requestId && !err.requestId) {
      throw new ApiError({
        kind: err.kind,
        status: err.status,
        message: err.message,
        code: err.code,
        details: err.details,
        requestId,
      });
    }
    throw err;
  }

  if (res.status === 204) return undefined as T;
  return (await parseBody(res)) as T;
}

export const apiClient = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>("GET", path, opts),
  // Mutations — explicit, never auto-retried by react-query (see providers.tsx).
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>("POST", path, { ...opts, body }),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>("PUT", path, { ...opts, body }),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>("PATCH", path, { ...opts, body }),
  delete: <T>(path: string, opts?: RequestOptions) => request<T>("DELETE", path, opts),
};

export type ApiClient = typeof apiClient;
