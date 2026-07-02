// Phase 3C — adapters for /api/inventory/v2/stocktakes. Normalizes the backend
// row shapes into stable UI models (snake_case → camelCase, numbers coerced,
// nullable counted_qty preserved as null = uncounted).

import type { StocktakeStatus, StocktakeScopeType } from "../schemas/stocktake.schema";

function s(v: unknown): string { return v == null ? "" : String(v); }
function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function bool(v: unknown): boolean { return v === 1 || v === true || v === "1"; }
function mapStatus(raw: unknown): StocktakeStatus {
  const v = String(raw ?? "draft");
  return (["draft", "counting", "submitted", "approved", "posted", "cancelled"].includes(v) ? v : "draft") as StocktakeStatus;
}

export interface StocktakeRow {
  id: string;
  number: string;
  status: StocktakeStatus;
  version: number;
  date: string | null;
  createdAt: string | null;
  warehouse: { id: string; name: string };
  scopeType: StocktakeScopeType;
  reason: string | null;
  totalLines: number;
  countedLines: number;
  varianceLines: number;
  totalVarianceValue: number;
}
export interface StocktakeKpis { draft: number; counting: number; submitted: number; approved: number; posted: number; cancelled: number; varianceLines: number; postedVarianceValue: number; }
export interface StocktakePage { rows: StocktakeRow[]; kpis: StocktakeKpis; pagination: { page: number; pageSize: number; total: number; totalPages: number }; filters: Record<string, unknown>; }

function toRow(r: Record<string, unknown>): StocktakeRow {
  return {
    id: s(r.id),
    number: s(r.stocktake_number),
    status: mapStatus(r.status),
    version: num(r.version) || 1,
    date: r.stocktake_date ? s(r.stocktake_date) : null,
    createdAt: r.created_at ? s(r.created_at) : null,
    warehouse: { id: s(r.warehouse_id), name: s(r.warehouse_name ?? r.warehouse_id) },
    scopeType: (["full", "category", "items"].includes(String(r.scope_type)) ? r.scope_type : "full") as StocktakeScopeType,
    reason: r.reason ? s(r.reason) : null,
    totalLines: num(r.total_lines),
    countedLines: num(r.counted_lines),
    varianceLines: num(r.variance_lines),
    totalVarianceValue: num(r.total_variance_value),
  };
}

export function toStocktakePage(raw: unknown): StocktakePage {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rows = (Array.isArray(r.data) ? r.data : []) as Record<string, unknown>[];
  const k = (r.kpis ?? {}) as Record<string, unknown>;
  const p = (r.pagination ?? {}) as Record<string, unknown>;
  return {
    rows: rows.map(toRow),
    kpis: { draft: num(k.draft), counting: num(k.counting), submitted: num(k.submitted), approved: num(k.approved), posted: num(k.posted), cancelled: num(k.cancelled), varianceLines: num(k.varianceLines), postedVarianceValue: num(k.postedVarianceValue) },
    pagination: { page: num(p.page) || 1, pageSize: num(p.pageSize) || 25, total: num(p.total), totalPages: num(p.totalPages) || 1 },
    filters: (r.filters ?? {}) as Record<string, unknown>,
  };
}

export interface StocktakeLine {
  id: string;
  item: { id: string; name: string; unit: string };
  snapshotQty: number;
  countedQty: number | null;
  counted: boolean;
  netMovements: number;
  theoreticalQty: number;
  variance: number;
  varianceValue: number;
  variancePct: number;
  isFlagged: boolean;
  unitCost: number;
  reasonCode: string | null;
  notes: string | null;
  countedAt: string | null;
}
export interface StocktakeTimelineEvent { action: string; fromStatus: string | null; toStatus: string | null; actor: string; note: string | null; at: string | null; }
export interface StocktakeMovementRow { id: string; at: string | null; type: string; qty: number; reason: string; referenceType: string; }
export interface StocktakeJournalRow { id: string; number: string; date: string | null; totalDebit: number; totalCredit: number; entries: { accountCode: string; accountName: string; debit: number; credit: number }[]; }

export interface StocktakeDetail {
  id: string;
  number: string;
  status: StocktakeStatus;
  version: number;
  date: string | null;
  warehouse: { id: string; name: string; code: string };
  scopeType: StocktakeScopeType;
  blindCount: boolean;
  includeZero: boolean;
  reason: string | null;
  referenceEvidence: string | null;
  notes: string | null;
  snapshotAt: string | null;
  totalLines: number;
  countedLines: number;
  varianceLines: number;
  totalVarianceValue: number;
  evidenceThreshold: number;
  adjustmentId: string | null;
  adjustmentNumber: string | null;
  actors: { createdBy: string; submittedBy: string; approvedBy: string; postedBy: string; cancelledBy: string; recountBy: string };
  recountReason: string | null;
  cancelReason: string | null;
  currentSeq: number;
  lines: StocktakeLine[];
  timeline: StocktakeTimelineEvent[];
  movements: StocktakeMovementRow[];
  journals: StocktakeJournalRow[];
}

export function toStocktakeDetail(raw: unknown): StocktakeDetail {
  const r = (raw ?? {}) as Record<string, unknown>;
  const d = (r.data ?? {}) as Record<string, unknown>;
  const lines = (Array.isArray(r.lines) ? r.lines : []) as Record<string, unknown>[];
  const tl = (Array.isArray(r.timeline) ? r.timeline : []) as Record<string, unknown>[];
  const mv = (Array.isArray(r.movements) ? r.movements : []) as Record<string, unknown>[];
  const jr = (Array.isArray(r.journals) ? r.journals : []) as Record<string, unknown>[];
  return {
    id: s(d.id),
    number: s(d.stocktake_number),
    status: mapStatus(d.status),
    version: num(d.version) || 1,
    date: d.stocktake_date ? s(d.stocktake_date) : null,
    warehouse: { id: s(d.warehouse_id), name: s(d.warehouse_name ?? d.warehouse_id), code: s(d.warehouse_code) },
    scopeType: (["full", "category", "items"].includes(String(d.scope_type)) ? d.scope_type : "full") as StocktakeScopeType,
    blindCount: bool(d.blind_count),
    includeZero: bool(d.include_zero),
    reason: d.reason ? s(d.reason) : null,
    referenceEvidence: d.reference_evidence ? s(d.reference_evidence) : null,
    notes: d.notes ? s(d.notes) : null,
    snapshotAt: d.snapshot_at ? s(d.snapshot_at) : null,
    totalLines: num(d.total_lines),
    countedLines: num(d.counted_lines),
    varianceLines: num(d.variance_lines),
    totalVarianceValue: num(d.total_variance_value),
    evidenceThreshold: num(d.evidence_threshold),
    adjustmentId: d.adjustment_id ? s(d.adjustment_id) : null,
    adjustmentNumber: d.adjustment_number ? s(d.adjustment_number) : null,
    actors: { createdBy: s(d.created_by), submittedBy: s(d.submitted_by), approvedBy: s(d.approved_by), postedBy: s(d.posted_by), cancelledBy: s(d.cancelled_by), recountBy: s(d.recount_by) },
    recountReason: d.recount_reason ? s(d.recount_reason) : null,
    cancelReason: d.cancel_reason ? s(d.cancel_reason) : null,
    currentSeq: num(r.currentSeq),
    lines: lines.map((l) => ({
      id: s(l.id),
      item: { id: s(l.item_id), name: s(l.item_name ?? l.item_id), unit: s(l.unit) },
      snapshotQty: num(l.snapshot_qty),
      countedQty: l.counted_qty === null || l.counted_qty === undefined ? null : num(l.counted_qty),
      counted: !(l.counted_qty === null || l.counted_qty === undefined),
      netMovements: num(l.net_movements),
      theoreticalQty: num(l.theoretical_qty),
      variance: num(l.variance),
      varianceValue: num(l.variance_value),
      variancePct: num(l.variance_pct),
      isFlagged: bool(l.is_flagged),
      unitCost: num(l.unit_cost),
      reasonCode: l.reason_code ? s(l.reason_code) : null,
      notes: l.notes ? s(l.notes) : null,
      countedAt: l.counted_at ? s(l.counted_at) : null,
    })),
    timeline: tl.map((e) => ({ action: s(e.action), fromStatus: e.from_status ? s(e.from_status) : null, toStatus: e.to_status ? s(e.to_status) : null, actor: s(e.actor), note: e.note ? s(e.note) : null, at: e.created_at ? s(e.created_at) : null })),
    movements: mv.map((m) => ({ id: s(m.id), at: m.movement_date ? s(m.movement_date) : null, type: s(m.type), qty: num(m.qty), reason: s(m.reason), referenceType: s(m.reference_type) })),
    journals: jr.map((j) => ({ id: s(j.id), number: s(j.journal_number), date: j.journal_date ? s(j.journal_date) : null, totalDebit: num(j.total_debit), totalCredit: num(j.total_credit), entries: (Array.isArray(j.entries) ? j.entries : []).map((e: Record<string, unknown>) => ({ accountCode: s(e.account_code), accountName: s(e.account_name), debit: num(e.debit), credit: num(e.credit) })) })),
  };
}

export interface StocktakeMutationResult { success: boolean; documentNumber: string | null; status: string | null; version: number | null; adjustmentId: string | null; journalId: string | null; affectedValue: number; data: Record<string, unknown> | null; }
export function toStocktakeMutation(raw: unknown): StocktakeMutationResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  const data = (r.data ?? null) as Record<string, unknown> | null;
  return {
    success: r.success !== false,
    documentNumber: r.documentNumber ? s(r.documentNumber) : null,
    status: r.status ? s(r.status) : null,
    version: r.version != null ? num(r.version) : null,
    adjustmentId: r.adjustmentId ? s(r.adjustmentId) : (data && data.adjustmentId ? s(data.adjustmentId) : null),
    journalId: r.journalId ? s(r.journalId) : null,
    affectedValue: num(r.affectedValue),
    data,
  };
}
