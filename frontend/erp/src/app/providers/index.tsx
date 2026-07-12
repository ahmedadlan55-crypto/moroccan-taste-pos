import type { ReactNode } from "react";
import { QueryProvider } from "./query-provider";
import { AuthProvider } from "./auth-provider";
import { PermissionProvider } from "./permission-provider";
import { ToastProvider } from "@/shared/ui";

// App-wide providers, composed once. Order matters: QueryProvider wraps
// everything (the permission provider reads access-scope via react-query),
// AuthProvider decodes the session, PermissionProvider binds `can()` to it.
// ToastProvider is mounted here — ONCE — so every module reaches useToast()
// through the shell; modules must NOT mount their own local ToastProvider.
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryProvider>
      <AuthProvider>
        <PermissionProvider>
          <ToastProvider>{children}</ToastProvider>
        </PermissionProvider>
      </AuthProvider>
    </QueryProvider>
  );
}

export { QueryProvider } from "./query-provider";
export { AuthProvider, useAuth } from "./auth-provider";
export { PermissionProvider, usePermissions, useCan } from "./permission-provider";
export { RequireAuth } from "./require-auth";
export { useAccessScope } from "./use-access-scope";
