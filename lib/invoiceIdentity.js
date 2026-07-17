'use strict';

// ─── invoice identity: scoped resolution + immutable historical snapshot ─────
//
// TWO problems this solves.
//
// 1. SCOPE. `settings` is a flat global key→value table, while `companies`
//    (legal_name, cr_number, tax_number, logo_url), `brands` (name, logo) and
//    `branches` (name, location, company_name) are a fully-built multi-tenant
//    identity model that NO receipt path ever read. Identity now resolves
//    branch → brand → company → global settings, most specific wins.
//
// 2. HISTORY. Every company/VAT/logo value on a receipt used to be resolved LIVE
//    at reprint time, so changing the tax number silently reprinted every
//    historical invoice with the new one — and regenerated its ZATCA QR from it.
//    A tax document must not mutate after issue. resolveIdentity() is therefore
//    snapshotted at checkout and the reprint reads the snapshot.
//
// The snapshot is CONTENT-ADDRESSED rather than copied onto each sale row: the
// logo alone is a base64 data-URL (tens of KB), so a per-sale copy would add
// ~50KB × every invoice ever. Identical identity → one shared row keyed by the
// hash of its canonical JSON. Changing the logo mints a new row; existing sales
// keep pointing at the old one. Storage is O(distinct identities), not O(sales).

const crypto = require('crypto');
const { isTruthy } = require('./settingsKeys');

/** Receipt-facing settings keys, canonical spelling (see lib/settingsKeys). */
const RECEIPT_SETTING_KEYS = Object.freeze([
  'CompanyName', 'TaxNumber', 'Currency', 'CompanyPhone', 'CompanyEmail', 'logo',
  'VATRate', 'SalesTaxName',
  // Added in v4 — the receipt had no configurable header/footer/thank-you at all
  // and no national address or CR anywhere on it.
  'ReceiptHeader', 'receiptFooter', 'ReceiptThankYou', 'ReceiptReturnPolicy',
  'NationalAddress', 'CrNumber', 'ReceiptLanguage', 'ReceiptShowFields',
  // Print preferences (paper size / auto-print). Settings-layer only: no
  // branch/brand column exists for them, and that is deliberate — they are
  // hardware preferences, not seller identity.
  'ReceiptPaperWidth', 'ReceiptAutoPrint',
]);

/** Paper widths the receipt renderer can honestly lay out. */
const PAPER_WIDTHS = Object.freeze(['58', '80', 'A4']);

/**
 * Normalize the two print-preference settings into the shape the POS catalog
 * ships: { paperWidth: '58'|'80'|'A4', autoPrint: '1'|'0' }.
 *
 * These are deliberately NOT part of the identity object: the identity is
 * content-addressed and frozen onto every issued invoice (a tax document must
 * not mutate), while paper width is a property of the printer a reprint runs
 * on TODAY. Folding it into the snapshot would both churn the hash on every
 * preference flip and pin old invoices to a paper size the shop may no longer
 * own.
 */
function normalizeReceiptSettings(rawPaperWidth, rawAutoPrint) {
  const pw = String(rawPaperWidth == null ? '' : rawPaperWidth).trim();
  const paperWidth = PAPER_WIDTHS.includes(pw) ? pw : '80';
  // Default ON when unset: auto-print has been the de-facto behaviour, so an
  // absent row must not silently turn it off.
  const autoPrint = (rawAutoPrint == null || String(rawAutoPrint).trim() === '')
    ? '1'
    : (isTruthy(rawAutoPrint) ? '1' : '0');
  return { paperWidth, autoPrint };
}

/** The shape a receipt renders. Every field has ONE resolved value + a source. */
function emptyIdentity() {
  return {
    sellerName: '', legalName: '', taxNumber: '', crNumber: '',
    address: '', nationalAddress: '', phone: '', email: '',
    logo: '', currency: 'SAR', vatRate: 15, salesTaxName: '',
    header: '', footer: '', thankYou: '', returnPolicy: '',
    language: 'ar',
    branchName: '', branchCompanyName: '', brandName: '',
  };
}

/**
 * Resolve the effective identity for a sale's scope.
 *
 * @param {object} db      db/connection (injected so this module opens no pool)
 * @param {object} scope   { branchId, brandId }
 * @returns {Promise<{identity: object, sources: Record<string,string>, receiptSettings: {paperWidth: string, autoPrint: string}}>}
 *          `sources` names where each field came from — the invoice-settings
 *          screen shows it, and it makes a wrong value diagnosable instead of
 *          mysterious. `receiptSettings` rides along as a SEPARATE member so it
 *          never enters the content-addressed identity snapshot (see
 *          normalizeReceiptSettings for why).
 */
async function resolveIdentity(db, scope) {
  const id = emptyIdentity();
  const sources = {};
  const set = (field, value, source) => {
    if (value === null || value === undefined || value === '') return;
    id[field] = value;
    sources[field] = source;
  };

  // ── layer 1 (weakest): global settings ──
  let settings = {};
  try {
    const [rows] = await db.query(
      `SELECT setting_key, setting_value FROM settings WHERE setting_key IN (${RECEIPT_SETTING_KEYS.map(() => '?').join(',')})`,
      RECEIPT_SETTING_KEYS
    );
    rows.forEach((r) => { settings[r.setting_key] = r.setting_value; });
  } catch (_) { /* settings table missing → defaults */ }

  set('sellerName', settings.CompanyName, 'settings.CompanyName');
  set('taxNumber', settings.TaxNumber, 'settings.TaxNumber');
  set('crNumber', settings.CrNumber, 'settings.CrNumber');
  set('nationalAddress', settings.NationalAddress, 'settings.NationalAddress');
  set('phone', settings.CompanyPhone, 'settings.CompanyPhone');
  set('email', settings.CompanyEmail, 'settings.CompanyEmail');
  set('logo', settings.logo, 'settings.logo');
  set('currency', settings.Currency, 'settings.Currency');
  set('salesTaxName', settings.SalesTaxName, 'settings.SalesTaxName');
  set('header', settings.ReceiptHeader, 'settings.ReceiptHeader');
  set('footer', settings.receiptFooter, 'settings.receiptFooter');
  set('thankYou', settings.ReceiptThankYou, 'settings.ReceiptThankYou');
  set('returnPolicy', settings.ReceiptReturnPolicy, 'settings.ReceiptReturnPolicy');
  set('language', settings.ReceiptLanguage, 'settings.ReceiptLanguage');
  if (settings.VATRate != null && settings.VATRate !== '') {
    const n = Number(settings.VATRate);
    if (Number.isFinite(n)) set('vatRate', n, 'settings.VATRate');
  }

  // Print preferences — resolved here (settings layer, global-only) but kept
  // OUT of `id` so they never enter the immutable snapshot or its hash.
  const receiptSettings = normalizeReceiptSettings(settings.ReceiptPaperWidth, settings.ReceiptAutoPrint);
  if (settings.ReceiptPaperWidth != null && settings.ReceiptPaperWidth !== '') sources.paperWidth = 'settings.ReceiptPaperWidth';
  if (settings.ReceiptAutoPrint != null && settings.ReceiptAutoPrint !== '') sources.autoPrint = 'settings.ReceiptAutoPrint';

  // ── layer 2: company (via the branch's company_id) ──
  let companyId = null;
  let branch = null;
  if (scope && scope.branchId) {
    try {
      const [b] = await db.query(
        'SELECT id, name, location, company_name, company_id FROM branches WHERE id = ? LIMIT 1',
        [scope.branchId]
      );
      if (b.length) branch = b[0];
    } catch (_) { /* older schema without these columns */ }
  }
  if (branch) companyId = branch.company_id || null;

  if (companyId) {
    try {
      const [c] = await db.query(
        'SELECT name, legal_name, cr_number, tax_number, city, base_currency, logo_url FROM companies WHERE id = ? LIMIT 1',
        [companyId]
      );
      if (c.length) {
        const co = c[0];
        set('sellerName', co.name, 'companies.name');
        set('legalName', co.legal_name, 'companies.legal_name');
        // The CR number has existed on companies since day one and was never
        // printed on a single receipt.
        set('crNumber', co.cr_number, 'companies.cr_number');
        set('taxNumber', co.tax_number, 'companies.tax_number');
        set('currency', co.base_currency, 'companies.base_currency');
        set('logo', co.logo_url, 'companies.logo_url');
      }
    } catch (_) { /* companies table missing */ }
  }

  // ── layer 3: brand (its logo/name override the company's) ──
  if (scope && scope.brandId) {
    try {
      const [br] = await db.query('SELECT name, logo FROM brands WHERE id = ? LIMIT 1', [scope.brandId]);
      if (br.length) {
        set('brandName', br[0].name, 'brands.name');
        set('logo', br[0].logo, 'brands.logo');
      }
    } catch (_) { /* brands table missing */ }
  }

  // ── layer 4 (strongest): branch ──
  if (branch) {
    set('branchName', branch.name, 'branches.name');
    set('address', branch.location, 'branches.location');
    set('branchCompanyName', branch.company_name, 'branches.company_name');
  }

  return { identity: id, sources, receiptSettings };
}

/**
 * Stable JSON for hashing: keys sorted so an identical identity always hashes
 * the same regardless of property insertion order.
 */
function canonicalJson(identity) {
  const keys = Object.keys(identity).sort();
  const ordered = {};
  for (const k of keys) ordered[k] = identity[k];
  return JSON.stringify(ordered);
}

/** Content address of an identity (its primary key in receipt_identities). */
function identityHash(identity) {
  return crypto.createHash('sha256').update(canonicalJson(identity)).digest('hex').slice(0, 40);
}

/**
 * Persist an identity (idempotent) and return its hash id. Safe to call on every
 * checkout: the INSERT is IGNORE-on-duplicate, so a stable identity writes one
 * row for the life of the install.
 */
async function snapshotIdentity(db, identity) {
  const hash = identityHash(identity);
  await db.query(
    'INSERT IGNORE INTO receipt_identities (id, payload_json) VALUES (?, ?)',
    [hash, canonicalJson(identity)]
  );
  return hash;
}

/**
 * Read a snapshot back. Returns null when the id is unknown or the row is
 * unreadable — callers fall back to a live resolve so invoices issued BEFORE
 * this feature still print (they simply carry no snapshot).
 */
async function loadIdentity(db, id) {
  if (!id) return null;
  try {
    const [rows] = await db.query('SELECT payload_json FROM receipt_identities WHERE id = ? LIMIT 1', [id]);
    if (!rows.length) return null;
    return { ...emptyIdentity(), ...JSON.parse(rows[0].payload_json) };
  } catch (_) {
    return null;
  }
}

/** Which optional receipt fields to render (settings.ReceiptShowFields JSON). */
function showFields(raw) {
  const defaults = { logo: true, taxNumber: true, crNumber: true, nationalAddress: true, phone: true, email: true, cashier: true, customer: true, qr: true };
  if (!raw) return defaults;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const out = { ...defaults };
    for (const k of Object.keys(defaults)) {
      if (parsed && Object.prototype.hasOwnProperty.call(parsed, k)) out[k] = isTruthy(parsed[k]);
    }
    return out;
  } catch (_) {
    return defaults;
  }
}

module.exports = {
  RECEIPT_SETTING_KEYS,
  PAPER_WIDTHS,
  normalizeReceiptSettings,
  emptyIdentity,
  resolveIdentity,
  canonicalJson,
  identityHash,
  snapshotIdentity,
  loadIdentity,
  showFields,
};
