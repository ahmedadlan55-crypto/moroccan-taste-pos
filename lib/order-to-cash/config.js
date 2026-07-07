/**
 * lib/order-to-cash/config.js — runtime config reads for Order-to-Cash.
 */
'use strict';

let _vatCache = null;
let _vatAt = 0;

/** Standard VAT rate from settings.VATRate (default 15), cached 60s. */
async function standardVatRate(db) {
  const now = Date.now();
  if (_vatCache != null && now - _vatAt < 60000) return _vatCache;
  try {
    const [rows] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'VATRate' LIMIT 1");
    const v = rows.length ? Number(rows[0].setting_value) : 15;
    _vatCache = Number.isFinite(v) ? v : 15;
  } catch (_) {
    _vatCache = 15;
  }
  _vatAt = now;
  return _vatCache;
}

function o2cEnabled() {
  return /^(1|true|on|yes)$/i.test(String(process.env.ORDER_TO_CASH_ENABLE || '').trim());
}

/** Maker–Checker for large collections / reversals (default ON). */
function makerCheckerEnabled() {
  return /^(1|true|on|yes)$/i.test(String(process.env.O2C_MAKER_CHECKER || '1').trim());
}

/** Collection/reversal amount above which Maker–Checker is required. */
function makerCheckerThreshold() {
  const v = Number(process.env.O2C_MAKER_CHECKER_THRESHOLD);
  return Number.isFinite(v) && v > 0 ? v : 10000;
}

module.exports = { standardVatRate, o2cEnabled, makerCheckerEnabled, makerCheckerThreshold };
