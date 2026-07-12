import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useAuth } from "./auth-provider";
import { useAccessScope } from "./use-access-scope";
import { can as canDo, type Capability } from "@/app/permissions";

// Permission provider — exposes a memoized `can(cap)` bound to the current user.
// UI uses it to hide/disable actions; the backend still enforces.
//
// Capabilities come from the server (access-scope) when available (authoritative,
// kept in sync with the backend RBAC gates); the client catalog (@/app/permissions)
// is the fallback so buttons aren't dead before it loads or for caps the server
// doesn't report.

interface PermissionContextValue {
  can: (cap: Capability) => boolean;
}

const PermissionContext = createContext<PermissionContextValue>({ can: () => false });

export function PermissionProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { data } = useAccessScope();
  const caps = data?.capabilities;
  const value = useMemo<PermissionContextValue>(
    () => ({
      can: (cap: Capability) => {
        if (caps && Object.prototype.hasOwnProperty.call(caps, cap)) return !!caps[cap];
        return canDo(user, cap);
      },
    }),
    [user, caps],
  );
  return <PermissionContext.Provider value={value}>{children}</PermissionContext.Provider>;
}

export function usePermissions(): PermissionContextValue {
  return useContext(PermissionContext);
}

/** Convenience hook for a single capability. */
export function useCan(cap: Capability): boolean {
  return usePermissions().can(cap);
}
