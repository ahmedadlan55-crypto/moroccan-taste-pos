/**
 * modules/menu/recipesApi.ts — the ONE data layer for the unified recipe domain
 * (`routes/recipes.js`, mounted at /api/recipes). `apiClient` prefixes `/api`
 * itself, so every path here starts at `/recipes`.
 *
 * Two screens consume this:
 *   /menu/recipes                        → catalog (server-mode DataTable)
 *   /menu/recipes/:source/:productId     → the full-page recipe
 *
 * Contracts worth stating once, here, rather than re-deriving in each screen:
 *
 *  • The catalog LISTS PRODUCTS, not recipes. A product with no recipe comes
 *    back with `bomId: null` and `recipeStatus: "none"` — that is a headline
 *    row, never an edge case, so nothing in this file filters it away.
 *  • Image BYTES are never in a list payload (the live `menu` table holds ~66 MB
 *    of base64). A row carries `imageVersion`; `productImageUrl()` turns that
 *    into an immutable-cached URL, and returns null when there is no image.
 *  • `rowVersion` is the optimistic-lock token and `version` is the business
 *    revision number the user sees. Every mutation sends `expectedVersion =
 *    rowVersion`; conflating the two would make a concurrent edit look like a
 *    new revision.
 *  • Cost is HIDDEN, never faked: the server strips cost fields to null and
 *    reports `canViewCost:false`. Screens must honour that flag on top of the
 *    client-side `menu.cost.view` capability.
 */
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";

const BASE = "/recipes";

// ── vocabulary (mirrors lib/recipeEngine.js — the server still owns the truth
//    and ships it via GET /recipes/meta, so nothing here is hardcoded into a UI
//    filter list) ─────────────────────────────────────────────────────────────
export type RecipeSource = "menu" | "inv";
export type RecipeStatusCode = "draft" | "active" | "archived";
/** The catalog adds a synthetic "none" for products that have no recipe yet. */
export type CatalogStatus = RecipeStatusCode | "none";
export type UnitId = string | number;

export interface RecipeBrand {
  id: string;
  name: string;
  nameEn: string;
}

export interface RecipeMeta {
  brands: RecipeBrand[];
  categories: string[];
  productTypes: string[];
  recipeStatuses: string[];
  outputTypes: string[];
  allocMethods: string[];
  costAnomalies: string[];
  sorts: string[];
}

export interface CatalogRow {
  productSource: RecipeSource;
  productId: string;
  sku: string;
  name: string;
  nameEn: string;
  productType: string;
  brandId: string | null;
  brandName: string;
  brandNameEn: string;
  category: string;
  unit: string;
  imageVersion: string | null;
  bomId: string | null;
  recipeStatus: CatalogStatus;
  version: number | null;
  rowVersion: number | null;
  yieldQuantity: number | null;
  yieldUnit: string | null;
  lineCount: number;
  needsReview: boolean;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  updatedAt: string | null;
  sellingPrice: number | null;
  batchCost: number | null;
  unitCost: number | null;
  foodCostPct: number | null;
  marginPct: number | null;
  costAnomalies: string[];
}

export interface CatalogKpis {
  products: number;
  withoutRecipe: number;
  needsReview: number;
  avgFoodCostPct: number | null;
}

export interface PageInfo {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface CatalogPage {
  rows: CatalogRow[];
  pagination: PageInfo;
  kpis: CatalogKpis;
  canViewCost: boolean;
}

export interface RecipeLine {
  id: string;
  componentItemId: string;
  itemName: string;
  itemNameEn: string;
  itemKind: string;
  trackingMode: string;
  enteredUnitId: UnitId | null;
  enteredUnitCode: string;
  enteredUnitName: string;
  baseUnit: string;
  /** SNAPSHOTTED at save time — a later unit redefinition cannot restate this recipe. */
  conversionFactor: number;
  /** NET, in the entered unit. */
  quantity: number;
  /** NET, in the component's base unit. */
  baseQuantity: number;
  /** EXPECTED recipe loss — NOT the scrap a production order actually records. */
  wastePct: number;
  /** What production issues: net × (1 + waste). */
  grossQuantity: number;
  costBasis: string;
  unitCost: number | null;
  lineCost: number | null;
  lineNo: number;
  notes: string | null;
}

export interface RecipeOutput {
  id: string;
  outputType: string;
  productId: string;
  productSource: RecipeSource;
  productName: string;
  productNameEn: string;
  quantity: number;
  baseQuantity: number;
  enteredUnitId: UnitId | null;
  enteredUnitCode: string;
  conversionFactor: number;
  warehouseId: string | null;
  warehouseName: string;
  allocMethod: string;
  allocValue: number | null;
  requiresLot: boolean;
  lineNo: number;
  notes: string | null;
}

export interface RecipeCost {
  batchCost: number;
  unitCost: number;
  sellingPrice: number | null;
  foodCostPct: number | null;
  marginPct: number | null;
  computedAt: string | null;
  cachedBatchCost: number | null;
  anomalies: string[];
}

export interface RecipeProduct {
  id: string;
  sku: string;
  name: string;
  nameEn: string;
  productType: string;
  category: string;
  brandId: string | null;
  unit: string;
  imageVersion: string | null;
  sellingPrice: number | null;
  productionMethod: string | null;
  deductStrategy: string | null;
  trackingMode: string | null;
}

export interface RecipeDetail {
  bomId: string;
  productSource: RecipeSource;
  productId: string;
  product: RecipeProduct | null;
  status: RecipeStatusCode;
  version: number;
  rowVersion: number;
  revisionOf: string | null;
  yieldQuantity: number;
  yieldUnit: string;
  yieldUnitId: UnitId | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  needsReview: boolean;
  notes: string;
  consumptionWarehouseId: string | null;
  createdBy: string | null;
  createdAt: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  lines: RecipeLine[];
  outputs: RecipeOutput[];
  cost: RecipeCost | null;
}

export interface RecipeVersionRow {
  bomId: string;
  version: number;
  rowVersion: number;
  status: RecipeStatusCode;
  yieldQuantity: number;
  yieldUnit: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  revisionOf: string | null;
  needsReview: boolean;
  createdBy: string | null;
  createdAt: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  cachedUnitCost: number | null;
}

export interface RecipeDetailPayload {
  productSource: RecipeSource;
  productId: string;
  product: RecipeProduct;
  recipe: RecipeDetail | null;
  versions: RecipeVersionRow[];
  canViewCost: boolean;
}

export interface ComponentUnit {
  id: UnitId;
  name: string;
  code: string;
  isBase: boolean;
  conversionToBase: number;
  precision: number;
}

export interface ComponentOption {
  itemId: string;
  name: string;
  nameEn: string;
  sku: string;
  baseUnit: string;
  kind: string;
  trackingMode: string;
  category: string;
  unitCost: number | null;
  units: ComponentUnit[];
}

export interface WhereUsedRow {
  bomId: string | null;
  productId: string;
  productSource: RecipeSource;
  productName: string;
  productNameEn: string;
  version: number | null;
  status: string;
  yieldQuantity: number;
  quantity: number;
  baseQuantity: number;
  wastePct: number;
  unit: string;
  origin: string;
}

export interface WhereUsedPayload {
  itemId: string;
  usedIn: WhereUsedRow[];
  activeCount: number;
  totalCount: number;
}

export interface AvailabilityItem {
  itemId: string;
  itemName: string;
  itemNameEn: string;
  unit: string;
  required: number;
  available: number;
  delta: number;
  status: "ok" | "short";
}

export interface AvailabilityPayload {
  bomId: string;
  warehouseId: string | null;
  batches: number;
  items: AvailabilityItem[];
  summary: {
    shortageCount: number;
    allAvailable: boolean;
    itemCount: number;
    makeableBatches: number;
    makeableQuantity: number;
  };
}

export interface CompareSide {
  bomId: string;
  version: number;
  status: string;
  yieldQuantity: number;
  unitCost: number | null;
}

export interface CompareLine {
  componentItemId: string;
  itemName: string;
  itemNameEn: string;
  unit: string;
  change: "added" | "removed" | "modified" | "unchanged";
  before: { baseQuantity: number; wastePct: number; lineCost: number | null } | null;
  after: { baseQuantity: number; wastePct: number; lineCost: number | null } | null;
}

export interface ComparePayload {
  a: CompareSide;
  b: CompareSide;
  header: { yieldQuantityChanged: boolean; yieldUnitChanged: boolean };
  lines: CompareLine[];
  costDelta: { batch: number; unit: number } | null;
  summary: { added: number; removed: number; modified: number };
}

export interface SaveLineInput {
  componentItemId: string;
  quantity: number;
  enteredUnitId: UnitId | null;
  enteredUnitCode: string;
  wastePct: number;
  notes?: string | null;
}

export interface SaveRecipeInput {
  bomId?: string | null;
  expectedVersion: number | null;
  yieldQuantity: number;
  yieldUnit: string;
  yieldUnitId?: UnitId | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  notes: string;
  consumptionWarehouseId: string | null;
  needsReview: boolean;
  activate?: boolean;
  lines: SaveLineInput[];
}

export interface SaveRecipeResult {
  bomId: string;
  productSource: RecipeSource;
  productId: string;
  version: number;
  rowVersion: number;
  status: RecipeStatusCode;
  action: "create" | "edit" | "revise";
  batchCost: number | null;
  unitCost: number | null;
  warnings: { code: string; message: string }[];
}

// ── envelope helpers ────────────────────────────────────────────────────────
interface Envelope<T> {
  success?: boolean;
  data?: T;
}
interface PagedEnvelope<T> extends Envelope<T[]> {
  pagination?: Partial<PageInfo>;
  canViewCost?: boolean;
}
interface CatalogEnvelope extends PagedEnvelope<CatalogRow> {
  kpis?: Partial<CatalogKpis>;
}

const EMPTY_PAGE: PageInfo = { page: 1, pageSize: 25, total: 0, totalPages: 1 };

function pageInfo(p: Partial<PageInfo> | undefined, fallbackCount: number): PageInfo {
  return {
    page: Number(p?.page) || EMPTY_PAGE.page,
    pageSize: Number(p?.pageSize) || EMPTY_PAGE.pageSize,
    total: Number(p?.total) || fallbackCount,
    totalPages: Number(p?.totalPages) || 1,
  };
}

// ── query keys ──────────────────────────────────────────────────────────────
export const recipeKeys = {
  all: ["recipes"] as const,
  meta: () => ["recipes", "meta"] as const,
  catalog: (params: Record<string, unknown>) => ["recipes", "catalog", params] as const,
  detail: (source: string, productId: string) => ["recipes", "detail", source, productId] as const,
  componentUnits: (itemId: string) => ["recipes", "component-units", itemId] as const,
  whereUsed: (itemId: string) => ["recipes", "where-used", itemId] as const,
  availability: (bomId: string, warehouseId: string, batches: number) =>
    ["recipes", "availability", bomId, warehouseId, batches] as const,
  compare: (a: string, b: string) => ["recipes", "compare", a, b] as const,
  warehouses: () => ["recipes", "warehouses"] as const,
};

/**
 * Immutable-cached bytes URL for a product image, or null when the product has
 * none. NEVER build an <img> without an `imageVersion` — the endpoint 404s and
 * every row would fire a pointless request.
 */
export function productImageUrl(
  source: string,
  productId: string,
  imageVersion: string | null | undefined,
): string | null {
  if (!imageVersion) return null;
  return `/api/recipes/product-image/${encodeURIComponent(source)}/${encodeURIComponent(productId)}?v=${encodeURIComponent(imageVersion)}`;
}

// ── reads ───────────────────────────────────────────────────────────────────
export function useRecipeMeta() {
  return useQuery({
    queryKey: recipeKeys.meta(),
    staleTime: 5 * 60_000,
    queryFn: ({ signal }) =>
      apiClient.get<Envelope<RecipeMeta>>(`${BASE}/meta`, { signal }).then((r) => ({
        brands: r?.data?.brands ?? [],
        categories: r?.data?.categories ?? [],
        productTypes: r?.data?.productTypes ?? [],
        recipeStatuses: r?.data?.recipeStatuses ?? [],
        outputTypes: r?.data?.outputTypes ?? [],
        allocMethods: r?.data?.allocMethods ?? [],
        costAnomalies: r?.data?.costAnomalies ?? [],
        sorts: r?.data?.sorts ?? [],
      })),
  });
}

export interface CatalogQuery {
  page?: number;
  pageSize?: number;
  q?: string;
  brandId?: string;
  category?: string;
  source?: string;
  productType?: string;
  recipeStatus?: string;
  missingRecipe?: string;
  needsReview?: string;
  costAnomaly?: string;
  sort?: string;
  dir?: string;
  includeRawMaterials?: string;
}

export function useRecipeCatalog(query: CatalogQuery) {
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") params[k] = v as string | number;
  }
  return useQuery<CatalogPage>({
    queryKey: recipeKeys.catalog(params),
    staleTime: 30_000,
    // Keep the previous page on screen while the next one loads (no flash of
    // LoadingState between pages); DataTable still shows the thin busy bar.
    placeholderData: (prev) => prev,
    queryFn: async ({ signal }): Promise<CatalogPage> => {
      const r = await apiClient.get<CatalogEnvelope>(BASE, { signal, params });
      const rows = Array.isArray(r?.data) ? r.data : [];
      return {
        rows,
        pagination: pageInfo(r?.pagination, rows.length),
        kpis: {
          products: Number(r?.kpis?.products) || 0,
          withoutRecipe: Number(r?.kpis?.withoutRecipe) || 0,
          needsReview: Number(r?.kpis?.needsReview) || 0,
          avgFoodCostPct: r?.kpis?.avgFoodCostPct == null ? null : Number(r.kpis.avgFoodCostPct),
        },
        // Absent flag → assume allowed; the server strips the numbers anyway,
        // so a missing flag can never leak a cost figure.
        canViewCost: r?.canViewCost !== false,
      };
    },
  });
}

export function useRecipeDetail(source: string | null, productId: string | null) {
  const enabled = !!source && !!productId;
  return useQuery({
    enabled,
    queryKey: recipeKeys.detail(source ?? "", productId ?? ""),
    queryFn: ({ signal }) =>
      apiClient
        .get<Envelope<Omit<RecipeDetailPayload, "canViewCost">> & { canViewCost?: boolean }>(
          `${BASE}/${encodeURIComponent(source ?? "")}/${encodeURIComponent(productId ?? "")}`,
          { signal },
        )
        .then<RecipeDetailPayload>((r) => ({
          productSource: (r?.data?.productSource ?? "menu") as RecipeSource,
          productId: r?.data?.productId ?? (productId ?? ""),
          product: (r?.data?.product ?? null) as RecipeProduct,
          recipe: r?.data?.recipe ?? null,
          versions: r?.data?.versions ?? [],
          canViewCost: r?.canViewCost !== false,
        })),
  });
}

/** Paged component picker — never load the whole item master to pick one line. */
export async function fetchComponents(args: {
  q: string;
  page: number;
  signal?: AbortSignal;
}): Promise<{ items: ComponentOption[]; nextPage: number | null; total: number }> {
  const r = await apiClient.get<PagedEnvelope<ComponentOption>>(`${BASE}/components`, {
    signal: args.signal,
    params: { q: args.q, page: args.page, pageSize: 25 },
  });
  const items = Array.isArray(r?.data) ? r.data : [];
  const p = pageInfo(r?.pagination, items.length);
  return { items, nextPage: p.page < p.totalPages ? p.page + 1 : null, total: p.total };
}

/**
 * Registered units for the components ALREADY on a saved recipe. A line only
 * carries the unit it was saved with, so the editor needs the component's full
 * registered set before it can offer a choice — free-text units are gone.
 * One cached query per distinct component (recipes have a handful of lines).
 */
export function useComponentUnits(components: { itemId: string; name: string }[]) {
  const results = useQueries({
    queries: components.map((c) => ({
      queryKey: recipeKeys.componentUnits(c.itemId),
      staleTime: 5 * 60_000,
      queryFn: ({ signal }: { signal?: AbortSignal }) =>
        apiClient
          .get<PagedEnvelope<ComponentOption>>(`${BASE}/components`, {
            signal,
            params: { q: c.name, pageSize: 50 },
          })
          .then((r) => (Array.isArray(r?.data) ? r.data : []).find((x) => x.itemId === c.itemId)?.units ?? []),
    })),
  });
  const map: Record<string, ComponentUnit[]> = {};
  components.forEach((c, i) => {
    const units = results[i]?.data;
    if (units && units.length) map[c.itemId] = units;
  });
  return map;
}

export function useWhereUsed(itemId: string | null) {
  return useQuery({
    enabled: !!itemId,
    queryKey: recipeKeys.whereUsed(itemId ?? ""),
    queryFn: ({ signal }) =>
      apiClient
        .get<Envelope<WhereUsedPayload>>(`${BASE}/where-used/${encodeURIComponent(itemId ?? "")}`, { signal })
        .then((r) => r?.data ?? { itemId: itemId ?? "", usedIn: [], activeCount: 0, totalCount: 0 }),
  });
}

export function useAvailability(bomId: string | null, warehouseId: string, batches: number) {
  return useQuery({
    enabled: !!bomId,
    queryKey: recipeKeys.availability(bomId ?? "", warehouseId, batches),
    queryFn: ({ signal }) =>
      apiClient
        .get<Envelope<AvailabilityPayload>>(`${BASE}/bom/${encodeURIComponent(bomId ?? "")}/availability`, {
          signal,
          params: { warehouseId, batches },
        })
        .then((r) => r?.data ?? null),
  });
}

export function useCompare(a: string, b: string) {
  return useQuery({
    enabled: !!a && !!b && a !== b,
    queryKey: recipeKeys.compare(a, b),
    queryFn: ({ signal }) =>
      apiClient
        .get<Envelope<ComparePayload>>(`${BASE}/compare`, { signal, params: { a, b } })
        .then((r) => r?.data ?? null),
  });
}

export interface WarehouseOption {
  id: string;
  name: string;
}

/**
 * Warehouse options for the availability tab. Best-effort: the recipe domain
 * does not own a warehouse endpoint, and a user without warehouse-admin reach
 * simply gets the GLOBAL-stock view instead of a broken tab.
 */
export function useWarehouseOptions() {
  return useQuery({
    queryKey: recipeKeys.warehouses(),
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: ({ signal }) =>
      apiClient
        .get<unknown>("/erp/warehouses-list", { signal })
        .then((r) => {
          const raw = Array.isArray(r) ? r : ((r as Envelope<unknown[]>)?.data ?? []);
          return (Array.isArray(raw) ? raw : []).map((w) => {
            const row = w as Record<string, unknown>;
            return { id: String(row.id ?? ""), name: String(row.name ?? row.id ?? "") };
          });
        })
        .catch(() => [] as WarehouseOption[]),
  });
}

// ── writes ──────────────────────────────────────────────────────────────────
function idempotencyKey(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* jsdom / older browsers */
  }
  return `idem-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export function useRecipeMutations(source: string, productId: string) {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: recipeKeys.all });
    // The recipe cascade rewrites menu.cost / inv_items.cost, so the product
    // catalogs that show those numbers are stale the moment a save lands.
    qc.invalidateQueries({ queryKey: ["menu"] });
    qc.invalidateQueries({ queryKey: ["inventory"] });
  };

  const save = useMutation<SaveRecipeResult, Error, SaveRecipeInput>({
    mutationFn: (input) =>
      apiClient
        .post<Envelope<SaveRecipeResult> & { warnings?: { code: string; message: string }[] }>(
          `${BASE}/${encodeURIComponent(source)}/${encodeURIComponent(productId)}`,
          input,
          { headers: { "Idempotency-Key": idempotencyKey() } },
        )
        .then((r) => ({ ...(r?.data as SaveRecipeResult), warnings: r?.warnings ?? [] })),
    onSuccess: invalidate,
  });

  const activate = useMutation<unknown, Error, { bomId: string; expectedVersion: number }>({
    mutationFn: ({ bomId, expectedVersion }) =>
      apiClient.post<unknown>(`${BASE}/bom/${encodeURIComponent(bomId)}/activate`, { expectedVersion }),
    onSuccess: invalidate,
  });

  const clone = useMutation<Envelope<{ bomId: string; version: number }>, Error, { bomId: string }>({
    mutationFn: ({ bomId }) =>
      apiClient.post<Envelope<{ bomId: string; version: number }>>(`${BASE}/bom/${encodeURIComponent(bomId)}/clone`, {}),
    onSuccess: invalidate,
  });

  const archive = useMutation<unknown, Error, { bomId: string; expectedVersion: number }>({
    mutationFn: ({ bomId, expectedVersion }) =>
      apiClient.post<unknown>(`${BASE}/bom/${encodeURIComponent(bomId)}/archive`, { expectedVersion }),
    onSuccess: invalidate,
  });

  return { save, activate, clone, archive };
}
