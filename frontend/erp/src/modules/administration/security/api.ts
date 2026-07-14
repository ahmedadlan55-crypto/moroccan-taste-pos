// ── Advanced security policies — API adapter + React Query hooks ─────────────
// Thin typed layer over @/shared/api for GET/PUT /api/security-policies. The
// backend stores each block in the `settings` table and returns sensible
// defaults when unset; writes require `administration.security.manage`.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";

export interface PasswordPolicy {
  minLength: number;
  requireUpper: boolean;
  requireNumber: boolean;
  requireSymbol: boolean;
  /** Days until a password must be rotated. 0 = never expires. */
  expiryDays: number;
}
export interface SessionPolicy {
  /** Idle minutes before auto sign-out. 0 = no idle timeout. */
  idleTimeoutMinutes: number;
  /** Absolute session lifetime in hours. 0 = no absolute cap. */
  absoluteTimeoutHours: number;
}
export interface IpAllowlist {
  enabled: boolean;
  cidrs: string[];
}
export interface SecurityPolicies {
  passwordPolicy: PasswordPolicy;
  session: SessionPolicy;
  ipAllowlist: IpAllowlist;
}

/** A PUT may carry any subset of the three blocks. */
export interface SecurityPoliciesUpdate {
  passwordPolicy?: PasswordPolicy;
  session?: SessionPolicy;
  ipAllowlist?: IpAllowlist;
}
type SecurityPoliciesAck = SecurityPolicies & { success?: boolean; error?: string };

const KEY = ["security-policies"] as const;

export function useSecurityPolicies() {
  return useQuery({
    queryKey: [...KEY],
    queryFn: ({ signal }) => apiClient.get<SecurityPolicies>("/security-policies", { signal }),
  });
}

export function useSaveSecurityPolicies() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SecurityPoliciesUpdate) =>
      apiClient.put<SecurityPoliciesAck>("/security-policies", input),
    onSuccess: (data) => {
      // The server echoes the full merged state — prime the cache with it so the
      // three cards stay consistent without a second round-trip, then refetch.
      if (data && data.passwordPolicy && data.session && data.ipAllowlist) {
        qc.setQueryData<SecurityPolicies>([...KEY], {
          passwordPolicy: data.passwordPolicy,
          session: data.session,
          ipAllowlist: data.ipAllowlist,
        });
      }
      qc.invalidateQueries({ queryKey: [...KEY] });
    },
  });
}
