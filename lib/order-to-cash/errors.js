/**
 * lib/order-to-cash/errors.js — canonical O2C error codes (spec §14) + the
 * unified success envelope. Builds on lib/inventoryTxContract (parseListQuery /
 * mapError / CODES). Internal/DB errors are sanitized before reaching the client
 * (never leaks SQL / table names / stack traces / DSN) — a generic Arabic message
 * + a correlation id, with the full detail logged server-side.
 */
'use strict';

const base = require('../inventoryTxContract');
const crypto = require('crypto');

const GENERIC_INTERNAL_AR = 'تعذّر إتمام العملية. أعد المحاولة، وإن استمرت المشكلة تواصل مع المسؤول.';

const O_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  SCOPE_ACCESS_DENIED: 'SCOPE_ACCESS_DENIED',
  CUSTOMER_REQUIRED: 'CUSTOMER_REQUIRED',
  CUSTOMER_INACTIVE: 'CUSTOMER_INACTIVE',
  CREDIT_LIMIT_EXCEEDED: 'CREDIT_LIMIT_EXCEEDED',
  CREDIT_APPROVAL_REQUIRED: 'CREDIT_APPROVAL_REQUIRED',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  INVOICE_IMMUTABLE: 'INVOICE_IMMUTABLE',
  OVER_ALLOCATION: 'OVER_ALLOCATION',
  OVER_RETURN: 'OVER_RETURN',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  // Same Idempotency-Key presented with a DIFFERENT payload. Distinct from
  // IDEMPOTENCY_CONFLICT (a concurrent same-operation race): reuse means the
  // client is trying to make the key mean two different things, and neither
  // replaying the first result nor running the second request is safe.
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  // Separation of duties: the actor holds the capability but is the document's
  // own creator. Distinct from PERMISSION_DENIED so the UI can say WHY — "you
  // raised this one, someone else must approve it" — instead of implying the
  // manager lacks the right, which they do not.
  SOD_VIOLATION: 'SOD_VIOLATION',
  PERIOD_CLOSED: 'PERIOD_CLOSED',
  ZATCA_POSTING_FAILED: 'ZATCA_POSTING_FAILED',
  GL_POSTING_FAILED: 'GL_POSTING_FAILED',
  STOCK_POSTING_FAILED: 'STOCK_POSTING_FAILED',
  UNIT_CONVERSION_CONFLICT: 'UNIT_CONVERSION_CONFLICT',
  CUSTOMER_DUPLICATE: 'CUSTOMER_DUPLICATE',
  PAYMENT_NOT_ALLOCATABLE: 'PAYMENT_NOT_ALLOCATABLE',
  RETURN_ALREADY_POSTED: 'RETURN_ALREADY_POSTED',
  NOT_FOUND: 'NOT_FOUND',
  // account guards from lib/order-to-cash/accounts.js
  O2C_ACCOUNT_MISSING: 'GL_POSTING_FAILED',
  O2C_ACCOUNT_STRUCTURAL: 'GL_POSTING_FAILED',
};

const O_HTTP = {
  VALIDATION_ERROR: 422,
  PERMISSION_DENIED: 403,
  SCOPE_ACCESS_DENIED: 403,
  CUSTOMER_REQUIRED: 422,
  CUSTOMER_INACTIVE: 422,
  CREDIT_LIMIT_EXCEEDED: 422,
  CREDIT_APPROVAL_REQUIRED: 422,
  INVALID_STATE_TRANSITION: 422,
  INVOICE_IMMUTABLE: 409,
  OVER_ALLOCATION: 422,
  OVER_RETURN: 422,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  SOD_VIOLATION: 403,
  PERIOD_CLOSED: 422,
  ZATCA_POSTING_FAILED: 502,
  GL_POSTING_FAILED: 500,
  STOCK_POSTING_FAILED: 500,
  UNIT_CONVERSION_CONFLICT: 409,
  CUSTOMER_DUPLICATE: 409,
  PAYMENT_NOT_ALLOCATABLE: 422,
  RETURN_ALREADY_POSTED: 409,
  NOT_FOUND: 404,
};

class OrderToCashError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.name = 'OrderToCashError';
    this.code = O_CODES[code] || code;
    this.rawCode = code;
    this.details = details || null;
  }
}

function err(code, message, details) {
  return new OrderToCashError(code, message, details);
}

function httpFor(code) {
  if (O_HTTP[code] != null) return O_HTTP[code];
  return base.httpFor(code);
}

function resolve(e) {
  if (e instanceof OrderToCashError) {
    const code = O_CODES[e.rawCode] || e.code || 'VALIDATION_ERROR';
    return { code, http: httpFor(code), message: e.message, details: e.details };
  }
  if (e && e.code && O_CODES[e.code]) {
    const code = O_CODES[e.code];
    return { code, http: httpFor(code), message: e.message, details: null };
  }
  const code = base.mapError(e);
  return { code, http: httpFor(code), message: (e && e.message) || String(e), details: null };
}

/** O2C success envelope (spec §14). */
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
    journalId: p.journalId != null ? p.journalId : (Array.isArray(p.journalIds) && p.journalIds.length ? p.journalIds[0] : null),
    auditEvent: p.auditEvent != null ? p.auditEvent : null,
    warnings: Array.isArray(p.warnings) ? p.warnings : [],
    generatedAt: new Date().toISOString(),
  };
}

/** True for DB-driver / system / programming errors that must be sanitized. */
function isInternalError(e) {
  if (!e || typeof e !== 'object') return false;
  if (e instanceof OrderToCashError) return false;
  if (e.code && O_CODES[e.code]) return false;
  if (e.sqlMessage != null || e.errno != null || e.sqlState != null) return true;
  const c = String(e.code || '');
  if (/^(ER_|PROTOCOL_|ECONN|ETIMEDOUT|ENOTFOUND|EPIPE|ENET)/i.test(c)) return true;
  if (e instanceof TypeError || e instanceof ReferenceError || e instanceof RangeError || e instanceof SyntaxError) return true;
  return false;
}

function errorBody(e) {
  const r = resolve(e);
  if (!isInternalError(e)) {
    return { body: { success: false, code: r.code, error: r.message, details: r.details || undefined }, http: r.http };
  }
  const correlationId = 'O2C-' + crypto.randomBytes(6).toString('hex');
  try {
    const parts = [`[order-to-cash][${correlationId}] internal error http=500`, `msg=${(e && e.message) || String(e)}`];
    if (e && e.sqlMessage) parts.push(`sqlMessage=${e.sqlMessage}`);
    if (e && e.sql) parts.push(`sql=${String(e.sql).slice(0, 500)}`);
    if (e && e.errno != null) parts.push(`errno=${e.errno}`);
    if (e && e.code) parts.push(`code=${e.code}`);
    console.error(parts.join(' | '));
    if (e && e.stack) console.error(e.stack);
  } catch (_) { /* logging must never throw */ }
  return { body: { success: false, code: 'INTERNAL_ERROR', error: GENERIC_INTERNAL_AR, correlationId }, http: 500 };
}

function sendError(res, e) {
  const { body, http } = errorBody(e);
  return res.status(http).json(body);
}

module.exports = {
  OrderToCashError, err, ok, errorBody, sendError, resolve, httpFor, isInternalError,
  CODES: Object.assign({}, base.CODES, O_CODES),
  parseListQuery: base.parseListQuery,
};
