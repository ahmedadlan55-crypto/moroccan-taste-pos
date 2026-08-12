/**
 * lib/procurement/errors.js — canonical error codes + the unified success
 * envelope for the /api/procurement module.
 *
 * Builds on lib/inventoryTxContract.js (reusing its CODES / HTTP_FOR / mapError
 * / parseListQuery) and adds the procurement-specific codes from the spec (§10).
 * The success envelope matches the spec contract, extending the inventory one
 * with `journalIds` (array) and `affectedValue`.
 */
'use strict';

const base = require('../inventoryTxContract');
const crypto = require('crypto');

// Generic, user-safe message for unexpected/internal failures. NEVER leaks SQL,
// table names, stack traces, or connection details to the client.
const GENERIC_INTERNAL_AR = 'تعذّر إتمام العملية. أعد المحاولة، وإن استمرت المشكلة تواصل مع المسؤول.';

// Procurement-specific codes layered on top of the shared inventory codes.
const P_CODES = {
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  WAREHOUSE_ACCESS_DENIED: 'WAREHOUSE_ACCESS_DENIED',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  OVER_RECEIPT: 'OVER_RECEIPT',
  UNIT_CONVERSION_CONFLICT: 'UNIT_CONVERSION_CONFLICT',
  UNIT_LOCKED_BY_HISTORY: 'UNIT_LOCKED_BY_HISTORY',
  COST_REQUIRED: 'COST_REQUIRED',
  TAX_CONFIGURATION_ERROR: 'TAX_CONFIGURATION_ERROR',
  MATCHING_VARIANCE: 'MATCHING_VARIANCE',
  DUPLICATE_SUPPLIER_INVOICE: 'DUPLICATE_SUPPLIER_INVOICE',
  PAYMENT_OVER_ALLOCATION: 'PAYMENT_OVER_ALLOCATION',
  GL_POSTING_FAILED: 'GL_POSTING_FAILED',
  PERIOD_CLOSED: 'PERIOD_CLOSED',
  DOCUMENT_HAS_HISTORY: 'DOCUMENT_HAS_HISTORY',
  SUPPLIER_INACTIVE: 'SUPPLIER_INACTIVE',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  // account/period guards from lib/procurement/accounts.js
  PROC_ACCOUNT_MISSING: 'GL_POSTING_FAILED',
  PROC_GRNI_STRUCTURAL: 'GL_POSTING_FAILED',
  PROC_ACCOUNT_ROLE_REQUIRED: 'GL_POSTING_FAILED',
  PROC_ACCOUNT_ROLE_UNKNOWN: 'GL_POSTING_FAILED',
  PROC_ACCOUNT_COMPANY_REQUIRED: 'GL_POSTING_FAILED',
  PROC_ACCOUNT_ROLE_INVALID: 'GL_POSTING_FAILED',
  PROC_ACCOUNT_ROLE_TYPE_DRIFT: 'GL_POSTING_FAILED',
  PROC_ACCOUNT_ROLE_TAX_DRIFT: 'GL_POSTING_FAILED',
  PROC_ACCOUNT_ROLE_COLLISION: 'GL_POSTING_FAILED',
};

const P_HTTP = {
  PERMISSION_DENIED: 403,
  WAREHOUSE_ACCESS_DENIED: 403,
  INVALID_STATE_TRANSITION: 422,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  OVER_RECEIPT: 422,
  UNIT_CONVERSION_CONFLICT: 409,
  UNIT_LOCKED_BY_HISTORY: 409,
  COST_REQUIRED: 422,
  TAX_CONFIGURATION_ERROR: 422,
  MATCHING_VARIANCE: 422,
  DUPLICATE_SUPPLIER_INVOICE: 409,
  PAYMENT_OVER_ALLOCATION: 422,
  GL_POSTING_FAILED: 500,
  PERIOD_CLOSED: 422,
  DOCUMENT_HAS_HISTORY: 409,
  SUPPLIER_INACTIVE: 422,
  VALIDATION_ERROR: 422,
  NOT_FOUND: 404,
};

/** A domain error carrying a canonical code + optional details. */
class ProcurementError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.name = 'ProcurementError';
    this.code = P_CODES[code] || code;
    this.rawCode = code;
    this.details = details || null;
  }
}

function err(code, message, details) {
  return new ProcurementError(code, message, details);
}

function httpFor(code) {
  if (P_HTTP[code] != null) return P_HTTP[code];
  return base.httpFor(code);
}

/** Resolve any thrown error to { code, http, message }. */
function resolve(e) {
  if (e instanceof ProcurementError) {
    const code = P_CODES[e.rawCode] || e.code || 'VALIDATION_ERROR';
    return { code, http: httpFor(code), message: e.message, details: e.details };
  }
  // account errors (lib/procurement/accounts.js) carry .code
  if (e && e.code && P_CODES[e.code]) {
    const code = P_CODES[e.code];
    return { code, http: httpFor(code), message: e.message, details: null };
  }
  const code = base.mapError(e);
  return { code, http: httpFor(code), message: (e && e.message) || String(e), details: null };
}

/**
 * Is this an internal/unexpected error whose message must be sanitized before it
 * reaches the client? True for DB-driver / system / programming errors; false for
 * intentional domain errors (ProcurementError, account errors) whose Arabic
 * messages are safe to surface.
 */
function isInternalError(e) {
  if (!e || typeof e !== 'object') return false;
  if (e instanceof ProcurementError) return false;
  if (e.code && P_CODES[e.code]) return false;
  if (e.sqlMessage != null || e.errno != null || e.sqlState != null) return true; // mysql2 driver error
  const c = String(e.code || '');
  if (/^(ER_|PROTOCOL_|ECONN|ETIMEDOUT|ENOTFOUND|EPIPE|ENET)/i.test(c)) return true;
  if (e instanceof TypeError || e instanceof ReferenceError || e instanceof RangeError || e instanceof SyntaxError) return true;
  return false;
}

/** Unified error body written to the client. */
function errorBody(e) {
  const r = resolve(e);
  if (!isInternalError(e)) {
    return { body: { success: false, code: r.code, error: r.message, details: r.details || undefined }, http: r.http };
  }
  // Internal/unexpected error (e.g. a raw SQL error): log the full technical
  // detail server-side under a correlation id, and return ONLY a generic message
  // + that id to the client — no SQL, table names, stack traces or DSN.
  const correlationId = 'PROC-' + crypto.randomBytes(6).toString('hex');
  try {
    const parts = [`[procurement][${correlationId}] internal error http=500`, `msg=${(e && e.message) || String(e)}`];
    if (e && e.sqlMessage) parts.push(`sqlMessage=${e.sqlMessage}`);
    if (e && e.sql) parts.push(`sql=${String(e.sql).slice(0, 500)}`);
    if (e && e.errno != null) parts.push(`errno=${e.errno}`);
    if (e && e.code) parts.push(`code=${e.code}`);
    console.error(parts.join(' | '));
    if (e && e.stack) console.error(e.stack);
  } catch (_) { /* logging must never throw */ }
  return { body: { success: false, code: 'INTERNAL_ERROR', error: GENERIC_INTERNAL_AR, correlationId }, http: 500 };
}

/** Unified success envelope (spec §10). */
function ok(parts) {
  const p = parts || {};
  return {
    success: true,
    data: p.data != null ? p.data : null,
    documentNumber: p.documentNumber != null ? String(p.documentNumber) : null,
    status: p.status != null ? String(p.status) : null,
    version: p.version != null ? Number(p.version) : null,
    affectedStock: Array.isArray(p.affectedStock) ? p.affectedStock : [],
    affectedValue: p.affectedValue != null ? Number(p.affectedValue) : 0,
    journalIds: Array.isArray(p.journalIds) ? p.journalIds : (p.journalId ? [String(p.journalId)] : []),
    auditEvent: p.auditEvent != null ? p.auditEvent : null,
    warnings: Array.isArray(p.warnings) ? p.warnings : [],
  };
}

/** Express helper: send a resolved error. */
function sendError(res, e) {
  const { body, http } = errorBody(e);
  return res.status(http).json(body);
}

module.exports = {
  ProcurementError, err, ok, errorBody, sendError, resolve, httpFor, isInternalError,
  CODES: Object.assign({}, base.CODES, P_CODES),
  parseListQuery: base.parseListQuery,
};
