import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { toAccessScope, type AccessScope } from "@/lib/adapters/access-scope.adapter";

// Reads which keys the api-client uses for the JWT (kept in sync with
// api-client.getToken) so we don't fire the access-scope request on the login
// screen before a token exists.
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

// useAccessScope — the warehouse-v2 access bootstrap: the caller's accessible
// warehouses + capability map. Loaded ONCE and shared (the scope provider and
// the permission provider both call this; react-query dedupes to a single
// request — no N+1).
export function useAccessScope() {
  return useQuery<AccessScope>({
    queryKey: queryKeys.accessScope(),
    enabled: hasToken(),
    queryFn: ({ signal }) =>
      apiClient.get<unknown>("/inventory/access-scope", { signal }).then(toAccessScope),
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
  });
}
