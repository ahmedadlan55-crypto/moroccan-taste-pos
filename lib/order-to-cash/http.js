/**
 * lib/order-to-cash/http.js — shared Express helpers for /api/order-to-cash.
 * Envelope + error mapping, idempotency / version / actor extraction, safe list
 * query parsing (allow-listed sort), and CSV export (BOM + formula-injection
 * guard + row cap). Actor/approver are ALWAYS derived from the JWT — never the body.
 */
'use strict';

const crypto = require('crypto');
const E = require('./errors');

function actorOf(req) {
  return (req.user && (req.user.username || req.user.name)) || '';
}
function actorIdOf(req) {
  return (req.user && (req.user.id != null ? req.user.id : req.user.userId)) || null;
}
function idemOf(req) {
  return String(req.headers['idempotency-key'] || (req.body && req.body.idempotencyKey) || '').trim() || null;
}
function expectedVersionOf(req) {
  const v = req.headers['if-match'] != null ? req.headers['if-match'] : (req.body && req.body.expectedVersion);
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── request fingerprint ─────────────────────────────────────────────────────
// Key-order-independent stringify, so {a,b} and {b,a} — the same logical
// request serialized by two different clients — fingerprint identically.
// `idempotencyKey` itself is excluded: the key IDENTIFIES the request, the
// hash is over what the request DOES, and a client that moves the key from
// body to header must not change the fingerprint.
function _stable(v) {
  if (v === undefined || v === null) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(_stable).join(',') + ']';
  return '{' + Object.keys(v).sort()
    .filter((k) => v[k] !== undefined && k !== 'idempotencyKey')
    .map((k) => JSON.stringify(k) + ':' + _stable(v[k])).join(',') + '}';
}
/** sha256 fingerprint of the request body (stable across key order / key placement). */
function requestHashOf(req) {
  return crypto.createHash('sha256').update(_stable((req && req.body) || {})).digest('hex');
}

function sendOk(res, envelope, httpStatus = 200) {
  return res.status(httpStatus).json(E.ok(envelope));
}
function sendData(res, data, extra = {}, httpStatus = 200) {
  return res.status(httpStatus).json(Object.assign({ success: true, data, generatedAt: new Date().toISOString() }, extra));
}
function sendErr(res, e) {
  return E.sendError(res, e);
}

/** Parse a paginated list query with an allow-listed sort column. */
function listParams(req, sortWhitelist, statuses) {
  const p = E.parseListQuery(req.query, sortWhitelist, statuses);
  p.customerId = req.query.customerId ? String(req.query.customerId) : '';
  p.brandId = req.query.brandId ? String(req.query.brandId) : '';
  p.channelId = req.query.channelId ? String(req.query.channelId) : '';
  return p;
}

// ── CSV export ──────────────────────────────────────────────────────────────
const CSV_ROW_CAP = 50000;
function _csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // formula-injection guard
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function toCsv(rows, columns) {
  const capped = rows.slice(0, CSV_ROW_CAP);
  const head = columns.map((c) => _csvCell(c.label)).join(',');
  const body = capped.map((r) => columns.map((c) => _csvCell(r[c.key])).join(',')).join('\r\n');
  return '﻿' + head + '\r\n' + body + '\r\n';
}
function sendCsv(res, filename, rows, columns) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.status(200).send(toCsv(rows, columns));
}

/** Build ORDER BY from an allow-listed column map ({apiKey: 'sql_col'}). */
function orderBy(sortKey, dir, map, fallbackCol) {
  const col = map[sortKey] || fallbackCol || Object.values(map)[0];
  const d = String(dir).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  return `${col} ${d}`;
}

/** Branch/warehouse-scope fragment for a column (empty when enforcement is off). */
function scopeClause(req, column) {
  if (typeof req.whScopeClause === 'function') return req.whScopeClause(column);
  return { sql: '', params: [] };
}

module.exports = {
  actorOf, actorIdOf, idemOf, expectedVersionOf, requestHashOf,
  sendOk, sendData, sendErr, listParams,
  toCsv, sendCsv, orderBy, scopeClause, CSV_ROW_CAP,
};
