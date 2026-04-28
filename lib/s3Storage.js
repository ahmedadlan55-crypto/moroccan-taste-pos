/**
 * V4 — Optional S3/R2 attachment storage
 * If S3_* env vars are set, attachments are uploaded to S3 and only the
 * URL is stored in the DB. Otherwise falls back to base64 inside the row.
 *
 * Required env vars (set in Railway → Variables):
 *   S3_ENDPOINT          — e.g. https://<acct>.r2.cloudflarestorage.com
 *   S3_REGION            — usually 'auto' for R2 or 'us-east-1' for AWS
 *   S3_ACCESS_KEY_ID
 *   S3_SECRET_ACCESS_KEY
 *   S3_BUCKET
 *   S3_PUBLIC_BASE_URL   — public URL prefix (for downloads)
 *
 * Optional:
 *   S3_PATH_PREFIX       — folder prefix (default 'attachments/')
 */

'use strict';

const crypto = require('crypto');
const https = require('https');

const ENABLED = !!(process.env.S3_ENDPOINT && process.env.S3_BUCKET &&
                   process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY);
const ENDPOINT = process.env.S3_ENDPOINT || '';
const REGION = process.env.S3_REGION || 'auto';
const ACCESS_KEY = process.env.S3_ACCESS_KEY_ID || '';
const SECRET_KEY = process.env.S3_SECRET_ACCESS_KEY || '';
const BUCKET = process.env.S3_BUCKET || '';
const PUBLIC_BASE = process.env.S3_PUBLIC_BASE_URL || ENDPOINT;
const PATH_PREFIX = process.env.S3_PATH_PREFIX || 'attachments/';

if (ENABLED) {
  console.log('[s3] enabled — bucket:', BUCKET, 'region:', REGION);
} else {
  console.log('[s3] disabled — attachments stored inline (set S3_* env vars to enable)');
}

// Pure-Node SigV4 signer (no aws-sdk dependency to keep bundle small)
function _hmac(key, val, enc) { return crypto.createHmac('sha256', key).update(val).digest(enc); }
function _sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function _signRequest(method, key, contentType, bodyHash) {
  const now = new Date();
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = date.substring(0, 8);
  const url = new URL(ENDPOINT);
  const host = url.host;
  const path = url.pathname.replace(/\/$/, '') + '/' + BUCKET + '/' + key;

  const headers = {
    'host': host,
    'x-amz-content-sha256': bodyHash,
    'x-amz-date': date,
    'content-type': contentType
  };
  const signedHeadersList = Object.keys(headers).sort();
  const canonicalHeaders = signedHeadersList.map(k => `${k}:${headers[k]}\n`).join('');
  const signedHeaders = signedHeadersList.join(';');
  const canonicalRequest = `${method}\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${bodyHash}`;
  const credentialScope = `${dateStamp}/${REGION}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${credentialScope}\n${_sha256(canonicalRequest)}`;
  const kDate = _hmac('AWS4' + SECRET_KEY, dateStamp);
  const kRegion = _hmac(kDate, REGION);
  const kService = _hmac(kRegion, 's3');
  const kSigning = _hmac(kService, 'aws4_request');
  const signature = _hmac(kSigning, stringToSign, 'hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers: Object.assign({}, headers, { Authorization: authorization }), path };
}

/**
 * Upload data URL (or raw buffer) to S3.
 * Returns { url, key, size, mime } on success.
 * Throws if S3 not configured or upload fails.
 */
async function upload(dataUrlOrBuffer, fileName, mimeOverride) {
  if (!ENABLED) throw new Error('S3 not enabled');

  let body, mime;
  if (typeof dataUrlOrBuffer === 'string' && dataUrlOrBuffer.startsWith('data:')) {
    const m = dataUrlOrBuffer.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) throw new Error('Invalid data URL');
    mime = mimeOverride || m[1];
    body = Buffer.from(m[2], 'base64');
  } else if (Buffer.isBuffer(dataUrlOrBuffer)) {
    body = dataUrlOrBuffer;
    mime = mimeOverride || 'application/octet-stream';
  } else {
    throw new Error('upload accepts data URL or Buffer');
  }

  const safeName = (fileName || 'file').replace(/[^\w.\-]/g, '_').substring(0, 100);
  const key = PATH_PREFIX + new Date().toISOString().slice(0, 7).replace('-', '/') + '/' +
              crypto.randomBytes(8).toString('hex') + '-' + safeName;
  const bodyHash = _sha256(body);
  const { headers, path } = _signRequest('PUT', key, mime, bodyHash);

  return new Promise((resolve, reject) => {
    const url = new URL(ENDPOINT);
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: path,
      method: 'PUT',
      headers: Object.assign({}, headers, { 'Content-Length': body.length }),
      timeout: 30000   // V4.5.2: 30s hard timeout — never hang forever
    }, (res) => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const publicUrl = PUBLIC_BASE.replace(/\/$/, '') + '/' + key;
          resolve({ url: publicUrl, key, size: body.length, mime });
        } else {
          reject(new Error(`S3 upload failed (${res.statusCode}): ${Buffer.concat(chunks).toString().substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('S3 upload timed out after 30s'));
    });
    req.write(body);
    req.end();
  });
}

/**
 * If the input string looks like a data URL AND S3 is enabled, upload to
 * S3 and return the URL. Otherwise return the input unchanged. Idempotent —
 * safe to call on already-uploaded URLs.
 */
async function maybeUpload(dataUrlOrUrl, fileName, mime) {
  if (!ENABLED) return dataUrlOrUrl;   // pass through to inline storage
  if (typeof dataUrlOrUrl !== 'string') return dataUrlOrUrl;
  if (!dataUrlOrUrl.startsWith('data:')) return dataUrlOrUrl;   // already an URL
  try {
    const result = await upload(dataUrlOrUrl, fileName, mime);
    return result.url;
  } catch (e) {
    console.warn('[s3] upload failed, falling back to inline:', e.message);
    return dataUrlOrUrl;
  }
}

module.exports = {
  ENABLED,
  upload,
  maybeUpload
};
