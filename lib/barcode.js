'use strict';
/**
 * ─── Barcode normalization + validation (Phase W4) ──────────────────────────
 *
 * A single source of truth for how a scanned/typed code is normalized before
 * it is stored or looked up. SKU is a SEPARATE identity and is NEVER touched
 * by this module.
 *
 *   normalize('  abc-123 ') → 'ABC-123'   (trim, upper, strip inner whitespace)
 *
 * Uniqueness is enforced at the DB level (UNIQUE on the normalized column);
 * this module only produces the canonical form + a light validity check.
 */

function normalize(code) {
  if (code == null) return '';
  return String(code).trim().toUpperCase().replace(/\s+/g, '');
}

// A valid barcode after normalization: 3–80 chars, no ASCII control chars.
// We deliberately DO NOT restrict to digits — the system stores GTIN/EAN/UPC
// as well as internal alphanumeric codes and size labels.
function isValid(code) {
  const n = normalize(code);
  if (n.length < 3 || n.length > 80) return false;
  for (let i = 0; i < n.length; i++) { const c = n.charCodeAt(i); if (c < 0x20 || c === 0x7f) return false; }
  return true;
}

// Validate + normalize or throw a coded error (used by the write routes).
function requireValid(code) {
  const n = normalize(code);
  if (!isValid(n)) { const e = new Error('باركود غير صالح (3–80 حرفًا بلا رموز تحكم)'); e.code = 'VALIDATION_ERROR'; throw e; }
  return n;
}

module.exports = { normalize, isValid, requireValid };
