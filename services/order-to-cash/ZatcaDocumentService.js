/**
 * services/order-to-cash/ZatcaDocumentService.js — REAL ZATCA stamping for O2C
 * documents (spec §7). No mock, no fake "submitted" success.
 *
 *  - Every issued invoice / credit note gets a genuine UUID + hash-chain link +
 *    a Phase-1 TLV QR (lib/zatca.js — the same primitives the POS sale flow uses).
 *  - An issued document is IMMUTABLE; a correction is a NEW credit note that links
 *    to the original (original_document_id) — never an edit of the stamped invoice.
 *  - Status is honest: 'pending' until a real Phase-2 clearance/reporting call
 *    succeeds; 'not_required' for a fully out-of-scope document. It is NEVER set to
 *    'accepted'/'submitted' by this module — that only happens when a real gateway
 *    call returns success (integration point below), so a 0-integration deploy
 *    truthfully shows 'pending' rather than a green lie.
 *  - 0% / exempt / out-of-scope VAT stays 0 (the calculations layer guarantees it).
 */
'use strict';

const zatca = require('../../lib/zatca');
const calc = require('../../lib/order-to-cash/calculations');
const { err } = require('../../lib/order-to-cash/errors');

// One chain per EGS unit. A constant, not a company-id lookup: deriving the id
// at seed time AND at every read means any disagreement (renamed company row,
// fresh test DB) silently forks the chain — one variant per derived id.
const CHAIN_ID = 'o2c:default';
const GENESIS_HASH = '0'.repeat(64); // the repo's own genesis (lib/zatca.js chainHash)

async function _sellerFromSettings(conn) {
  const [rows] = await conn.query(
    "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('CompanyName','CompanyNameEn','VATNumber','VatNumber','TaxNumber')");
  const map = {};
  for (const r of rows) map[r.setting_key] = r.setting_value;
  return {
    name: map.CompanyName || map.CompanyNameEn || 'Establishment',
    vatNumber: map.VATNumber || map.VatNumber || map.TaxNumber || '',
  };
}

/**
 * The chain head, LOCKED. Replaces a MAX(created_at) scan over ar_documents
 * that failed three separate ways: created_at has 1-second resolution so two
 * same-second documents had no defined order (two such rows exist live);
 * FOR UPDATE over an EMPTY result set locks nothing, so the first two
 * documents ever could both compute the genesis previousHash even unraced;
 * and a bare catch(_) re-ran the query WITHOUT the lock — the exact
 * concurrency case the lock exists for — silently forking the chain. It also
 * made linkPosSale's copied legacy-sale hashes eligible chain heads.
 *
 * A dedicated, always-present row fixes all four by construction: INSERT
 * IGNORE self-heals a pre-seed DB, the SELECT ... FOR UPDATE is a real lock
 * even at genesis, there is no fallback (a lock error aborts the stamp and
 * withTransaction retries 1213/1205), and POS-copied hashes never touch it.
 *
 * REQUIRES a transaction connection: on an autocommit conn the row lock
 * releases at statement end and serializes nothing.
 */
async function _chainHead(conn) {
  await conn.query(
    'INSERT IGNORE INTO zatca_chain_state (chain_id, last_hash, last_icv) VALUES (?,?,0)',
    [CHAIN_ID, GENESIS_HASH]);
  const [r] = await conn.query(
    'SELECT last_hash, last_icv FROM zatca_chain_state WHERE chain_id = ? FOR UPDATE', [CHAIN_ID]);
  if (!r.length) throw err('ZATCA_POSTING_FAILED', 'سلسلة ZATCA غير مهيأة');
  return { lastHash: r[0].last_hash, lastIcv: Number(r[0].last_icv) || 0 };
}

/**
 * Advance the head — call in the SAME transaction that persists the stamped
 * document, after stamp(). Rollback then reverts both together, so a failed
 * issue/post can never advance the chain, and an idempotent replay (which
 * skips perform entirely) can never advance it twice.
 */
async function advanceChain(conn, { hash, icv }) {
  await conn.query(
    'UPDATE zatca_chain_state SET last_hash = ?, last_icv = ?, updated_at = NOW() WHERE chain_id = ?',
    [hash, icv, CHAIN_ID]);
}

/** True when EVERY line is out-of-scope (category 'O') → the doc needs no ZATCA reporting. */
function _isOutOfScope(lines) {
  if (!Array.isArray(lines) || !lines.length) return false;
  return lines.every((l) => String(l.vat_category || l.vatCategory || 'S').toUpperCase() === 'O');
}

/**
 * Stamp an AR document (invoice | credit_note). Pure (no DB write) apart from the
 * chain read — the caller persists uuid/hash/status on ar_documents inside its tx.
 * @returns {{ uuid, hash, previousHash, qr, status, docTypeCode }}
 */
async function stamp(conn, { doc, lines }) {
  const seller = await _sellerFromSettings(conn);
  const head = await _chainHead(conn);
  // Genesis is representable: the seed row's hash, not a NULL from an empty
  // scan. ICV is NOT mixed into canonicalInvoice — the hash function must not
  // silently change under existing stamped documents.
  const previousHash = head.lastHash;
  const icv = head.lastIcv + 1;
  const issueYmd = calc.ymd(doc.issue_date);
  const ksa = zatca.nowInRiyadh(new Date(issueYmd + 'T00:00:00Z'));
  const stamped = zatca.stampInvoice({
    invoice: {
      invoiceNumber: doc.document_number || doc.id || '',
      uuid: doc.zatca_uuid || undefined,
      issueDate: ksa.date,
      issueTime: ksa.time,
      total: calc.money(doc.total_amount),
      vatAmount: calc.money(doc.vat_amount),
      lines: (lines || []).map((l) => ({
        description: l.description, qty: l.base_qty != null ? l.base_qty : l.baseQty,
        unitPrice: l.unit_price != null ? l.unit_price : l.unitPrice,
        net: l.net_amount != null ? l.net_amount : l.netAmount,
        vat: l.vat_amount != null ? l.vat_amount : l.vatAmount,
        vatCategory: l.vat_category || l.vatCategory || 'S',
      })),
    },
    seller,
    previousHash,
  });
  const status = _isOutOfScope(lines) ? 'not_required' : 'pending';
  const docTypeCode = doc.document_type === 'credit_note' ? '381' : (doc.document_type === 'debit_note' ? '383' : '388');
  return { uuid: stamped.uuid, hash: stamped.invoiceHash, previousHash: stamped.previousInvoiceHash, qr: stamped.qrBase64, status, docTypeCode, icv };
}

module.exports = { stamp, advanceChain, _isOutOfScope, CHAIN_ID };
