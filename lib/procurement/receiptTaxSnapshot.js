/**
 * Trusted tax snapshots for goods-receipt lines.
 *
 * A GRN is not a tax document, so a direct receipt has no authoritative tax
 * rate yet.  It deliberately stores NULL/NULL.  A PO-backed receipt copies the
 * immutable VAT fields from the matching PO line; values supplied by the HTTP
 * client are never consulted.
 */
'use strict';

const { err } = require('./errors');

const VALID_TAX_CODES = new Set(['S', 'S15', 'Z', 'E', 'O']);

function normalizeStoredTax(row) {
  const rawRate = row && row.vat_rate;
  const rawCode = row && row.tax_code;
  let vatRate = null;
  let taxCode = null;

  if (rawRate != null && rawRate !== '') {
    const numeric = Number(rawRate);
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) {
      throw err('TAX_CONFIGURATION_ERROR', 'نسبة الضريبة المخزنة في أمر الشراء غير صالحة');
    }
    vatRate = numeric;
  }
  if (rawCode != null && String(rawCode).trim()) {
    const normalized = String(rawCode).trim().toUpperCase();
    if (!VALID_TAX_CODES.has(normalized)) {
      throw err('TAX_CONFIGURATION_ERROR', 'رمز الضريبة المخزن في أمر الشراء غير صالح');
    }
    taxCode = normalized;
  }
  return { vat_rate: vatRate, tax_code: taxCode };
}

async function attachTrustedTaxSnapshots(conn, { poId, lines }) {
  const target = Array.isArray(lines) ? lines : [];
  const headerPoId = poId == null ? '' : String(poId).trim();
  const ids = [...new Set(target.map((line) => line.po_line_id).filter(Boolean).map(String))];

  // A direct receipt has no tax source until a supplier invoice arrives.
  // Explicit NULL also defeats the legacy table default of 15%.
  if (!headerPoId && ids.length === 0) {
    for (const line of target) Object.assign(line, { vat_rate: null, tax_code: null });
    return target;
  }
  if (!headerPoId) {
    throw err('VALIDATION_ERROR', 'سطر أمر الشراء يتطلب ربط الاستلام بأمر الشراء نفسه');
  }
  if (target.some((line) => !line.po_line_id)) {
    throw err('VALIDATION_ERROR', 'كل سطر استلام مرتبط بأمر شراء يجب أن يحدد سطر أمر الشراء');
  }

  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await conn.query(
    `SELECT id, po_id, item_id, vat_rate, tax_code
       FROM po_lines WHERE id IN (${placeholders})`, ids);
  const byId = new Map(rows.map((row) => [String(row.id), row]));

  for (const line of target) {
    const source = byId.get(String(line.po_line_id));
    if (!source) throw err('VALIDATION_ERROR', 'سطر أمر الشراء المرتبط بالاستلام غير موجود');
    if (String(source.po_id) !== headerPoId) {
      throw err('VALIDATION_ERROR', 'سطر الاستلام لا ينتمي إلى أمر الشراء المحدد');
    }
    if (line.item_id != null && source.item_id != null && String(line.item_id) !== String(source.item_id)) {
      throw err('VALIDATION_ERROR', 'الصنف في سطر الاستلام لا يطابق سطر أمر الشراء');
    }
    Object.assign(line, normalizeStoredTax(source));
  }
  return target;
}

module.exports = { VALID_TAX_CODES, normalizeStoredTax, attachTrustedTaxSnapshots };
