/**
 * lib/zatca-qr-image.js — server-side ZATCA QR rendering + TLV decoding.
 *
 * The design rule (stated in frontend/pos/src/lib/receipt.ts and honoured by
 * both frontends): clients NEVER encode QRs — no QR library ships to the
 * browser. The only renderer used to live inline in routes/sales.js for the
 * legacy receipt; O2C documents (credit notes, back-office invoice prints)
 * need the same capability without reaching into that route file, so it
 * lives here. routes/sales.js keeps its local copy for now — consolidating
 * it here is a follow-up owned by whoever next edits that file.
 *
 * decodeZatcaTlv exists because the persisted TLV is the FROZEN truth about
 * the seller: tags 1 (name) and 2 (VAT number) were stamped at issue time.
 * ar_documents carries no seller columns, and re-reading live settings at
 * print time reproduces exactly the drift-after-rename defect the sales side
 * eliminated by snapshotting identity at issue.
 */
'use strict';

const qrImage = require('qrcode');

/** TLV base64 → PNG data URL. The TLV is BINARY — feed bytes, not text. */
async function zatcaQrDataUrl(tlvBase64) {
  if (!tlvBase64) return null;
  try {
    return await qrImage.toDataURL([{ data: Buffer.from(tlvBase64, 'base64'), mode: 'byte' }], { margin: 0, width: 160 });
  } catch (e) {
    console.error('[zatca] QR image render failed:', e.message);
    return null;
  }
}

/**
 * Parse the Phase-1 tags out of a stamped TLV. Mirrors _tlvField in
 * lib/zatca.js: 1-byte tag, then length as 1 byte, 0x81+1 byte, or
 * 0x82+2 bytes (Phase-2 signature tags can exceed 127 bytes). Unknown or
 * cryptographic tags are skipped, not errors. Returns null on any structural
 * damage — a print must show "no seller snapshot" rather than garbage.
 */
function decodeZatcaTlv(tlvBase64) {
  if (!tlvBase64) return null;
  try {
    const buf = Buffer.from(tlvBase64, 'base64');
    const out = {};
    let i = 0;
    while (i + 2 <= buf.length) {
      const tag = buf[i]; i += 1;
      let len = buf[i]; i += 1;
      if (len === 0x81) { len = buf[i]; i += 1; }
      else if (len === 0x82) { len = (buf[i] << 8) | buf[i + 1]; i += 2; }
      if (i + len > buf.length) return null; // truncated TLV
      const val = buf.slice(i, i + len); i += len;
      if (tag === 1) out.sellerName = val.toString('utf8');
      else if (tag === 2) out.vatNumber = val.toString('utf8');
      else if (tag === 3) out.timestamp = val.toString('utf8');
      else if (tag === 4) out.total = val.toString('utf8');
      else if (tag === 5) out.vat = val.toString('utf8');
      // tags 6-9 are hashes/signatures/keys — not printable text
    }
    return out.sellerName || out.vatNumber ? out : null;
  } catch (_) {
    return null;
  }
}

module.exports = { zatcaQrDataUrl, decodeZatcaTlv };
