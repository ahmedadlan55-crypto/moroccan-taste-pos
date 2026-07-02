/**
 * Transfer (stock-issue) API contract — Phase 3A.
 *
 * A pure module that gives the transfer mutation routes (routes/warehouse-ops.js)
 * and the scoped read router (routes/warehouse-transfers.js) ONE source of truth
 * for:
 *   • the 8 canonical error codes + their HTTP status,
 *   • mapping the legacy/internal error `.code`s (from lib/warehouseTransfer.js
 *     and the route handlers) onto those canonical codes,
 *   • the unified mutation-success envelope,
 *   • parsing/validating list query params (page/sort allow-list).
 *
 * No I/O, no DB — every export is pure and unit-tested in
 * tests/transferContract.test.js. The legacy HTML UI is never broken: routes
 * ADD `code` + envelope fields alongside the existing keys, never replace them.
 */
'use strict';

// ── The 8 canonical error codes (the React contract, §5) ───────────────────
const CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  WAREHOUSE_ACCESS_DENIED: 'WAREHOUSE_ACCESS_DENIED',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  OVER_RECEIPT: 'OVER_RECEIPT',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
};

const HTTP_FOR = {
  VALIDATION_ERROR: 422,
  PERMISSION_DENIED: 403,
  WAREHOUSE_ACCESS_DENIED: 403,
  INVALID_STATE_TRANSITION: 422,
  INSUFFICIENT_STOCK: 422,
  OVER_RECEIPT: 422,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
};

// Internal/legacy `.code` (thrown by lib/warehouseTransfer.js or the route
// handlers) → canonical code. Anything unknown falls back to VALIDATION_ERROR.
const ALIASES = {
  // state-machine guards
  ISSUE_REQUIRES_APPROVED: CODES.INVALID_STATE_TRANSITION,
  RECEIVE_INVALID_STATE: CODES.INVALID_STATE_TRANSITION,
  INVALID_TRANSITION: CODES.INVALID_STATE_TRANSITION,
  CANNOT_CANCEL: CODES.INVALID_STATE_TRANSITION,
  CANNOT_REVERSE: CODES.INVALID_STATE_TRANSITION,
  NOT_DRAFT: CODES.INVALID_STATE_TRANSITION,
  // validation
  NEGATIVE_QTY: CODES.VALIDATION_ERROR,
  ITEMS_ARRAY_EMPTY: CODES.VALIDATION_ERROR,
  ITEMS_REQUIRED: CODES.VALIDATION_ERROR,
  NOTHING_TO_RECEIVE: CODES.VALIDATION_ERROR,
  SAME_WAREHOUSE: CODES.VALIDATION_ERROR,
  WAREHOUSE_NOT_FOUND: CODES.VALIDATION_ERROR,
  REASON_REQUIRED: CODES.VALIDATION_ERROR,
  // stock / receipt
  OVER_RECEIPT: CODES.OVER_RECEIPT,
  INSUFFICIENT_STOCK: CODES.INSUFFICIENT_STOCK,
  // concurrency
  state_changed: CODES.VERSION_CONFLICT,
  STATE_CHANGED: CODES.VERSION_CONFLICT,
  VERSION_CONFLICT: CODES.VERSION_CONFLICT,
  IDEMPOTENCY_CONFLICT: CODES.IDEMPOTENCY_CONFLICT,
  // access / role
  PERMISSION_DENIED: CODES.PERMISSION_DENIED,
  FORBIDDEN: CODES.PERMISSION_DENIED,
  WAREHOUSE_ACCESS_DENIED: CODES.WAREHOUSE_ACCESS_DENIED,
};

const SORT_WHITELIST = ['created_at', 'issue_date', 'status', 'issue_number', 'total_cost'];
const STATUSES = ['draft', 'approved', 'issued', 'partially_received', 'received', 'cancelled', 'reversed'];

function isCanonical(code) {
  return Object.prototype.hasOwnProperty.call(HTTP_FOR, String(code));
}

// Resolve any error/string/code to one of the 8 canonical codes.
function mapError(err) {
  if (!err) return CODES.VALIDATION_ERROR;
  const raw = typeof err === 'string' ? err : (err.code || err.canonicalCode || '');
  const key = String(raw);
  if (isCanonical(key)) return key;
  if (Object.prototype.hasOwnProperty.call(ALIASES, key)) return ALIASES[key];
  // Heuristic fallbacks on the message for un-coded legacy errors.
  const msg = String((err && err.message) || err || '').toLowerCase();
  if (/insufficient|غير كاف|الرصيد المتاح|لا يكفي/.test(msg)) return CODES.INSUFFICIENT_STOCK;
  if (/over[- ]?receipt|أكبر من المتبقي/.test(msg)) return CODES.OVER_RECEIPT;
  if (/state.*chang|تغيّرت الحالة|تغيرت الحالة/.test(msg)) return CODES.VERSION_CONFLICT;
  if (/permission|forbidden|صلاحية/.test(msg)) return CODES.PERMISSION_DENIED;
  if (/scope|access denied|الوصول|النطاق/.test(msg)) return CODES.WAREHOUSE_ACCESS_DENIED;
  return CODES.VALIDATION_ERROR;
}

function httpFor(code) {
  return HTTP_FOR[String(code)] || (isCanonical(code) ? 422 : 422);
}

// Unified error body. Keeps a human `error` message (legacy UI reads `error`).
function errorBody(code, message) {
  const canonical = isCanonical(code) ? code : mapError(code);
  return { success: false, code: canonical, error: String(message || canonical) };
}

// Unified mutation-success envelope (the contract, §5). Extra keys may be
// spread in by the caller (e.g. legacy `id`, `issueNumber`).
function mutationEnvelope(parts) {
  const p = parts || {};
  return {
    success: true,
    data: p.data != null ? p.data : null,
    documentNumber: p.documentNumber != null ? String(p.documentNumber) : null,
    status: p.status != null ? String(p.status) : null,
    version: p.version != null ? Number(p.version) : null,
    affectedStock: Array.isArray(p.affectedStock) ? p.affectedStock : [],
    auditEvent: p.auditEvent != null ? p.auditEvent : null,
    warnings: Array.isArray(p.warnings) ? p.warnings : [],
  };
}

function _int(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

// Parse + clamp the transfers list query. sort is allow-listed (injection-safe).
function parseListQuery(query) {
  const q = query || {};
  let page = _int(q.page, 1);
  if (page < 1) page = 1;
  let pageSize = _int(q.pageSize, 25);
  if (pageSize < 1) pageSize = 1;
  if (pageSize > 200) pageSize = 200;
  const sort = SORT_WHITELIST.indexOf(String(q.sort)) !== -1 ? String(q.sort) : 'created_at';
  const dir = String(q.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const status = STATUSES.indexOf(String(q.status)) !== -1 ? String(q.status) : '';
  const search = (q.q != null ? String(q.q) : '').trim().slice(0, 120);
  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    sort,
    dir,
    status,
    fromWarehouseId: q.fromWarehouseId ? String(q.fromWarehouseId) : '',
    toWarehouseId: q.toWarehouseId ? String(q.toWarehouseId) : '',
    warehouseId: q.warehouseId ? String(q.warehouseId) : '',
    dateFrom: q.dateFrom ? String(q.dateFrom) : '',
    dateTo: q.dateTo ? String(q.dateTo) : '',
    q: search,
  };
}

module.exports = {
  CODES,
  HTTP_FOR,
  SORT_WHITELIST,
  STATUSES,
  isCanonical,
  mapError,
  httpFor,
  errorBody,
  mutationEnvelope,
  parseListQuery,
};
