// Phase 3B — adapters for the independent inventory-transaction endpoints
// (/api/inventory/v2/{receipts,issues,adjustments}). The three doc types share
// one response shape; per-type column names (receipt_number vs issue_number…)
// are coalesced so a single adapter serves all three.

import type { InvTxStatus, InvTxDocType } from "../schemas/invtx.schema";

function s(v: unknown): string { return v == null ? "" : String(v); }
function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function mapStatus(raw: unknown): InvTxStatus {
  const v = String(raw ?? "draft");
  return (["draft", "approved", "posted", "cancelled", "reversed"].includes(v) ? v : "draft") as InvTxStatus;
}
function pick(row: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (row[k] != null) return row[k];
  return null;
}

export interface InvTxRow {
  id: string;
  number: string;
  status: InvTxStatus;
  version: number;
  date: string | null;
  createdAt: string | null;
  warehouse: { id: string; name: string };
  reason: string | null;
  totalValue: number;
}
export interface InvTxKpis {
  draft: number; approved: number; posted: number; cancelled: number; reversed: number; postedValue: number;
}
export interface InvTxPage {
  rows: InvTxRow[];
  kpis: InvTxKpis;
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  filters: Record<string, unknown>;
}

const NUMBER_COLS = ["receipt_number", "issue_number", "adjustment_number", "number"];
const DATE_COLS = ["receipt_date", "issue_date", "adjustment_date", "date"];
const VALUE_COLS = ["total_value", "total_delta_value", "totalValue"];

function toRow(row: Record<string, unknown>): InvTxRow {
  return {
    id: s(row.id),
    number: s(pick(row, NUMBER_COLS)),
    status: mapStatus(row.status),
    version: num(row.version) || 1,
    date: pick(row, DATE_COLS) ? s(pick(row, DATE_COLS)) : null,
    createdAt: row.created_at ? s(row.created_at) : null,
    warehouse: { id: s(row.warehouse_id), name: s(row.warehouse_name ?? row.warehouse_id) },
    reason: row.reason ? s(row.reason) : null,
    totalValue: num(pick(row, VALUE_COLS)),
  };
}

export function toInvTxPage(raw: unknown): InvTxPage {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rows = (Array.isArray(r.data) ? r.data : []) as Record<string, unknown>[];
  const k = (r.kpis ?? {}) as Record<string, unknown>;
  const p = (r.pagination ?? {}) as Record<string, unknown>;
  return {
    rows: rows.map(toRow),
    kpis: { draft: num(k.draft), approved: num(k.approved), posted: num(k.posted), cancelled: num(k.cancelled), reversed: num(k.reversed), postedValue: num(k.postedValue) },
    pagination: { page: num(p.page) || 1, pageSize: num(p.pageSize) || 25, total: num(p.total), totalPages: num(p.totalPages) || 1 },
    filters: (r.filters ?? {}) as Record<string, unknown>,
  };
}

export interface InvTxLine {
  id: string;
  item: { id: string; name: string; unit: string };
  qty: number;
  unitCost: number;
  lineTotal: number;
  postedUnitCost: number;
  // adjustment-only
  systemQtySnapshot: number;
  countedQty: number;
  delta: number;
  deltaValue: number;
}
export interface TimelineEvent { action: string; fromStatus: string | null; toStatus: string | null; actor: string; note: string | null; at: string | null; }
export interface MovementRow { id: string; at: string | null; type: string; qty: number; reason: string; referenceType: string; }
export interface JournalRow { id: string; number: string; date: string | null; totalDebit: number; totalCredit: number; referenceType: string; entries: { accountCode: string; accountName: string; debit: number; credit: number }[]; }

export interface InvTxDetail {
  id: string;
  number: string;
  status: InvTxStatus;
  version: number;
  date: string | null;
  createdAt: string | null;
  warehouse: { id: string; name: string; code: string };
  reason: string | null;
  sourceRef: string | null;
  recipient: string | null;
  referenceEvidence: string | null;
  counterAccountCode: string | null;
  expenseAccountCode: string | null;
  notes: string | null;
  totalValue: number;
  totalCost: number;
  actors: { createdBy: string; approvedBy: string; postedBy: string; cancelledBy: string; reversedBy: string };
  cancelReason: string | null;
  reverseReason: string | null;
  lines: InvTxLine[];
  timeline: TimelineEvent[];
  movements: MovementRow[];
  journals: JournalRow[];
}

export function toInvTxDetail(raw: unknown): InvTxDetail {
  const r = (raw ?? {}) as Record<string, unknown>;
  const d = (r.data ?? {}) as Record<string, unknown>;
  const lines = (Array.isArray(r.lines) ? r.lines : []) as Record<string, unknown>[];
  const tl = (Array.isArray(r.timeline) ? r.timeline : []) as Record<string, unknown>[];
  const mv = (Array.isArray(r.movements) ? r.movements : []) as Record<string, unknown>[];
  const jr = (Array.isArray(r.journals) ? r.journals : []) as Record<string, unknown>[];
  return {
    id: s(d.id),
    number: s(pick(d, NUMBER_COLS)),
    status: mapStatus(d.status),
    version: num(d.version) || 1,
    date: pick(d, DATE_COLS) ? s(pick(d, DATE_COLS)) : null,
    createdAt: d.created_at ? s(d.created_at) : null,
    warehouse: { id: s(d.warehouse_id), name: s(d.warehouse_name ?? d.warehouse_id), code: s(d.warehouse_code) },
    reason: d.reason ? s(d.reason) : null,
    sourceRef: d.source_ref ? s(d.source_ref) : null,
    recipient: d.recipient ? s(d.recipient) : null,
    referenceEvidence: d.reference_evidence ? s(d.reference_evidence) : null,
    counterAccountCode: d.counter_account_code ? s(d.counter_account_code) : null,
    expenseAccountCode: d.expense_account_code ? s(d.expense_account_code) : null,
    notes: d.notes ? s(d.notes) : null,
    totalValue: num(pick(d, VALUE_COLS)),
    totalCost: num(d.total_cost),
    actors: { createdBy: s(d.created_by), approvedBy: s(d.approved_by), postedBy: s(d.posted_by), cancelledBy: s(d.cancelled_by), reversedBy: s(d.reversed_by) },
    cancelReason: d.cancel_reason ? s(d.cancel_reason) : null,
    reverseReason: d.reverse_reason ? s(d.reverse_reason) : null,
    lines: lines.map((l) => ({
      id: s(l.id),
      item: { id: s(l.item_id), name: s(l.item_name ?? l.item_id), unit: s(l.unit) },
      qty: num(l.qty),
      unitCost: num(l.unit_cost),
      lineTotal: num(l.line_total),
      postedUnitCost: num(l.posted_unit_cost),
      systemQtySnapshot: num(l.system_qty_snapshot),
      countedQty: num(l.counted_qty),
      delta: num(l.delta),
      deltaValue: num(l.delta_value),
    })),
    timeline: tl.map((e) => ({ action: s(e.action), fromStatus: e.from_status ? s(e.from_status) : null, toStatus: e.to_status ? s(e.to_status) : null, actor: s(e.actor), note: e.note ? s(e.note) : null, at: e.created_at ? s(e.created_at) : null })),
    movements: mv.map((m) => ({ id: s(m.id), at: m.movement_date ? s(m.movement_date) : null, type: s(m.type), qty: num(m.qty), reason: s(m.reason), referenceType: s(m.reference_type) })),
    journals: jr.map((j) => ({
      id: s(j.id), number: s(j.journal_number), date: j.journal_date ? s(j.journal_date) : null,
      totalDebit: num(j.total_debit), totalCredit: num(j.total_credit), referenceType: s(j.reference_type),
      entries: (Array.isArray(j.entries) ? j.entries : []).map((e: Record<string, unknown>) => ({ accountCode: s(e.account_code), accountName: s(e.account_name), debit: num(e.debit), credit: num(e.credit) })),
    })),
  };
}

export interface MutationResult {
  success: boolean;
  documentNumber: string | null;
  status: string | null;
  version: number | null;
  affectedValue: number;
  journalId: string | null;
  data: Record<string, unknown> | null;
}
export function toMutationResult(raw: unknown): MutationResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    success: r.success !== false,
    documentNumber: r.documentNumber ? s(r.documentNumber) : null,
    status: r.status ? s(r.status) : null,
    version: r.version != null ? num(r.version) : null,
    affectedValue: num(r.affectedValue),
    journalId: r.journalId ? s(r.journalId) : null,
    data: (r.data ?? null) as Record<string, unknown> | null,
  };
}

export type { InvTxStatus, InvTxDocType };
