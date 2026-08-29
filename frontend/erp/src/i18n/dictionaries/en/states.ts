/** Shared page-state copy (loading / empty / error / offline / session-expired
 *  / permission-denied / conflict). English mirror of the Arabic in
 *  frontend/erp/src/shared/ui/states.tsx — another agent wires the component up
 *  to t("states.xxx"); this file just supplies the keys+values so the ar/en
 *  shapes stay in parity from the start. */
export const states = {
  loading: "Loading…",
  emptyDefault: "No data yet",
  errorDefault: "Couldn't load the data",

  reference: "Reference:",
  permissionDenied: "You don't have access to this section",
  permissionDeniedBody: "This area requires a higher permission level. Contact your manager if you believe this is a mistake.",
  sessionExpired: "Session expired",
  sessionExpiredBody: "Your sign-in has expired. Sign in again, then return to this page.",
  loginBtn: "Sign in",
  offline: "You're offline",
  offlineBody: "We couldn't reach the server. We'll retry automatically once the connection is back.",
  retryBtn: "Retry",
  conflict: "The data changed since it was last loaded",
  refreshBtn: "Refresh",
  unexpectedError: "An unexpected error occurred. Try again, and if the problem persists contact your administrator.",
} as const;
