'use strict';

// ─── settings: canonical keys + tolerant reads ──────────────────────────────
//
// `settings` is a flat setting_key → setting_value table that grew TWO spellings
// for the same fact. The receipt/ZATCA path reads PascalCase ('CompanyName',
// 'TaxNumber'); the React admin wrote camelCase ('name', 'taxNumber'). Those are
// different rows, so editing the tax number in the React admin never reached a
// printed invoice or its ZATCA QR — silently, with a success toast. The legacy
// settings page avoided the bug only because it dual-wrote both spellings.
//
// Values also disagreed on how a boolean looks: React wrote "true"/"false" while
// readers compared against '1'/'0', so NewProductsTaxInclusive failed OPEN and
// RequireManagerApprovalForVoid failed CLOSED.
//
// Fix: every write goes through normalizeSettingsWrite() (fans a value out to the
// canonical key AND its aliases, so no reader is left behind), and every boolean
// read goes through isTruthy() (accepts either spelling). Aliases are still
// written — not just read — because legacy pages and older rows persist.

/** alias → canonical key. */
const CANONICAL_OF = Object.freeze({
  name: 'CompanyName',
  taxNumber: 'TaxNumber',
  companyPhone: 'CompanyPhone',
  companyEmail: 'CompanyEmail',
  currency: 'Currency',
  CompanyLogo: 'logo',
});

/** canonical key → aliases kept in sync on write. */
const ALIASES_OF = Object.freeze({
  CompanyName: ['name'],
  TaxNumber: ['taxNumber'],
  CompanyPhone: ['companyPhone'],
  CompanyEmail: ['companyEmail'],
  Currency: ['currency'],
  // routes/cash.js reads 'CompanyLogo'; every writer used 'logo'. Keep both.
  logo: ['CompanyLogo'],
});

/** Keys whose value is a boolean and must persist as '1'/'0'. */
const BOOLEAN_KEYS = Object.freeze(['NewProductsTaxInclusive', 'RequireManagerApprovalForVoid']);

/** Resolve any spelling to the key the receipt/ZATCA path reads. */
function canonicalKey(key) {
  return Object.prototype.hasOwnProperty.call(CANONICAL_OF, key) ? CANONICAL_OF[key] : key;
}

/**
 * The ONE boolean reading. Accepts '1'/'true'/'on'/'yes' (any case) plus real
 * booleans. Anything else — including '' and null — is false.
 */
function isTruthy(value) {
  if (typeof value === 'boolean') return value;
  const s = String(value == null ? '' : value).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on' || s === 'yes';
}

/** Persisted form of a boolean setting. */
function boolToSetting(value) {
  return isTruthy(value) ? '1' : '0';
}

/**
 * Expand a settings payload into the exact rows to persist: canonical key first,
 * then its aliases, with boolean keys coerced to '1'/'0'. A payload naming both a
 * canonical key and its alias resolves to one value (last write wins) rather than
 * to two rows that disagree.
 *
 * @param {Record<string, unknown>} payload
 * @returns {Array<[string, string]>} [key, value] pairs, aliases included
 */
function normalizeSettingsWrite(payload) {
  const resolved = new Map();
  for (const [rawKey, rawValue] of Object.entries(payload || {})) {
    const key = canonicalKey(rawKey);
    const value = BOOLEAN_KEYS.includes(key) ? boolToSetting(rawValue) : String(rawValue == null ? '' : rawValue);
    resolved.set(key, value);
  }

  const rows = [];
  for (const [key, value] of resolved) {
    rows.push([key, value]);
    for (const alias of ALIASES_OF[key] || []) {
      // Don't let an explicit alias in the same payload get clobbered by the
      // canonical fan-out — it already resolved to the same value above.
      rows.push([alias, value]);
    }
  }
  return rows;
}

module.exports = {
  CANONICAL_OF,
  ALIASES_OF,
  BOOLEAN_KEYS,
  canonicalKey,
  isTruthy,
  boolToSetting,
  normalizeSettingsWrite,
};
