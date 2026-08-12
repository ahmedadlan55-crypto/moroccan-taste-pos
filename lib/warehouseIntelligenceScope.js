/**
 * Fail-closed warehouse scope for financial/decision reports.
 *
 * Unlike middleware/warehouseScope's rollout helpers, this module never reads
 * WAREHOUSE_SCOPE_ENFORCE. A missing scope or an empty non-global scope always
 * produces zero rows, and a requested out-of-scope warehouse is denied.
 */
'use strict';

const WS = require('./warehouseScope');

const TRUSTED_EXPRESSIONS = new Set([
  'ws.warehouse_id',
  'w.id',
  'po.warehouse_id',
  'pr.warehouse_id',
  'we.warehouse_id',
  'f.warehouse_id',
  'm.warehouse_id',
  'mm.warehouse_id',
  'ge.warehouse_id',
  'a.warehouse_id',
  's.warehouse_id',
  'pl.warehouse_id',
  'warehouse_id',
  'from_warehouse_id',
  'to_warehouse_id',
  'si.from_warehouse_id',
  'si.to_warehouse_id',
  'sr.warehouse_id',
  'COALESCE(prl.warehouse_id, pr.warehouse_id)',
  'COALESCE(rl.warehouse_id,sr.warehouse_id)',
]);

function trustedExpression(expression) {
  const value = String(expression || '');
  if (!TRUSTED_EXPRESSIONS.has(value)) {
    const error = new Error('Untrusted warehouse scope expression');
    error.code = 'WAREHOUSE_SCOPE_EXPRESSION_INVALID';
    throw error;
  }
  return value;
}

function predicate(scope, expression, requestedWarehouseId) {
  const column = trustedExpression(expression);
  const requested = requestedWarehouseId == null ? '' : String(requestedWarehouseId).trim();
  if (requested) {
    return WS.hasWarehouseAccess(scope, requested)
      ? { sql: ` AND ${column} = ?`, params: [requested] }
      : { sql: ' AND 1=0', params: [] };
  }
  return WS.scopeSqlClause(scope, column);
}

function append(scope, expression, where, params, requestedWarehouseId) {
  const scoped = predicate(scope, expression, requestedWarehouseId);
  if (!scoped.sql) return;
  where.push(scoped.sql.replace(/^\s*AND\s+/i, ''));
  params.push(...scoped.params);
}

function canReadWarehouse(scope, warehouseId) {
  return WS.hasWarehouseAccess(scope, warehouseId);
}

function publicScope(scope) {
  if (!scope || typeof scope !== 'object') return { all: false, warehouseIds: [] };
  return {
    all: scope.all === true,
    warehouseIds: scope.all === true
      ? []
      : [...new Set((Array.isArray(scope.warehouseIds) ? scope.warehouseIds : []).map(String).filter(Boolean))],
  };
}

module.exports = {
  TRUSTED_EXPRESSIONS,
  predicate,
  append,
  canReadWarehouse,
  publicScope,
};
