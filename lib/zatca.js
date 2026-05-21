/**
 * ZATCA Phase 2 (Fatoora) — Helpers
 *
 * Produces the ZATCA-compliant metadata every invoice must carry:
 *   1. UUID v4         (invoice_uuid)
 *   2. Invoice hash    (SHA-256 of canonical invoice representation)
 *   3. Chain hash      (SHA-256 linked to the previous invoice's hash)
 *   4. TLV-encoded QR  (base64, carrying seller name, VAT number, timestamp,
 *                       total, VAT amount — per ZATCA Phase 1 QR spec)
 *
 * Scope note: This module generates the on-device metadata required to stamp
 * each invoice. The actual eInvoicing API submission (clearance for
 * B2B/standard, reporting for B2C/simplified) is out of scope here — those
 * require ZATCA onboarding (CSR → Compliance CSID → Production CSID) plus
 * signed XML (UBL 2.1). The fields produced here are the exact inputs
 * ZATCA's Fatoora portal expects.
 */
const crypto = require('crypto');

// v6.0.2 Wave B.1 — Asia/Riyadh timezone helper.
// ZATCA BR-DT-03 requires invoice issueDate/issueTime in Saudi local
// time. `new Date().toISOString()` always returns UTC, which on a
// server running e.g. in Frankfurt produces an off-by-3-hours stamp
// (and rolls the date around 21:00 KSA). This helper returns the
// {date, time, iso} triple in Asia/Riyadh regardless of server TZ.
function nowInRiyadh(d) {
  const date = d || new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(date);
  const get = (t) => {
    const p = parts.find(pp => pp.type === t);
    return p ? p.value : '00';
  };
  const dStr = get('year') + '-' + get('month') + '-' + get('day');
  // Note: en-CA returns hour="24" at midnight in some locales — normalise to 00
  const hh = get('hour') === '24' ? '00' : get('hour');
  const tStr = hh + ':' + get('minute') + ':' + get('second');
  return { date: dStr, time: tStr, iso: dStr + 'T' + tStr + '+03:00' };
}

// Generate a RFC-4122 v4 UUID (no external dep)
function uuidV4() {
  // crypto.randomUUID() is node 14.17+; fallback to randomBytes for compat
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;    // version 4
  b[8] = (b[8] & 0x3f) | 0x80;    // variant RFC-4122
  const h = b.toString('hex');
  return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);
}

/**
 * Build the canonical invoice digest input. For Phase 2 XML the canonical
 * form is the UBL XML with inclusions/exclusions per ZATCA rules; here we
 * use a stable JSON projection of the invoice record so chain-hashing is
 * deterministic across restarts.
 */
function canonicalInvoice(inv) {
  const o = {
    uuid:           inv.uuid || '',
    invoiceNumber:  inv.invoiceNumber || inv.orderId || '',
    issueDate:      inv.issueDate || '',     // YYYY-MM-DD
    issueTime:      inv.issueTime || '',     // HH:mm:ss
    sellerName:     inv.sellerName || '',
    sellerVat:      inv.sellerVat || '',
    buyerName:      inv.buyerName || '',
    buyerVat:       inv.buyerVat || '',
    total:          Number(inv.total || 0).toFixed(2),
    vatAmount:      Number(inv.vatAmount || 0).toFixed(2),
    lines: Array.isArray(inv.lines) ? inv.lines.map(l => ({
      name: l.name || '',
      qty: Number(l.qty || 0),
      unitPrice: Number(l.unitPrice || l.price || 0).toFixed(4),
      lineTotal: Number(l.lineTotal || l.total || 0).toFixed(2)
    })) : []
  };
  return JSON.stringify(o);
}

/** SHA-256 (hex) of a string/buffer */
function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

/**
 * Hash-chain an invoice: hash of the canonical invoice concatenated with
 * the previous invoice's hash (or the genesis "0".repeat(64) if none).
 * This is what ZATCA calls "Previous Invoice Hash" linking.
 */
function chainHash(inv, previousHash) {
  const prev = previousHash || '0'.repeat(64);
  return sha256Hex(canonicalInvoice(inv) + '|' + prev);
}

/**
 * TLV encoder for ZATCA QR. Per the ZATCA QR spec the payload is
 * Tag-Length-Value bytes, each Tag+Length = 1 byte each, then Value bytes,
 * finally base64-encoded. Tags used:
 *   1 = Seller name
 *   2 = Seller VAT registration number
 *   3 = Timestamp (ISO-8601)
 *   4 = Invoice total (with VAT)
 *   5 = VAT total
 */
function buildZatcaQR(params) {
  const fields = [
    { tag: 1, value: params.sellerName || '' },
    { tag: 2, value: params.sellerVat || '' },
    { tag: 3, value: params.timestamp || new Date().toISOString() },
    { tag: 4, value: Number(params.total || 0).toFixed(2) },
    { tag: 5, value: Number(params.vatAmount || 0).toFixed(2) }
  ];
  const chunks = [];
  for (const f of fields) {
    const valBuf = Buffer.from(String(f.value), 'utf8');
    const header = Buffer.from([f.tag, valBuf.length]);
    chunks.push(header, valBuf);
  }
  return Buffer.concat(chunks).toString('base64');
}

/**
 * Generate the full ZATCA stamp for an invoice, given the previous hash.
 *
 *   input:  { invoice: {...}, previousHash: '<hex|null>', seller: {...} }
 *   output: { uuid, invoiceHash, previousInvoiceHash, qrBase64 }
 *
 * invoice should contain: invoiceNumber, issueDate, issueTime, total, vatAmount, lines[]
 * seller should contain: name, vatNumber
 */
function stampInvoice(input) {
  const inv = input.invoice || {};
  const seller = input.seller || {};
  const uuid = inv.uuid || uuidV4();
  inv.uuid = uuid;
  inv.sellerName = seller.name || inv.sellerName || '';
  inv.sellerVat = seller.vatNumber || inv.sellerVat || '';
  const previousInvoiceHash = input.previousHash || null;
  const invoiceHash = chainHash(inv, previousInvoiceHash);
  const qrBase64 = buildZatcaQR({
    sellerName: inv.sellerName,
    sellerVat: inv.sellerVat,
    timestamp: (inv.issueDate || '') + (inv.issueTime ? 'T' + inv.issueTime : 'T00:00:00'),
    total: inv.total,
    vatAmount: inv.vatAmount
  });
  return { uuid, invoiceHash, previousInvoiceHash, qrBase64 };
}

/**
 * Fetch the most recent sale's invoice_hash from the database — used to
 * establish the chain link for the next invoice. Returns null for genesis.
 *
 * v6.0.2 Wave B.5 — When called inside a transaction, attempts to lock
 * the last row with SELECT … FOR UPDATE so concurrent invoices can't
 * both read the same previous_invoice_hash and produce a forked chain.
 * If the connection isn't transactional (older callers), falls back
 * gracefully to a plain SELECT. Removed the silent try/catch that
 * masked DB errors — the caller now sees a real failure.
 */
async function getLastInvoiceHash(db) {
  try {
    const [r] = await db.query(
      `SELECT invoice_hash FROM sales
       WHERE invoice_hash IS NOT NULL AND invoice_hash != ''
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`);
    return r.length ? r[0].invoice_hash : null;
  } catch (lockErr) {
    // Fallback for non-transactional callers (no FOR UPDATE allowed)
    const [r] = await db.query(
      `SELECT invoice_hash FROM sales
       WHERE invoice_hash IS NOT NULL AND invoice_hash != ''
       ORDER BY created_at DESC LIMIT 1`);
    return r.length ? r[0].invoice_hash : null;
  }
}

/** Convenience: stamp a sale end-to-end and return fields ready to write back.
 * v6.0.2 Wave B.1 — issueDate/issueTime now reflect Asia/Riyadh local time
 * regardless of server timezone (BR-DT-03 compliance).
 */
async function stampSale(db, sale, seller) {
  const prev = await getLastInvoiceHash(db);
  const baseDate = sale.createdAt ? new Date(sale.createdAt) : new Date();
  const ksa = nowInRiyadh(baseDate);
  const stamp = stampInvoice({
    invoice: {
      invoiceNumber: sale.orderId || sale.id || '',
      issueDate: ksa.date,
      issueTime: ksa.time,
      total: sale.total,
      vatAmount: sale.vatAmount,
      lines: sale.lines || []
    },
    seller: seller || { name: '', vatNumber: '' },
    previousHash: prev
  });
  return stamp;
}

module.exports = { uuidV4, sha256Hex, chainHash, buildZatcaQR, stampInvoice, stampSale, getLastInvoiceHash, canonicalInvoice, nowInRiyadh };
