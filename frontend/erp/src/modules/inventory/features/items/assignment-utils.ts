// D1 — pure helpers for the item branch/warehouse assignment editor. Kept
// framework-free so they are unit-tested directly and reused by both the
// AssignmentsSection UI and the form-level pre-save validation. The server
// (D3) is the real gate; these mirror its rules for immediate UX feedback.

export interface AssignmentDraft {
  key: string;              // stable client key
  branchId: string;
  warehouseId: string;
  isActive: boolean;
  minQty: string;
  maxStock: string;
  reorderPoint: string;
  reorderQty: string;
  safetyStock: string;
  leadTimeDays: string;
}

export interface WarehouseUniverseRow {
  id: string;
  name: string;
  code: string;
  branchId: string;
  branchName: string;
  isActive: boolean;
  isMain: boolean;
}

export function blankAssignment(branchId = "", warehouseId = ""): AssignmentDraft {
  return {
    key: "asg-" + Math.random().toString(36).slice(2, 9),
    branchId, warehouseId, isActive: true,
    minQty: "", maxStock: "", reorderPoint: "", reorderQty: "", safetyStock: "", leadTimeDays: "",
  };
}

const n = (v: string) => (v === "" || v == null ? 0 : Number(v));

/**
 * The first assignment whose warehouse is NOT under its selected branch, else
 * null. A warehouse with no known universe row is treated as valid (the server
 * still validates) so an as-yet-unpicked warehouse doesn't false-positive.
 */
export function findCrossBranchAssignment(
  drafts: AssignmentDraft[],
  universe: WarehouseUniverseRow[],
): { warehouse: string; branch: string } | null {
  const byId = new Map(universe.map((w) => [w.id, w]));
  for (const d of drafts) {
    if (!d.warehouseId || !d.branchId) continue;
    const w = byId.get(d.warehouseId);
    if (w && w.branchId && w.branchId !== d.branchId) {
      const branch = universe.find((x) => x.branchId === d.branchId)?.branchName || d.branchId;
      return { warehouse: w.name || d.warehouseId, branch };
    }
  }
  return null;
}

/** The first warehouseId assigned more than once (or unset), else null. */
export function findDuplicateWarehouse(
  drafts: AssignmentDraft[],
  universe: WarehouseUniverseRow[],
): string | null {
  const seen = new Set<string>();
  const byId = new Map(universe.map((w) => [w.id, w]));
  for (const d of drafts) {
    if (!d.warehouseId) continue;
    if (seen.has(d.warehouseId)) return byId.get(d.warehouseId)?.name || d.warehouseId;
    seen.add(d.warehouseId);
  }
  return null;
}

export type RuleIssue = "reorderQtyPositive" | "maxGteReorder" | "reorderGteSafety";

/** Per-location reorder-rule sanity (mirrors warehouseRuleInput refinements). */
export function assignmentRuleIssue(d: AssignmentDraft): RuleIssue | null {
  const reorderPoint = n(d.reorderPoint);
  const reorderQty = n(d.reorderQty);
  const maxStock = n(d.maxStock);
  const safety = n(d.safetyStock);
  if (d.isActive && reorderQty <= 0 && (reorderPoint > 0 || maxStock > 0 || safety > 0)) return "reorderQtyPositive";
  if (maxStock > 0 && maxStock < reorderPoint) return "maxGteReorder";
  if (reorderPoint > 0 && reorderPoint < safety) return "reorderGteSafety";
  return null;
}

export interface AssignmentValidation {
  ok: boolean;
  cross: { warehouse: string; branch: string } | null;
  duplicate: string | null;
  ruleIssue: { key: string; issue: RuleIssue } | null;
}

export function validateAssignments(
  drafts: AssignmentDraft[],
  universe: WarehouseUniverseRow[],
): AssignmentValidation {
  const cross = findCrossBranchAssignment(drafts, universe);
  const duplicate = cross ? null : findDuplicateWarehouse(drafts, universe);
  let ruleIssue: { key: string; issue: RuleIssue } | null = null;
  if (!cross && !duplicate) {
    for (const d of drafts.filter((x) => x.warehouseId)) {
      const issue = assignmentRuleIssue(d);
      if (issue) { ruleIssue = { key: d.key, issue }; break; }
    }
  }
  return { ok: !cross && !duplicate && !ruleIssue, cross, duplicate, ruleIssue };
}

/** Map drafts → the PUT payload assignment array (only rows with a warehouse). */
export function draftsToInput(drafts: AssignmentDraft[]) {
  return drafts
    .filter((d) => d.warehouseId)
    .map((d) => ({
      warehouseId: d.warehouseId,
      isActive: d.isActive,
      minQty: n(d.minQty),
      maxStock: n(d.maxStock),
      reorderPoint: n(d.reorderPoint),
      reorderQty: n(d.reorderQty),
      safetyStock: n(d.safetyStock),
      leadTimeDays: n(d.leadTimeDays),
    }));
}

/** Build a full "all branches & warehouses" draft set from the active universe,
 *  preserving any rule values already entered for a warehouse. */
export function allBranchesDrafts(
  universe: WarehouseUniverseRow[],
  existing: AssignmentDraft[],
): AssignmentDraft[] {
  const byWh = new Map(existing.map((d) => [d.warehouseId, d]));
  return universe
    .filter((w) => w.isActive)
    .map((w) => {
      const prev = byWh.get(w.id);
      return prev ? { ...prev, branchId: w.branchId } : blankAssignment(w.branchId, w.id);
    });
}
