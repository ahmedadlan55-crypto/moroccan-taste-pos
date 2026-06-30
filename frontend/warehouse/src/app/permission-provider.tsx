import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useAuth } from "./auth-provider";
import { can as canDo, type WarehouseAction } from "@/lib/permissions";
import { useAccessScope } from "@/lib/hooks/useAccessScope";

// Permission provider — exposes a memoized `can(action)` bound to the current
// user. UI uses it to hide/disable actions; the backend still enforces.
//
// Phase 2A.2 — capabilities come from the server (access-scope) when available
// (authoritative, kept in sync with the backend RBAC gates); the client matrix
// in lib/permissions is the fallback so buttons aren't dead before it loads.

interface PermissionContextValue {
  can: (action: WarehouseAction) => boolean;
}

const PermissionContext = createContext<PermissionContextValue>({ can: () => false });

export function PermissionProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { data } = useAccessScope();
  const caps = data?.capabilities;
  const value = useMemo<PermissionContextValue>(
    () => ({
      can: (action: WarehouseAction) => {
        if (caps && Object.prototype.hasOwnProperty.call(caps, action)) return !!caps[action];
        return canDo(user, action);
      },
    }),
    [user, caps],
  );
  return <PermissionContext.Provider value={value}>{children}</PermissionContext.Provider>;
}

export function usePermissions(): PermissionContextValue {
  return useContext(PermissionContext);
}

/** Convenience hook for a single action. */
export function useCan(action: WarehouseAction): boolean {
  return usePermissions().can(action);
}
