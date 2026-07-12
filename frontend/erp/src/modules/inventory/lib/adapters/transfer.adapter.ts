// Transfer adapter — maps the legacy `stock_issues` row shape to the clean
// UI Transfer DTO, including the legacy→UI status rename (`issued` →
// `in_transit`) the blueprint §8.5 mandates, and the cumulative
// qtyRemaining = qtyIssued − qtyReceived the Phase 0 backend now tracks.

import type { Transfer, TransferLine, TransferStatus } from "../schemas/transfer.schema";
export type { TransferLine, TransferStatus } from "../schemas/transfer.schema";

const STATUS_MAP: Record<string, TransferStatus> = {
  draft: "draft",
  submitted: "submitted",
  approved: "approved",
  issued: "in_transit", // backend 'issued' is shown as 'in_transit' in the UI
  partially_received: "partially_received",
  received: "received",
  cancelled: "cancelled",
  reversed: "reversed",
};

export function mapStatus(raw: string | undefined): TransferStatus {
  return STATUS_MAP[String(raw ?? "draft")] ?? "draft";
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toLine(raw: Record<string, unknown>): TransferLine {
  const qtyIssued = num(raw.qty_issued ?? raw.qtyIssued);
  const qtyReceived = num(raw.qty_received ?? raw.qtyReceived);
  return {
    id: String(raw.id ?? ""),
    item: {
      id: String(raw.item_id ?? raw.itemId ?? ""),
      name: String(raw.item_name ?? raw.itemName ?? raw.item_id ?? ""),
      unit: String(raw.item_unit ?? raw.unit ?? ""),
    },
    qtyRequested: num(raw.qty_requested ?? raw.qtyRequested) || 0.0001,
    qtyIssued,
    qtyReceived,
    qtyRemaining: Math.max(0, qtyIssued - qtyReceived),
    unitCost: num(raw.unit_cost ?? raw.unitCost),
  };
}

export function toTransfer(raw: Record<string, unknown>): Transfer {
  const items = Array.isArray(raw.items) ? (raw.items as Record<string, unknown>[]) : [];
  return {
    id: String(raw.id ?? ""),
    number: String(raw.issue_number ?? raw.number ?? "ISS-"),
    status: mapStatus(raw.status as string | undefined),
    fromWarehouse: {
      id: String(raw.from_warehouse_id ?? raw.fromWarehouseId ?? ""),
      name: String(raw.from_warehouse_name ?? raw.fromWarehouse ?? ""),
      code: String(raw.from_warehouse_code ?? ""),
    },
    toWarehouse: {
      id: String(raw.to_warehouse_id ?? raw.toWarehouseId ?? ""),
      name: String(raw.to_warehouse_name ?? raw.toWarehouse ?? ""),
      code: String(raw.to_warehouse_code ?? ""),
    },
    issuedAt: (raw.issued_at as string) ?? null,
    totalCost: num(raw.total_cost ?? raw.totalCost),
    lines: items.length ? items.map(toLine) : [],
  };
}

// ── Phase 3A — the new scoped read endpoints (/api/inventory/transfers*) ─────
// These return the camelCase envelope, so the adapters are thin coercions.

function s(v: unknown): string { return v == null ? "" : String(v); }

export interface TransferListRow {
  id: string;
  number: string;
  status: TransferStatus;
  version: number;
  issueDate: string | null;
  createdAt: string | null;
  fromWarehouse: { id: string; name: string };
  toWarehouse: { id: string; name: string };
  totalCost: number;
  lineCount: number;
  remainingQty: number;
}
export interface TransferKpis {
  count: number;
  draft: number; approved: number; issued: number; partiallyReceived: number;
  received: number; cancelled: number; reversed: number;
  pending: number; inTransit: number; remainingQty: number;
}
export interface TransfersPage {
  rows: TransferListRow[];
  kpis: TransferKpis;
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  filters: Record<string, unknown>;
  scope: { allWarehousesAccess: boolean; warehouseId: string | null };
  generatedAt: string | null;
}

export function toTransfersPage(raw: unknown): TransfersPage {
  const r = (raw ?? {}) as Record<string, unknown>;
  const t = (r.totals ?? {}) as Record<string, unknown>;
  const p = (r.pagination ?? {}) as Record<string, unknown>;
  const sc = (r.scope ?? {}) as Record<string, unknown>;
  const rows = (Array.isArray(r.data) ? r.data : []) as Record<string, unknown>[];
  return {
    rows: rows.map((row) => {
      const fw = (row.fromWarehouse ?? {}) as Record<string, unknown>;
      const tw = (row.toWarehouse ?? {}) as Record<string, unknown>;
      return {
        id: s(row.id),
        number: s(row.number),
        status: mapStatus(row.status as string | undefined),
        version: num(row.version) || 1,
        issueDate: row.issueDate ? s(row.issueDate) : null,
        createdAt: row.createdAt ? s(row.createdAt) : null,
        fromWarehouse: { id: s(fw.id), name: s(fw.name) },
        toWarehouse: { id: s(tw.id), name: s(tw.name) },
        totalCost: num(row.totalCost),
        lineCount: num(row.lineCount),
        remainingQty: num(row.remainingQty),
      };
    }),
    kpis: {
      count: num(t.count), draft: num(t.draft), approved: num(t.approved), issued: num(t.issued),
      partiallyReceived: num(t.partiallyReceived), received: num(t.received), cancelled: num(t.cancelled),
      reversed: num(t.reversed), pending: num(t.pending), inTransit: num(t.inTransit), remainingQty: num(t.remainingQty),
    },
    pagination: { page: num(p.page) || 1, pageSize: num(p.pageSize) || 25, total: num(p.total), totalPages: num(p.totalPages) || 1 },
    filters: (r.filters ?? {}) as Record<string, unknown>,
    scope: { allWarehousesAccess: sc.allWarehousesAccess === true, warehouseId: sc.warehouseId ? s(sc.warehouseId) : null },
    generatedAt: r.generatedAt ? s(r.generatedAt) : null,
  };
}

export interface TimelineEvent { action: string; fromStatus: string | null; toStatus: string | null; actor: string; note: string | null; at: string | null; }
export interface MovementRow { id: string; at: string | null; type: string; qty: number; reason: string; warehouseId: string; itemId: string; itemName: string; }
export interface TransferDetail {
  id: string;
  number: string;
  status: TransferStatus;
  version: number;
  issueDate: string | null;
  createdAt: string | null;
  fromWarehouse: { id: string; name: string; code: string };
  toWarehouse: { id: string; name: string; code: string };
  totalCost: number;
  actors: { createdBy: string; approvedBy: string; issuedBy: string; receivedBy: string; reversedBy: string };
  reverseReason: string | null;
  lines: TransferLine[];
  timeline: TimelineEvent[];
  movements: MovementRow[];
  gl: { issueJournalId: string | null; reverseJournalId: string | null };
}

export function toTransferDetail(raw: unknown): TransferDetail {
  const r = (raw ?? {}) as Record<string, unknown>;
  const d = (r.data ?? {}) as Record<string, unknown>;
  const fw = (d.fromWarehouse ?? {}) as Record<string, unknown>;
  const tw = (d.toWarehouse ?? {}) as Record<string, unknown>;
  const ac = (d.actors ?? {}) as Record<string, unknown>;
  const gl = (d.gl ?? {}) as Record<string, unknown>;
  const lines = (Array.isArray(d.lines) ? d.lines : []) as Record<string, unknown>[];
  const tl = (Array.isArray(d.timeline) ? d.timeline : []) as Record<string, unknown>[];
  const mv = (Array.isArray(d.movements) ? d.movements : []) as Record<string, unknown>[];
  return {
    id: s(d.id), number: s(d.number), status: mapStatus(d.status as string | undefined), version: num(d.version) || 1,
    issueDate: d.issueDate ? s(d.issueDate) : null, createdAt: d.createdAt ? s(d.createdAt) : null,
    fromWarehouse: { id: s(fw.id), name: s(fw.name), code: s(fw.code) },
    toWarehouse: { id: s(tw.id), name: s(tw.name), code: s(tw.code) },
    totalCost: num(d.totalCost),
    actors: { createdBy: s(ac.createdBy), approvedBy: s(ac.approvedBy), issuedBy: s(ac.issuedBy), receivedBy: s(ac.receivedBy), reversedBy: s(ac.reversedBy) },
    reverseReason: d.reverseReason ? s(d.reverseReason) : null,
    lines: lines.map((l) => ({
      id: s(l.id),
      item: { id: s(l.itemId), name: s(l.itemName), unit: s(l.unit) },
      qtyRequested: num(l.qtyRequested) || 0.0001,
      qtyIssued: num(l.qtyIssued),
      qtyReceived: num(l.qtyReceived),
      qtyRemaining: num(l.qtyRemaining),
      unitCost: num(l.unitCost),
    })),
    timeline: tl.map((e) => ({ action: s(e.action), fromStatus: e.fromStatus ? s(e.fromStatus) : null, toStatus: e.toStatus ? s(e.toStatus) : null, actor: s(e.actor), note: e.note ? s(e.note) : null, at: e.at ? s(e.at) : null })),
    movements: mv.map((m) => ({ id: s(m.id), at: m.at ? s(m.at) : null, type: s(m.type), qty: num(m.qty), reason: s(m.reason), warehouseId: s(m.warehouseId), itemId: s(m.itemId), itemName: s(m.itemName) })),
    gl: { issueJournalId: gl.issueJournalId ? s(gl.issueJournalId) : null, reverseJournalId: gl.reverseJournalId ? s(gl.reverseJournalId) : null },
  };
}

// Unified mutation response (contract §5) returned by every transfer action.
export interface MutationResult {
  success: boolean;
  documentNumber: string | null;
  status: string | null;
  version: number | null;
  data: Record<string, unknown> | null;
}
export function toMutationResult(raw: unknown): MutationResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    success: r.success !== false,
    documentNumber: r.documentNumber ? s(r.documentNumber) : (r.issueNumber ? s(r.issueNumber) : null),
    status: r.status ? s(r.status) : null,
    version: r.version != null ? num(r.version) : null,
    data: (r.data ?? null) as Record<string, unknown> | null,
  };
}
