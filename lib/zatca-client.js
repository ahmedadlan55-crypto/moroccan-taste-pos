/**
 * lib/zatca-client.js — HTTPS client for ZATCA Fatoora portal APIs.
 *
 * Endpoints supported:
 *   1. POST /compliance              — request Compliance CSID (after CSR)
 *   2. POST /compliance/invoices     — submit a test/compliance invoice
 *   3. POST /production/csids        — graduate to production CSID
 *   4. POST /invoices/reporting/single   — submit a Simplified (B2C) invoice
 *   5. POST /invoices/clearance/single   — submit a Standard (B2B) invoice
 *
 * Environment selection via env vars:
 *   ZATCA_ENV            sandbox | simulation | production   (default: sandbox)
 *   ZATCA_SANDBOX_URL    base URL (default: ZATCA developer portal)
 *   ZATCA_SIMULATION_URL base URL
 *   ZATCA_PRODUCTION_URL base URL
 *
 * Auth:
 *   - The compliance CSID request uses HTTP Basic with the OTP as the
 *     username and an empty password (per ZATCA spec).
 *   - All subsequent requests use Basic auth with the binary security
 *     token (the CSID cert in base64) as username and the secret as
 *     password — both returned by the CSID issuance call.
 *
 * Pure-Node (https module). No third-party deps.
 *
 * v6.1.0 — Wave E.4
 */

const https = require('https');
const { URL } = require('url');

const DEFAULT_URLS = {
  sandbox:    'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal',
  simulation: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation',
  production: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/core'
};

function baseUrl() {
  const env = (process.env.ZATCA_ENV || 'sandbox').toLowerCase();
  switch (env) {
    case 'production': return process.env.ZATCA_PRODUCTION_URL || DEFAULT_URLS.production;
    case 'simulation': return process.env.ZATCA_SIMULATION_URL || DEFAULT_URLS.simulation;
    default:           return process.env.ZATCA_SANDBOX_URL    || DEFAULT_URLS.sandbox;
  }
}

function _post(path, body, headers) {
  return new Promise((resolve, reject) => {
    let urlStr;
    try {
      urlStr = baseUrl() + path;
      // sanity-check URL — throws if invalid
      // eslint-disable-next-line no-new
      new URL(urlStr);
    } catch (e) {
      return reject(new Error('Bad ZATCA URL: ' + (urlStr || '') + ' — ' + e.message));
    }
    const u = new URL(urlStr);
    const bodyJson = JSON.stringify(body || {});
    const opts = {
      method: 'POST',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: Object.assign(
        {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Accept-Version': 'V2',
          'Content-Length': Buffer.byteLength(bodyJson)
        },
        headers || {}
      ),
      // Use Node's default trust store; ZATCA certs are public
      timeout: 30000
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = { raw }; }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: parsed
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('ZATCA request timeout (30s)'));
    });
    req.write(bodyJson);
    req.end();
  });
}

function _basicAuth(user, pass) {
  return 'Basic ' + Buffer.from((user || '') + ':' + (pass || ''), 'utf8').toString('base64');
}

// ─── 1. Compliance CSID request ────────────────────────────────────────

/**
 * Submit the CSR + OTP to ZATCA's compliance endpoint. Returns a
 * "binarySecurityToken" (base64 of the issued cert) + "secret" — both
 * required to authenticate subsequent compliance + production calls.
 *
 * @param {Object} opts
 *   opts.csr  — base64 of the DER-encoded CSR (or PEM stripped to base64)
 *   opts.otp  — 6-digit OTP from Fatoora portal
 * @returns {Promise<{requestID, binarySecurityToken, secret}>}
 */
async function requestComplianceCSID({ csr, otp }) {
  const csrBase64 = String(csr || '')
    .replace(/-----BEGIN CERTIFICATE REQUEST-----/g, '')
    .replace(/-----END CERTIFICATE REQUEST-----/g, '')
    .replace(/\s+/g, '');
  const res = await _post('/compliance', { csr: csrBase64 }, {
    OTP: String(otp || '')
  });
  if (res.status !== 200 && res.status !== 201) {
    const err = new Error('ZATCA compliance CSID failed: HTTP ' + res.status + ' ' + JSON.stringify(res.body));
    err.status = res.status;
    err.body = res.body;
    throw err;
  }
  return {
    requestID:           res.body.requestID,
    binarySecurityToken: res.body.binarySecurityToken,
    secret:              res.body.secret
  };
}

// ─── 2. Compliance invoice upload (sandbox test) ───────────────────────

/**
 * Submit a signed invoice to /compliance/invoices for sandbox validation.
 *
 * @param {Object} opts
 *   opts.invoiceHash      — base64 SHA-256 of canonical UBL XML
 *   opts.uuid             — invoice UUID
 *   opts.invoiceXmlBase64 — base64 of the signed UBL XML
 *   opts.binaryToken      — from requestComplianceCSID
 *   opts.secret           — from requestComplianceCSID
 * @returns {Promise<{status, body}>}
 */
async function complianceInvoiceUpload({ invoiceHash, uuid, invoiceXmlBase64, binaryToken, secret }) {
  return _post('/compliance/invoices', {
    invoiceHash, uuid, invoice: invoiceXmlBase64
  }, {
    Authorization: _basicAuth(binaryToken, secret)
  });
}

// ─── 3. Production CSID graduation ─────────────────────────────────────

async function productionCSID({ requestID, binaryToken, secret }) {
  const res = await _post('/production/csids', { compliance_request_id: requestID }, {
    Authorization: _basicAuth(binaryToken, secret)
  });
  if (res.status !== 200 && res.status !== 201) {
    const err = new Error('ZATCA production CSID failed: HTTP ' + res.status);
    err.status = res.status; err.body = res.body;
    throw err;
  }
  return {
    requestID:           res.body.requestID,
    binarySecurityToken: res.body.binarySecurityToken,
    secret:              res.body.secret
  };
}

// ─── 4. Reporting (B2C Simplified) ─────────────────────────────────────

async function reportInvoice({ invoiceHash, uuid, invoiceXmlBase64, binaryToken, secret }) {
  return _post('/invoices/reporting/single', {
    invoiceHash, uuid, invoice: invoiceXmlBase64
  }, {
    Authorization:  _basicAuth(binaryToken, secret),
    'Clearance-Status': '0'
  });
}

// ─── 5. Clearance (B2B Standard) ───────────────────────────────────────

async function clearanceInvoice({ invoiceHash, uuid, invoiceXmlBase64, binaryToken, secret }) {
  return _post('/invoices/clearance/single', {
    invoiceHash, uuid, invoice: invoiceXmlBase64
  }, {
    Authorization:  _basicAuth(binaryToken, secret),
    'Clearance-Status': '1'
  });
}

module.exports = {
  baseUrl,
  requestComplianceCSID,
  complianceInvoiceUpload,
  productionCSID,
  reportInvoice,
  clearanceInvoice
};
