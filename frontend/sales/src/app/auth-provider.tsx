import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { Role, SessionUser } from "@/lib/permissions";

// Auth provider — decodes the JWT the legacy app already stored in
// localStorage (pos_token) so the warehouse app shares one session. No login
// screen here in Phase 1: if there's no/expired token the app shows a gentle
// "sign in from the main app" state (handled by RequireAuth).

interface AuthContextValue {
  user: SessionUser | null;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextValue>({ user: null, isAuthenticated: false });

function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(decodeURIComponent(escape(json)));
  } catch {
    return null;
  }
}

function readSession(): SessionUser | null {
  if (typeof localStorage === "undefined") return null;
  const token =
    localStorage.getItem("pos_token") ||
    localStorage.getItem("token") ||
    localStorage.getItem("jwt") ||
    "";
  if (!token) return null;
  const claims = decodeJwt(token);
  if (!claims || !claims.username) return null;
  // Expiry check (exp is seconds since epoch).
  if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) return null;
  const role = String(claims.role ?? "cashier").toLowerCase() as Role;
  return {
    username: String(claims.username),
    name: (claims.name as string) || (claims.full_name as string) || undefined,
    role,
    isDeveloper: Boolean(claims.isDeveloper ?? claims.is_developer ?? false),
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const value = useMemo<AuthContextValue>(() => {
    const user = readSession();
    return { user, isAuthenticated: !!user };
  }, []);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
