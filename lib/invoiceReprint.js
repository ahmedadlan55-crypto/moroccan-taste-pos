'use strict';

/**
 * Historical sale-line adapter for invoice reprints.
 *
 * `sales.items_json` is the checkout snapshot. It retains details that the
 * legacy `sales_items` projection never stored (unit, notes, tax category,
 * tax-inclusive convention and entered/base quantities). A reprint therefore
 * prefers it, falling back to `sales_items` only for old/corrupt sales.
 */

function _finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function _text(value) {
  return value == null ? null : String(value);
}

function parseItemsSnapshot(raw) {
  if (raw == null || raw === '') return null;
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(value) && value.length ? value : null;
  } catch (_) {
    return null;
  }
}

function historicalInvoiceItems(rawItemsJson, salesItems, lineIdByOrdinal) {
  const snapshot = parseItemsSnapshot(rawItemsJson);
  const fallbackRows = Array.isArray(salesItems) ? salesItems : [];
  const source = snapshot || fallbackRows;

  return source.map((raw, idx) => {
    const fallback = fallbackRows[idx] || {};
    const qty = _finite(raw.qty ?? raw.enteredQty ?? fallback.qty) ?? 0;
    const baseQty = _finite(raw.baseQty);
    const price = _finite(raw.price ?? raw.unitPrice ?? fallback.price) ?? 0;
    const storedTotal = _finite(raw.total ?? raw.lineTotalGross ?? fallback.total);
    const line = {
      name: _text(raw.name ?? raw.itemName ?? raw.nameSnapshot ?? fallback.item_name) || '',
      qty,
      price,
      total: storedTotal == null ? Math.round(qty * price * 100) / 100 : storedTotal,
      lineId: lineIdByOrdinal && lineIdByOrdinal[idx] != null ? lineIdByOrdinal[idx] : null,
    };

    // Optional fields are copied only when they were actually captured. Never
    // manufacture missing historical detail from today's catalog.
    const optional = {
      lineDiscount: _finite(raw.lineDiscount ?? raw.line_discount),
      vatCategory: _text(raw.vatCategory ?? raw.vat_category),
      taxInclusive: typeof raw.taxInclusive === 'boolean' ? raw.taxInclusive : null,
      notes: _text(raw.notes),
      enteredUnitId: _text(raw.enteredUnitId ?? raw.entered_unit_id),
      enteredUnitCode: _text(raw.enteredUnitCode ?? raw.entered_unit_code),
      enteredUnitName: _text(raw.enteredUnitName ?? raw.entered_unit_name),
      enteredQty: _finite(raw.enteredQty ?? raw.entered_qty),
      conversionFactorSnapshot: _finite(raw.conversionFactorSnapshot ?? raw.conversion_factor_snapshot),
      baseQty,
    };
    for (const [key, value] of Object.entries(optional)) {
      if (value !== null) line[key] = value;
    }
    return line;
  });
}

module.exports = { parseItemsSnapshot, historicalInvoiceItems };
