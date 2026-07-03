/**
 * Inventory-transaction API contract — Phase 3B.
 *
 * ONE source of truth for the independent receipts / issues / adjustments
 * routes (routes/inventory-transactions.js):
 *   • the 10 canonical error codes + their HTTP status,
 *   • mapping internal/legacy `.code`s onto those canonical codes,
 *   • the unified mutation-success envelope (extends the transfer envelope with
 *     affectedValue / movementIds / journalId),
 *   • list query parsing (page/sort allow-list, injection-safe).
 *
 * Pure (no I/O, no DB). Mirrors lib/transferContract.js so the two stay
 * consistent; unit-tested in tests/inventoryTxContract.test.js.
 */
'use strict';

// ── The 10 canonical error codes (the React contract, §7) ──────────────────
const CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  WAREHOUSE_ACCESS_DENIED: 'WAREHOUSE_ACCESS_DENIED',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  QUANTITY_CONFLICT: 'QUANTITY_CONFLICT',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  COST_REQUIRED: 'COST_REQUIRED',
  GL_POSTING_FAILED: 'GL_POSTING_FAILED',
  // Phase 4B — lots / expiry / FEFO / traceability
  INSUFFICIENT_LOT_QUANTITY: 'INSUFFICIENT_LOT_QUANTITY',
  EXPIRED_LOT: 'EXPIRED_LOT',
  QUARANTINED_LOT: 'QUARANTINED_LOT',
  RECALLED_LOT: 'RECALLED_LOT',
  LOT_REQUIRED: 'LOT_REQUIRED',
  TRACKING_MODE_LOCKED: 'TRACKING_MODE_LOCKED',
  LOT_INVARIANT_VIOLATION: 'LOT_INVARIANT_VIOLATION',
  WRITER_NOT_LOT_AWARE: 'WRITER_NOT_LOT_AWARE',
  // Phase W2 — negative-stock policy
  NEGATIVE_CONFIRMATION_REQUIRED: 'NEGATIVE_CONFIRMATION_REQUIRED',
  NEGATIVE_LIMIT_EXCEEDED: 'NEGATIVE_LIMIT_EXCEEDED',
  REASON_REQUIRED: 'REASON_REQUIRED',
  ALLOW_REQUIRES_DEVELOPER: 'ALLOW_REQUIRES_DEVELOPER',
  MAKER_CHECKER_SELF_APPROVAL: 'MAKER_CHECKER_SELF_APPROVAL',
  POLICY_NOT_ALLOWED_FOR_TRACKED: 'POLICY_NOT_ALLOWED_FOR_TRACKED',
  // Phase W3 — purchase-receive linkage
  OVER_RECEIPT: 'OVER_RECEIPT',
  ALREADY_RECEIVED_IN_V2: 'ALREADY_RECEIVED_IN_V2',
  V2_RECEIPTS_LINKED: 'V2_RECEIPTS_LINKED',
  // Phase W4 — barcode
  BARCODE_TAKEN: 'BARCODE_TAKEN',
};

const HTTP_FOR = {
  VALIDATION_ERROR: 422,
  PERMISSION_DENIED: 403,
  WAREHOUSE_ACCESS_DENIED: 403,
  INVALID_STATE_TRANSITION: 422,
  INSUFFICIENT_STOCK: 422,
  QUANTITY_CONFLICT: 409,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  COST_REQUIRED: 422,
  GL_POSTING_FAILED: 500,
  // Phase 4B
  INSUFFICIENT_LOT_QUANTITY: 422,
  EXPIRED_LOT: 422,
  QUARANTINED_LOT: 422,
  RECALLED_LOT: 422,
  LOT_REQUIRED: 422,
  TRACKING_MODE_LOCKED: 422,
  LOT_INVARIANT_VIOLATION: 500,
  WRITER_NOT_LOT_AWARE: 422,
  // Phase W2
  NEGATIVE_CONFIRMATION_REQUIRED: 409,
  NEGATIVE_LIMIT_EXCEEDED: 422,
  REASON_REQUIRED: 422,
  ALLOW_REQUIRES_DEVELOPER: 403,
  MAKER_CHECKER_SELF_APPROVAL: 403,
  POLICY_NOT_ALLOWED_FOR_TRACKED: 422,
  // Phase W3
  OVER_RECEIPT: 422,
  ALREADY_RECEIVED_IN_V2: 409,
  V2_RECEIPTS_LINKED: 409,
  // Phase W4
  BARCODE_TAKEN: 409,
};

// Internal/legacy `.code` → canonical. Unknown falls back to VALIDATION_ERROR.
const ALIASES = {
  // state-machine guards
  INVALID_TRANSITION: CODES.INVALID_STATE_TRANSITION,
  NOT_DRAFT: CODES.INVALID_STATE_TRANSITION,
  NOT_APPROVED: CODES.INVALID_STATE_TRANSITION,
  NOT_POSTED: CODES.INVALID_STATE_TRANSITION,
  ALREADY_POSTED: CODES.INVALID_STATE_TRANSITION,
  CANNOT_CANCEL: CODES.INVALID_STATE_TRANSITION,
  CANNOT_REVERSE: CODES.INVALID_STATE_TRANSITION,
  CANNOT_DELETE: CODES.INVALID_STATE_TRANSITION,
  // validation
  NEGATIVE_QTY: CODES.VALIDATION_ERROR,
  ZERO_QTY: CODES.VALIDATION_ERROR,
  ITEMS_REQUIRED: CODES.VALIDATION_ERROR,
  ITEMS_ARRAY_EMPTY: CODES.VALIDATION_ERROR,
  DUPLICATE_ITEM: CODES.VALIDATION_ERROR,
  REASON_REQUIRED: CODES.VALIDATION_ERROR,
  EVIDENCE_REQUIRED: CODES.VALIDATION_ERROR,
  WAREHOUSE_NOT_FOUND: CODES.VALIDATION_ERROR,
  ITEM_NOT_FOUND: CODES.VALIDATION_ERROR,
  MAKER_CHECKER: CODES.PERMISSION_DENIED,
  // stock / cost
  INSUFFICIENT_STOCK: CODES.INSUFFICIENT_STOCK,
  COST_REQUIRED: CODES.COST_REQUIRED,
  // concurrency
  QUANTITY_CONFLICT: CODES.QUANTITY_CONFLICT,
  SNAPSHOT_STALE: CODES.QUANTITY_CONFLICT,
  state_changed: CODES.VERSION_CONFLICT,
  STATE_CHANGED: CODES.VERSION_CONFLICT,
  VERSION_CONFLICT: CODES.VERSION_CONFLICT,
  IDEMPOTENCY_CONFLICT: CODES.IDEMPOTENCY_CONFLICT,
  // gl
  GL_POSTING_FAILED: CODES.GL_POSTING_FAILED,
  GL_FAILED: CODES.GL_POSTING_FAILED,
  // access / role
  PERMISSION_DENIED: CODES.PERMISSION_DENIED,
  FORBIDDEN: CODES.PERMISSION_DENIED,
  WAREHOUSE_ACCESS_DENIED: CODES.WAREHOUSE_ACCESS_DENIED,
};

const STATUSES = ['draft', 'approved', 'posted', 'cancelled', 'reversed'];

function isCanonical(code) {
  return Object.prototype.hasOwnProperty.call(HTTP_FOR, String(code));
}

// Resolve any error/string/code to one of the 10 canonical codes.
function mapError(err) {
  if (!err) return CODES.VALIDATION_ERROR;
  const raw = typeof err === 'string' ? err : (err.code || err.canonicalCode || '');
  const key = String(raw);
  if (isCanonical(key)) return key;
  if (Object.prototype.hasOwnProperty.call(ALIASES, key)) return ALIASES[key];
  const msg = String((err && err.message) || err || '').toLowerCase();
  if (/insufficient|غير كاف|الرصيد المتاح|لا يكفي|الرصيد لا/.test(msg)) return CODES.INSUFFICIENT_STOCK;
  if (/snapshot|تغيّر الرصيد|تغير الرصيد|الكمية تغيّرت/.test(msg)) return CODES.QUANTITY_CONFLICT;
  if (/state.*chang|version|تغيّرت الحالة|تغيرت الحالة|الإصدار/.test(msg)) return CODES.VERSION_CONFLICT;
  if (/cost.*required|التكلفة مطلوبة|بلا تكلفة/.test(msg)) return CODES.COST_REQUIRED;
  if (/gl|قيد|journal|محاسب/.test(msg)) return CODES.GL_POSTING_FAILED;
  if (/permission|forbidden|صلاحية|الاعتماد الذاتي/.test(msg)) return CODES.PERMISSION_DENIED;
  if (/scope|access denied|الوصول|النطاق/.test(msg)) return CODES.WAREHOUSE_ACCESS_DENIED;
  return CODES.VALIDATION_ERROR;
}

function httpFor(code) {
  return HTTP_FOR[String(code)] || 422;
}

// Unified error body. Keeps a human `error` message (legacy clients read `error`).
function errorBody(code, message) {
  const canonical = isCanonical(code) ? code : mapError(code);
  return { success: false, code: canonical, error: String(message || canonical) };
}

// Unified mutation-success envelope (the contract, §7). Extends the transfer
// envelope with affectedValue / movementIds / journalId. Extra keys may be
// spread in by the caller.
function mutationEnvelope(parts) {
  const p = parts || {};
  return {
    success: true,
    data: p.data != null ? p.data : null,
    documentNumber: p.documentNumber != null ? String(p.documentNumber) : null,
    status: p.status != null ? String(p.status) : null,
    version: p.version != null ? Number(p.version) : null,
    affectedStock: Array.isArray(p.affectedStock) ? p.affectedStock : [],
    affectedValue: p.affectedValue != null ? Number(p.affectedValue) : 0,
    movementIds: Array.isArray(p.movementIds) ? p.movementIds : [],
    journalId: p.journalId != null ? String(p.journalId) : null,
    auditEvent: p.auditEvent != null ? p.auditEvent : null,
    warnings: Array.isArray(p.warnings) ? p.warnings : [],
  };
}

function _int(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

// Parse + clamp a list query. `sortWhitelist` (actual column names) makes sort
// injection-safe; `statuses` allow-lists the status filter.
function parseListQuery(query, sortWhitelist, statuses) {
  const q = query || {};
  const wl = Array.isArray(sortWhitelist) && sortWhitelist.length ? sortWhitelist : ['created_at'];
  const st = Array.isArray(statuses) && statuses.length ? statuses : STATUSES;
  let page = _int(q.page, 1); if (page < 1) page = 1;
  let pageSize = _int(q.pageSize, 25); if (pageSize < 1) pageSize = 1; if (pageSize > 200) pageSize = 200;
  const sort = wl.indexOf(String(q.sort)) !== -1 ? String(q.sort) : wl[0];
  const dir = String(q.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const status = st.indexOf(String(q.status)) !== -1 ? String(q.status) : '';
  const search = (q.q != null ? String(q.q) : '').trim().slice(0, 120);
  return {
    page, pageSize, offset: (page - 1) * pageSize, sort, dir, status,
    warehouseId: q.warehouseId ? String(q.warehouseId) : '',
    dateFrom: q.dateFrom ? String(q.dateFrom) : '',
    dateTo: q.dateTo ? String(q.dateTo) : '',
    q: search,
  };
}

module.exports = {
  CODES, HTTP_FOR, STATUSES,
  isCanonical, mapError, httpFor, errorBody, mutationEnvelope, parseListQuery,
};
