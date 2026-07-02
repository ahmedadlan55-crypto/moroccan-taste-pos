/**
 * Warehouse Scope — per-user warehouse access control (Phase 2A.2).
 *
 * Separates RBAC (WHAT a user may do — stays in middleware/auth.requireRole)
 * from Warehouse Scope (WHICH warehouses a user may touch — this module).
 *
 * Pure rules (no DB / no I/O) shared by:
 *   • middleware/warehouseScope.js — loads the per-request scope from the
 *     user_warehouse_access table and wires req.assertWh / req.whScopeClause.
 *   • the warehouse routes (inventory / warehouse-ops / erp / stocktake-pro).
 *   • tests/warehouseScope.test.js.
 *
 * Hard rules:
 *   • admin + developer have IMPLICIT access to every warehouse.
 *   • everyone else sees ONLY explicitly-granted warehouses; no grant = deny.
 *   • a transfer requires access to BOTH source and destination.
 *   • denials are generic — they never reveal a forbidden warehouse's id/name,
 *     so an out-of-scope id is indistinguishable from a non-existent one.
 */
'use strict';

function _err(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

// Generic, non-revealing denial message (never names the warehouse).
const ACCESS_DENIED_MSG = 'لا تملك صلاحية الوصول إلى هذا المستودع.';

// admin or developer → implicit access to ALL warehouses.
function isGlobalScope(user) {
  if (!user) return false;
  if (String(user.role || '').toLowerCase() === 'admin') return true;
  return user.isDeveloper === true || user.isDeveloper === 1 || user.isDeveloper === '1';
}

// Normalize a scope object: { all:boolean, warehouseIds:string[] }.
// Tolerates a bare array (treated as a non-global allow-list) or null.
function _scope(scope) {
  if (!scope) return { all: false, warehouseIds: [] };
  if (Array.isArray(scope)) return { all: false, warehouseIds: scope.map(String) };
  return { all: !!scope.all, warehouseIds: (scope.warehouseIds || []).map(String) };
}

// Build the scope from the user + their access rows.
// rows: array of { warehouse_id } objects (or plain id strings).
function resolveScopeFromRows(user, rows) {
  if (isGlobalScope(user)) return { all: true, warehouseIds: [] };
  const ids = [];
  const seen = Object.create(null);
  (rows || []).forEach((r) => {
    const raw = r && typeof r === 'object' ? r.warehouse_id : r;
    const id = raw == null ? '' : String(raw);
    if (id && !seen[id]) { seen[id] = true; ids.push(id); }
  });
  return { all: false, warehouseIds: ids };
}

function hasWarehouseAccess(scope, warehouseId) {
  const s = _scope(scope);
  if (s.all) return true;
  if (warehouseId == null || String(warehouseId) === '') return false;
  return s.warehouseIds.indexOf(String(warehouseId)) !== -1;
}

function assertWarehouseAccess(scope, warehouseId) {
  if (!hasWarehouseAccess(scope, warehouseId)) {
    throw _err('WAREHOUSE_ACCESS_DENIED', ACCESS_DENIED_MSG);
  }
}

// A transfer touches two warehouses; the actor must be able to access BOTH.
function hasTransferAccess(scope, sourceId, destId) {
  return hasWarehouseAccess(scope, sourceId) && hasWarehouseAccess(scope, destId);
}
function assertTransferAccess(scope, sourceId, destId) {
  // Generic — must NOT reveal which side failed.
  if (!hasTransferAccess(scope, sourceId, destId)) {
    throw _err('WAREHOUSE_ACCESS_DENIED', ACCESS_DENIED_MSG);
  }
}

// Intersect a candidate id list with the scope (for in-code filtering).
function filterAccessibleIds(scope, candidateIds) {
  const s = _scope(scope);
  const list = (candidateIds || []).map(String);
  if (s.all) return list.slice();
  const allow = Object.create(null);
  s.warehouseIds.forEach((id) => { allow[id] = true; });
  return list.filter((id) => allow[id]);
}

// Injection-safe SQL fragment restricting `column` to the allowed warehouses.
//   all   → '' (no restriction)
//   list  → ' AND col IN (?,?,…)' + params
//   empty → ' AND 1=0' (no access → return zero rows; default deny)
// `column` MUST be a trusted constant identifier — never user input.
function scopeSqlClause(scope, column) {
  const s = _scope(scope);
  if (s.all) return { sql: '', params: [] };
  if (!s.warehouseIds.length) return { sql: ' AND 1=0', params: [] };
  const placeholders = s.warehouseIds.map(() => '?').join(',');
  return { sql: ' AND ' + column + ' IN (' + placeholders + ')', params: s.warehouseIds.slice() };
}

module.exports = {
  ACCESS_DENIED_MSG,
  isGlobalScope,
  resolveScopeFromRows,
  hasWarehouseAccess,
  assertWarehouseAccess,
  hasTransferAccess,
  assertTransferAccess,
  filterAccessibleIds,
  scopeSqlClause,
};
