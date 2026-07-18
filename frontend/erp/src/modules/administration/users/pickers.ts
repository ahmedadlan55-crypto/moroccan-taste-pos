import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";
import { asArray } from "../_common";

// Brand / branch / warehouse pickers for the user form. These REUSE the exact
// endpoints the rest of the Administration module already reads — /erp/brands
// (Branches › BranchFormDialog), /erp/branches-full (Branches list), and
// /erp/warehouses-list (accounting dimension lookups) — and share their query
// keys so the caches stay hot. No new fetch logic is introduced.

export interface PickerOption {
  id: string;
  name: string;
}
export interface BranchOption extends PickerOption {
  brandId?: string;
  warehouseId?: string;
  warehouseName?: string;
}

export function useBrandOptions(enabled: boolean) {
  return useQuery({
    queryKey: ["erp", "brands"],
    enabled,
    queryFn: async ({ signal }) =>
      asArray<PickerOption>(await apiClient.get<unknown>("/erp/brands", { signal })),
  });
}

export function useBranchOptions(enabled: boolean) {
  return useQuery({
    queryKey: ["erp", "branches-full"],
    enabled,
    queryFn: async ({ signal }) =>
      asArray<BranchOption>(await apiClient.get<unknown>("/erp/branches-full", { signal })),
  });
}

export function useWarehouseOptions(enabled: boolean) {
  return useQuery({
    queryKey: ["erp", "warehouses-list"],
    enabled,
    queryFn: async ({ signal }) =>
      asArray<PickerOption>(await apiClient.get<unknown>("/erp/warehouses-list", { signal })),
  });
}
