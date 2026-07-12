import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";
import type { Capability } from "@/app/permissions";

// Lean access-scope bootstrap: the caller's server-computed capability map.
// Loaded ONCE (react-query dedupes), enabled only when a token exists so it
// never fires on the sign-in state. The permission provider uses this as the
// AUTHORITATIVE source and falls back to the client catalog for caps the server
// doesn't (yet) report.

export interface AccessScope {
  capabilities: Partial<Record<Capability, boolean>>;
}

function hasToken(): boolean {
  try {
    return !!(
      localStorage.getItem("pos_token") ||
      localStorage.getItem("token") ||
      localStorage.getItem("jwt")
    );
  } catch {
    return false;
  }
}

function toAccessScope(raw: unknown): AccessScope {
  const r = (raw ?? {}) as Record<string, unknown>;
  const caps =
    r.capabilities && typeof r.capabilities === "object"
      ? (r.capabilities as Partial<Record<Capability, boolean>>)
      : {};
  return { capabilities: caps };
}

export function useAccessScope() {
  return useQuery<AccessScope>({
    queryKey: ["erp", "access-scope"],
    enabled: hasToken(),
    queryFn: ({ signal }) =>
      apiClient.get<unknown>("/inventory/access-scope", { signal }).then(toAccessScope),
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    retry: 1,
  });
}
