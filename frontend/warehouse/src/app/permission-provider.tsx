import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useAuth } from "./auth-provider";
import { can as canDo, type WarehouseAction } from "@/lib/permissions";

// Permission provider — exposes a memoized `can(action)` bound to the current
// user. UI uses it to hide/disable actions; the backend still enforces.

interface PermissionContextValue {
  can: (action: WarehouseAction) => boolean;
}

const PermissionContext = createContext<PermissionContextValue>({ can: () => false });

export function PermissionProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const value = useMemo<PermissionContextValue>(
    () => ({ can: (action: WarehouseAction) => canDo(user, action) }),
    [user],
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
