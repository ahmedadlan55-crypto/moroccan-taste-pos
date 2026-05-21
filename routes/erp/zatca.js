/**
 * routes/erp/zatca.js — ZATCA Phase 2 onboarding + status endpoints.
 *
 * Owner / admin flow:
 *   1. GET  /api/erp/zatca/status                — current CSID state + queue stats
 *   2. POST /api/erp/zatca/onboard/compliance    — { otp, csrFields } → compliance CSID
 *   3. POST /api/erp/zatca/onboard/production    — graduate compliance → production
 *   4. POST /api/erp/zatca/test                  — submit a synthetic compliance invoice
 *   5. POST /api/erp/zatca/revoke                — clear all credentials
 *
 * v6.1.0 — Wave E.5
 */

const router = require('express').Router();
const db = require('../../db/connection');
const zatcaSigner = require('../../lib/zatca-signer');
const zatcaClient = require('../../lib/zatca-client');
const zatcaUbl    = require('../../lib/zatca-ubl');
const zatca       = require('../../lib/zatca');
const encryption  = require('../../lib/encryption');

router.get('/zatca/status', async (req, res) => {
  try {
    const [c] = await db.query(`
      SELECT zatca_csid_status, zatca_csid_obtained_at, zatca_csid_request_id,
             name, tax_number
        FROM companies WHERE id='CO-MAIN' LIMIT 1`);
    const row = c.length ? c[0] : {};
    let queueStats = { pending: 0, running: 0, done: 0, failed: 0 };
    try {
      const [stats] = await db.query(`
        SELECT status, COUNT(*) AS n FROM zatca_submission_queue GROUP BY status`);
      stats.forEach(s => { queueStats[s.status] = Number(s.n); });
    } catch (_) {}
    let lastSubmittedAt = null;
    try {
      const [last] = await db.query(`
        SELECT MAX(zatca_submitted_at) AS t FROM sales WHERE zatca_submitted_at IS NOT NULL`);
      if (last.length) lastSubmittedAt = last[0].t;
    } catch (_) {}
    res.json({
      success: true,
      csidStatus: row.zatca_csid_status || 'none',
      csidObtainedAt: row.zatca_csid_obtained_at || null,
      requestId: row.zatca_csid_request_id || null,
      sellerName: row.name || '',
      sellerVat: row.tax_number || '',
      lastSubmittedAt,
      queueStats
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/zatca/onboard/compliance', async (req, res) => {
  try {
    const { otp, commonName, organizationName, organizationalUnitName,
            invoiceType, sellerLocation, industryCode, vatNumber, crNumber } = req.body || {};
    if (!otp) return res.json({ success: false, error: 'OTP من بَوَّابة فاتورة مَطلوب' });
    if (!vatNumber) return res.json({ success: false, error: 'الرَّقم الضَّريبي مَطلوب' });

    // 1. Generate keypair
    const { privateKey, publicKey } = zatcaSigner.generateKeyPair();

    // 2. Build CSR
    const csr = zatcaSigner.generateCSR({
      commonName: commonName || vatNumber,
      organizationName: organizationName || '',
      organizationalUnitName: organizationalUnitName || '',
      country: 'SA',
      invoiceType: invoiceType || '1100',
      sellerLocation: sellerLocation || 'Riyadh',
      industryCode: industryCode || '0000',
      privateKey, publicKey
    });

    // 3. Submit to ZATCA compliance endpoint
    const csidResp = await zatcaClient.requestComplianceCSID({ csr, otp });

    // 4. Persist encrypted on the companies row
    await db.query(`
      UPDATE companies SET
        name = COALESCE(NULLIF(?, ''), name),
        tax_number = COALESCE(NULLIF(?, ''), tax_number),
        zatca_csid_request_id = ?,
        zatca_binary_token_encrypted = ?,
        zatca_secret_encrypted = ?,
        zatca_private_key_encrypted = ?,
        zatca_csid_status = 'compliance',
        zatca_csid_obtained_at = NOW()
      WHERE id = 'CO-MAIN'`,
      [
        organizationName || '',
        vatNumber,
        csidResp.requestID || null,
        encryption.encrypt(csidResp.binarySecurityToken || ''),
        encryption.encrypt(csidResp.secret || ''),
        encryption.encrypt(privateKey)
      ]
    );

    res.json({
      success: true,
      csidStatus: 'compliance',
      requestId: csidResp.requestID,
      message: 'تَم تَفعيل CSID للاختبار. أرسِل 3 فواتير اختبارية ثم اضغط "Graduate" للانتقال لـ Production.'
    });
  } catch (e) {
    res.json({ success: false, error: e.message, status: e.status, body: e.body });
  }
});

router.post('/zatca/onboard/production', async (req, res) => {
  try {
    const [c] = await db.query(`
      SELECT zatca_csid_request_id, zatca_binary_token_encrypted, zatca_secret_encrypted,
             zatca_csid_status
      FROM companies WHERE id='CO-MAIN' LIMIT 1`);
    if (!c.length) return res.json({ success: false, error: 'لم يَتم compliance onboarding بَعد' });
    const row = c[0];
    if (row.zatca_csid_status !== 'compliance') {
      return res.json({ success: false, error: 'يَجب إكمال compliance onboarding أولاً' });
    }
    const binaryToken = encryption.decrypt(row.zatca_binary_token_encrypted);
    const secret      = encryption.decrypt(row.zatca_secret_encrypted);
    const prodResp = await zatcaClient.productionCSID({
      requestID: row.zatca_csid_request_id,
      binaryToken, secret
    });
    await db.query(`
      UPDATE companies SET
        zatca_csid_request_id = ?,
        zatca_binary_token_encrypted = ?,
        zatca_secret_encrypted = ?,
        zatca_csid_status = 'production',
        zatca_csid_obtained_at = NOW()
      WHERE id = 'CO-MAIN'`,
      [
        prodResp.requestID || null,
        encryption.encrypt(prodResp.binarySecurityToken || ''),
        encryption.encrypt(prodResp.secret || '')
      ]
    );
    res.json({ success: true, csidStatus: 'production', message: 'تَم الانتقال إلى Production CSID.' });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/zatca/test', async (req, res) => {
  try {
    const [c] = await db.query(`
      SELECT name, tax_number, zatca_binary_token_encrypted, zatca_secret_encrypted,
             zatca_private_key_encrypted, zatca_csid_status
      FROM companies WHERE id='CO-MAIN' LIMIT 1`);
    if (!c.length || c[0].zatca_csid_status === 'none') {
      return res.json({ success: false, error: 'CSID غير مُفعَّل' });
    }
    const row = c[0];
    const seller = {
      name: row.name || '', vatNumber: row.tax_number || '',
      crNumber: process.env.COMPANY_CR || '',
      address: { street: 'Test', buildingNumber: '0000', city: 'Riyadh', postalCode: '00000' }
    };
    const ksaNow = zatca.nowInRiyadh(new Date());
    const sale = {
      id: 'TEST-' + Date.now(),
      orderId: 'TEST-' + Date.now(),
      invoiceUuid: zatca.uuidV4(),
      previousInvoiceHash: '0'.repeat(64),
      issueDate: ksaNow.date, issueTime: ksaNow.time,
      total: 115.00, vatAmount: 15.00,
      paymentMethod: 'Cash'
    };
    const xml = zatcaUbl.buildSimplifiedInvoiceXml({
      sale, seller,
      lines: [{ name: 'Test Item', qty: 1, unitPrice: 115.00, taxCategory: 'S' }],
      taxSubtotals: { S: { net: 100.00, vat: 15.00, rate: 15 } }
    });
    const canonical = zatcaUbl.canonicalize(xml);
    const privateKey = encryption.decrypt(row.zatca_private_key_encrypted);
    const sig = zatcaSigner.signInvoiceXml({
      ublXml: xml, canonicalXml: canonical,
      privateKeyPem: privateKey, certPem: '',
      certBase64: encryption.decrypt(row.zatca_binary_token_encrypted),
      issuerName: 'CN=ZATCA', serialNumber: '1'
    });
    const submitResult = await zatcaClient.complianceInvoiceUpload({
      invoiceHash: sig.invoiceHash,
      uuid: sale.invoiceUuid,
      invoiceXmlBase64: Buffer.from(sig.signedXml, 'utf8').toString('base64'),
      binaryToken: encryption.decrypt(row.zatca_binary_token_encrypted),
      secret: encryption.decrypt(row.zatca_secret_encrypted)
    });
    res.json({
      success: submitResult.status === 200 || submitResult.status === 202,
      httpStatus: submitResult.status,
      response: submitResult.body,
      invoiceUuid: sale.invoiceUuid,
      invoiceHash: sig.invoiceHash
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/zatca/revoke', async (req, res) => {
  try {
    await db.query(`
      UPDATE companies SET
        zatca_csid_request_id = NULL,
        zatca_binary_token_encrypted = NULL,
        zatca_secret_encrypted = NULL,
        zatca_private_key_encrypted = NULL,
        zatca_csid_status = 'revoked'
      WHERE id = 'CO-MAIN'`);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

module.exports = router;
