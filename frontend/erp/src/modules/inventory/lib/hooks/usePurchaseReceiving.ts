// Phase W3b — the purchase-receiving work queue: open legacy purchases still
// receivable through V2, and the per-purchase receive plan (outstanding per
// line + tracking mode). The actual receipt creation goes through the existing
// useInvTxMutations("receipt") with { purchaseId } — one write path only.

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";
import { queryKeys } from "@/modules/inventory/lib/query-keys";

/* eslint-disable @typescript-eslint/no-explicit-any */
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const str = (v: unknown): string => (v == null ? "" : String(v));

export interface OpenPurchaseRow {
  id: string;
  purchaseDate: string | null;
  supplierId: string | null;
  supplierName: string;
  warehouseId: string | null;
  warehouseName: string;
  poId: string | null;
  totalPrice: number;
  v2ReceiveStatus: "none" | "partial";
  lineCount: number;
  orderedQty: number;
  receivedQty: number;
  outstandingLines: number;
}

export interface OpenPurchasesPage {
  rows: OpenPurchaseRow[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export interface ReceivePlanLine {
  itemId: string;
  name: string;
  unit: string;
  trackingMode: string;
  active: boolean;
  ordered: number;
  receivedV2: number;
  outstanding: number;
  unitPrice: number;
}

export interface ReceivePlan {
  purchaseId: string;
  supplierId: string | null;
  supplierName: string | null;
  warehouseId: string | null;
  purchaseDate: string | null;
  notes: string | null;
  v2ReceiveStatus: string;
  lines: ReceivePlanLine[];
}

function toOpenPage(body: any): OpenPurchasesPage {
  const rows = (Array.isArray(body?.data) ? body.data : []).map((r: any): OpenPurchaseRow => ({
    id: str(r.id),
    purchaseDate: r.purchaseDate ? str(r.purchaseDate) : null,
    supplierId: r.supplierId ? str(r.supplierId) : null,
    supplierName: str(r.supplierName),
    warehouseId: r.warehouseId ? str(r.warehouseId) : null,
    warehouseName: str(r.warehouseName),
    poId: r.poId ? str(r.poId) : null,
    totalPrice: num(r.totalPrice),
    v2ReceiveStatus: r.v2ReceiveStatus === "partial" ? "partial" : "none",
    lineCount: num(r.lineCount),
    orderedQty: num(r.orderedQty),
    receivedQty: num(r.receivedQty),
    outstandingLines: num(r.outstandingLines),
  }));
  const p = body?.pagination ?? {};
  return { rows, pagination: { page: num(p.page) || 1, pageSize: num(p.pageSize) || 25, total: num(p.total), totalPages: num(p.totalPages) || 1 } };
}

function toPlan(body: any): ReceivePlan {
  const d = body?.data ?? {};
  return {
    purchaseId: str(d.purchaseId),
    supplierId: d.supplierId ? str(d.supplierId) : null,
    supplierName: d.supplierName ? str(d.supplierName) : null,
    warehouseId: d.warehouseId ? str(d.warehouseId) : null,
    purchaseDate: d.purchaseDate ? str(d.purchaseDate) : null,
    notes: d.notes ? str(d.notes) : null,
    v2ReceiveStatus: str(d.v2ReceiveStatus) || "none",
    lines: (Array.isArray(d.lines) ? d.lines : []).map((l: any): ReceivePlanLine => ({
      itemId: str(l.itemId), name: str(l.name) || str(l.itemId), unit: str(l.unit),
      trackingMode: str(l.trackingMode) || "none", active: l.active !== false,
      ordered: num(l.ordered), receivedV2: num(l.receivedV2), outstanding: num(l.outstanding), unitPrice: num(l.unitPrice),
    })),
  };
}

export function useOpenPurchases(query: { q?: string; status?: string; page?: number; pageSize?: number }) {
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") params[k] = v as string | number;
  return useQuery({
    queryKey: queryKeys.purchaseReceiving.open(params),
    queryFn: ({ signal }) => apiClient.get<unknown>("/inventory/v2/purchases/open", { signal, params }).then(toOpenPage),
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  });
}

export function useReceivePlan(purchaseId: string | null) {
  return useQuery({
    enabled: !!purchaseId,
    queryKey: queryKeys.purchaseReceiving.plan(purchaseId ?? ""),
    queryFn: ({ signal }) => apiClient.get<unknown>(`/inventory/v2/purchases/${purchaseId}/receive-plan`, { signal }).then(toPlan),
  });
}
