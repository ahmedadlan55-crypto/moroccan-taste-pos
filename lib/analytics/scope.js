/**
 * lib/analytics/scope.js — resolve WHO may see WHAT for the analytics engine.
 *
 * resolveScope(db, user) → { all, brandIds, branchIds, caps }
 *   all       — admin / developer: every branch, no scope clause.
 *   branchIds — everyone else: derived from user_warehouse_access →
 *               warehouses.branch_id (one query, no N+1). ZERO grants →
 *               { all:false, branchIds: [] } — the planner then emits a
 *               `1=0` scope clause and the user gets EMPTY rows, never an
 *               error and never someone else's data (fail-closed).
 *   brandIds  — the brands those branches belong to (branches.brand_id),
 *               informational for the UI; the enforced clause is branch-level
 *               (every fact carries branch_id — see registry/facts.js
 *               scopeColumn).
 *   caps      — Set of the effective analytics.* capabilities, computed with
 *               the EXACT model middleware/requireCapability.js uses
 *               (role_permissions ∪ {override:grant} \ {override:revoke}),
 *               but batched: ONE query for all analytics capabilities instead
 *               of one per check. Global users get the full set (they bypass
 *               capability checks everywhere else in this codebase).
 *
 * Any DB fault while resolving throws — middleware/analyticsScope.js maps
 * that to a 500. Guessing a scope on error would either leak (too wide) or
 * lie (too narrow).
 */
'use strict';

const WS = require('../warehouseScope');

/** Every capability the analytics module is gated on (registry + seeds). */
const ANALYTICS_CAPS = Object.freeze([
  'analytics.view',
  'analytics.cost.view',
  'analytics.customers.view',
  'analytics.employees.view',
  'analytics.export',
  'analytics.share',
  'analytics.schedule',
  'analytics.budget.manage',
  'analytics.reconciliation.view',
  'analytics.anomaly.manage',
]);

/**
 * Batch-compute the effective capability set for a user.
 * Same effective-permission model as requireCapability.hasCapability —
 * (granted by role AND not revoked by override) OR granted by override —
 * in one query over the whole analytics cap list.
 */
async function loadCaps(db, user) {
  if (WS.isGlobalScope(user)) return new Set(ANALYTICS_CAPS);
  if (!user || !user.username) return new Set();
  const role = String(user.role || 'employee').toLowerCase();
  const ph = ANALYTICS_CAPS.map(() => '?').join(',');
  const [rows] = await db.query(
    `SELECT p.id,
            MAX(rp.permission_id IS NOT NULL)                                AS by_role,
            MAX(CASE WHEN upo.grant_type = 'grant'  THEN 1 ELSE 0 END)        AS o_grant,
            MAX(CASE WHEN upo.grant_type = 'revoke' THEN 1 ELSE 0 END)        AS o_revoke
       FROM permissions_v3 p
       LEFT JOIN role_permissions rp
              ON rp.permission_id = p.id AND rp.role = ?
       LEFT JOIN user_permission_overrides upo
              ON upo.permission_id = p.id AND upo.username = ?
      WHERE p.id IN (${ph})
      GROUP BY p.id`,
    [role, user.username, ...ANALYTICS_CAPS]
  );
  const caps = new Set();
  for (const r of rows) {
    const byRole = !!Number(r.by_role);
    const granted = !!Number(r.o_grant);
    const revoked = !!Number(r.o_revoke);
    if ((byRole && !revoked) || granted) caps.add(r.id);
  }
  return caps;
}

/**
 * Branch/brand scope from the warehouse-access grants:
 * user_warehouse_access (user_id) → warehouses.branch_id → branches.brand_id.
 * One joined query; warehouses without a branch contribute nothing (a fact
 * row is always branch-attributed — see ProjectionService).
 */
async function loadBranchScope(db, user) {
  if (WS.isGlobalScope(user)) return { all: true, brandIds: [], branchIds: [] };
  if (!user || user.id == null) return { all: false, brandIds: [], branchIds: [] };
  const [rows] = await db.query(
    `SELECT DISTINCT w.branch_id, b.brand_id
       FROM user_warehouse_access uwa
       JOIN warehouses w ON w.id = uwa.warehouse_id
       LEFT JOIN branches b ON b.id = w.branch_id
      WHERE uwa.user_id = ?`,
    [user.id]
  );
  const branchIds = [], brandIds = [];
  const seenBranch = new Set(), seenBrand = new Set();
  for (const r of rows) {
    if (r.branch_id != null && !seenBranch.has(String(r.branch_id))) {
      seenBranch.add(String(r.branch_id));
      branchIds.push(String(r.branch_id));
    }
    if (r.brand_id != null && !seenBrand.has(String(r.brand_id))) {
      seenBrand.add(String(r.brand_id));
      brandIds.push(String(r.brand_id));
    }
  }
  return { all: false, brandIds, branchIds };
}

/**
 * @returns {Promise<{all:boolean, brandIds:string[], branchIds:string[], caps:Set<string>}>}
 */
async function resolveScope(db, user) {
  const [branchScope, caps] = await Promise.all([
    loadBranchScope(db, user),
    loadCaps(db, user),
  ]);
  return { all: branchScope.all, brandIds: branchScope.brandIds, branchIds: branchScope.branchIds, caps };
}

/** Stable string identity of a scope — cache-key component in QueryService. */
function scopeHash(scope) {
  const caps = [...(scope.caps || [])].sort();
  const branches = (scope.branchIds || []).slice().sort();
  return JSON.stringify({ all: !!scope.all, branches, caps });
}

module.exports = { resolveScope, loadCaps, loadBranchScope, scopeHash, ANALYTICS_CAPS };
