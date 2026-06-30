// Transfer adapter — maps the legacy `stock_issues` row shape to the clean
// UI Transfer DTO, including the legacy→UI status rename (`issued` →
// `in_transit`) the blueprint §8.5 mandates, and the cumulative
// qtyRemaining = qtyIssued − qtyReceived the Phase 0 backend now tracks.

import type { Transfer, TransferLine, TransferStatus } from "../schemas/transfer.schema";

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
