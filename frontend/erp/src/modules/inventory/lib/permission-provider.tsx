import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useAuth } from "@/app/providers";
import { can as canDo, type WarehouseAction, type SessionUser } from "./permissions";
import { useAccessScope } from "./hooks/useAccessScope";

// Warehouse permission provider — exposes a memoized `can(action)` bound to the
// current user, keyed by the warehouse `WarehouseAction` matrix. MOVED from the
// warehouse app (SD4). It is a SEPARATE React context from the unified app's
// permission provider (@/app/providers) because it speaks the warehouse action
// vocabulary; the inventory-family modules mount it locally.
//
// Capabilities come from the server (access-scope) when available (authoritative,
// kept in sync with the backend RBAC gates); the client matrix in ./permissions
// is the fallback so buttons aren't dead before it loads.

interface PermissionContextValue {
  can: (action: WarehouseAction) => boolean;
}

const PermissionContext = createContext<PermissionContextValue>({ can: () => false });

export function WarehousePermissionProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { data } = useAccessScope();
  const caps = data?.capabilities;
  const value = useMemo<PermissionContextValue>(
    () => ({
      can: (action: WarehouseAction) => {
        if (caps && Object.prototype.hasOwnProperty.call(caps, action)) return !!caps[action];
        // The unified session user is structurally the warehouse SessionUser
        // (same JWT claims); its role union is wider, so cast for the matrix.
        return canDo((user as unknown as SessionUser | null), action);
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
