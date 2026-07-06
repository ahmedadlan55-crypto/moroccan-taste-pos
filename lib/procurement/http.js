/**
 * lib/procurement/http.js — shared Express helpers for /api/procurement.
 * Envelope + error mapping, idempotency / version / actor extraction, safe list
 * query parsing (allow-listed sort), and CSV export (BOM + formula-injection
 * guard + row cap).
 */
'use strict';

const E = require('./errors');

function actorOf(req) {
  return (req.user && (req.user.username || req.user.name)) || '';
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

function sendOk(res, envelope, httpStatus = 200) {
  return res.status(httpStatus).json(E.ok(envelope));
}
function sendData(res, data, extra = {}, httpStatus = 200) {
  return res.status(httpStatus).json(Object.assign({ success: true, data }, extra));
}
function sendErr(res, e) {
  return E.sendError(res, e);
}

/** Parse a paginated list query with an allow-listed sort column. */
function listParams(req, sortWhitelist, statuses) {
  const p = E.parseListQuery(req.query, sortWhitelist, statuses);
  p.supplierId = req.query.supplierId ? String(req.query.supplierId) : '';
  p.brandId = req.query.brandId ? String(req.query.brandId) : '';
  return p;
}

// ── CSV export ──────────────────────────────────────────────────────────────
const CSV_ROW_CAP = 50000;
function _csvCell(v) {
  let s = v == null ? '' : String(v);
  // formula-injection guard: neutralize leading = + - @ (and tab/CR)
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
/**
 * @param {Array} rows
 * @param {Array<{key,label}>} columns
 * @returns {string} CSV text with UTF-8 BOM
 */
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

/** Warehouse-scope fragment for a column (empty when enforcement is off). */
function scopeClause(req, column) {
  if (typeof req.whScopeClause === 'function') return req.whScopeClause(column);
  return { sql: '', params: [] };
}

module.exports = {
  actorOf, idemOf, expectedVersionOf,
  sendOk, sendData, sendErr, listParams,
  toCsv, sendCsv, orderBy, scopeClause, CSV_ROW_CAP,
};
