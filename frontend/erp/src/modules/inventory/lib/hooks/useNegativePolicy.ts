// Phase W2 — TanStack Query hooks for the negative-stock policy settings +
// deficit ledger (/api/inventory/v2/negative-policy). Mirrors useProduction:
// apiClient + queryKeys + adapters; the save mutation carries expectedVersion
// (409 VERSION_CONFLICT surfaces as ApiError.isConflict) and invalidates the
// whole negativePolicy slice (rows + every cached effective decision +
// deficits) so the tester and tables refresh together.
//
// NOTE (backend contract): /deficits is NOT paginated server-side — it returns
// every row matching status/warehouseId (already scoped to the caller's
// warehouses). Pages paginate/filter the rest client-side.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient, getToken } from "@/shared/api";
import { queryKeys } from "@/modules/inventory/lib/query-keys";
import {
  toPolicySettings,
  toEffectivePolicy,
  toDeficitLedger,
  toPolicySaveResult,
  type PolicySettings,
  type EffectivePolicy,
  type DeficitLedger,
  type PolicySaveResult,
  type PolicyScope,
  type PolicyMode,
} from "@/modules/inventory/lib/adapters/negative-policy.adapter";

const BASE = "/inventory/v2/negative-policy";

/** All configured rows (global/warehouse/item) + the two env gates. */
export function useNegativePolicySettings() {
  return useQuery<PolicySettings>({
    queryKey: queryKeys.negativePolicy.rows(),
    queryFn: ({ signal }) => apiClient.get<unknown>(BASE, { signal }).then(toPolicySettings),
    staleTime: 30_000,
  });
}

/**
 * The computed decision for a (warehouse[, item]) pair. Enabled once a
 * warehouse is chosen; the item is optional (without it the warehouse/global
 * chain resolves).
 */
export function useEffectivePolicy(warehouseId: string, itemId: string) {
  return useQuery<EffectivePolicy>({
    enabled: !!warehouseId,
    queryKey: queryKeys.negativePolicy.effective(warehouseId, itemId),
    queryFn: ({ signal }) =>
      apiClient
        .get<unknown>(`${BASE}/effective`, {
          signal,
          params: { warehouseId, itemId: itemId || undefined },
        })
        .then(toEffectivePolicy),
    staleTime: 15_000,
  });
}

export interface DeficitsQuery {
  /** 'open' (= open+partial, server default) | 'partial' | 'covered' | 'adjusted' | 'all' */
  status?: string;
  warehouseId?: string;
}

/** Deficit ledger rows («عجز مخزني يجب تسويته»). */
export function useDeficits(query: DeficitsQuery) {
  const params: Record<string, string> = {};
  if (query.status) params.status = query.status;
  if (query.warehouseId) params.warehouseId = query.warehouseId;
  return useQuery<DeficitLedger>({
    queryKey: queryKeys.negativePolicy.deficits(params),
    queryFn: ({ signal }) =>
      apiClient.get<unknown>(`${BASE}/deficits`, { signal, params }).then(toDeficitLedger),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

export interface SavePolicyInput {
  scope: PolicyScope;
  /** required for scope 'warehouse' AND 'item' (an item policy is per warehouse+item pair). */
  warehouseId?: string | null;
  /** required for scope 'item'. */
  itemId?: string | null;
  policy: PolicyMode;
  /** always sent — the backend validates a finite number ≥ 0 even for block/allow. */
  maxNegativeQty: number;
  requireReason: boolean;
  isEnabled: boolean;
  /** optimistic-concurrency check when editing an existing row. */
  expectedVersion?: number;
}

/**
 * Upsert one policy row. Backend RBAC: admin (or developer); policy 'allow'
 * additionally requires developer (403 ALLOW_REQUIRES_DEVELOPER). A stale
 * expectedVersion 409s (VERSION_CONFLICT → ApiError.isConflict); a non-block
 * policy on a tracked item 422s (POLICY_NOT_ALLOWED_FOR_TRACKED).
 */
export function useSavePolicy() {
  const qc = useQueryClient();
  return useMutation<PolicySaveResult, Error, SavePolicyInput>({
    mutationFn: (input) => {
      const body: Record<string, unknown> = {
        scope: input.scope,
        policy: input.policy,
        maxNegativeQty: input.maxNegativeQty,
        requireReason: input.requireReason,
        isEnabled: input.isEnabled,
      };
      if (input.warehouseId) body.warehouseId = input.warehouseId;
      if (input.itemId) body.itemId = input.itemId;
      if (input.expectedVersion != null) body.expectedVersion = input.expectedVersion;
      return apiClient.put<unknown>(BASE, body).then(toPolicySaveResult);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.negativePolicy.all });
    },
  });
}

/**
 * CSV export of the deficit ledger — same fetch/blob pattern as
 * lib/downloadCsv.ts (api-client is JSON-only): attach the JWT, download the
 * blob, throw an Error with the server message so the caller surfaces it.
 */
export async function downloadDeficitsCsv(params: DeficitsQuery): Promise<void> {
  const qs = new URLSearchParams();
  if (params.status) qs.append("status", params.status);
  if (params.warehouseId) qs.append("warehouseId", params.warehouseId);
  const url = `/api${BASE}/deficits/export${qs.toString() ? `?${qs}` : ""}`;
  const token = getToken();
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: "same-origin",
  });
  if (!res.ok) {
    let msg = "تعذّر تصدير سجل العجوزات.";
    try {
      const j = await res.json();
      if (j && j.error) msg = String(j.error);
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = `stock-deficits-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}
