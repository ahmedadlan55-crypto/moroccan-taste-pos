/**
 * CSV export — Phase 2B (read-only reports). Pure; no I/O.
 *
 * - UTF-8 BOM so Excel opens Arabic correctly.
 * - RFC-4180 quoting (wrap on comma/quote/CR/LF; inner quotes doubled).
 * - Formula-injection hardening: a cell that Excel/Sheets would treat as a
 *   formula (leading = + @ tab CR, or a leading - that isn't a plain number)
 *   is prefixed with a single quote so it renders as literal text.
 * - MAX_EXPORT_ROWS cap → throws EXPORT_LIMIT with a clear Arabic message.
 *
 * Shared by the report /export endpoints; tested in tests/csvExport.test.js.
 */
'use strict';

const BOM = '﻿';
const MAX_EXPORT_ROWS = 50000;

// Neutralize formula-trigger cells. Keep legitimate negative numbers intact
// (a report routinely shows negative variance / negative stock).
function sanitizeCell(value) {
  const s = value == null ? '' : String(value);
  if (s === '') return s;
  if (/^[=+@\t\r]/.test(s)) return "'" + s;
  if (s[0] === '-' && !/^-?\d+(\.\d+)?$/.test(s)) return "'" + s;
  return s;
}

function quoteCell(value) {
  const s = sanitizeCell(value);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsvRow(fields) {
  return (fields || []).map(quoteCell).join(',');
}

// headers: string[]; rows: Array<Array<any>>. Returns a full CSV string.
function toCsv(headers, rows, opts) {
  const o = opts || {};
  const body = rows || [];
  if (body.length > MAX_EXPORT_ROWS) {
    const e = new Error('تجاوز التصدير الحد الأقصى (' + MAX_EXPORT_ROWS + ' صف). ضيّق الفلاتر ثم أعد المحاولة.');
    e.code = 'EXPORT_LIMIT';
    throw e;
  }
  const lines = [toCsvRow(headers || [])];
  for (const r of body) lines.push(toCsvRow(r));
  return (o.bom === false ? '' : BOM) + lines.join('\r\n') + '\r\n';
}

module.exports = { toCsv, toCsvRow, sanitizeCell, quoteCell, BOM, MAX_EXPORT_ROWS };
