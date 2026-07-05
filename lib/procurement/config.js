/**
 * lib/procurement/config.js — small runtime config reads for procurement.
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

function makerCheckerEnabled() {
  const v = String(process.env.PROCUREMENT_MAKER_CHECKER || '1').toLowerCase();
  return /^(1|true|on|yes)$/.test(v);
}

function p2pEnabled() {
  return /^(1|true|on|yes)$/i.test(String(process.env.PROCUREMENT_P2P_ENABLE || '').trim());
}

module.exports = { standardVatRate, makerCheckerEnabled, p2pEnabled };
