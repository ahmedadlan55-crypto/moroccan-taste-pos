// Phase W6 — warehouse management hooks (CRUD on /api/inventory/v2/warehouses).
//
// Kept separate from useWarehouses.ts (the read-only summary hook) so existing
// read paths are untouched. Every mutation invalidates:
//   • queryKeys.warehouses.all — the admin list, detail, scope assignments
//   • ["dashboard"]            — warehouse cards / KPIs on the dashboard
//   • ["inventory"]            — per-warehouse grids (a rename/deactivate
//                                changes their headers and pickers)
// Mutations never auto-retry (providers.tsx sets mutations.retry = false).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import {
  toWarehouseAdminList,
  toWarehouseAdminDetail,
  toScopeAssignments,
  toWarehouseFormOptions,
  toWarehouseMutationResult,
  type WarehouseAdminListResponse,
  type WarehouseAdminDetailResponse,
  type ScopeAssignmentsResponse,
  type WarehouseFormOptions,
  type WarehouseMutationResult,
} from "@/lib/adapters/warehouse-admin.adapter";

const BASE = "/inventory/v2/warehouses";

// ── Inputs ──────────────────────────────────────────────────────────────────

export interface WarehouseFormInput {
  name: string;
  code: string;
  type: string;
  brandId?: string | null;
  branchId?: string | null;
  location?: string | null;
  manager?: string | null;
  description?: string | null;
  isMain?: boolean;
}

// ── Queries ─────────────────────────────────────────────────────────────────

export function useWarehouseAdminList() {
  return useQuery<WarehouseAdminListResponse>({
    queryKey: [...queryKeys.warehouses.all, "admin", "list"],
    queryFn: ({ signal }) => apiClient.get<unknown>(BASE, { signal }).then(toWarehouseAdminList),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
  });
}

export function useWarehouseAdminDetail(id: string | null) {
  return useQuery<WarehouseAdminDetailResponse>({
    queryKey: queryKeys.warehouses.detail(id ?? ""),
    enabled: !!id,
    queryFn: ({ signal }) =>
      apiClient.get<unknown>(`${BASE}/${id}`, { signal }).then(toWarehouseAdminDetail),
    staleTime: 15_000,
    gcTime: 5 * 60_000,
  });
}

/** Brands + branches + the type enum for the create/edit form. */
export function useWarehouseFormOptions(enabled = true) {
  return useQuery<WarehouseFormOptions>({
    queryKey: [...queryKeys.warehouses.all, "admin", "options"],
    enabled,
    queryFn: ({ signal }) =>
      apiClient.get<unknown>(`${BASE}/options`, { signal }).then(toWarehouseFormOptions),
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
  });
}

/** Admin-only: current access rows + the assignable user list. */
export function useWarehouseScopeAssignments(id: string | null, enabled = true) {
  return useQuery<ScopeAssignmentsResponse>({
    queryKey: queryKeys.warehouses.scopeAssignments(id ?? ""),
    enabled: !!id && enabled,
    queryFn: ({ signal }) =>
      apiClient
        .get<unknown>(`${BASE}/${id}/scope-assignments`, { signal })
        .then(toScopeAssignments),
    staleTime: 15_000,
    gcTime: 5 * 60_000,
  });
}

// ── Mutations ───────────────────────────────────────────────────────────────

function useInvalidateWarehouses() {
  const qc = useQueryClient();
  return (id?: string) => {
    qc.invalidateQueries({ queryKey: queryKeys.warehouses.all });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
    qc.invalidateQueries({ queryKey: ["inventory"] });
    if (id) qc.invalidateQueries({ queryKey: queryKeys.warehouses.detail(id) });
  };
}

export function useCreateWarehouse() {
  const invalidate = useInvalidateWarehouses();
  return useMutation<WarehouseMutationResult, Error, WarehouseFormInput>({
    mutationFn: (input) => apiClient.post<unknown>(BASE, input).then(toWarehouseMutationResult),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateWarehouse() {
  const invalidate = useInvalidateWarehouses();
  return useMutation<WarehouseMutationResult, Error, { id: string; input: Partial<WarehouseFormInput> }>({
    mutationFn: ({ id, input }) =>
      apiClient.patch<unknown>(`${BASE}/${id}`, input).then(toWarehouseMutationResult),
    onSuccess: (_r, v) => invalidate(v.id),
  });
}

export function useActivateWarehouse() {
  const invalidate = useInvalidateWarehouses();
  return useMutation<WarehouseMutationResult, Error, { id: string }>({
    mutationFn: ({ id }) =>
      apiClient.post<unknown>(`${BASE}/${id}/activate`, {}).then(toWarehouseMutationResult),
    onSuccess: (_r, v) => invalidate(v.id),
  });
}

export function useDeactivateWarehouse() {
  const invalidate = useInvalidateWarehouses();
  return useMutation<WarehouseMutationResult, Error, { id: string; note?: string }>({
    mutationFn: ({ id, note }) =>
      apiClient.post<unknown>(`${BASE}/${id}/deactivate`, { note }).then(toWarehouseMutationResult),
    onSuccess: (_r, v) => invalidate(v.id),
  });
}

/** HARD delete — admin only; the backend refuses (422) unless never used. */
export function useDeleteWarehouse() {
  const invalidate = useInvalidateWarehouses();
  return useMutation<WarehouseMutationResult, Error, { id: string }>({
    mutationFn: ({ id }) =>
      apiClient.delete<unknown>(`${BASE}/${id}`).then(toWarehouseMutationResult),
    onSuccess: () => invalidate(),
  });
}

/** REPLACE the warehouse's user access rows (admin only). */
export function useSaveScopeAssignments() {
  const qc = useQueryClient();
  const invalidate = useInvalidateWarehouses();
  return useMutation<WarehouseMutationResult, Error, { id: string; userIds: number[] }>({
    mutationFn: ({ id, userIds }) =>
      apiClient
        .put<unknown>(`${BASE}/${id}/scope-assignments`, { userIds })
        .then(toWarehouseMutationResult),
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: queryKeys.warehouses.scopeAssignments(v.id) });
      // Scope changes alter what OTHER users can see everywhere.
      qc.invalidateQueries({ queryKey: ["access-scope"] });
      invalidate(v.id);
    },
  });
}
