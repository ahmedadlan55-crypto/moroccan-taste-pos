// Phase 4A — TanStack Query hooks for the Item Master. List/detail + mutations
// (create/update/activate/deactivate/saveRule). create + saveRule carry an
// Idempotency-Key; mutations carry expectedVersion; 409s surface as
// ApiError(isConflict). onSuccess invalidates items + inventory + dashboard +
// replenishment so every dependent surface refreshes.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { toItemPage, toItemDetail, toItemMutation, type ItemMutationResult } from "@/lib/adapters/item.adapter";

const BASE = "/inventory/v2/items";
function uid(): string {
  try { if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID(); } catch { /* jsdom */ }
  return "idem-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export interface ItemListQuery { q?: string; status?: string; category?: string; warehouseId?: string; page?: number; pageSize?: number; sort?: string; dir?: string }

export function useItemList(query: ItemListQuery) {
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") params[k] = v as string | number;
  return useQuery({
    queryKey: queryKeys.items.list(params),
    queryFn: ({ signal }) => apiClient.get<unknown>(BASE, { signal, params }).then(toItemPage),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}
export function useItemDetail(id: string | null) {
  return useQuery({ enabled: !!id, queryKey: queryKeys.items.detail(id ?? ""), queryFn: ({ signal }) => apiClient.get<unknown>(`${BASE}/${id}`, { signal }).then(toItemDetail) });
}
export function useItemCategories() {
  return useQuery({ queryKey: queryKeys.items.categories(), staleTime: 5 * 60_000, queryFn: ({ signal }) => apiClient.get<{ data?: string[] }>("/inventory/v2/categories", { signal }).then((r) => (Array.isArray(r?.data) ? r.data : [])) });
}
export interface UnitOption { code: string; nameAr: string; nameEn: string; type: string }
export function useUnits() {
  return useQuery({ queryKey: queryKeys.items.units(), staleTime: 5 * 60_000, queryFn: ({ signal }) => apiClient.get<{ data?: UnitOption[] }>("/inventory/v2/units", { signal }).then((r) => (Array.isArray(r?.data) ? r.data : [])) });
}

export function useItemMutations() {
  const qc = useQueryClient();
  const invalidate = (id?: string) => {
    qc.invalidateQueries({ queryKey: queryKeys.items.all });
    if (id) qc.invalidateQueries({ queryKey: queryKeys.items.detail(id) });
    qc.invalidateQueries({ queryKey: ["inventory"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
    qc.invalidateQueries({ queryKey: ["replenishment"] });
  };
  type R = ItemMutationResult;
  const create = useMutation<R, Error, Record<string, unknown>>({
    mutationFn: (input) => apiClient.post<unknown>(BASE, input, { headers: { "Idempotency-Key": uid() } }).then(toItemMutation),
    onSuccess: () => invalidate(),
  });
  const update = useMutation<R, Error, { id: string; input: Record<string, unknown> }>({
    mutationFn: ({ id, input }) => apiClient.patch<unknown>(`${BASE}/${id}`, input).then(toItemMutation),
    onSuccess: (_r, v) => invalidate(v.id),
  });
  const activate = useMutation<R, Error, { id: string; expectedVersion?: number }>({
    mutationFn: ({ id, expectedVersion }) => apiClient.post<unknown>(`${BASE}/${id}/activate`, { expectedVersion }).then(toItemMutation),
    onSuccess: (_r, v) => invalidate(v.id),
  });
  const deactivate = useMutation<R, Error, { id: string; expectedVersion?: number }>({
    mutationFn: ({ id, expectedVersion }) => apiClient.post<unknown>(`${BASE}/${id}/deactivate`, { expectedVersion }).then(toItemMutation),
    onSuccess: (_r, v) => invalidate(v.id),
  });
  const saveRule = useMutation<R, Error, { id: string; warehouseId: string; input: Record<string, unknown> }>({
    mutationFn: ({ id, warehouseId, input }) => apiClient.put<unknown>(`${BASE}/${id}/warehouse-rules/${warehouseId}`, input, { headers: { "Idempotency-Key": uid() } }).then(toItemMutation),
    onSuccess: (_r, v) => invalidate(v.id),
  });
  // Phase W4 — replace the item's barcode list (primary + secondaries). 409
  // BARCODE_TAKEN surfaces as ApiError(isConflict=false, status 409) — the tab
  // shows it inline with the conflicting code.
  const saveBarcodes = useMutation<R, Error, { id: string; primaryBarcode: string | null; barcodes: { code: string; sizeVariant?: string | null }[]; expectedVersion: number }>({
    mutationFn: ({ id, ...input }) => apiClient.put<unknown>(`${BASE}/${id}/barcodes`, input).then(toItemMutation),
    onSuccess: (_r, v) => invalidate(v.id),
  });
  return { create, update, activate, deactivate, saveRule, saveBarcodes };
}

// Phase W4 — imperative barcode lookup (Topbar scan + the in-tab scan tester).
export interface BarcodeLookupResult { itemId: string; name: string; sku: string; unit: string; active: boolean; matchedBarcode: string | null; sizeVariant: string | null }
export async function lookupBarcode(code: string, signal?: AbortSignal): Promise<BarcodeLookupResult | null> {
  try {
    const r = await apiClient.get<{ data?: { item?: Record<string, unknown>; matchedBarcode?: string; sizeVariant?: string } }>(
      "/inventory/v2/items/by-barcode", { signal, params: { code } });
    const it = r?.data?.item as Record<string, unknown> | undefined;
    if (!it || !it.id) return null;
    return {
      itemId: String(it.id), name: String(it.name ?? it.id), sku: String(it.sku ?? ""), unit: String(it.unit ?? ""),
      active: it.active === 1 || it.active === true,
      matchedBarcode: r?.data?.matchedBarcode ? String(r.data.matchedBarcode) : null,
      sizeVariant: r?.data?.sizeVariant ? String(r.data.sizeVariant) : null,
    };
  } catch (e) {
    if (e instanceof Error && "status" in e && (e as { status?: number }).status === 404) return null;
    throw e;
  }
}
