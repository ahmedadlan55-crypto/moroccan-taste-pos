import type { ReactNode } from "react";
import { usePermissions } from "@/app/providers";
import type { Capability } from "@/app/permissions";
import { PermissionDenied } from "@/shared/ui";

// Per-route capability gate. Renders the page when the user has the capability;
// otherwise the shared "permission denied" state (which carries
// data-state="permission-denied", so the E2E gate fails on it). In dev/preview it
// never blocks (parity with RequireAuth) so the foundation stays demoable without
// a real session — the closure gate therefore runs against a PRODUCTION build.
// The backend remains the authoritative boundary.
export function CapGuard({ cap, children }: { cap?: Capability; children: ReactNode }) {
  const { can } = usePermissions();
  if (!cap || can(cap) || import.meta.env.DEV) return <>{children}</>;
  return <PermissionDenied />;
}
