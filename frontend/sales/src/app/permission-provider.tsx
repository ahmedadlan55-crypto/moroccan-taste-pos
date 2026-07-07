import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useAuth } from "./auth-provider";
import { can as canDo, type O2CCapability } from "@/lib/permissions";

// Permission provider — exposes a memoized `can(cap)` bound to the current user
// (decoded from the shared JWT). The UI uses it to hide/disable actions; the
// backend `requireCapability` stays the real security boundary.

interface PermissionContextValue {
  can: (cap: O2CCapability) => boolean;
}

const PermissionContext = createContext<PermissionContextValue>({ can: () => false });

export function PermissionProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const value = useMemo<PermissionContextValue>(
    () => ({ can: (cap: O2CCapability) => canDo(user, cap) }),
    [user],
  );
  return <PermissionContext.Provider value={value}>{children}</PermissionContext.Provider>;
}

export function usePermissions(): PermissionContextValue {
  return useContext(PermissionContext);
}

export function useCan(cap: O2CCapability): boolean {
  return usePermissions().can(cap);
}
