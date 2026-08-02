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
/**
 * Segregation of duties on purchase-order approval. Enforced server-side inside
 * the approval transaction (routes/procurement/orders.js) — this screen only
 * decides the policy, it never gates the button.
 */
export interface ProcurementApprovalPolicy {
  /** When true, whoever created or submitted a PO may not approve it. */
  enabled: boolean;
  /** PO total (VAT included) at which the rule starts applying. 0 = every PO. */
  thresholdAmount: number;
}
export interface SecurityPolicies {
  passwordPolicy: PasswordPolicy;
  session: SessionPolicy;
  ipAllowlist: IpAllowlist;
  procurementApproval: ProcurementApprovalPolicy;
}

/** A PUT may carry any subset of the blocks. */
export interface SecurityPoliciesUpdate {
  passwordPolicy?: PasswordPolicy;
  session?: SessionPolicy;
  ipAllowlist?: IpAllowlist;
  procurementApproval?: ProcurementApprovalPolicy;
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
      // cards stay consistent without a second round-trip, then refetch.
      if (data && data.passwordPolicy && data.session && data.ipAllowlist && data.procurementApproval) {
        qc.setQueryData<SecurityPolicies>([...KEY], {
          passwordPolicy: data.passwordPolicy,
          session: data.session,
          ipAllowlist: data.ipAllowlist,
          procurementApproval: data.procurementApproval,
        });
      }
      qc.invalidateQueries({ queryKey: [...KEY] });
    },
  });
}
