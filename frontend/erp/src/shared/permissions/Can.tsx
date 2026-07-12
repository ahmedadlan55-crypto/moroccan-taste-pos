import type { ReactNode } from "react";
import { useCan } from "@/app/providers";
import type { Capability } from "@/app/permissions";
import { PermissionDenied } from "@/shared/ui";

export interface CanProps {
  /** The capability required to render `children`. */
  cap: Capability;
  children: ReactNode;
  /** Rendered instead when the capability is missing (default: nothing). */
  fallback?: ReactNode;
  /** Render the full PermissionDenied panel when denied (for whole sections). */
  showDenied?: boolean;
}

/**
 * Declarative capability gate. Hides (or replaces) UI the current user may not
 * use. This is a UI convenience only — the backend RBAC gate remains the real
 * security boundary.
 */
export function Can({ cap, children, fallback = null, showDenied = false }: CanProps) {
  const allowed = useCan(cap);
  if (allowed) return <>{children}</>;
  if (showDenied) return <PermissionDenied />;
  return <>{fallback}</>;
}
