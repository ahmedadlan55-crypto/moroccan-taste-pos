import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "./auth-provider";

// Roles whose only home is the cashier app. Mirrors POS_ONLY_ROLES in
// middleware/posPortalScope.js — that server module is the real boundary
// (it 403s back-office paths for these roles); this is the UI half so a
// cashier never sees a back-office shell at all.
export const POS_ONLY_ROLES = ["cashier"];

/** True when this role's only home is the cashier app (see POS_ONLY_ROLES). */
export function isPosOnlyRole(role: unknown): boolean {
  return POS_ONLY_ROLES.includes(String(role || "").toLowerCase());
}

// Gate the whole app behind a valid session. The Back-Office shares the legacy
// app's JWT (localStorage pos_token). In dev/preview we render the UI even
// without a token so the foundation is demoable; in production an
// unauthenticated user is redirected to the in-app /login route (FC-P4), which
// is what lets `/app` stand alone as the default entry point.
export function RequireAuth({ children }: { children: ReactNode }) {
  const { isAuthenticated, user } = useAuth();

  // PORTAL ISOLATION. Both apps are served from the same origin and read the
  // same `pos_token` key, so signing in at /pos also satisfied this gate —
  // token presence was the ONLY check. A cashier could therefore type /app
  // and get the back-office shell. Login.tsx's cashier redirect did not help:
  // it fires once, on the ERP login form, and a cashier normally signs in at
  // /pos and never touches it. Send them home instead — a full navigation,
  // because /pos is a different Vite bundle, not a route in this router.
  if (isAuthenticated && isPosOnlyRole(user?.role)) {
    if (typeof window !== "undefined") window.location.assign("/pos/");
    return null;
  }

  if (isAuthenticated || import.meta.env.DEV) return <>{children}</>;
  return <Navigate to="/login" replace />;
}
