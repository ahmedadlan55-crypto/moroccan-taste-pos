/**
 * Warehouse Scope middleware (Phase 2A.2).
 *
 * Runs AFTER the global /api auth gate (req.user is set) and BEFORE the
 * warehouse routers. Loads the caller's accessible warehouses ONCE per request
 * (no N+1) and exposes the helpers routes use to enforce scope.
 *
 * Enforcement is gated by WAREHOUSE_SCOPE_ENFORCE:
 *   • OFF (default) — guards are pass-through (legacy behavior preserved), but
 *     would-be denials are shadow-logged. The resolved scope is still attached
 *     so the access-scope endpoint + React work during rollout.
 *   • ON — req.guardWh / req.guardTransfer answer with a generic 403 and
 *     req.whScopeClause restricts list/aggregate queries to allowed warehouses.
 *
 * The guards WRITE the 403 response and return false (instead of throwing), so
 * a route only needs `if (!req.guardWh(res, id)) return;` — no edits to the
 * ~75 existing try/catch blocks, and the frontend's 403→PermissionDenied path
 * fires correctly. The body is generic and never names the warehouse.
 */
'use strict';

const db = require('../db/connection');
const WS = require('../lib/warehouseScope');

const ENFORCE = /^(1|true|on|yes)$/i.test(String(process.env.WAREHOUSE_SCOPE_ENFORCE || '').trim());

function isEnforced() { return ENFORCE; }

// Resolve a user's scope from the access table (one query; skipped for global
// admins/developers). Never throws — a missing table → no grants.
async function loadScope(user) {
  if (WS.isGlobalScope(user)) return { all: true, warehouseIds: [] };
  if (!user || user.id == null) return { all: false, warehouseIds: [] };
  let rows = [];
  try {
    const [r] = await db.query('SELECT warehouse_id FROM user_warehouse_access WHERE user_id = ?', [user.id]);
    rows = r || [];
  } catch (e) {
    rows = [];
  }
  return WS.resolveScopeFromRows(user, rows);
}

function _deny(res) {
  return res.status(403).json({
    success: false,
    code: 'WAREHOUSE_ACCESS_DENIED',
    error: WS.ACCESS_DENIED_MSG,
  });
}

async function loadWarehouseScope(req, res, next) {
  try {
    const scope = await loadScope(req.user);
    req.warehouseScope = scope;
    const who = (req.user && req.user.username) || '?';

    // Guard a single warehouse. Returns true to proceed, false after writing a
    // 403. An empty id is "nothing to check" → proceed (callers decide whether
    // a missing id should instead trigger list-scoping via whScopeClause).
    req.guardWh = function (response, warehouseId) {
      if (warehouseId == null || String(warehouseId) === '') return true;
      if (WS.hasWarehouseAccess(scope, warehouseId)) return true;
      if (!ENFORCE) {
        console.warn('[wh-scope shadow] user=%s would be denied warehouse=%s on %s', who, warehouseId, require('../lib/urlScrub').scrubUrl(req.originalUrl));
        return true;
      }
      _deny(response);
      return false;
    };

    // Guard BOTH ends of a transfer.
    req.guardTransfer = function (response, sourceId, destId) {
      if (WS.hasTransferAccess(scope, sourceId, destId)) return true;
      if (!ENFORCE) {
        console.warn('[wh-scope shadow] user=%s would be denied transfer %s→%s on %s', who, sourceId, destId, require('../lib/urlScrub').scrubUrl(req.originalUrl));
        return true;
      }
      _deny(response);
      return false;
    };

    // Injection-safe IN(...) fragment for list/aggregate scoping. Empty when
    // not enforced (legacy unscoped behavior). `column` MUST be a constant.
    req.whScopeClause = function (column) {
      if (!ENFORCE) return { sql: '', params: [] };
      return WS.scopeSqlClause(scope, column);
    };

    next();
  } catch (e) {
    next(e);
  }
}

module.exports = { loadWarehouseScope, loadScope, isEnforced, ENFORCE };
