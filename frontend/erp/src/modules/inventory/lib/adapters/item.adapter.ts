// Phase 4A — adapters for /api/inventory/v2/items.

function s(v: unknown): string { return v == null ? "" : String(v); }
function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function bool(v: unknown): boolean { return v === 1 || v === true || v === "1"; }

export interface ItemRow {
  id: string; name: string; nameEn: string; sku: string; category: string; unit: string;
  cost: number; stock: number; minStock: number; active: boolean; kind: string; version: number; createdAt: string | null;
  // Enriched, OPTIONAL columns. Present when the list endpoint (D3) sends them;
  // otherwise they degrade to sensible fallbacks so every column still renders.
  subCategory: string;
  baseUnit: string;        // base-unit label (falls back to `unit`)
  majorUnit: string;       // major/purchase unit label ("" when none)
  convRate: number;        // 1 major = convRate base ( <=1 → no major unit )
  baseCost: number;        // base-unit cost (falls back to `cost`)
  majorCost: number | null; // major-unit cost (computed baseCost*convRate when absent)
  availableQty: number;    // available qty (falls back to `stock`)
  reorderPoint: number | null; // per-item reorder point (null when unknown)
  assignedCount: number | null; // assigned branches/warehouses count (null when unknown)
  hasImage: boolean;
}
export interface ItemKpis { total: number; active: number; inactive: number; noSku: number }
export interface ItemPage { rows: ItemRow[]; kpis: ItemKpis; pagination: { page: number; pageSize: number; total: number; totalPages: number }; filters: Record<string, unknown> }

function has(r: Record<string, unknown>, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(r, k) && r[k] != null && r[k] !== "";
}
function toRow(r: Record<string, unknown>): ItemRow {
  const unit = s(r.unit);
  const baseUnit = has(r, "base_unit") ? s(r.base_unit) : unit;
  const majorUnit = has(r, "major_unit") ? s(r.major_unit) : s(r.big_unit);
  const convRate = has(r, "conv_rate") ? num(r.conv_rate) : 0;
  const baseCost = has(r, "base_cost") ? num(r.base_cost) : num(r.cost);
  const majorCost = has(r, "major_cost")
    ? num(r.major_cost)
    : convRate > 1
      ? baseCost * convRate
      : null;
  return {
    id: s(r.id), name: s(r.name), nameEn: s(r.name_en), sku: s(r.sku), category: s(r.category), unit,
    cost: num(r.cost), stock: num(r.stock), minStock: num(r.min_stock), active: bool(r.active), kind: s(r.kind) || "raw",
    version: num(r.version) || 1, createdAt: r.created_at ? s(r.created_at) : null,
    subCategory: s(r.sub_category), baseUnit, majorUnit, convRate, baseCost, majorCost,
    availableQty: has(r, "available_qty") ? num(r.available_qty) : num(r.stock),
    reorderPoint: has(r, "reorder_point") ? num(r.reorder_point) : null,
    assignedCount: has(r, "assigned_count")
      ? num(r.assigned_count)
      : has(r, "warehouse_count")
        ? num(r.warehouse_count)
        : null,
    hasImage: bool(r.has_image),
  };
}
export function toItemPage(raw: unknown): ItemPage {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rows = (Array.isArray(r.data) ? r.data : []) as Record<string, unknown>[];
  const k = (r.kpis ?? {}) as Record<string, unknown>;
  const p = (r.pagination ?? {}) as Record<string, unknown>;
  return {
    rows: rows.map(toRow),
    kpis: { total: num(k.total), active: num(k.active), inactive: num(k.inactive), noSku: num(k.noSku) },
    pagination: { page: num(p.page) || 1, pageSize: num(p.pageSize) || 25, total: num(p.total), totalPages: num(p.totalPages) || 1 },
    filters: (r.filters ?? {}) as Record<string, unknown>,
  };
}

export interface ItemBarcode { id: string; code: string; sizeVariant: string | null; isPrimary: boolean }
export interface ItemDistribution { warehouseId: string; warehouseName: string; isMain: boolean; qty: number; avgCost: number; value: number }
export interface ItemRule { warehouseId: string; minQty: number; reorderPoint: number; reorderQty: number; maxStock: number; safetyStock: number; leadTimeDays: number; isEnabled: boolean; version: number }
export interface ItemMovement { id: string; at: string | null; type: string; qty: number; reason: string; warehouseId: string; referenceType: string }
export interface ItemTimelineEvent { action: string; actor: string; note: string | null; at: string | null }
export interface ItemDetail {
  id: string; name: string; nameEn: string; sku: string; category: string; unit: string; bigUnit: string; convRate: number;
  cost: number; stock: number; minStock: number; maxStock: number; active: boolean; kind: string; version: number;
  defaultWarehouseId: string; description: string; notes: string; hasMovements: boolean;
  trackingMode: string; barcode: string | null; barcodes: ItemBarcode[];
  distribution: ItemDistribution[]; rules: ItemRule[]; movements: ItemMovement[]; timeline: ItemTimelineEvent[];
}

export function toItemDetail(raw: unknown): ItemDetail {
  const r = (raw ?? {}) as Record<string, unknown>;
  const d = (r.data ?? {}) as Record<string, unknown>;
  const dist = (Array.isArray(r.distribution) ? r.distribution : []) as Record<string, unknown>[];
  const rules = (Array.isArray(r.rules) ? r.rules : []) as Record<string, unknown>[];
  const mv = (Array.isArray(r.movements) ? r.movements : []) as Record<string, unknown>[];
  const tl = (Array.isArray(r.timeline) ? r.timeline : []) as Record<string, unknown>[];
  const bcs = (Array.isArray(r.barcodes) ? r.barcodes : []) as Record<string, unknown>[];
  return {
    id: s(d.id), name: s(d.name), nameEn: s(d.name_en), sku: s(d.sku), category: s(d.category), unit: s(d.unit),
    bigUnit: s(d.big_unit), convRate: num(d.conv_rate) || 1, cost: num(d.cost), stock: num(d.stock), minStock: num(d.min_stock),
    maxStock: num(d.max_stock), active: bool(d.active), kind: s(d.kind) || "raw", version: num(d.version) || 1,
    defaultWarehouseId: s(d.default_warehouse_id), description: s(d.description), notes: s(d.notes), hasMovements: mv.length > 0,
    trackingMode: s(d.tracking_mode) || "none",
    barcode: d.barcode ? s(d.barcode) : null,
    barcodes: bcs.map((x) => ({ id: s(x.id), code: s(x.code), sizeVariant: x.size_variant ? s(x.size_variant) : null, isPrimary: bool(x.is_primary) })),
    distribution: dist.map((x) => ({ warehouseId: s(x.warehouse_id), warehouseName: s(x.warehouse_name ?? x.warehouse_id), isMain: bool(x.is_main), qty: num(x.qty), avgCost: num(x.avg_cost), value: num(x.value) })),
    rules: rules.map((x) => ({ warehouseId: s(x.warehouse_id), minQty: num(x.min_qty), reorderPoint: num(x.reorder_point), reorderQty: num(x.reorder_qty), maxStock: num(x.max_stock), safetyStock: num(x.safety_stock), leadTimeDays: num(x.lead_time_days), isEnabled: bool(x.is_enabled), version: num(x.version) || 1 })),
    movements: mv.map((x) => ({ id: s(x.id), at: x.movement_date ? s(x.movement_date) : null, type: s(x.type), qty: num(x.qty), reason: s(x.reason), warehouseId: s(x.warehouse_id), referenceType: s(x.reference_type) })),
    timeline: tl.map((e) => ({ action: s(e.action), actor: s(e.actor), note: e.note ? s(e.note) : null, at: e.created_at ? s(e.created_at) : null })),
  };
}

export interface ItemMutationResult { success: boolean; id: string | null; status: string | null; version: number | null }
export function toItemMutation(raw: unknown): ItemMutationResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  return { success: r.success !== false, id: r.id ? s(r.id) : (r.data && (r.data as Record<string, unknown>).id ? s((r.data as Record<string, unknown>).id) : null), status: r.status ? s(r.status) : null, version: r.version != null ? num(r.version) : null };
}
