// ── Sales Channels domain API adapter + React Query hooks ───────────────────
// Thin typed layer over @/shared/api. Every path/param mirrors the backend
// routes/sales-channels.js and routes/channel-menu.js EXACTLY (see those files
// for the wire shapes). Channels live at /api/sales-channels; per-channel item
// overrides at /api/channel-menus.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";
import type { TFunction } from "@/i18n";

const CH_KEY = ["sales-channels"] as const;
const MENU_KEY = ["channel-menus"] as const;

// ── Generic ack ──────────────────────────────────────────────────────────────
export interface MutationAck {
  success: boolean;
  error?: string;
  [k: string]: unknown;
}

// ════════════════════════════════════════════════════════════════════════════
// Channels
// ════════════════════════════════════════════════════════════════════════════
export interface SalesChannel {
  id: string;
  code: string;
  name: string;
  nameEn: string;
  channelType: string;
  priceListId: string | null;
  priceListName: string | null;
  icon: string;
  color: string;
  commissionPct: number;
  serviceFeePct: number;
  glRevenueAccount: string | null;
  glCommissionAccount: string | null;
  requiresExternalRef: boolean;
  allowDiscount: boolean;
  isActive: boolean;
  displayOrder: number;
  notes: string;
  useFullMenu: boolean;
}

// Create (POST) / update (PUT) body — camelCase, mirrors the route field maps.
// icon/color are intentionally omitted so the server keeps its defaults / the
// existing values (no new hex colors introduced from the UI).
export interface ChannelInput {
  code?: string;
  name: string;
  nameEn?: string;
  channelType?: string;
  priceListId?: string | null;
  commissionPct?: number;
  serviceFeePct?: number;
  requiresExternalRef?: boolean;
  allowDiscount?: boolean;
  isActive?: boolean;
  displayOrder?: number;
  notes?: string;
  useFullMenu?: boolean;
}

export function useChannels(enabled = true) {
  return useQuery({
    queryKey: [...CH_KEY, "list"],
    enabled,
    queryFn: async () => {
      // On a DB error the route returns { error, channels: [] } with a 200; on
      // success it returns a bare array. Normalize both to SalesChannel[].
      const res = await apiClient.get<SalesChannel[] | { channels?: SalesChannel[] }>(
        "/sales-channels",
      );
      return Array.isArray(res) ? res : (res.channels ?? []);
    },
  });
}

export function useCreateChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ChannelInput) =>
      apiClient.post<MutationAck>("/sales-channels", input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CH_KEY });
      qc.invalidateQueries({ queryKey: MENU_KEY });
    },
  });
}

export function useUpdateChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; input: ChannelInput }) =>
      apiClient.put<MutationAck>(`/sales-channels/${v.id}`, v.input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CH_KEY });
      qc.invalidateQueries({ queryKey: MENU_KEY });
    },
  });
}

export function useDeleteChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.delete<MutationAck>(`/sales-channels/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CH_KEY });
      qc.invalidateQueries({ queryKey: MENU_KEY });
    },
  });
}

export function useToggleChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.patch<MutationAck>(`/sales-channels/${id}/toggle`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CH_KEY });
      qc.invalidateQueries({ queryKey: MENU_KEY });
    },
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Per-channel menu-item overrides
// ════════════════════════════════════════════════════════════════════════════
export interface ChannelItem {
  id: string;
  channelId: string;
  branchId: string | null;
  menuItemId: string;
  itemName: string;
  category: string | null;
  menuCategory: string | null;
  basePrice: number;
  overridePrice: number | null;
  priceListPrice: number | null;
  priceSource: "override" | "priceList" | "menu" | string;
  effectivePrice: number;
  cost: number;
  isAvailable: boolean;
  dailyLimit: number | null;
  soldToday: number;
  sortOrder: number;
  notes: string | null;
}
export interface ChannelItemsResponse {
  priceList: { id: string; name: string } | null;
  items: ChannelItem[];
}

export function useChannelItems(channelId: string | null) {
  return useQuery({
    queryKey: [...MENU_KEY, "items", channelId],
    enabled: !!channelId,
    queryFn: () => apiClient.get<ChannelItemsResponse>(`/channel-menus/${channelId}`),
  });
}

// Candidate menu items NOT yet on the channel (for the "add items" picker).
export interface AvailableItem {
  id: string;
  name: string;
  price: number;
  category: string | null;
  cost: number;
  brand_name?: string | null;
}
export function useAvailableItems(
  channelId: string | null,
  brandId: string | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: [...MENU_KEY, "available", channelId, brandId ?? "all"],
    enabled: enabled && !!channelId,
    queryFn: () =>
      apiClient.get<AvailableItem[]>(`/channel-menus/${channelId}/available-items`, {
        params: { brandId: brandId || undefined },
      }),
  });
}

// Bulk add. `defaults` uses snake_case keys — the route reads d.is_available,
// d.override_price, d.daily_limit, d.sort_order directly.
export interface ChannelItemDefaults {
  is_available?: boolean;
  override_price?: number | null;
  daily_limit?: number | null;
  sort_order?: number;
}
export function useAddChannelItems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { channelId: string; itemIds: string[]; defaults?: ChannelItemDefaults }) =>
      apiClient.post<{ success: boolean; added?: number; requested?: number; error?: string }>(
        `/channel-menus/${v.channelId}/items`,
        { itemIds: v.itemIds, defaults: v.defaults },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: MENU_KEY });
      qc.invalidateQueries({ queryKey: CH_KEY });
    },
  });
}

// Update one override row. The route addresses the row by channel + menu_item_id
// and reads snake_case fields from the body.
export interface ChannelItemPatch {
  is_available?: boolean;
  override_price?: number | null;
  daily_limit?: number | null;
  sort_order?: number;
  notes?: string | null;
}
export function useUpdateChannelItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { channelId: string; menuItemId: string; patch: ChannelItemPatch }) =>
      apiClient.put<MutationAck>(
        `/channel-menus/${v.channelId}/items/${v.menuItemId}`,
        v.patch,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: MENU_KEY });
    },
  });
}

export function useDeleteChannelItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { channelId: string; menuItemId: string }) =>
      apiClient.delete<MutationAck>(
        `/channel-menus/${v.channelId}/items/${v.menuItemId}`,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: MENU_KEY });
      qc.invalidateQueries({ queryKey: CH_KEY });
    },
  });
}

export function useCopyChannelItems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { channelId: string; srcChannelId: string }) =>
      apiClient.post<{ success: boolean; copied?: number; total_source?: number; error?: string }>(
        `/channel-menus/${v.channelId}/copy-from/${v.srcChannelId}`,
        {},
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: MENU_KEY });
      qc.invalidateQueries({ queryKey: CH_KEY });
    },
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Lookups — brands (for the item picker filter) + price lists (channel form)
// ════════════════════════════════════════════════════════════════════════════
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

export interface PriceListOption {
  id: string;
  name: string;
  isActive: boolean;
}
export function usePriceLists() {
  return useQuery({
    queryKey: ["erp", "price-lists"],
    staleTime: 300_000,
    queryFn: async () => {
      const rows = await apiClient.get<Array<{ id: string; name: string; isActive?: boolean }>>(
        "/erp/price-lists",
      );
      return (rows ?? []).map((p) => ({ id: p.id, name: p.name, isActive: p.isActive !== false }));
    },
  });
}

// Server error strings → surfaced as-is (already localized on these routes);
// only the generic fallback is translated via t.
export function channelError(error: unknown, t: TFunction): string {
  const raw = error instanceof Error ? error.message : "";
  return raw || t("sales.opFailed");
}
