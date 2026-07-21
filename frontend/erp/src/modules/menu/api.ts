// ── Menu & Recipes domain API adapter + React Query hooks ──────────────────────
// Thin typed layer over @/shared/api for the server-owned menu engine
// (routes/menu.js → /api/menu/*), plus the brand list (/api/erp/brands) and the
// inventory-item catalog (/api/inventory/items) the recipe editor picks from.
//
// Many legacy menu WRITE routes answer HTTP 200 with `{ success:false, error }`
// on failure (only validation errors use 4xx). apiClient therefore does NOT throw
// on those — mutations pipe the ack through `ensureOk` so a failed write surfaces
// as a rejected mutation instead of a silent success. Study parity: this mirrors
// modules/people/payroll/api.ts (ensureOk) and modules/banking/api.ts (queryKeys).

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";
import type { EntityFetcher, EntityPage } from "@/shared/ui";

// ── Query keys ─────────────────────────────────────────────────────────────────
const KEY = ["menu"] as const;
export const qk = {
  all: KEY,
  brands: () => [...KEY, "brands"] as const,
  items: (params?: unknown) => [...KEY, "items", params ?? {}] as const,
  priceHistory: (id: string) => [...KEY, "price-history", id] as const,
  recipes: () => [...KEY, "recipes"] as const,
  recipeBom: (id: string | null) => [...KEY, "recipe-bom", id] as const,
  semiFinished: (brandId?: string) => [...KEY, "semi-finished", brandId ?? "all"] as const,
  combos: (brandId?: string) => [...KEY, "combos", brandId ?? "all"] as const,
  invItems: (brandId?: string) => [...KEY, "inv-items", brandId ?? "all"] as const,
  images: (params?: unknown) => [...KEY, "images", params ?? {}] as const,
  categories: () => [...KEY, "categories"] as const,
};

// ── Shared mutation ack ──────────────────────────────────────────────────────
export interface MutationAck {
  success?: boolean;
  error?: string;
  [k: string]: unknown;
}
/** Throw on the legacy `{ success:false, error }` 200-response shape. */
function ensureOk<T extends MutationAck>(d: T): T {
  if (d && d.success === false) throw new Error(String(d.error || "تعذّر تنفيذ العملية"));
  return d;
}

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

export interface Brand {
  id: string;
  name: string;
  code: string;
  logo: string | null;
  isActive: boolean;
}

export interface MenuItem {
  id: string;
  name: string;
  nameEn: string;
  price: number;
  category: string;
  cost: number;
  computedCost: number;
  stock: number;
  minStock: number;
  active: boolean;
  brandId: string;
  brandName: string;
  pricingMode: string;
  markupPct: number;
  isSemiFinished: boolean;
  isCombo: boolean;
  bomId: string | null;
  productionMethod: string;
  deductStrategy: string;
  unit: string | null;
  bigUnit: string | null;
  convRate: number;
  yieldQuantity: number;
  yieldUnit: string | null;
  isTaxInclusive: boolean;
  /** close/d-images — stored product image as a base64 data URL (null = none).
   *  _mapMenu (routes/menu.js) has always shipped it on /menu/all; typed
   *  optional so older payload mocks stay valid. The POS catalog never carries
   *  it — cards fetch bytes from /api/pos/v2/item-image/:id instead. */
  imageData?: string | null;
  /** close/d-images bulk manager (ImageManager) — FORWARD-LOOKING optional
   *  fields for an image review/audit workflow. NEITHER /menu/all NOR the
   *  verified GET /api/product-images contract (routes/product-images.js)
   *  populates these today — there is no review-status workflow anywhere in
   *  the backend yet. Kept here (always undefined at runtime right now) so
   *  ImageManager's review-status filter and status column have somewhere to
   *  read from the moment such a workflow ships, without another type change. */
  imageReviewStatus?: "pending" | "approved" | "rejected" | null;
  imageUpdatedAt?: string | null;
  imageUpdatedBy?: string | null;
}

/** POST /menu + PUT /menu/:id body (create/update a catalog item). On PUT the
 *  route resets unit/yield columns when they are absent, so the edit form carries
 *  the existing values through (see BrandMenu) to avoid clobbering them. */
export interface MenuItemInput {
  name: string;
  nameEn?: string;
  price: number;
  category: string;
  cost: number;
  stock?: number;
  minStock?: number;
  active?: boolean;
  pricingMode?: string;
  markupPct?: number;
  brandId?: string | null;
  unit?: string | null;
  bigUnit?: string | null;
  convRate?: number;
  yieldQuantity?: number;
  yieldUnit?: string | null;
  taxInclusive?: boolean;
  taxCategory?: string;
  /** close/d-images — ≤512px JPEG data URL from ItemImageEditor. Absent =
   *  leave the stored image untouched (PUT); '' = clear it. The server 400s
   *  anything that is not data:image/(jpeg|png|webp);base64 ≤ 300KB decoded. */
  imageData?: string;
}

export interface PriceHistoryRow {
  id: string;
  user: string;
  at: string;
  oldPrice: number;
  newPrice: number;
  cost: number;
  reason: string;
}

export interface InvItem {
  id: string;
  name: string;
  category: string;
  kind: string;
  cost: number;
  stock: number;
  minStock: number;
  unit: string | null;
  brandId: string;
  brandName: string;
}

export interface RecipeBomLine {
  id: string;
  componentItemId: string;
  itemName: string;
  unit: string;
  quantity: number;
  wastePct: number;
  avgCost: number;
  lineCost: number;
}
export interface RecipeBom {
  menuId: string;
  menuName: string;
  bomId: string | null;
  version: number;
  yieldQuantity: number;
  yieldUnit: string;
  productionMethod: string;
  deductStrategy: string;
  allowNegativeStock: boolean;
  minStockAlert: number;
  lines: RecipeBomLine[];
  totalCost: number;
  hasLegacyRecipe: boolean;
}
/** POST /menu/:id/recipe-bom body. */
export interface RecipeBomInput {
  yieldQuantity: number;
  yieldUnit: string;
  notes?: string;
  lines: Array<{ componentItemId: string; quantity: number; unit: string; wastePct: number }>;
}

export interface SemiFinishedItem {
  id: string;
  name: string;
  category: string;
  cost: number;
  stock: number;
  minStock: number;
  unit: string | null;
  bigUnit: string | null;
  convRate: number;
  brandId: string;
  brandName: string;
  consumerCount: number;
}

export interface ComboOption {
  menuItemId: string;
  name: string;
  nameEn: string;
  price: number;
  qty: number;
  hasRecipe: boolean;
  active: boolean;
}
export interface ComboGroup {
  id: string;
  type: "fixed" | "choice";
  name: string;
  minSelect: number;
  maxSelect: number;
  options: ComboOption[];
}
export interface Combo {
  id: string;
  name: string;
  nameEn: string;
  price: number;
  cost: number;
  category: string;
  brandId: string;
  active: boolean;
  isCombo: boolean;
  groups: ComboGroup[];
}
/** POST/PUT /menu/combos body. */
export interface ComboInput {
  name: string;
  nameEn?: string;
  price: number;
  category?: string;
  brandId?: string | null;
  active?: boolean;
  groups: Array<{
    type: "fixed" | "choice";
    name: string;
    minSelect?: number;
    maxSelect?: number;
    items: Array<{ menuItemId: string; qty: number }>;
  }>;
}

export interface BulkPriceInput {
  itemIds?: string[];
  brandId?: string | null;
  categoryFilter?: string | null;
  mode: "percent" | "fixed_set" | "fixed_add";
  value: number;
  reason?: string;
}
export interface BulkPriceResult extends MutationAck {
  affected: number;
  mode: string;
  value: number;
  items: Array<{ id: string; name: string; oldPrice: number; newPrice: number; cost: number; marginPct: number }>;
}

// ── close/d-images bulk manager (ImageManager) ──────────────────────────────
// GET/POST/PUT/DELETE /api/product-images* — routes/product-images.js (Owner
// C), confirmed against the ACTUAL router source in this worktree on
// 2026-07-20 (it already exists, just not yet mounted in server.js — see
// ImageManager.tsx's header comment for why the live table still sources
// from useMenuItems instead of useImageList).
//
// IMPORTANT: the list row is NOT a MenuItem. routes/product-images.js
// deliberately never selects image_data in the list query ("the 66MB rule")
// — it ships only a content-hash version tag (imageVer) + byte length, no
// brandName/price/cost/thumbnail. So this can power filters and audit
// columns but NEVER the thumbnail preview column; /menu/all remains the only
// source with the actual image bytes.
export interface ImageListFilters {
  brandId?: string;
  category?: string;
  /** true = only items WITH an image, false = only items MISSING one. */
  hasImage?: boolean;
  q?: string;
  page?: number;
  pageSize?: number;
}
export interface ProductImageListItem {
  id: string;
  name: string;
  nameEn: string;
  category: string;
  brandId: string;
  /** 8-char content hash of image_data; null when the item has no image. */
  imageVer: string | null;
  /** Decoded byte length of image_data (0 when there is no image). */
  imageBytes: number;
}
export interface ImageListPage extends MutationAck {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  items: ProductImageListItem[];
}

export interface BulkImageUploadItem {
  menuId: string;
  /** ≤512px JPEG q0.8 base64 data URL, already run through downscaleImageFile. */
  imageData: string;
}
export interface BulkImageUploadResult {
  menuId: string | null;
  ok: boolean;
  code?: string;
  error?: string;
  dryRun?: boolean;
  /** sha1 content hash before/after the write (null = no image). */
  before?: string | null;
  after?: string | null;
}
export interface BulkImageUploadResponse extends MutationAck {
  dryRun: boolean;
  total: number;
  succeeded: number;
  failed: number;
  results: BulkImageUploadResult[];
}

// ── bilingual-i18n-images — category translations (CategoryTranslations) ───
// GET/PUT /api/menu/categories* — routes/menu.js, backed by
// db/migrations/0013_bilingual_catalog.sql (menu_category_i18n: category_ar
// PK + category_en). GET is public (no auth), same as the rest of the
// catalog-shaped reads in this file; PUT is MGR-gated (admin/developer/
// manager), matching capability "menu.catalog.manage" below.
export interface CategoryTranslation {
  /** The Arabic category name as stored on `menu.category` — the stable key
   *  (GROUP BY m.category server-side), NOT a synthetic id. */
  categoryAr: string;
  /** '' when no translation has been saved yet for this Arabic name. */
  categoryEn: string;
  /** Count of non-deleted menu items currently in this category. */
  itemCount: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Queries
// ════════════════════════════════════════════════════════════════════════════

export function useBrands() {
  return useQuery({
    queryKey: qk.brands(),
    staleTime: 300_000,
    queryFn: ({ signal }) => apiClient.get<Brand[]>("/erp/brands", { signal }),
  });
}

/** GET /menu/all — admin list (includes inactive). `type` defaults to "all"
 *  (finished + semi + combos) so the catalog screens see everything. */
export function useMenuItems(opts: { brandId?: string; type?: "all" | "finished" | "semi" } = {}) {
  const { brandId, type = "all" } = opts;
  return useQuery({
    queryKey: qk.items({ brandId: brandId ?? "", type }),
    queryFn: ({ signal }) =>
      apiClient.get<MenuItem[]>("/menu/all", { signal, params: { brandId: brandId || undefined, type } }),
  });
}

export function usePriceHistory(id: string | null) {
  return useQuery({
    queryKey: qk.priceHistory(id ?? ""),
    enabled: !!id,
    queryFn: ({ signal }) => apiClient.get<PriceHistoryRow[]>(`/menu/${id}/price-history`, { signal }),
  });
}

export function useRecipes() {
  return useQuery({
    queryKey: qk.recipes(),
    queryFn: ({ signal }) =>
      apiClient.get<Array<{ menuId: string; menuName: string; invItemId: string; invItemName: string; qtyUsed: number }>>(
        "/menu/recipes",
        { signal },
      ),
  });
}

export function useRecipeBom(menuId: string | null) {
  return useQuery({
    queryKey: qk.recipeBom(menuId),
    enabled: !!menuId,
    queryFn: ({ signal }) => apiClient.get<RecipeBom>(`/menu/${menuId}/recipe-bom`, { signal }),
  });
}

export function useSemiFinished(brandId?: string) {
  return useQuery({
    queryKey: qk.semiFinished(brandId),
    queryFn: ({ signal }) =>
      apiClient.get<SemiFinishedItem[]>("/menu/semi-finished", { signal, params: { brandId: brandId || undefined } }),
  });
}

export function useCombos(brandId?: string) {
  return useQuery({
    queryKey: qk.combos(brandId),
    queryFn: ({ signal }) =>
      apiClient.get<Combo[]>("/menu/combos", { signal, params: { brandId: brandId || undefined } }),
  });
}

/** GET /product-images — paginated, filterable image-audit list (id/name/
 *  category/brandId/imageVer/imageBytes — NO image bytes, see the type doc
 *  above). `pageSize` caps at 200 server-side (routes/product-images.js).
 *  NOTE (2026-07-20): the router exists in this worktree but is not yet
 *  mounted in server.js (Owner C's in-progress work) — ImageManager's live
 *  table currently sources from useMenuItems instead (see ImageManager.tsx's
 *  header comment for why: this endpoint could never power the thumbnail
 *  column anyway). Kept here, verified against the real router source, ready
 *  for whatever audit/status view eventually wants it. */
export function useImageList(filters: ImageListFilters = {}) {
  const { brandId, category, hasImage, q, page = 1, pageSize = 50 } = filters;
  return useQuery({
    queryKey: qk.images({ brandId, category, hasImage, q, page, pageSize }),
    queryFn: ({ signal }) =>
      apiClient.get<ImageListPage>("/product-images", {
        signal,
        params: {
          brandId: brandId || undefined,
          category: category || undefined,
          hasImage,
          q: q || undefined,
          page,
          pageSize,
        },
      }),
  });
}

/** GET /menu/categories — every distinct category in use, its English label
 *  (if translated) and how many items sit in it. Public read (no auth), so
 *  this is safe to call from any screen with menu.view. */
export function useCategoryList() {
  return useQuery({
    queryKey: qk.categories(),
    queryFn: ({ signal }) => apiClient.get<CategoryTranslation[]>("/menu/categories", { signal }),
  });
}

/** Inventory items catalog (raw + semi) — the component source for recipe BOM
 *  lines. The legacy /inventory/items route returns a plain array. */
export function useInventoryItems(brandId?: string) {
  return useQuery({
    queryKey: qk.invItems(brandId),
    staleTime: 60_000,
    queryFn: ({ signal }) =>
      apiClient.get<InvItem[]>("/inventory/items", { signal, params: { brandId: brandId || undefined } }),
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Mutations
// ════════════════════════════════════════════════════════════════════════════

export function useCreateMenuItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: MenuItemInput) =>
      apiClient.post<MutationAck & { id?: string }>("/menu", input).then(ensureOk),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEY, "items"] }),
  });
}

export function useUpdateMenuItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; input: MenuItemInput }) =>
      apiClient.put<MutationAck>(`/menu/${v.id}`, v.input).then(ensureOk),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEY, "items"] }),
  });
}

export function useDeleteMenuItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.delete<MutationAck>(`/menu/${id}`).then(ensureOk),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEY, "items"] }),
  });
}

/** PUT /menu/categories/:categoryAr — set/replace the English label for an
 *  Arabic category name (upsert into menu_category_i18n). MGR-gated
 *  server-side; the caller must hold "menu.catalog.manage". `categoryAr` is
 *  Arabic text living in the URL path, so it MUST be percent-encoded. */
export function useUpdateCategoryEn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { categoryAr: string; categoryEn: string }) =>
      apiClient
        .put<MutationAck & { categoryAr?: string; categoryEn?: string }>(
          `/menu/categories/${encodeURIComponent(v.categoryAr)}`,
          { categoryEn: v.categoryEn },
        )
        .then(ensureOk),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.categories() }),
  });
}

/** PATCH /menu/:id/price — records a price-change audit row (reason required). */
export function useUpdatePrice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; price: number; reason: string }) =>
      apiClient
        .patch<MutationAck & { oldPrice?: number; newPrice?: number; marginPct?: number; noop?: boolean }>(
          `/menu/${v.id}/price`,
          { price: v.price, reason: v.reason },
        )
        .then(ensureOk),
    onSuccess: (_res, v) => {
      qc.invalidateQueries({ queryKey: [...KEY, "items"] });
      qc.invalidateQueries({ queryKey: qk.priceHistory(v.id) });
    },
  });
}

export function useBulkPriceUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BulkPriceInput) =>
      apiClient.post<BulkPriceResult>("/menu/bulk-price-update", input).then(ensureOk),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEY, "items"] }),
  });
}

export function useSaveRecipeBom() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { menuId: string; input: RecipeBomInput }) =>
      apiClient
        .post<MutationAck & { bomId?: string; computedCost?: number }>(`/menu/${v.menuId}/recipe-bom`, v.input)
        .then(ensureOk),
    onSuccess: (_res, v) => {
      qc.invalidateQueries({ queryKey: qk.recipeBom(v.menuId) });
      qc.invalidateQueries({ queryKey: [...KEY, "items"] });
      qc.invalidateQueries({ queryKey: qk.recipes() });
    },
  });
}

/** POST /product-images/bulk — {items:[{menuId,imageData}]} → {results:[...]}.
 *  Server caps a batch at 100 items (MAX_BULK_ITEMS in routes/product-images.js)
 *  and rejects the whole request with code BULK_LIMIT_EXCEEDED above that — the
 *  caller only needs a normal mutation onError handler, apiClient already
 *  throws on the 400 before ensureOk runs. NOTE (2026-07-20): the router
 *  exists in this worktree (verified against source) but is not yet mounted
 *  in server.js. There is no legacy bulk-image equivalent on /api/menu, so
 *  this is the only path ImageManagerBulkUpload can call — it will start
 *  working the moment Owner C's mount lands, no frontend change needed. */
export function useBulkUploadImages() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (items: BulkImageUploadItem[]) =>
      apiClient.post<BulkImageUploadResponse>("/product-images/bulk", { items }).then(ensureOk),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.images() });
      qc.invalidateQueries({ queryKey: [...KEY, "items"] });
    },
  });
}

/** DELETE /product-images/:menuId — clears the stored image for one item.
 *  NOTE (2026-07-20): router exists but not yet mounted (see useImageList).
 *  ImageManager's row action currently falls back to
 *  useUpdateMenuItem({imageData:""}) (the EXISTING /menu/:id path) for
 *  standalone usability; swap the call site to this hook once server.js
 *  mounts the router. */
export function useDeleteImage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (menuId: string) => apiClient.delete<MutationAck>(`/product-images/${menuId}`).then(ensureOk),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.images() });
      qc.invalidateQueries({ queryKey: [...KEY, "items"] });
    },
  });
}

/** PUT /product-images/:menuId — {imageData} → replaces one item's image.
 *  NOTE (2026-07-20): router exists but not yet mounted — same fallback story
 *  as useDeleteImage. */
export function useReplaceImage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { menuId: string; imageData: string }) =>
      apiClient.put<MutationAck>(`/product-images/${v.menuId}`, { imageData: v.imageData }).then(ensureOk),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.images() });
      qc.invalidateQueries({ queryKey: [...KEY, "items"] });
    },
  });
}

export function useCreateCombo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ComboInput) =>
      apiClient.post<MutationAck & { id?: string; cost?: number }>("/menu/combos", input).then(ensureOk),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEY, "combos"] }),
  });
}

export function useUpdateCombo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; input: ComboInput }) =>
      apiClient.put<MutationAck & { cost?: number }>(`/menu/combos/${v.id}`, v.input).then(ensureOk),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEY, "combos"] }),
  });
}

export function useDeleteCombo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.delete<MutationAck>(`/menu/combos/${id}`).then(ensureOk),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEY, "combos"] }),
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Combobox fetchers (in-memory client filter over a loaded list)
// ════════════════════════════════════════════════════════════════════════════

/** Client-side fetcher over the loaded inventory catalog → drives a
 *  SearchableEntityCombobox with instant filtering (no per-keystroke network). */
export function makeInvItemFetcher(items: InvItem[]): EntityFetcher<InvItem> {
  return ({ q }) => {
    const needle = q.trim().toLowerCase();
    const list = needle
      ? items.filter((i) => `${i.name} ${i.category}`.toLowerCase().includes(needle))
      : items;
    return Promise.resolve({ items: list, nextPage: null, total: list.length } as EntityPage<InvItem>);
  };
}

/** Client-side fetcher over a loaded menu-item list (combo option picker). */
export function makeMenuItemFetcher(items: MenuItem[]): EntityFetcher<MenuItem> {
  return ({ q }) => {
    const needle = q.trim().toLowerCase();
    const list = needle
      ? items.filter((i) => `${i.name} ${i.nameEn} ${i.category}`.toLowerCase().includes(needle))
      : items;
    return Promise.resolve({ items: list, nextPage: null, total: list.length } as EntityPage<MenuItem>);
  };
}
