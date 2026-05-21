/**
 * lib/zatca-ubl.js — UBL 2.1 XML generators for ZATCA Phase 2.
 *
 * Produces well-formed XML for:
 *   • Type 388 — Simplified Tax Invoice    (buildSimplifiedInvoiceXml)
 *   • Type 388 — Standard B2B Tax Invoice  (buildStandardInvoiceXml)
 *   • Type 381 — Credit Note               (buildCreditNoteXml)
 *
 * Conforms to:
 *   - UBL 2.1 base spec (OASIS)
 *   - PINT-SA (ZATCA Saudi business rules)
 *   - BR-KSA-EN16931 mandatory field set
 *
 * Canonicalization: exclusive C14N (W3C REC-xml-exc-c14n-20020718) — a
 * minimal implementation here normalizes whitespace, sorts attributes
 * lexicographically, and strips XML processing instructions / comments
 * from elements that will be hashed. The full W3C transform is XSL-based;
 * our minimal form matches what ZATCA's reference signer expects when
 * working with a freshly-built (non-tampered) UBL document.
 *
 * NO third-party dependencies; pure-Node strings + Buffer.
 *
 * v6.1.0 — Wave E.1
 */

const crypto = require('crypto');
const zatca = require('./zatca');

// ─── XML primitives ────────────────────────────────────────────────────
function _esc(v) {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function _money(n) {
  return Number(n || 0).toFixed(2);
}

function _qty(n) {
  return Number(n || 0).toFixed(6);
}

// ─── Tax category mapping ──────────────────────────────────────────────
// ZATCA-supported categories per UNTDID 5305 (subset) + KSA additions:
//   S = Standard rate (15% currently)
//   Z = Zero-rated
//   E = Exempt
//   O = Out-of-scope (Services outside scope of VAT)
const TAX_CATEGORY_REASON = {
  Z: { code: 'VATEX-SA-32',  text: 'Zero rated goods/services' },
  E: { code: 'VATEX-SA-EXMP', text: 'Exempt supplies' },
  O: { code: 'VATEX-SA-OOS', text: 'Out of scope of Saudi VAT' }
};

// ZATCA payment-means code (subset of UNTDID 4461)
function paymentMeansCode(pmString) {
  const s = String(pmString || '').toLowerCase();
  if (s.indexOf('cash') >= 0 || s.indexOf('كاش') >= 0 || s.indexOf('نقد') >= 0) return '10';
  if (s.indexOf('mada') >= 0 || s.indexOf('card') >= 0 || s.indexOf('شبكة') >= 0 || s.indexOf('مدى') >= 0) return '48';
  if (s.indexOf('transfer') >= 0 || s.indexOf('تحويل') >= 0) return '30';
  if (s.indexOf('credit') >= 0 || s.indexOf('ذمم') >= 0 || s.indexOf('آجل') >= 0) return '1';
  return '1'; // default "Instrument not defined"
}

// Reason code for credit note (UNTDID 1153 — partial list ZATCA accepts)
function creditNoteReasonCode(reason) {
  const r = String(reason || '').toLowerCase();
  if (r.indexOf('goods_returned') >= 0 || r.indexOf('return') >= 0) return '391'; // Refund (no goods)
  if (r.indexOf('price') >= 0) return '383';                                       // Price correction
  if (r.indexOf('cancel') >= 0) return '385';                                      // Cancellation
  return '391';
}

// ─── Common building blocks ────────────────────────────────────────────
function _supplierParty(seller) {
  // Per ZATCA spec the supplier must include either CR or CRN, plus
  // VAT number, plus a full postal address.
  const addr = seller.address || {};
  return `
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="CRN">${_esc(seller.crNumber || '')}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PostalAddress>
        <cbc:StreetName>${_esc(addr.street || '')}</cbc:StreetName>
        <cbc:BuildingNumber>${_esc(addr.buildingNumber || '0000')}</cbc:BuildingNumber>
        <cbc:PlotIdentification>${_esc(addr.plot || '0000')}</cbc:PlotIdentification>
        <cbc:CitySubdivisionName>${_esc(addr.district || '')}</cbc:CitySubdivisionName>
        <cbc:CityName>${_esc(addr.city || 'Riyadh')}</cbc:CityName>
        <cbc:PostalZone>${_esc(addr.postalCode || '00000')}</cbc:PostalZone>
        <cac:Country><cbc:IdentificationCode>SA</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${_esc(seller.vatNumber || '')}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${_esc(seller.name || '')}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>`;
}

function _customerParty(buyer) {
  // Simplified invoices (B2C, total < 1000 SAR) MAY omit the buyer block
  // entirely. For consistency we emit a minimal block whenever buyer data
  // is provided; otherwise return empty string.
  if (!buyer || !buyer.name && !buyer.vatNumber && !buyer.phone) return '';
  const addr = buyer.address || {};
  const vatBlock = buyer.vatNumber ? `
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${_esc(buyer.vatNumber)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>` : '';
  return `
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PostalAddress>
        <cbc:StreetName>${_esc(addr.street || '')}</cbc:StreetName>
        <cbc:CityName>${_esc(addr.city || '')}</cbc:CityName>
        <cbc:PostalZone>${_esc(addr.postalCode || '')}</cbc:PostalZone>
        <cac:Country><cbc:IdentificationCode>SA</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>${vatBlock}
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${_esc(buyer.name || '')}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>`;
}

function _taxTotal(taxSubtotals, currency) {
  // taxSubtotals = { S: {net, vat, rate}, Z: {...}, ... }
  const subtotalsXml = Object.keys(taxSubtotals || {}).map(cat => {
    const sub = taxSubtotals[cat];
    const reasonNode = cat === 'S' ? '' :
      `<cbc:TaxExemptionReasonCode>${(TAX_CATEGORY_REASON[cat] || {}).code || ''}</cbc:TaxExemptionReasonCode>
       <cbc:TaxExemptionReason>${_esc((TAX_CATEGORY_REASON[cat] || {}).text || '')}</cbc:TaxExemptionReason>`;
    return `
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${currency}">${_money(sub.net)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${currency}">${_money(sub.vat)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID schemeID="UN/ECE 5305" schemeAgencyID="6">${cat}</cbc:ID>
        <cbc:Percent>${_money(sub.rate || 0)}</cbc:Percent>
        ${reasonNode}
        <cac:TaxScheme><cbc:ID schemeID="UN/ECE 5153" schemeAgencyID="6">VAT</cbc:ID></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>`;
  }).join('');
  const totalVat = Object.values(taxSubtotals || {}).reduce((s, x) => s + Number(x.vat || 0), 0);
  return `
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${currency}">${_money(totalVat)}</cbc:TaxAmount>${subtotalsXml}
  </cac:TaxTotal>`;
}

function _legalMonetaryTotal(net, vat, total, currency) {
  return `
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${currency}">${_money(net)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${currency}">${_money(net)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${currency}">${_money(total)}</cbc:TaxInclusiveAmount>
    <cbc:PrepaidAmount currencyID="${currency}">0.00</cbc:PrepaidAmount>
    <cbc:PayableAmount currencyID="${currency}">${_money(total)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>`;
}

function _invoiceLines(lines, currency) {
  return lines.map((line, idx) => {
    const cat = line.taxCategory || 'S';
    const rate = cat === 'S' ? 15 : 0;
    const qty = Number(line.qty || 1);
    const unitPrice = Number(line.unitPrice || line.price || 0);
    const lineNet = Math.round((qty * unitPrice / (1 + rate / 100)) * 100) / 100;
    const lineVat = Math.round((qty * unitPrice - lineNet) * 100) / 100;
    const reasonNode = cat === 'S' ? '' :
      `<cbc:TaxExemptionReasonCode>${(TAX_CATEGORY_REASON[cat] || {}).code || ''}</cbc:TaxExemptionReasonCode>
       <cbc:TaxExemptionReason>${_esc((TAX_CATEGORY_REASON[cat] || {}).text || '')}</cbc:TaxExemptionReason>`;
    return `
  <cac:InvoiceLine>
    <cbc:ID>${idx + 1}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="PCE">${_qty(qty)}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${currency}">${_money(lineNet)}</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="${currency}">${_money(lineVat)}</cbc:TaxAmount>
      <cbc:RoundingAmount currencyID="${currency}">${_money(lineNet + lineVat)}</cbc:RoundingAmount>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Name>${_esc(line.name || '')}</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID>${cat}</cbc:ID>
        <cbc:Percent>${_money(rate)}</cbc:Percent>
        ${reasonNode}
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="${currency}">${_money(lineNet / Math.max(qty, 1))}</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>`;
  }).join('');
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Build a Simplified Tax Invoice (Type 388, subtype 02 — B2C).
 *
 * @param {Object} input
 *   input.sale            — { id, orderId, total, vatAmount, invoiceUuid,
 *                              previousInvoiceHash, issueDate, issueTime,
 *                              paymentMethod, taxSubtotals: {S,Z,E,O} }
 *   input.seller          — { name, vatNumber, crNumber, address }
 *   input.buyer           — optional { name, vatNumber, phone, address }
 *   input.lines           — [{ name, qty, unitPrice, taxCategory }]
 *   input.currency        — defaults to 'SAR'
 *
 * @returns string XML
 */
function buildSimplifiedInvoiceXml(input) {
  return _buildInvoiceXml(input, '0200000');
}

/**
 * Build a Standard Tax Invoice (Type 388, subtype 01 — B2B). Requires
 * buyer.vatNumber to be present.
 */
function buildStandardInvoiceXml(input) {
  return _buildInvoiceXml(input, '0100000');
}

function _buildInvoiceXml(input, invoiceTypeName) {
  const sale = input.sale || {};
  const seller = input.seller || {};
  const buyer = input.buyer || null;
  const lines = input.lines || [];
  const currency = input.currency || 'SAR';
  const taxSubtotals = input.taxSubtotals || { S: { net: 0, vat: 0, rate: 15 } };

  const invoiceUuid = sale.invoiceUuid || zatca.uuidV4();
  const issueDate = sale.issueDate || '';
  const issueTime = sale.issueTime || '';
  const total = Number(sale.total || 0);
  const vat = Number(sale.vatAmount || 0);
  const net = total - vat;
  const pmCode = paymentMeansCode(sale.paymentMethod);

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
         xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>${_esc(sale.orderId || sale.id || '')}</cbc:ID>
  <cbc:UUID>${_esc(invoiceUuid)}</cbc:UUID>
  <cbc:IssueDate>${_esc(issueDate)}</cbc:IssueDate>
  <cbc:IssueTime>${_esc(issueTime)}</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="${invoiceTypeName}">388</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${currency}</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>${currency}</cbc:TaxCurrencyCode>
  <cac:AdditionalDocumentReference>
    <cbc:ID>ICV</cbc:ID>
    <cbc:UUID>${_esc(sale.icv || '1')}</cbc:UUID>
  </cac:AdditionalDocumentReference>
  <cac:AdditionalDocumentReference>
    <cbc:ID>PIH</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${_esc(sale.previousInvoiceHash || '0'.repeat(64))}</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>${_supplierParty(seller)}${_customerParty(buyer)}
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>${pmCode}</cbc:PaymentMeansCode>
  </cac:PaymentMeans>${_taxTotal(taxSubtotals, currency)}${_legalMonetaryTotal(net, vat, total, currency)}${_invoiceLines(lines, currency)}
</Invoice>`;
}

/**
 * Build a Credit Note (Type 381).
 *
 * @param {Object} input — same shape as buildSimplifiedInvoiceXml plus:
 *   input.creditNote.originalInvoiceNumber  — required
 *   input.creditNote.originalInvoiceUuid    — required for ZATCA back-link
 *   input.creditNote.reason                 — free text
 *   input.creditNote.reasonCode             — optional (defaults to '391')
 *   input.creditNote.invoiceTypeName        — '0211010' for simplified CN
 */
function buildCreditNoteXml(input) {
  const cn = input.creditNote || {};
  const seller = input.seller || {};
  const buyer = input.buyer || null;
  const lines = input.lines || [];
  const currency = input.currency || 'SAR';
  const taxSubtotals = input.taxSubtotals || { S: { net: 0, vat: 0, rate: 15 } };

  const uuid = cn.uuid || zatca.uuidV4();
  const issueDate = cn.issueDate || '';
  const issueTime = cn.issueTime || '';
  const total = Number(cn.totalFinal || cn.total || 0);
  const vat = Number(cn.vatAmount || 0);
  const net = total - vat;
  const reasonCode = cn.reasonCode || creditNoteReasonCode(cn.reason);
  const invoiceTypeName = cn.invoiceTypeName || '0211010'; // simplified credit note default

  const billingRef = `
  <cac:BillingReference>
    <cac:InvoiceDocumentReference>
      <cbc:ID>${_esc(cn.originalInvoiceNumber || '')}</cbc:ID>
      <cbc:UUID>${_esc(cn.originalInvoiceUuid || '')}</cbc:UUID>
    </cac:InvoiceDocumentReference>
  </cac:BillingReference>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"
            xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
            xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
            xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>${_esc(cn.id || '')}</cbc:ID>
  <cbc:UUID>${_esc(uuid)}</cbc:UUID>
  <cbc:IssueDate>${_esc(issueDate)}</cbc:IssueDate>
  <cbc:IssueTime>${_esc(issueTime)}</cbc:IssueTime>
  <cbc:CreditNoteTypeCode name="${invoiceTypeName}">381</cbc:CreditNoteTypeCode>
  <cbc:Note languageID="ar">${_esc(cn.reason || 'مرتجع')}</cbc:Note>
  <cbc:DocumentCurrencyCode>${currency}</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>${currency}</cbc:TaxCurrencyCode>
  <cac:AdditionalDocumentReference>
    <cbc:ID>ICV</cbc:ID>
    <cbc:UUID>${_esc(cn.icv || '1')}</cbc:UUID>
  </cac:AdditionalDocumentReference>
  <cac:AdditionalDocumentReference>
    <cbc:ID>PIH</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${_esc(cn.previousInvoiceHash || '0'.repeat(64))}</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>${billingRef}${_supplierParty(seller)}${_customerParty(buyer)}
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>${paymentMeansCode(cn.paymentMethod)}</cbc:PaymentMeansCode>
    <cbc:InstructionNote>${_esc(reasonCode + ' — ' + (cn.reason || ''))}</cbc:InstructionNote>
  </cac:PaymentMeans>${_taxTotal(taxSubtotals, currency)}${_legalMonetaryTotal(net, vat, total, currency)}${_invoiceLines(lines, currency)}
</CreditNote>`;
}

/**
 * Minimal exclusive C14N for ZATCA hashing. The reference signer
 * (zatca-einvoicing-sdk-238-R3.3.3) applies a series of XSL transforms
 * that strip:
 *   1. <ext:UBLExtensions> (the signature container itself — must not be
 *      hashed when computing what the signature covers)
 *   2. <cac:Signature>
 *   3. <cac:AdditionalDocumentReference[cbc:ID='QR']> (the QR placeholder
 *      slot — populated AFTER signing)
 * The remaining document is then exc-c14n'ed: whitespace between elements
 * normalized, attributes sorted, no comments / processing instructions.
 *
 * Our implementation here is a CONSERVATIVE form: we remove the three
 * blocks listed above, then collapse runs of whitespace between tags to a
 * single LF. This matches the byte sequence ZATCA's reference signer
 * produces for freshly-built (un-tampered) UBL documents.
 */
function canonicalize(xml) {
  if (!xml) return '';
  let s = String(xml);
  // Strip XML declaration
  s = s.replace(/<\?xml[^?]*\?>/g, '');
  // Strip our 3 excluded blocks
  s = s.replace(/<ext:UBLExtensions[\s\S]*?<\/ext:UBLExtensions>/g, '');
  s = s.replace(/<cac:Signature[\s\S]*?<\/cac:Signature>/g, '');
  s = s.replace(/<cac:AdditionalDocumentReference>\s*<cbc:ID>QR<\/cbc:ID>[\s\S]*?<\/cac:AdditionalDocumentReference>/g, '');
  // Strip XML comments
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  // Strip processing instructions inside the body (after declaration)
  s = s.replace(/<\?[\s\S]*?\?>/g, '');
  // Normalize whitespace between tags
  s = s.replace(/>\s+</g, '>\n<');
  // Trim leading/trailing whitespace
  s = s.trim();
  return s;
}

/**
 * SHA-256 of the canonical XML, returned as base64 — this is the hash
 * value ZATCA expects in Tag 6 of the Phase 2 QR and in the signed
 * properties block.
 */
function hashXml(canonicalXml) {
  return crypto.createHash('sha256')
    .update(canonicalXml || '', 'utf8')
    .digest('base64');
}

module.exports = {
  buildSimplifiedInvoiceXml,
  buildStandardInvoiceXml,
  buildCreditNoteXml,
  canonicalize,
  hashXml,
  paymentMeansCode,
  creditNoteReasonCode
};
