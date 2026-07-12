// Phase U — typed server-side fetchers for SearchableEntityCombobox. Each maps
// one backend search endpoint to the generic EntityPage<T> contract. Factories
// (`makeItemFetcher`, `makeAccountFetcher`) bake in context/scope params so a
// call site only wires the picker. All searches are paginated server-side; none
// loads the whole table.

import { apiClient } from "@/shared/api";
import type { EntityFetcher, EntityPage } from "@/shared/ui";

// ── shared shapes ────────────────────────────────────────────────────────────
export interface ItemHit {
  id: string;
  name: string;
  nameEn?: string | null;
  sku?: string | null;
  category?: string | null;
  primaryBarcode?: string | null;
  baseUnit: { code: string; name: string };
  majorUnits: { unitCode: string; unitName: string; factor: number }[];
  trackingMode?: string;
  active: boolean;
  warehouseQty?: number | null;
  warehouseCost?: number | null;
  warning?: "low" | "out" | "negative" | null;
}
export interface AccountHit { id: string; code: string; name: string; nameEn?: string | null; type: string; parentId?: string | null; active: boolean }
export interface SupplierHit { id: string; name: string; nameEn?: string | null; vatNumber?: string | null; phone?: string | null; active: boolean }
export interface CustomerHit { id: string; name: string; nameEn?: string | null; phone?: string | null; customerType?: string | null }
export interface WarehouseHit { id: string; name: string; code?: string | null; type?: string | null; isMain?: boolean; active?: boolean }

interface Paged<T> { data: T[]; pagination?: { page: number; totalPages: number; total: number }; exactBarcodeId?: string | null }
function toPage<T>(r: Paged<T>): EntityPage<T> {
  // Contract guard: a paginated search MUST return `{ data: [...] }`. If the
  // shape is wrong (null body, an HTML error page coerced to text, a non-array
  // `data`), throw so the combobox shows its error+retry state instead of
  // silently rendering an empty list. A legitimate empty result is `data: []`.
  if (r == null || typeof r !== "object" || !Array.isArray((r as Paged<T>).data)) {
    throw new Error("SEARCH_CONTRACT_INVALID");
  }
  const pg = r.pagination;
  const nextPage = pg && pg.page < pg.totalPages ? pg.page + 1 : null;
  return { items: r.data, nextPage, total: pg?.total ?? r.data.length, exactMatchId: r.exactBarcodeId ?? null };
}

// ── items / materials / products ─────────────────────────────────────────────
export interface ItemFetcherOpts {
  warehouseId?: string | null;
  context?: string; // receipt|issue|waste|transfer|stocktake|production|sale|adjustment|report
  category?: string | null;
  activeOnly?: boolean;
  pageSize?: number;
}
export function makeItemFetcher(opts: ItemFetcherOpts = {}): EntityFetcher<ItemHit> {
  return ({ q, page, signal }) =>
    apiClient
      .get<Paged<ItemHit>>("/inventory/v2/item-search", {
        signal,
        params: {
          q, page, pageSize: opts.pageSize ?? 20,
          warehouseId: opts.warehouseId ?? undefined,
          context: opts.context ?? undefined,
          category: opts.category ?? undefined,
          activeOnly: opts.activeOnly === false ? 0 : 1,
        },
      })
      .then(toPage);
}

// ── GL accounts (posting-leaf, context allow-list) ───────────────────────────
export interface AccountFetcherOpts { context?: string; postingOnly?: boolean; accountType?: string; pageSize?: number }
export function makeAccountFetcher(opts: AccountFetcherOpts = {}): EntityFetcher<AccountHit> {
  return ({ q, page, signal }) =>
    apiClient
      .get<Paged<AccountHit>>("/accounting/accounts/search", {
        signal,
        params: {
          q, page, pageSize: opts.pageSize ?? 20,
          context: opts.context ?? undefined,
          postingOnly: opts.postingOnly === false ? 0 : 1,
          accountType: opts.accountType ?? undefined,
        },
      })
      .then(toPage);
}

// ── suppliers ────────────────────────────────────────────────────────────────
export const supplierFetcher: EntityFetcher<SupplierHit> = ({ q, page, signal }) =>
  apiClient.get<Paged<SupplierHit>>("/erp/suppliers/search", { signal, params: { q, page, pageSize: 20 } }).then(toPage);

// ── customers (cashier) — endpoint returns a bare array, single page ─────────
export const customerFetcher: EntityFetcher<CustomerHit> = ({ q, signal }) =>
  apiClient.get<CustomerHit[]>("/erp/customers/search", { signal, params: { q } }).then((rows) => ({
    items: Array.isArray(rows) ? rows : [], nextPage: null, total: Array.isArray(rows) ? rows.length : 0,
  }));

// ── warehouses — small list; fetch once, filter client-side, single page ─────
export const warehouseFetcher: EntityFetcher<WarehouseHit> = ({ q, signal }) =>
  apiClient.get<{ data?: WarehouseHit[] }>("/inventory/v2/warehouses", { signal }).then((r) => {
    const all = Array.isArray(r?.data) ? r.data : [];
    const needle = q.trim().toLowerCase();
    const items = needle
      ? all.filter((w) => `${w.name} ${w.code ?? ""}`.toLowerCase().includes(needle))
      : all;
    return { items, nextPage: null, total: items.length };
  });
