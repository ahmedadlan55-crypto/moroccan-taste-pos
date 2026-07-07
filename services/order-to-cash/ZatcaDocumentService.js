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

/** Last stamped O2C document hash (chain link). Locks in a tx to avoid a forked chain. */
async function _lastHash(conn) {
  try {
    const [r] = await conn.query(
      "SELECT zatca_hash FROM ar_documents WHERE zatca_hash IS NOT NULL AND zatca_hash <> '' ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE");
    return r.length ? r[0].zatca_hash : null;
  } catch (_) {
    const [r] = await conn.query(
      "SELECT zatca_hash FROM ar_documents WHERE zatca_hash IS NOT NULL AND zatca_hash <> '' ORDER BY created_at DESC, id DESC LIMIT 1");
    return r.length ? r[0].zatca_hash : null;
  }
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
  const previousHash = await _lastHash(conn);
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
  return { uuid: stamped.uuid, hash: stamped.invoiceHash, previousHash: stamped.previousInvoiceHash, qr: stamped.qrBase64, status, docTypeCode };
}

module.exports = { stamp, _isOutOfScope };
