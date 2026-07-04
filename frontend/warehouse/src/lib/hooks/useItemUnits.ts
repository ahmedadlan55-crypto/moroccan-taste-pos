// Phase U — per-item units & conversions (base + major units, frozen factors).
// GET returns the current set + a hasMovements flag (drives the factor-lock UI).
// PUT replaces the set (expectedVersion optimistic lock); the backend rejects an
// unsafe change after history with UNIT_LOCKED_BY_HISTORY.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";

export interface ItemUnitRow {
  id?: string;
  unitId?: string | null;
  unitName: string;
  unitCode: string;
  isBase: boolean;
  conversionToBase: number;
  precision: number;
  allowPurchase: boolean;
  allowReceipt: boolean;
  allowIssue: boolean;
  allowTransfer: boolean;
  allowStocktake: boolean;
  allowProduction: boolean;
  allowSale: boolean;
  barcodeId?: string | null;
  isActive: boolean;
  version?: number;
}
export interface ItemUnitsData {
  item: { id: string; name: string; unit: string; version: number };
  units: ItemUnitRow[];
  hasMovements: boolean;
}

export function useItemUnits(itemId: string | null) {
  return useQuery({
    enabled: !!itemId,
    queryKey: ["item-units", itemId],
    queryFn: ({ signal }) => apiClient.get<{ data: ItemUnitsData }>(`/inventory/v2/items/${itemId}/units`, { signal }).then((r) => r.data),
    staleTime: 15_000,
  });
}

export function useItemUnitsMutation(itemId: string) {
  const qc = useQueryClient();
  return useMutation<{ data: { units: ItemUnitRow[] }; version: number }, Error, { units: ItemUnitRow[]; expectedVersion?: number }>({
    mutationFn: (input) => apiClient.put(`/inventory/v2/items/${itemId}/units`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["item-units", itemId] });
      qc.invalidateQueries({ queryKey: ["items"] });
    },
  });
}
