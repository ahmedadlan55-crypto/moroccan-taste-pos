import type { ReactNode } from "react";
import { AlertTriangle, Inbox, Lock, LogIn, RefreshCw, WifiOff } from "lucide-react";
import { ApiError } from "@/shared/api";
import type { TFunction } from "@/i18n";
import { Button } from "./button";
import { Skeleton } from "./skeleton";
import { arT, useTx } from "./i18n";

// The canonical page states: loading skeleton, empty (first-use and filtered),
// server error, permission denied, offline, and a 409 conflict with a Refresh CTA.
//
// Every state carries a stable `data-state` so automation can tell a healthy
// screen (data / "empty") from a broken one (error / offline / session-expired /
// permission-denied / conflict) WITHOUT matching translated copy. The closure
// E2E gate fails on any non-healthy state, so these values are a contract.
export type PageState =
  | "loading"
  | "empty"
  | "error"
  | "offline"
  | "session-expired"
  | "permission-denied"
  | "conflict"
  | "not-found";

/**
 * The one state frame. Exported as `StateShell` so app-level states that need
 * router context (see app/shell/NotFound) reuse it instead of hand-copying the
 * markup — `shared/*` deliberately stays free of a react-router dependency.
 */
export function StateShell(props: {
  icon: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
  state: PageState;
}) {
  return <Shell {...props} />;
}

function Shell({
  icon,
  title,
  body,
  action,
  state,
}: {
  icon: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
  state: PageState;
}) {
  return (
    <div data-state={state} className="surface grid place-items-center gap-3 p-12 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-2xl bg-slate-100 text-slate-500">{icon}</div>
      <div className="text-base font-extrabold text-slate-800">{title}</div>
      {body && <p className="max-w-md text-sm font-medium text-slate-500">{body}</p>}
      {action}
    </div>
  );
}

export function LoadingState({ rows = 4 }: { rows?: number }) {
  const t = useTx();
  return (
    <div data-state="loading" className="space-y-4" role="status" aria-live="polite" aria-busy="true">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
      <Skeleton className="h-64" />
      {rows > 4 && <Skeleton className="h-40" />}
      <span className="sr-only">{t("states.loading")}</span>
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
  icon,
}: {
  title?: string;
  body?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  const t = useTx();
  return (
    <Shell
      state="empty"
      icon={icon ?? <Inbox className="h-6 w-6" />}
      title={title ?? t("states.emptyDefault")}
      body={body}
      action={action}
    />
  );
}

export function PermissionDenied({
  title,
  body,
}: {
  title?: string;
  body?: string;
}) {
  const t = useTx();
  return (
    <Shell
      state="permission-denied"
      icon={<Lock className="h-6 w-6" />}
      title={title ?? t("states.permissionDenied")}
      body={body ?? t("states.permissionDeniedBody")}
    />
  );
}

export function SessionExpired() {
  const t = useTx();
  return (
    <Shell
      state="session-expired"
      icon={<LogIn className="h-6 w-6" />}
      title={t("states.sessionExpired")}
      body={t("states.sessionExpiredBody")}
      action={
        <Button
          variant="primary"
          onClick={() => {
            // Base-aware jump to the app login (never the legacy root).
            const base = import.meta.env.BASE_URL.replace(/\/$/, "");
            window.location.assign(`${base}/login`);
          }}
        >
          <LogIn className="h-4 w-4" /> {t("states.loginBtn")}
        </Button>
      }
    />
  );
}

export function OfflineState({ onRetry }: { onRetry?: () => void }) {
  const t = useTx();
  return (
    <Shell
      state="offline"
      icon={<WifiOff className="h-6 w-6" />}
      title={t("states.offline")}
      body={t("states.offlineBody")}
      action={
        onRetry && (
          <Button variant="secondary" onClick={onRetry}>
            <RefreshCw className="h-4 w-4" /> {t("states.retryBtn")}
          </Button>
        )
      }
    />
  );
}

// Never render raw technical / DB / stack error text to the user. Intentional
// short domain messages pass through; anything resembling SQL, driver internals,
// or a stack trace is replaced by a safe generic message. `t` defaults to the
// Arabic-bound fallback so the many module call sites that pass only the error
// keep working; ErrorState threads its own active-language `t` in.
export function safeUserMessage(error: unknown, t: TFunction = arT): string {
  const GENERIC = t("states.unexpectedError");
  const raw = error instanceof Error ? String(error.message || "") : "";
  if (!raw) return GENERIC;
  if (
    /\b(select|insert|update|delete|from|where|group\s+by|sql_mode|only_full_group_by|nonaggregated|syntax|errno|econnrefused|sqlmessage)\b/i.test(
      raw,
    )
  )
    return GENERIC;
  if (/\.(js|ts|tsx):\d+|\bat\s+\w+\s+\(/.test(raw)) return GENERIC; // stack frames
  if (raw.length > 160) return GENERIC; // overly long → likely a dump, not a UI message
  return raw;
}

export function ErrorState({
  error,
  onRetry,
  title,
  body,
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
  body?: string;
}) {
  const t = useTx();
  if (error instanceof ApiError) {
    if (error.kind === "network") return <OfflineState onRetry={onRetry} />;
    if (error.kind === "unauthorized") return <SessionExpired />;
    if (error.kind === "forbidden") return <PermissionDenied />;
    if (error.isConflict) {
      return (
        <Shell
          state="conflict"
          icon={<RefreshCw className="h-6 w-6" />}
          title={t("states.conflict")}
          body={safeUserMessage(error, t)}
          action={
            onRetry && (
              <Button onClick={onRetry}>
                <RefreshCw className="h-4 w-4" /> {t("states.refreshBtn")}
              </Button>
            )
          }
        />
      );
    }
  }
  return (
    <Shell
      state="error"
      icon={<AlertTriangle className="h-6 w-6 text-rose-600" />}
      title={title ?? t("states.errorDefault")}
      body={body ?? safeUserMessage(error, t)}
      action={
        onRetry && (
          <Button variant="secondary" onClick={onRetry}>
            <RefreshCw className="h-4 w-4" /> {t("states.retryBtn")}
          </Button>
        )
      }
    />
  );
}
