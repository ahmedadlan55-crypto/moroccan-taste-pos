'use strict';
/*
 * lib/itemUnits.js — DB-facing bridge between document routes and the pure
 * unit-conversion engine (lib/unitConversion.js).
 *
 * Every V2 document line may carry a unit selection. This module:
 *   • loads an item's item_units rows,
 *   • validates the chosen unit (exists / active / allowed for the context),
 *   • computes baseQty from enteredQty (single) or major+minor (composite),
 *   • RE-COMPUTES baseQty server-side and rejects a client mismatch
 *     (UNIT_CONVERSION_CONFLICT),
 *   • returns the frozen snapshot fields to persist on the *_items row.
 *
 * Backward-compatible: a line with NO unit info resolves to the base unit
 * (factor 1, baseQty = enteredQty), so legacy callers keep working unchanged.
 */
const U = require('./unitConversion');

function _err(code, message) { return Object.assign(new Error(message || code), { code }); }
const _num = (v) => (v == null || v === '' ? null : Number(v));

function _mapRow(r) {
  return {
    id: r.id, itemId: r.item_id, unitId: r.unit_id, unitName: r.unit_name, unitCode: r.unit_code,
    isBase: r.is_base === 1 || r.is_base === true, conversionToBase: Number(r.conversion_to_base),
    precision: Number(r.quantity_precision) || 2,
    allowPurchase: !!r.allow_purchase, allowReceipt: !!r.allow_receipt, allowIssue: !!r.allow_issue,
    allowTransfer: !!r.allow_transfer, allowStocktake: !!r.allow_stocktake,
    allowProduction: !!r.allow_production, allowSale: !!r.allow_sale,
    barcodeId: r.barcode_id, isActive: r.is_active === 1 || r.is_active === true, version: Number(r.version) || 1,
  };
}

async function loadUnits(conn, itemId) {
  const [rows] = await conn.query('SELECT * FROM item_units WHERE item_id=? ORDER BY is_base DESC, conversion_to_base ASC', [itemId]);
  return rows.map(_mapRow);
}

// Returns the base unit row for an item (or a synthetic one if none configured
// yet — treats the item as base-only, factor 1, so pre-migration items work).
async function baseUnit(conn, itemId, fallbackUnitName) {
  const units = await loadUnits(conn, itemId);
  const base = units.find((u) => u.isBase);
  if (base) return { base, units };
  const synthetic = { id: null, itemId, unitId: null, unitName: fallbackUnitName || '', unitCode: 'BASE', isBase: true, conversionToBase: 1, precision: 2, isActive: true };
  return { base: synthetic, units: [synthetic] };
}

/*
 * Resolve one document line to base units.
 * line may carry: { enteredUnitId | enteredUnitCode, enteredQty, majorQty, minorQty, baseQty }
 * context: 'receipt' | 'issue' | 'waste' | 'transfer' | 'stocktake' | 'adjustment' | 'production' | 'sale'
 * opts.allowUnset (default true): if no unit chosen, use base unit.
 * Returns { enteredQty, enteredUnitId, enteredUnitCode, unitName, conversionFactorSnapshot, baseQty }.
 */
async function resolveLineBase(conn, itemId, line, context, opts) {
  const o = opts || {};
  const { base, units } = await baseUnit(conn, itemId, o.fallbackUnitName);
  const wantId = line.enteredUnitId != null ? String(line.enteredUnitId) : null;
  const wantCode = line.enteredUnitCode != null ? String(line.enteredUnitCode).trim().toUpperCase() : null;

  let unit;
  if (wantId || wantCode) {
    unit = units.find((u) => (wantId && u.id === wantId) || (wantCode && String(u.unitCode).toUpperCase() === wantCode));
    if (!unit) throw _err('UNIT_REQUIRED', 'الوحدة المحددة غير موجودة لهذا الصنف');
    if (!U.isUnitAllowed(unit, context)) throw _err('UNIT_NOT_ALLOWED', 'الوحدة "' + unit.unitName + '" غير مسموحة في ' + context);
  } else {
    if (o.allowUnset === false) throw _err('UNIT_REQUIRED', 'الوحدة مطلوبة');
    unit = base; // default to base unit
  }

  const factor = Number(unit.conversionToBase);
  if (!U.isValidFactor(factor)) throw _err('INVALID_CONVERSION_FACTOR', 'عامل تحويل غير صالح للوحدة');

  // composite (major+minor) — only when the caller supplied a major/minor pair
  const hasComposite = line.majorQty != null || line.minorQty != null;
  let enteredQty, computedBase;
  if (hasComposite) {
    const maj = _num(line.majorQty) || 0;
    const min = _num(line.minorQty) || 0;
    computedBase = U.compositeToBase(maj, min, factor, base.precision);
    enteredQty = maj; // display quantity in the major unit; minor tracked separately
  } else {
    enteredQty = _num(line.enteredQty != null ? line.enteredQty : line.qty);
    if (enteredQty == null || !Number.isFinite(enteredQty)) throw _err('VALIDATION_ERROR', 'كمية غير صحيحة');
    computedBase = U.toBase(enteredQty, factor, base.precision);
  }

  // server is the source of truth: if the client sent baseQty, it MUST match.
  const clientBase = _num(line.baseQty);
  if (clientBase != null && U.round(clientBase, U.MAX_PRECISION) !== U.round(computedBase, U.MAX_PRECISION)) {
    throw _err('UNIT_CONVERSION_CONFLICT', 'baseQty المُرسل (' + clientBase + ') لا يساوي المحسوب (' + computedBase + ')');
  }

  return {
    enteredQty: hasComposite ? U.compositeToBase(_num(line.majorQty) || 0, _num(line.minorQty) || 0, factor, base.precision) / factor : enteredQty,
    enteredUnitId: unit.id,
    enteredUnitCode: unit.unitCode,
    unitName: unit.unitName,
    conversionFactorSnapshot: factor,
    baseQty: computedBase,
    isBase: unit.isBase,
    majorMinor: hasComposite ? { major: _num(line.majorQty) || 0, minor: _num(line.minorQty) || 0 } : null,
  };
}

// Has this item any posted movement? Used to lock unit-factor edits after history.
async function itemHasMovements(conn, itemId) {
  const [r] = await conn.query('SELECT 1 FROM inventory_movements WHERE item_id=? LIMIT 1', [itemId]);
  if (r.length) return true;
  const [r2] = await conn.query('SELECT 1 FROM inventory_lot_movements WHERE item_id=? LIMIT 1', [itemId]).catch(() => [[]]);
  return r2.length > 0;
}

module.exports = { loadUnits, baseUnit, resolveLineBase, itemHasMovements, _mapRow };
