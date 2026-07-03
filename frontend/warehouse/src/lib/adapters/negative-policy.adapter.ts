// Phase W2 — adapters for /api/inventory/v2/negative-policy.
//
// The route already emits camelCase for most fields (it maps the DB rows
// itself), but the adapter still accepts the snake_case names as a fallback
// and coerces stringy decimals / tinyint booleans, so no page ever renders
// raw JSON. Mirrors the style of production.adapter / item.adapter.

export type PolicyScope = "global" | "warehouse" | "item";
export type PolicyMode = "block" | "controlled" | "allow";
export type DeficitStatus = "open" | "partial" | "covered" | "adjusted";

type Raw = Record<string, unknown>;

function s(v: unknown): string { return v == null ? "" : String(v); }
function sOrNull(v: unknown): string | null { return v == null || v === "" ? null : String(v); }
function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function bool(v: unknown): boolean { return v === 1 || v === true || v === "1"; }
function pick(r: Raw, camel: string, snake: string): unknown {
  return r[camel] !== undefined ? r[camel] : r[snake];
}

const POLICY_MODES: PolicyMode[] = ["block", "controlled", "allow"];
export function toPolicyMode(v: unknown): PolicyMode {
  const p = s(v).toLowerCase() as PolicyMode;
  return POLICY_MODES.includes(p) ? p : "block";
}
function toPolicyModeOrNull(v: unknown): PolicyMode | null {
  return v == null ? null : toPolicyMode(v);
}

const SCOPES: PolicyScope[] = ["global", "warehouse", "item"];
export function toPolicyScope(v: unknown): PolicyScope {
  const p = s(v).toLowerCase() as PolicyScope;
  return SCOPES.includes(p) ? p : "global";
}

const DEFICIT_STATUSES: DeficitStatus[] = ["open", "partial", "covered", "adjusted"];
export function toDeficitStatus(v: unknown): DeficitStatus {
  const p = s(v).toLowerCase() as DeficitStatus;
  return DEFICIT_STATUSES.includes(p) ? p : "open";
}

// ── Configured policy rows (GET /) ──────────────────────────────────────────

export interface PolicyRow {
  id: string;
  scope: PolicyScope;
  warehouseId: string | null;
  warehouseName: string | null;
  itemId: string | null;
  itemName: string | null;
  policy: PolicyMode;
  maxNegativeQty: number;
  requireReason: boolean;
  isEnabled: boolean;
  version: number;
  updatedBy: string;
  updatedAt: string | null;
}

export interface PolicySettings {
  rows: PolicyRow[];
  globalRow: PolicyRow | null;
  warehouseRows: PolicyRow[];
  itemRows: PolicyRow[];
  /** env gate NEGATIVE_STOCK_ALLOW_ENABLED — when off, `allow` degrades to `controlled`. */
  allowEnabled: boolean;
  /** env gate NEGATIVE_STOCK_POLICY_ENABLED — when off, the guard doesn't run at issue time. */
  policyEnabled: boolean;
}

function toPolicyRow(r: Raw): PolicyRow {
  return {
    id: s(r.id),
    scope: toPolicyScope(r.scope),
    warehouseId: sOrNull(pick(r, "warehouseId", "warehouse_id")),
    warehouseName: sOrNull(pick(r, "warehouseName", "warehouse_name")),
    itemId: sOrNull(pick(r, "itemId", "item_id")),
    itemName: sOrNull(pick(r, "itemName", "item_name")),
    policy: toPolicyMode(r.policy),
    maxNegativeQty: num(pick(r, "maxNegativeQty", "max_negative_qty")),
    requireReason: bool(pick(r, "requireReason", "require_reason")),
    isEnabled: bool(pick(r, "isEnabled", "is_enabled")),
    version: num(r.version) || 1,
    updatedBy: s(pick(r, "updatedBy", "updated_by")),
    updatedAt: sOrNull(pick(r, "updatedAt", "updated_at")),
  };
}

export function toPolicySettings(raw: unknown): PolicySettings {
  const r = (raw ?? {}) as Raw;
  const list = (Array.isArray(r.data) ? r.data : []) as Raw[];
  const rows = list.map(toPolicyRow);
  return {
    rows,
    globalRow: rows.find((x) => x.scope === "global") ?? null,
    warehouseRows: rows.filter((x) => x.scope === "warehouse"),
    itemRows: rows.filter((x) => x.scope === "item"),
    allowEnabled: r.allowEnabled === true,
    policyEnabled: r.policyEnabled === true,
  };
}

// ── Effective policy (GET /effective) ───────────────────────────────────────

export interface EffectivePolicy {
  effectivePolicy: PolicyMode;
  /** null = غير محدود (allow with the env gate on). */
  effectiveMaxNegative: number | null;
  /** 'tracked-item' | 'default-block' | 'resolved' */
  reason: string;
  /** true when a stored `allow` was degraded to `controlled` by the env gate. */
  allowGated: boolean;
  trackingMode: string;
  levels: {
    global: PolicyMode | null;
    warehouse: PolicyMode | null;
    item: PolicyMode | null;
  };
}

export function toEffectivePolicy(raw: unknown): EffectivePolicy {
  const r = (raw ?? {}) as Raw;
  const d = (r.data ?? {}) as Raw;
  const levels = (d.levels ?? {}) as Raw;
  const max = pick(d, "effectiveMaxNegative", "effective_max_negative");
  return {
    effectivePolicy: toPolicyMode(pick(d, "effectivePolicy", "effective_policy")),
    effectiveMaxNegative: max == null ? null : num(max),
    reason: s(d.reason),
    allowGated: bool(pick(d, "allowGated", "allow_gated")),
    trackingMode: s(pick(d, "trackingMode", "tracking_mode")) || "none",
    levels: {
      global: toPolicyModeOrNull(levels.global),
      warehouse: toPolicyModeOrNull(levels.warehouse),
      item: toPolicyModeOrNull(levels.item),
    },
  };
}

// ── Deficit ledger (GET /deficits) ──────────────────────────────────────────

export interface DeficitRow {
  id: string;
  warehouseId: string;
  warehouseName: string;
  itemId: string;
  itemName: string;
  originDocType: string;
  originDocId: string;
  deficitQty: number;
  remainingQty: number;
  unitCostAtIssue: number;
  /** derived: remainingQty × unitCostAtIssue — the money still "in the hole". */
  remainingValue: number;
  reason: string;
  status: DeficitStatus;
  createdBy: string;
  createdAt: string | null;
  closedAt: string | null;
}

export interface DeficitLedger {
  rows: DeficitRow[];
  total: number;
}

function toDeficitRow(r: Raw): DeficitRow {
  const warehouseId = s(pick(r, "warehouseId", "warehouse_id"));
  const itemId = s(pick(r, "itemId", "item_id"));
  const remainingQty = num(pick(r, "remainingQty", "remaining_qty"));
  const unitCostAtIssue = num(pick(r, "unitCostAtIssue", "unit_cost_at_issue"));
  return {
    id: s(r.id),
    warehouseId,
    warehouseName: s(pick(r, "warehouseName", "warehouse_name")) || warehouseId,
    itemId,
    itemName: s(pick(r, "itemName", "item_name")) || itemId,
    originDocType: s(pick(r, "originDocType", "origin_doc_type")),
    originDocId: s(pick(r, "originDocId", "origin_doc_id")),
    deficitQty: num(pick(r, "deficitQty", "deficit_qty")),
    remainingQty,
    unitCostAtIssue,
    remainingValue: remainingQty * unitCostAtIssue,
    reason: s(r.reason),
    status: toDeficitStatus(r.status),
    createdBy: s(pick(r, "createdBy", "created_by")),
    createdAt: sOrNull(pick(r, "createdAt", "created_at")),
    closedAt: sOrNull(pick(r, "closedAt", "closed_at")),
  };
}

export function toDeficitLedger(raw: unknown): DeficitLedger {
  const r = (raw ?? {}) as Raw;
  const list = (Array.isArray(r.data) ? r.data : []) as Raw[];
  const rows = list.map(toDeficitRow);
  return { rows, total: r.total != null ? num(r.total) : rows.length };
}

// ── PUT / mutation envelope ─────────────────────────────────────────────────

export interface PolicySaveResult {
  success: boolean;
  id: string | null;
  status: string | null;
  version: number | null;
}

export function toPolicySaveResult(raw: unknown): PolicySaveResult {
  const r = (raw ?? {}) as Raw;
  const d = (r.data ?? {}) as Raw;
  return {
    success: r.success !== false,
    id: d.id ? s(d.id) : null,
    status: r.status ? s(r.status) : null,
    version: r.version != null ? num(r.version) : null,
  };
}
