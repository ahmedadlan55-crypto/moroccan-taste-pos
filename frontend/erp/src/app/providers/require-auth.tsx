import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "./auth-provider";

// Gate the whole app behind a valid session. The Back-Office shares the legacy
// app's JWT (localStorage pos_token). In dev/preview we render the UI even
// without a token so the foundation is demoable; in production an
// unauthenticated user is redirected to the in-app /login route (FC-P4), which
// is what lets `/app` stand alone as the default entry point.
export function RequireAuth({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  if (isAuthenticated || import.meta.env.DEV) return <>{children}</>;
  return <Navigate to="/login" replace />;
}
