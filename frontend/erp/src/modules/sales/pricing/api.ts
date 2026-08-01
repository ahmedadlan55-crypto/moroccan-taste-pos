// ── Menu Pricing domain API adapter + React Query hooks ─────────────────────
// Thin typed layer over @/shared/api. Every path/param mirrors routes/menu.js
// EXACTLY. Reads are public; the price WRITE endpoints (PATCH price, bulk, …)
// are manager/admin gated server-side and require the JWT (attached by the
// api client). Price-history is derived from audit_logs on the server.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";
import type { TFunction } from "@/i18n";

const KEY = ["sales-pricing"] as const;

// ── Menu items (with prices) ─────────────────────────────────────────────────
export interface MenuItem {
  id: string;
  name: string;
  nameEn: string;
  price: number;
  category: string;
  cost: number;
  active: boolean;
  brandId: string;
  brandName: string;
  computedCost: number;
  pricingMode: string;
  isCombo: boolean;
  /** ZATCA tax category (S/Z/E/O). Shipped by _mapMenu; needed to convert the
   *  stored net price to what the customer actually pays. */
  taxCategory?: string;
  /** Whether `price` already contains VAT. Also from _mapMenu. */
  isTaxInclusive?: boolean;
}

// GET /menu/all — admin list (active + inactive). Default hides semi-finished
// items (they are cost-driven, not priced for sale), which is exactly what the
// pricing screen wants. Optional brand filter.
export function useMenuItems(brandId: string | undefined) {
  return useQuery({
    queryKey: [...KEY, "items", brandId ?? "all"],
    queryFn: () =>
      apiClient.get<MenuItem[]>("/menu/all", {
        params: { brandId: brandId || undefined },
      }),
  });
}

// ── Single price edit (PATCH /menu/:id/price) ────────────────────────────────
export interface PriceUpdateAck {
  success: boolean;
  noop?: boolean;
  oldPrice?: number;
  newPrice?: number;
  cost?: number;
  marginPct?: number;
  error?: string;
}
export function useUpdatePrice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; price: number; reason: string }) =>
      apiClient.patch<PriceUpdateAck>(`/menu/${v.id}/price`, {
        price: v.price,
        reason: v.reason,
      }),
    onSuccess: (_res, v) => {
      qc.invalidateQueries({ queryKey: [...KEY, "items"] });
      qc.invalidateQueries({ queryKey: [...KEY, "history", v.id] });
    },
  });
}

// ── Bulk price update (POST /menu/bulk-price-update) ─────────────────────────
export type BulkMode = "percent" | "fixed_set" | "fixed_add";
export interface BulkResultItem {
  id: string;
  name: string;
  oldPrice: number;
  newPrice: number;
  cost: number;
  marginPct: number;
}
export interface BulkAck {
  success: boolean;
  affected?: number;
  mode?: string;
  value?: number;
  items?: BulkResultItem[];
  error?: string;
}
// The server REQUIRES an explicit scope: itemIds OR (brandId / categoryFilter).
// Never allow an unscoped "update everything".
export interface BulkInput {
  itemIds?: string[];
  brandId?: string;
  categoryFilter?: string;
  mode: BulkMode;
  value: number;
  reason?: string;
}
export function useBulkPriceUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BulkInput) =>
      apiClient.post<BulkAck>("/menu/bulk-price-update", input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...KEY, "items"] });
      qc.invalidateQueries({ queryKey: [...KEY, "history"] });
    },
  });
}

// ── Price history for one item (GET /menu/:id/price-history) ──────────────────
export interface PriceHistoryEntry {
  id: string | number;
  user: string;
  at: string;
  oldPrice: number;
  newPrice: number;
  cost: number;
  reason: string;
}
export function usePriceHistory(itemId: string | null) {
  return useQuery({
    queryKey: [...KEY, "history", itemId],
    enabled: !!itemId,
    queryFn: () => apiClient.get<PriceHistoryEntry[]>(`/menu/${itemId}/price-history`),
  });
}

// ── Brands (filter + bulk scope) ─────────────────────────────────────────────
export interface BrandOption {
  id: string;
  name: string;
}
export function useBrands() {
  return useQuery({
    queryKey: ["erp", "brands-stats"],
    staleTime: 300_000,
    queryFn: async () => {
      const rows = await apiClient.get<Array<{ id: string; name: string }>>("/erp/brands-stats");
      return (rows ?? []).map((b) => ({ id: b.id, name: b.name }));
    },
  });
}

// Margin helper — percentage of price kept after cost.
export function marginPct(price: number, cost: number): number {
  if (!(price > 0)) return 0;
  return Math.round(((price - cost) / price) * 1000) / 10;
}

export function pricingError(error: unknown, t: TFunction): string {
  const raw = error instanceof Error ? error.message : "";
  return raw || t("sales.opFailed");
}
