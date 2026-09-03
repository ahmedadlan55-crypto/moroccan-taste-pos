// The portal's API client.
//
// ─── WHY IT HAS ITS OWN TOKEN NAMESPACE ──────────────────────────────────────
// localStorage is keyed by ORIGIN, not by path: /app, /pos and /employee all
// read the same store. The ERP client (frontend/erp/src/shared/api/api-client.ts)
// resolves its token from ["pos_token", "token", "jwt"].
//
// So if this portal wrote `pos_token`, an employee signing in on a shared floor
// tablet to punch a fingerprint would silently hand whoever opens /app next a
// live back-office session. The retired PWA already namespaced its own keys
// (`emp_token` / `emp_session`) and this keeps that boundary: the portal reads
// and writes ONLY `emp_*`, and nothing in the ERP or the cashier reads those.
//
// The corollary is deliberate: signing into the portal does NOT sign you into
// the ERP, and signing out of the portal does not disturb an ERP session on the
// same device.

const TOKEN_KEY = "emp_token";
const SESSION_KEY = "emp_session";

export interface PortalSession {
  username: string;
  role: string;
  fullName?: string;
  /** Whether the account may open the standalone custody section. */
  custodyPortal?: boolean;
  /**
   * Whether the account is an ATTENDANCE employee — clock, hours, leave.
   * A custody officer signs in with this false and sees none of those tabs.
   * Absent (older backend) reads as true: that backend refused everyone
   * without the employee flag, so anyone it let in was an employee.
   */
  employeePortal?: boolean;
}

function storage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    // Private mode / disabled storage — the app still works for one session.
    return null;
  }
}

export function getToken(): string {
  return storage()?.getItem(TOKEN_KEY) ?? "";
}

export function getSession(): PortalSession | null {
  const raw = storage()?.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as PortalSession;
    return v && typeof v.username === "string" ? v : null;
  } catch {
    return null;
  }
}

export function setSession(token: string, session: PortalSession): void {
  const s = storage();
  if (!s) return;
  s.setItem(TOKEN_KEY, token);
  s.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  const s = storage();
  if (!s) return;
  s.removeItem(TOKEN_KEY);
  s.removeItem(SESSION_KEY);
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;

  constructor(message: string, status: number, code = "", body: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }

  /** True when the session is gone — the shell signs out rather than retrying. */
  get isUnauthorized(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /** True when the device could not reach the server at all. */
  get isOffline(): boolean {
    return this.status === 0;
  }
}

type Params = Record<string, string | number | boolean | undefined | null>;

function buildUrl(path: string, params?: Params): string {
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

function messageFrom(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    for (const k of ["error", "message", "msg"]) {
      const v = b[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  if (typeof body === "string" && body.trim() && body.length < 300) return body.trim();
  return fallback;
}

function codeFrom(body: unknown): string {
  if (body && typeof body === "object") {
    const v = (body as Record<string, unknown>).code;
    if (typeof v === "string") return v;
  }
  return "";
}

interface RequestOptions {
  signal?: AbortSignal;
  params?: Params;
  headers?: Record<string, string>;
  /** Skip the Authorization header (login is the only caller). */
  anonymous?: boolean;
  /**
   * Return a `success:false` body to the caller instead of throwing.
   *
   * The default coercion below is right almost everywhere: an HR route that
   * answers 200 with `{success:false,error}` has FAILED, and handing the UI a
   * "successful" object it renders as blank hides that.
   *
   * POST /hr/my-clock is the exception. There, `success:false` is a DOMAIN
   * ANSWER — "you are 420 m away, the fence is 100 m" — carrying `code`,
   * `distance` and `radius` that the employee needs to read. Throwing collapses
   * all of that into a generic message and tells someone standing outside the
   * branch only that something went wrong.
   */
  allowFailureBody?: boolean;
}

async function request<T>(
  method: string,
  path: string,
  opts: RequestOptions & { body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", ...(opts.headers ?? {}) };
  if (!opts.anonymous) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.params), {
      method,
      headers,
      signal: opts.signal,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    // An AbortError is the caller cancelling, NOT a failure — rethrow it as-is
    // so react-query treats it as a cancellation instead of rendering an error.
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError("تعذّر الاتصال بالخادم", 0, "network", null);
  }

  const body = await parseBody(res);

  if (!res.ok) {
    throw new ApiError(messageFrom(body, `HTTP ${res.status}`), res.status, codeFrom(body), body);
  }

  // Several HR endpoints answer 200 with { success:false, error } instead of a
  // status code — treat that as the failure it is rather than handing the UI a
  // "successful" object it will render as blank. See `allowFailureBody` for the
  // one route where success:false is an answer rather than a failure.
  if (!opts.allowFailureBody && body && typeof body === "object" && !Array.isArray(body)) {
    const b = body as Record<string, unknown>;
    if (b.success === false) {
      throw new ApiError(messageFrom(body, "فشل الطلب"), 200, codeFrom(body), body);
    }
  }

  return body as T;
}

export const api = {
  get: <T>(path: string, opts: RequestOptions = {}) => request<T>("GET", path, opts),
  post: <T>(path: string, body?: unknown, opts: RequestOptions = {}) =>
    request<T>("POST", path, { ...opts, body }),
  put: <T>(path: string, body?: unknown, opts: RequestOptions = {}) =>
    request<T>("PUT", path, { ...opts, body }),
};
