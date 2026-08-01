// Production BATCH API — ONE document covering SEVERAL independent products.
//
// Base: /api/inventory/v2/production-batches (routes/production-batches.js).
// A batch is a DOCUMENT GROUPING, never a cost object: every child is a real
// production_order with its own BOM, quantity, warehouses, WIP balance and
// cost. Nothing here ever pools cost across children.
//
// TRANSPORT — read this before "simplifying" it:
//   Everything goes through the shared `apiClient` EXCEPT `preview` and
//   `create`. Those two are the only endpoints that answer with PER-LINE
//   rejections (`{ code:'VALIDATION_ERROR', detail:[{line,code,message}] }`),
//   and the shared `toApiError` only lifts `body.details` — the backend sends
//   `body.detail`, so routing them through apiClient would silently DROP the
//   line map the create screen must render inline. `postJson` below therefore
//   does the request itself while still building its failure with the shared
//   `getToken` + `toApiError` primitives, so downstream error handling
//   (ErrorState / ApiError.kind / .code) is byte-identical to every other
//   screen. It additionally throws `BatchLineRejection` carrying `lines`.
import { apiClient, ApiError, getToken, toApiError } from "@/shared/api";

export const BATCH_BASE = "/inventory/v2/production-batches";

/* ────────────────────────────── error contract ───────────────────────────── */

/** One rejected row: `line` is the ZERO-BASED index of the offending item. */
export interface BatchLineError {
  line: number;
  code: string;
  message: string;
}

/**
 * A whole-request refusal that named the offending rows. The batch API has NO
 * partial success: when this is thrown, nothing was created.
 */
export class BatchLineRejection extends ApiError {
  readonly lines: BatchLineError[];
  constructor(base: ApiError, lines: BatchLineError[]) {
    super({
      kind: base.kind,
      status: base.status,
      message: base.message,
      code: base.code,
      details: base.details,
      requestId: base.requestId,
    });
    this.name = "BatchLineRejection";
    this.lines = lines;
  }
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string => (v == null ? "" : String(v));

/** Lift the per-line rejection array out of any shape the stack can hand us:
 *  the raw wire body (`detail`), or an ApiError whose `details` carried it. */
export function readLineErrors(source: unknown): BatchLineError[] {
  if (source instanceof BatchLineRejection) return source.lines;
  const bag =
    source instanceof ApiError
      ? (source.details as Record<string, unknown> | undefined)
      : (source as Record<string, unknown> | undefined);
  if (!bag) return [];
  const raw = Array.isArray(bag.detail) ? bag.detail : Array.isArray(bag.details) ? bag.details : null;
  if (!raw) return [];
  return raw
    .filter((d): d is Record<string, unknown> => !!d && typeof d === "object")
    .map((d) => ({ line: num(d.line), code: str(d.code), message: str(d.message) }))
    .filter((d) => d.message !== "" || d.code !== "");
}

/* ─────────────────────────────── transport ───────────────────────────────── */

async function parseBody(res: Response): Promise<unknown> {
  const ct = res.headers.get("content-type") || "";
  try {
    return ct.includes("application/json") ? await res.json() : await res.text();
  } catch {
    return null;
  }
}

async function postJson<T>(
  path: string,
  body: unknown,
  opts: { signal?: AbortSignal; headers?: Record<string, string> } = {},
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(opts.headers ?? {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: opts.signal,
      credentials: "same-origin",
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    // kind:"network" → ErrorState renders the translated OfflineState.
    throw new ApiError({ kind: "network", status: 0, message: "network request failed" });
  }

  const raw = await parseBody(res);
  if (!res.ok) {
    const requestId = res.headers.get("x-request-id") || undefined;
    const base = toApiError(res.status, raw);
    const err =
      requestId && !base.requestId
        ? new ApiError({
            kind: base.kind,
            status: base.status,
            message: base.message,
            code: base.code,
            details: base.details,
            requestId,
          })
        : base;
    const lines = readLineErrors(raw);
    throw lines.length ? new BatchLineRejection(err, lines) : err;
  }
  return raw as T;
}

function uid(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* jsdom */
  }
  return "idem-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/* ────────────────────────────── BOM options ──────────────────────────────── */

/**
 * A pickable recipe. Mirrors the inventory `BomOption` but ALSO carries
 * `version` — the outputs table shows the BOM version each row was planned
 * against, and the shared adapter drops it.
 */
export interface BomPickOption {
  id: string;
  productId: string;
  productName: string;
  productUnit: string;
  trackingMode: string;
  yieldQuantity: number;
  yieldUnit: string;
  lineCount: number;
  version: number | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function toBomPickOptions(body: any): BomPickOption[] {
  const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
  return rows.map((r: any) => ({
    id: str(r?.id),
    productId: str(r?.product_id ?? r?.productId),
    productName: str(r?.product_name ?? r?.productName) || str(r?.product_id ?? r?.productId),
    productUnit: str(r?.product_unit ?? r?.productUnit),
    trackingMode: str(r?.tracking_mode ?? r?.trackingMode) || "none",
    yieldQuantity: num(r?.yield_quantity ?? r?.yieldQuantity) || 1,
    yieldUnit: str(r?.yield_unit ?? r?.yieldUnit),
    lineCount: num(r?.line_count ?? r?.lineCount),
    version: r?.version == null ? null : num(r.version),
  }));
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function fetchBomOptions(q: string, signal?: AbortSignal): Promise<BomPickOption[]> {
  return apiClient
    .get<unknown>("/inventory/v2/production-orders/boms", { signal, params: q ? { q } : undefined })
    .then(toBomPickOptions);
}

/* ──────────────────────────────── request ────────────────────────────────── */

/**
 * ONE output row as the backend expects it.
 *
 * `allowedScrapPct` semantics (migration 0027) — do NOT default this to 0:
 *   null/undefined → use the default scrap policy
 *   0              → ZERO scrap allowed; any waste needs a manager override
 *                    with a recorded reason.
 */
export interface BatchItemInput {
  bomId: string;
  qtyPlanned: number;
  warehouseId?: string;
  outputWarehouseId?: string;
  allowedScrapPct?: number | null;
  batchNumber?: string;
  /** Planning value only — the create endpoint does not persist a per-order
   *  expiry (it is captured when output is recorded). Sent for forward
   *  compatibility; the UI labels it as a plan. */
  expiryDate?: string;
  notes?: string;
  priority?: string;
}

export interface BatchInput {
  warehouseId: string;
  outputWarehouseId?: string;
  batchDate?: string;
  notes?: string;
  items: BatchItemInput[];
}

/* ──────────────────────────────── preview ────────────────────────────────── */

export interface PreviewAttribution {
  line: number;
  bomId: string;
  productId: string;
  qty: number;
}

export interface PreviewMaterial {
  itemId: string;
  itemName: string;
  itemNameEn: string;
  unit: string;
  trackingMode: string;
  warehouseId: string;
  required: number;
  available: number;
  delta: number;
  status: "ok" | "short";
  unitCost: number;
  lineCost: number;
  /** WHICH product line needs how much of this material. */
  attribution: PreviewAttribution[];
}

export interface PreviewProduct {
  line: number;
  bomId: string;
  productId: string;
  qtyPlanned: number;
  warehouseId: string;
  materialCost: number;
}

export interface BatchPreview {
  products: PreviewProduct[];
  materials: PreviewMaterial[];
  summary: {
    productCount: number;
    materialCount: number;
    shortageCount: number;
    allAvailable: boolean;
    totalMaterialCost: number;
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toAttribution(raw: any): PreviewAttribution[] {
  return Array.isArray(raw)
    ? raw.map((a: any) => ({
        line: num(a?.line),
        bomId: str(a?.bomId),
        productId: str(a?.productId),
        qty: num(a?.qty),
      }))
    : [];
}

export function toBatchPreview(body: any): BatchPreview {
  const d = body?.data ?? {};
  const s = d?.summary ?? {};
  const materials: PreviewMaterial[] = Array.isArray(d.materials)
    ? d.materials.map((m: any) => ({
        itemId: str(m?.itemId),
        itemName: str(m?.itemName) || str(m?.itemId),
        itemNameEn: str(m?.itemNameEn),
        unit: str(m?.unit),
        trackingMode: str(m?.trackingMode) || "none",
        warehouseId: str(m?.warehouseId),
        required: num(m?.required),
        available: num(m?.available),
        delta: num(m?.delta),
        status: m?.status === "short" ? "short" : "ok",
        unitCost: num(m?.unitCost),
        lineCost: num(m?.lineCost),
        attribution: toAttribution(m?.attribution),
      }))
    : [];
  const products: PreviewProduct[] = Array.isArray(d.products)
    ? d.products.map((p: any) => ({
        line: num(p?.line),
        bomId: str(p?.bomId),
        productId: str(p?.productId),
        qtyPlanned: num(p?.qtyPlanned),
        warehouseId: str(p?.warehouseId),
        materialCost: num(p?.materialCost),
      }))
    : [];
  return {
    products,
    materials,
    summary: {
      productCount: num(s.productCount) || products.length,
      materialCount: num(s.materialCount) || materials.length,
      shortageCount: num(s.shortageCount),
      allAvailable: s.allAvailable !== false,
      totalMaterialCost: num(s.totalMaterialCost),
    },
  };
}

export function previewBatch(input: BatchInput, signal?: AbortSignal): Promise<BatchPreview> {
  return postJson<unknown>(`${BATCH_BASE}/preview`, input, { signal }).then(toBatchPreview);
}

/* ──────────────────────────────── create ─────────────────────────────────── */

export interface CreatedBatchChild {
  id: string;
  orderNumber: string;
  line: number;
  productId: string;
  qtyPlanned: number;
}

export interface CreatedBatch {
  id: string;
  batchNumber: string;
  children: CreatedBatchChild[];
}

export function toCreatedBatch(body: any): CreatedBatch {
  const d = body?.data ?? {};
  return {
    id: str(d.id),
    batchNumber: str(d.batchNumber) || str(body?.documentNumber),
    children: Array.isArray(d.children)
      ? d.children.map((c: any) => ({
          id: str(c?.id),
          orderNumber: str(c?.orderNumber),
          line: num(c?.line),
          productId: str(c?.productId),
          qtyPlanned: num(c?.qtyPlanned),
        }))
      : [],
  };
}

export function createBatch(input: BatchInput): Promise<CreatedBatch> {
  return postJson<unknown>(BATCH_BASE, input, { headers: { "Idempotency-Key": uid() } }).then(toCreatedBatch);
}

/* ───────────────────────────────── list ──────────────────────────────────── */

export interface BatchRow {
  id: string;
  batchNumber: string;
  batchDate: string | null;
  status: string;
  warehouseId: string;
  warehouseName: string;
  outputWarehouseId: string;
  outputWarehouseName: string;
  childCount: number;
  version: number;
  totalCost: number;
  wipBalance: number;
  createdBy: string;
  createdAt: string | null;
  approvedBy: string | null;
  notes: string;
}

export interface BatchPage {
  rows: BatchRow[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

function toBatchRow(r: any): BatchRow {
  return {
    id: str(r?.id),
    batchNumber: str(r?.batchNumber),
    batchDate: r?.batchDate ? str(r.batchDate) : null,
    status: str(r?.status) || "draft",
    warehouseId: str(r?.warehouseId),
    warehouseName: str(r?.warehouseName),
    outputWarehouseId: str(r?.outputWarehouseId) || str(r?.warehouseId),
    outputWarehouseName: str(r?.outputWarehouseName) || str(r?.warehouseName),
    childCount: num(r?.childCount),
    version: num(r?.version) || 1,
    totalCost: num(r?.totalCost),
    wipBalance: num(r?.wipBalance),
    createdBy: str(r?.createdBy),
    createdAt: r?.createdAt ? str(r.createdAt) : null,
    approvedBy: r?.approvedBy ? str(r.approvedBy) : null,
    notes: str(r?.notes),
  };
}

export function toBatchPage(body: any): BatchPage {
  const p = body?.pagination ?? {};
  return {
    rows: Array.isArray(body?.data) ? body.data.map(toBatchRow) : [],
    pagination: {
      page: num(p.page) || 1,
      pageSize: num(p.pageSize) || 25,
      total: num(p.total),
      totalPages: num(p.totalPages) || 1,
    },
  };
}

export interface BatchListQuery {
  page?: number;
  pageSize?: number;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  q?: string;
  warehouseId?: string;
}

export function fetchBatchPage(query: BatchListQuery, signal?: AbortSignal): Promise<BatchPage> {
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") params[k] = v as string | number;
  }
  return apiClient.get<unknown>(BATCH_BASE, { signal, params }).then(toBatchPage);
}

/* ──────────────────────────────── detail ─────────────────────────────────── */

export interface BatchChild {
  id: string;
  orderNumber: string;
  lineNo: number;
  bomId: string;
  bomVersion: number | null;
  productId: string;
  productName: string;
  productNameEn: string;
  qtyPlanned: number;
  qtyProduced: number;
  qtyWaste: number;
  status: string;
  warehouseId: string;
  warehouseName: string;
  outputWarehouseId: string;
  outputWarehouseName: string;
  wipBalance: number;
  totalCost: number;
  unitCost: number;
  allowedScrapPct: number | null;
  batchNumber: string | null;
  version: number;
}

export interface BatchMaterialAttribution {
  orderId: string;
  orderNumber: string;
  productName: string;
  qty: number;
}

export interface BatchMaterial {
  itemId: string;
  itemName: string;
  itemNameEn: string;
  unit: string;
  warehouseId: string;
  required: number;
  issued: number;
  remaining: number;
  available: number;
  shortage: number;
  unitCost: number;
  attribution: BatchMaterialAttribution[];
}

export interface BatchTimelineEvent {
  id: string;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  actor: string;
  note: string;
  at: string | null;
}

export interface BatchDetail {
  batch: {
    id: string;
    batchNumber: string;
    batchDate: string | null;
    status: string;
    warehouseId: string;
    outputWarehouseId: string;
    notes: string;
    version: number;
    childCount: number;
    createdBy: string;
    createdAt: string | null;
    approvedBy: string | null;
    approvedAt: string | null;
    cancelledBy: string | null;
    cancelReason: string | null;
  };
  children: BatchChild[];
  materials: BatchMaterial[];
  timeline: BatchTimelineEvent[];
}

export function toBatchDetail(body: any): BatchDetail {
  const b = body?.data ?? {};
  return {
    batch: {
      id: str(b.id),
      batchNumber: str(b.batchNumber),
      batchDate: b.batchDate ? str(b.batchDate) : null,
      status: str(b.status) || "draft",
      warehouseId: str(b.warehouseId),
      outputWarehouseId: str(b.outputWarehouseId) || str(b.warehouseId),
      notes: str(b.notes),
      version: num(b.version) || 1,
      childCount: num(b.childCount),
      createdBy: str(b.createdBy),
      createdAt: b.createdAt ? str(b.createdAt) : null,
      approvedBy: b.approvedBy ? str(b.approvedBy) : null,
      approvedAt: b.approvedAt ? str(b.approvedAt) : null,
      cancelledBy: b.cancelledBy ? str(b.cancelledBy) : null,
      cancelReason: b.cancelReason ? str(b.cancelReason) : null,
    },
    children: Array.isArray(body?.children)
      ? body.children.map((c: any) => ({
          id: str(c?.id),
          orderNumber: str(c?.orderNumber),
          lineNo: num(c?.lineNo),
          bomId: str(c?.bomId),
          bomVersion: c?.bomVersion == null ? null : num(c.bomVersion),
          productId: str(c?.productId),
          productName: str(c?.productName) || str(c?.productId),
          productNameEn: str(c?.productNameEn),
          qtyPlanned: num(c?.qtyPlanned),
          qtyProduced: num(c?.qtyProduced),
          qtyWaste: num(c?.qtyWaste),
          status: str(c?.status) || "draft",
          warehouseId: str(c?.warehouseId),
          warehouseName: str(c?.warehouseName),
          outputWarehouseId: str(c?.outputWarehouseId) || str(c?.warehouseId),
          outputWarehouseName: str(c?.outputWarehouseName) || str(c?.warehouseName),
          wipBalance: num(c?.wipBalance),
          totalCost: num(c?.totalCost),
          unitCost: num(c?.unitCost),
          allowedScrapPct: c?.allowedScrapPct == null ? null : num(c.allowedScrapPct),
          batchNumber: c?.batchNumber ? str(c.batchNumber) : null,
          version: num(c?.version) || 1,
        }))
      : [],
    materials: Array.isArray(body?.materials)
      ? body.materials.map((m: any) => ({
          itemId: str(m?.itemId),
          itemName: str(m?.itemName) || str(m?.itemId),
          itemNameEn: str(m?.itemNameEn),
          unit: str(m?.unit),
          warehouseId: str(m?.warehouseId),
          required: num(m?.required),
          issued: num(m?.issued),
          remaining: num(m?.remaining),
          available: num(m?.available),
          shortage: num(m?.shortage),
          unitCost: num(m?.unitCost),
          attribution: Array.isArray(m?.attribution)
            ? m.attribution.map((a: any) => ({
                orderId: str(a?.orderId),
                orderNumber: str(a?.orderNumber),
                productName: str(a?.productName) || str(a?.orderNumber),
                qty: num(a?.qty),
              }))
            : [],
        }))
      : [],
    timeline: Array.isArray(body?.timeline)
      ? body.timeline.map((e: any) => ({
          id: str(e?.id),
          action: str(e?.action),
          fromStatus: e?.from_status ? str(e.from_status) : e?.fromStatus ? str(e.fromStatus) : null,
          toStatus: e?.to_status ? str(e.to_status) : e?.toStatus ? str(e.toStatus) : null,
          actor: str(e?.actor),
          note: str(e?.note),
          at: e?.created_at ? str(e.created_at) : e?.at ? str(e.at) : null,
        }))
      : [],
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function fetchBatchDetail(id: string, signal?: AbortSignal): Promise<BatchDetail> {
  return apiClient.get<unknown>(`${BATCH_BASE}/${id}`, { signal }).then(toBatchDetail);
}

export function approveBatch(id: string, expectedVersion?: number): Promise<unknown> {
  return apiClient.post<unknown>(`${BATCH_BASE}/${id}/approve`, { expectedVersion });
}

export function cancelBatch(id: string, reason: string, expectedVersion?: number): Promise<unknown> {
  return apiClient.post<unknown>(`${BATCH_BASE}/${id}/cancel`, { reason, expectedVersion });
}
