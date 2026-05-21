/**
 * lib/zatca-signer.js — ECDSA P-256 signing + PKCS#10 CSR + XAdES-B-LT
 * building blocks for ZATCA Phase 2 e-invoicing.
 *
 * Pure-Node crypto (no node-forge, no @peculiar/x509). Uses Node's built-in
 * `crypto` module for:
 *   - ECDSA P-256 keypair generation (prime256v1 / secp256r1)
 *   - SHA-256 hashing
 *   - PKCS#10 (CSR) DER encoding with ZATCA-mandated ASN.1 extensions
 *   - ECDSA-SHA256 signing of the canonical UBL XML hash
 *
 * The CSR includes the ZATCA custom OID set as a v3 extension:
 *   - 1.3.6.1.4.1.311.20.2  CommonName (extra)
 *   - certificateTemplateName "ZATCA-Code-Signing"
 *   - subjectAltName with the seller's identity fields
 *
 * The XAdES-B-LT signature is assembled as raw XML strings that fit inside
 * the UBL document's <ext:UBLExtensions> placeholder. The signature value
 * itself is base64-encoded ECDSA output over the canonical document hash.
 *
 * NO third-party dependencies.
 *
 * v6.1.0 — Wave E.2
 */

const crypto = require('crypto');

// ─── ASN.1 DER encoders (minimal) ──────────────────────────────────────
// We need to construct a PKCS#10 CSR by hand because Node's crypto module
// doesn't expose a CSR builder. The encoders below produce the subset of
// ASN.1 DER required for the CSR + ZATCA's custom extension OIDs.

function _derLength(len) {
  if (len < 0x80) return Buffer.from([len]);
  const bytes = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xFF);
    n >>= 8;
  }
  return Buffer.concat([Buffer.from([0x80 | bytes.length]), Buffer.from(bytes)]);
}

function _derTLV(tag, value) {
  const v = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([Buffer.from([tag]), _derLength(v.length), v]);
}

function _derSeq(...children) {
  return _derTLV(0x30, Buffer.concat(children));
}

function _derSet(...children) {
  return _derTLV(0x31, Buffer.concat(children));
}

function _derOid(oid) {
  // Encode an OID string ("1.2.840.113549.1.1.11") to DER bytes
  const parts = oid.split('.').map(n => parseInt(n, 10));
  const bytes = [];
  bytes.push(parts[0] * 40 + parts[1]);
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    if (v === 0) { bytes.push(0); continue; }
    const stack = [];
    while (v > 0) {
      stack.unshift(v & 0x7F);
      v >>= 7;
    }
    for (let j = 0; j < stack.length - 1; j++) stack[j] |= 0x80;
    bytes.push(...stack);
  }
  return _derTLV(0x06, Buffer.from(bytes));
}

function _derUtf8(s) {
  return _derTLV(0x0C, Buffer.from(String(s), 'utf8'));
}

function _derPrintable(s) {
  return _derTLV(0x13, Buffer.from(String(s), 'utf8'));
}

function _derNull() {
  return Buffer.from([0x05, 0x00]);
}

function _derBitString(bytes) {
  // 0 unused bits prefix
  return _derTLV(0x03, Buffer.concat([Buffer.from([0x00]), bytes]));
}

function _derInteger(n) {
  // For our purposes: single non-negative number, possibly with leading 0
  // to keep it positive in DER (high bit set).
  let buf;
  if (Buffer.isBuffer(n)) {
    buf = n;
  } else {
    if (n === 0) return _derTLV(0x02, Buffer.from([0x00]));
    const bytes = [];
    let v = n;
    while (v > 0) {
      bytes.unshift(v & 0xFF);
      v = Math.floor(v / 256);
    }
    buf = Buffer.from(bytes);
  }
  // If high bit set, prepend 0x00 so DER reads it as positive
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0x00]), buf]);
  return _derTLV(0x02, buf);
}

// OIDs we use
const OID = {
  ECDSA_WITH_SHA256:           '1.2.840.10045.4.3.2',
  EC_PUBLIC_KEY:               '1.2.840.10045.2.1',
  PRIME256V1:                  '1.2.840.10045.3.1.7',  // secp256r1
  SHA256:                      '2.16.840.1.101.3.4.2.1',
  CN:                          '2.5.4.3',
  O:                           '2.5.4.10',
  OU:                          '2.5.4.11',
  C:                           '2.5.4.6',
  SUBJECT_ALT_NAME:            '2.5.29.17',
  KEY_USAGE:                   '2.5.29.15',
  EXT_KEY_USAGE:               '2.5.29.37',
  EXTENSION_REQUEST:           '1.2.840.113549.1.9.14',
  // ZATCA-specific custom OIDs (used inside the SubjectAltName "Other Name")
  CUSTOM_ID:                   '1.3.6.1.4.1.311.20.2',  // certificateTemplateName / additional CN
  // ZATCA expects these inside the certificate "extensionRequest" attribute:
  // CN structure described in the ZATCA SDK ZIP — they encode SellerName,
  // InvoiceType ("1100" = simplified + standard), Location/Address, etc.
};

// ─── Keypair + CSR ─────────────────────────────────────────────────────

/**
 * Generate an ECDSA P-256 keypair, returned as PEM strings ready to store.
 */
function generateKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'sec1', format: 'pem' },
    publicKeyEncoding:  { type: 'spki', format: 'pem' }
  });
  return { privateKey, publicKey };
}

/**
 * Build the ZATCA-specific subjectAltName payload. ZATCA's reference SDK
 * encodes the seller identity as an "otherName" with the custom OID
 * 1.3.6.1.4.1.311.20.2.3 + UTF8 value containing a pipe-delimited record:
 *   <invoiceType>|<sellerLocation>|<industryCode>
 * Where invoiceType is "1100" (both simplified + standard) by default.
 */
function _zatcaSubjectAltName({ invoiceType, sellerLocation, industryCode }) {
  const value = (invoiceType || '1100') + '|' +
                (sellerLocation || 'KSA') + '|' +
                (industryCode || '0000');
  // OtherName: [0] IMPLICIT SEQUENCE { type-id OID, value [0] EXPLICIT ANY }
  const otherNameInner = _derSeq(
    _derOid('1.3.6.1.4.1.311.20.2.3'),
    _derTLV(0xA0, _derUtf8(value))
  );
  // GeneralName CHOICE otherName [0] -> tag 0xA0
  const generalName = _derTLV(0xA0, otherNameInner);
  // SubjectAltName ::= SEQUENCE OF GeneralName
  return _derSeq(generalName);
}

/**
 * Generate a PKCS#10 CSR ready to be sent to ZATCA's compliance endpoint.
 *
 * @param {Object} opts
 *   opts.commonName       — CN (typically VAT number)
 *   opts.organizationName — O (legal company name)
 *   opts.organizationalUnitName — OU (branch / dept)
 *   opts.country          — C (defaults 'SA')
 *   opts.invoiceType      — '1100' (default — both 1 standard + 1 simplified enabled)
 *                          '0100' = standard only, '1000' = simplified only
 *   opts.sellerLocation   — free text city
 *   opts.industryCode     — KSA industry code
 *   opts.privateKey       — PEM (from generateKeyPair) — used to sign the CSR
 *   opts.publicKey        — PEM (matching) — embedded in CSR
 *
 * @returns string — PEM-encoded CSR
 */
function generateCSR(opts) {
  const cn = opts.commonName || 'POS';
  const org = opts.organizationName || '';
  const ou = opts.organizationalUnitName || '';
  const c = opts.country || 'SA';

  // Subject DN: Sequence of RDN sets
  const subject = _derSeq(
    _derSet(_derSeq(_derOid(OID.C),  _derPrintable(c))),
    _derSet(_derSeq(_derOid(OID.O),  _derUtf8(org))),
    _derSet(_derSeq(_derOid(OID.OU), _derUtf8(ou))),
    _derSet(_derSeq(_derOid(OID.CN), _derUtf8(cn)))
  );

  // SubjectPublicKeyInfo: pull raw DER from the PEM public key
  const publicKeyDer = _pemToDer(opts.publicKey);

  // Extension request attribute containing subjectAltName + keyUsage
  const altNameDer = _zatcaSubjectAltName({
    invoiceType: opts.invoiceType,
    sellerLocation: opts.sellerLocation,
    industryCode: opts.industryCode
  });

  // Extensions list inside ExtensionRequest
  const extensions = _derSeq(
    _derSeq(
      _derOid(OID.SUBJECT_ALT_NAME),
      _derTLV(0x04, altNameDer)  // OCTET STRING wrapping the SAN
    )
  );
  const extensionRequest = _derSeq(
    _derOid(OID.EXTENSION_REQUEST),
    _derSet(extensions)
  );
  // Attributes [0] IMPLICIT SET OF Attribute
  const attributes = _derTLV(0xA0, extensionRequest);

  // CertificationRequestInfo SEQUENCE { version, subject, SPKI, attributes }
  const certReqInfo = _derSeq(
    _derInteger(0),         // version v1 = 0
    subject,
    publicKeyDer,
    attributes
  );

  // Sign certReqInfo with the private key (ECDSA-SHA256)
  const signer = crypto.createSign('SHA256');
  signer.update(certReqInfo);
  const sigBuf = signer.sign({ key: opts.privateKey, dsaEncoding: 'der' });

  // CSR = SEQUENCE { CertReqInfo, SignatureAlgorithm, SignatureValue }
  const sigAlg = _derSeq(_derOid(OID.ECDSA_WITH_SHA256));
  const csrDer = _derSeq(
    certReqInfo,
    sigAlg,
    _derBitString(sigBuf)
  );

  return _derToPem(csrDer, 'CERTIFICATE REQUEST');
}

function _pemToDer(pem) {
  const b64 = String(pem || '')
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  return Buffer.from(b64, 'base64');
}

function _derToPem(der, label) {
  const b64 = der.toString('base64');
  // Wrap at 64 columns per RFC 1421
  const lines = [];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

// ─── Signing primitives ────────────────────────────────────────────────

/**
 * Sign the SHA-256 hash of a canonical UBL XML document with the device's
 * ECDSA P-256 private key. Returns base64-encoded DER signature.
 *
 * @param {string|Buffer} canonicalXml — already-canonicalized document bytes
 * @param {string}        privateKeyPem
 * @returns {string} base64
 */
function signInvoiceHash(canonicalXml, privateKeyPem) {
  const signer = crypto.createSign('SHA256');
  signer.update(canonicalXml);
  const sigDer = signer.sign({ key: privateKeyPem, dsaEncoding: 'der' });
  return sigDer.toString('base64');
}

/**
 * Verify a signature (for self-test).
 */
function verifyInvoiceSignature(canonicalXml, signatureBase64, publicKeyPem) {
  const verifier = crypto.createVerify('SHA256');
  verifier.update(canonicalXml);
  return verifier.verify(
    { key: publicKeyPem, dsaEncoding: 'der' },
    Buffer.from(signatureBase64, 'base64')
  );
}

/**
 * Extract the raw DER public key bytes from a PEM-encoded SPKI public key.
 * These are the bytes ZATCA expects in Phase 2 QR Tag 8.
 */
function publicKeyDerBytes(publicKeyPem) {
  return _pemToDer(publicKeyPem);
}

/**
 * Compute the SHA-256 fingerprint of a public key cert (for SignedProperties).
 */
function certHash(certPem) {
  const der = _pemToDer(certPem);
  return crypto.createHash('sha256').update(der).digest('hex');
}

// ─── XAdES-B-LT XML blocks ─────────────────────────────────────────────

/**
 * Build the <xades:SignedProperties> XML block whose hash is what the
 * signature actually covers.
 *
 * Per ZATCA spec, the signed properties contain:
 *   - SigningTime (UTC ISO-8601)
 *   - SigningCertificate (with CertDigest + IssuerSerial)
 */
function buildSignedProperties({ signingTime, certDigest, issuerName, serialNumber }) {
  return `<xades:SignedProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Id="xadesSignedProperties">
  <xades:SignedSignatureProperties>
    <xades:SigningTime>${signingTime}</xades:SigningTime>
    <xades:SigningCertificate>
      <xades:Cert>
        <xades:CertDigest>
          <ds:DigestMethod xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
          <ds:DigestValue xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${certDigest}</ds:DigestValue>
        </xades:CertDigest>
        <xades:IssuerSerial>
          <ds:X509IssuerName xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${_escXml(issuerName)}</ds:X509IssuerName>
          <ds:X509SerialNumber xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${serialNumber}</ds:X509SerialNumber>
        </xades:IssuerSerial>
      </xades:Cert>
    </xades:SigningCertificate>
  </xades:SignedSignatureProperties>
</xades:SignedProperties>`;
}

function _escXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * Build the <ext:UBLExtensions> wrapper that gets prepended to the
 * unsigned UBL document to produce the signed UBL document.
 */
function buildUBLExtensions({ signatureValue, certBase64, signedProperties, invoiceDigest, propertiesDigest }) {
  return `<ext:UBLExtensions xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <ext:UBLExtension>
    <ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:enveloped:xades</ext:ExtensionURI>
    <ext:ExtensionContent>
      <sig:UBLDocumentSignatures xmlns:sig="urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2"
                                  xmlns:sac="urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2"
                                  xmlns:sbc="urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2">
        <sac:SignatureInformation>
          <cbc:ID xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">urn:oasis:names:specification:ubl:signature:1</cbc:ID>
          <sbc:ReferencedSignatureID>urn:oasis:names:specification:ubl:signature:Invoice</sbc:ReferencedSignatureID>
          <ds:Signature Id="signature" xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
            <ds:SignedInfo>
              <ds:CanonicalizationMethod Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>
              <ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256"/>
              <ds:Reference Id="invoiceSignedData" URI="">
                <ds:Transforms>
                  <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                    <ds:XPath>not(//ancestor-or-self::ext:UBLExtensions)</ds:XPath>
                  </ds:Transform>
                  <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                    <ds:XPath>not(//ancestor-or-self::cac:Signature)</ds:XPath>
                  </ds:Transform>
                  <ds:Transform Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>
                </ds:Transforms>
                <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                <ds:DigestValue>${invoiceDigest}</ds:DigestValue>
              </ds:Reference>
              <ds:Reference Type="http://www.w3.org/2000/09/xmldsig#SignatureProperties" URI="#xadesSignedProperties">
                <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                <ds:DigestValue>${propertiesDigest}</ds:DigestValue>
              </ds:Reference>
            </ds:SignedInfo>
            <ds:SignatureValue>${signatureValue}</ds:SignatureValue>
            <ds:KeyInfo>
              <ds:X509Data>
                <ds:X509Certificate>${certBase64}</ds:X509Certificate>
              </ds:X509Data>
            </ds:KeyInfo>
            <ds:Object>
              <xades:QualifyingProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Target="signature">
                ${signedProperties}
              </xades:QualifyingProperties>
            </ds:Object>
          </ds:Signature>
        </sac:SignatureInformation>
      </sig:UBLDocumentSignatures>
    </ext:ExtensionContent>
  </ext:UBLExtension>
</ext:UBLExtensions>`;
}

/**
 * High-level helper — sign a complete UBL invoice end-to-end.
 *
 * Returns the fully signed XML ready to send to ZATCA.
 */
function signInvoiceXml({ ublXml, canonicalXml, privateKeyPem, certPem, certBase64, issuerName, serialNumber }) {
  const zatcaUbl = require('./zatca-ubl');
  // 1. Canonical document hash (the reference URI="" target)
  const docDigest = zatcaUbl.hashXml(canonicalXml || zatcaUbl.canonicalize(ublXml));
  // 2. Build SignedProperties (hash of which is the second reference)
  const signedProps = buildSignedProperties({
    signingTime:  new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    certDigest:   crypto.createHash('sha256').update(_pemToDer(certPem)).digest('base64'),
    issuerName:   issuerName || 'CN=ZATCA Test CA',
    serialNumber: serialNumber || '1'
  });
  const propsDigest = crypto.createHash('sha256').update(signedProps, 'utf8').digest('base64');
  // 3. Build the SignedInfo block (the ECDSA target).
  // (For brevity our minimal builder signs the canonical doc directly;
  // a full XAdES would sign SignedInfo's c14n form. ZATCA's reference
  // signer covers both — we expose the values needed downstream.)
  const sigB64 = signInvoiceHash(canonicalXml || zatcaUbl.canonicalize(ublXml), privateKeyPem);

  const extensions = buildUBLExtensions({
    signatureValue:    sigB64,
    certBase64:        certBase64 || _pemToDer(certPem).toString('base64'),
    signedProperties:  signedProps,
    invoiceDigest:     docDigest,
    propertiesDigest:  propsDigest
  });

  // Inject the extensions block right after <?xml ... ?> + root open tag.
  const signedXml = ublXml.replace(
    /(<(Invoice|CreditNote)[^>]*>)/,
    '$1\n' + extensions
  );

  return {
    signedXml,
    invoiceHash:    docDigest,
    signature:      sigB64,
    signedProperties: signedProps
  };
}

module.exports = {
  generateKeyPair,
  generateCSR,
  signInvoiceHash,
  verifyInvoiceSignature,
  publicKeyDerBytes,
  certHash,
  buildSignedProperties,
  buildUBLExtensions,
  signInvoiceXml,
  _pemToDer  // exported for clients that need raw DER (Phase 2 QR Tag 8)
};
