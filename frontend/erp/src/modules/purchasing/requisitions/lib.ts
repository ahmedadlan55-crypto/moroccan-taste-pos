// Pure helpers for the requisition screen — kept out of the component so the
// rules a branch user relies on can be asserted without rendering anything.

import type { RequisitionStatus } from "./api";

export interface BranchLike {
  id: string;
  warehouseId?: string;
}

/**
 * The warehouse a branch owns, or "" when the branch is unknown or has none.
 *
 * Picking a branch on the form sets the warehouse from this. The old form had
 * a free-text "branch id" box beside a warehouse picker, so the two could name
 * different places — and a request filed that way was found under one filter
 * and missing under the other.
 */
export function warehouseForBranch(branches: readonly BranchLike[], branchId: string): string {
  if (!branchId) return "";
  const b = branches.find((x) => x.id === branchId);
  return b?.warehouseId ? String(b.warehouseId) : "";
}

/** The lifecycle as a stepper: the happy path, with `rejected` shown in place
 *  of the steps a rejected request will never reach. */
export function requisitionSteps(status: RequisitionStatus): Array<{ key: string; current: boolean; reached: boolean }> {
  const path: RequisitionStatus[] = status === "rejected"
    ? ["draft", "submitted", "rejected"]
    : ["draft", "submitted", "approved", "converted"];
  const idx = Math.max(0, path.indexOf(status));
  return path.map((key, i) => ({ key, current: i === idx, reached: i <= idx }));
}

export interface ConvertLineOverride {
  unitPrice?: number;
  vatRate?: number | null;
}

/**
 * The convert-to-PO body. Only overrides that DIFFER from the estimate are
 * sent: an untouched line falls back server-side to its estimated price and
 * the standard VAT rate, exactly as it did before the approver could edit it.
 * A VAT of `null` means "standard" and is therefore not sent at all.
 */
export function buildConvertPayload(
  supplierId: string,
  lines: ReadonlyArray<{ id: string; estimated_price: number }>,
  overrides: Readonly<Record<string, ConvertLineOverride>>,
): { supplierId: string; lines?: Record<string, { unitPrice?: number; vatRate?: number }> } {
  const out: Record<string, { unitPrice?: number; vatRate?: number }> = {};
  for (const line of lines) {
    const ov = overrides[line.id];
    if (!ov) continue;
    const entry: { unitPrice?: number; vatRate?: number } = {};
    if (ov.unitPrice != null && Number.isFinite(ov.unitPrice) && ov.unitPrice !== Number(line.estimated_price)) {
      entry.unitPrice = ov.unitPrice;
    }
    if (ov.vatRate != null && Number.isFinite(ov.vatRate)) entry.vatRate = ov.vatRate;
    if (Object.keys(entry).length) out[line.id] = entry;
  }
  return Object.keys(out).length ? { supplierId, lines: out } : { supplierId };
}

/** Σ qty × (override ?? estimate) — the net the approver is about to commit. */
export function convertNetTotal(
  lines: ReadonlyArray<{ id: string; quantity: number; estimated_price: number }>,
  overrides: Readonly<Record<string, ConvertLineOverride>>,
): number {
  return lines.reduce((sum, l) => {
    const price = overrides[l.id]?.unitPrice;
    const unit = price != null && Number.isFinite(price) ? price : Number(l.estimated_price) || 0;
    return sum + (Number(l.quantity) || 0) * unit;
  }, 0);
}
