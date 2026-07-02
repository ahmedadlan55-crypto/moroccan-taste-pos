// Unified error contract for the warehouse app.
//
// The legacy backend is inconsistent: some endpoints return `{ error: "..." }`,
// some `{ success:false, error, code }`, some a bare list on failure. The API
// client normalizes ALL of these into a single ApiError shape so every screen
// can branch on a stable `.kind` / `.code` instead of sniffing response bodies.

export type ApiErrorKind =
  | "unauthorized" // 401
  | "forbidden" // 403
  | "conflict" // 409 — state changed; show a Refresh CTA
  | "validation" // 422 / 400 with field errors
  | "not_found" // 404
  | "server" // 500+
  | "network" // fetch failed / aborted
  | "unknown";

export interface ApiErrorDetails {
  field?: string;
  [key: string]: unknown;
}

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  readonly code?: string;
  readonly details?: ApiErrorDetails;
  readonly requestId?: string;

  constructor(opts: {
    kind: ApiErrorKind;
    status: number;
    message: string;
    code?: string;
    details?: ApiErrorDetails;
    requestId?: string;
  }) {
    super(opts.message);
    this.name = "ApiError";
    this.kind = opts.kind;
    this.status = opts.status;
    this.code = opts.code;
    this.details = opts.details;
    this.requestId = opts.requestId;
  }

  /** A 409 means the document changed under the user — UI should offer Refresh. */
  get isConflict(): boolean {
    return this.kind === "conflict";
  }
  get isPermissionDenied(): boolean {
    return this.kind === "forbidden" || this.kind === "unauthorized";
  }
}

export function kindFromStatus(status: number): ApiErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 422 || status === 400) return "validation";
  if (status >= 500) return "server";
  return "unknown";
}

/**
 * Map any legacy/normalized error body + HTTP status into an ApiError.
 * Accepts: { error: string } | { success:false, error, code, field, details } |
 *          { error: { code, message, field, details, requestId } } (new contract)
 */
export function toApiError(status: number, body: unknown): ApiError {
  const kind = kindFromStatus(status);
  let message = "حدث خطأ غير متوقع";
  let code: string | undefined;
  let details: ApiErrorDetails | undefined;
  let requestId: string | undefined;

  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    // New nested contract: { success:false, error:{ code, message, field, details, requestId } }
    if (b.error && typeof b.error === "object") {
      const e = b.error as Record<string, unknown>;
      message = (e.message as string) || message;
      code = e.code as string | undefined;
      requestId = e.requestId as string | undefined;
      if (e.field) details = { ...(details ?? {}), field: e.field as string };
      if (e.details && typeof e.details === "object")
        details = { ...(details ?? {}), ...(e.details as object) };
    } else {
      // Legacy flat shapes.
      if (typeof b.error === "string") message = b.error;
      if (typeof b.message === "string") message = b.message;
      if (typeof b.code === "string") code = b.code;
      if (typeof b.field === "string") details = { field: b.field };
      if (b.details && typeof b.details === "object")
        details = { ...(details ?? {}), ...(b.details as object) };
    }
  }

  return new ApiError({ kind, status, message, code, details, requestId });
}
