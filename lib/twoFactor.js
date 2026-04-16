/**
 * Two-Factor Authentication — TOTP (Time-based One-Time Password)
 * Compatible with Google Authenticator, Authy, Microsoft Authenticator
 * Uses native crypto — no external dependencies
 */
const crypto = require('crypto');

/**
 * Generate a random base32 secret (20 bytes = 32 chars)
 */
function generateSecret() {
  var bytes = crypto.randomBytes(20);
  return base32Encode(bytes);
}

/**
 * Generate TOTP code for current time
 * @param {string} secret - Base32 encoded secret
 * @param {number} timeStep - Time step in seconds (default 30)
 * @returns {string} 6-digit TOTP code
 */
function generateTOTP(secret, timeStep) {
  timeStep = timeStep || 30;
  var counter = Math.floor(Date.now() / 1000 / timeStep);
  return hotpGenerate(secret, counter);
}

/**
 * Verify a TOTP code (allows 1 step before/after for clock skew)
 * @param {string} secret - Base32 encoded secret
 * @param {string} code - 6-digit code to verify
 * @param {number} window - Number of steps to check (default 1)
 * @returns {boolean}
 */
function verifyTOTP(secret, code, window) {
  window = window || 1;
  var timeStep = 30;
  var counter = Math.floor(Date.now() / 1000 / timeStep);
  for (var i = -window; i <= window; i++) {
    if (hotpGenerate(secret, counter + i) === code) return true;
  }
  return false;
}

/**
 * Generate otpauth:// URI for QR code scanning
 * @param {string} secret - Base32 secret
 * @param {string} username - User identifier
 * @param {string} issuer - App name
 * @returns {string} otpauth URI
 */
function generateOTPAuthURI(secret, username, issuer) {
  issuer = issuer || 'MoroccanTaste';
  return 'otpauth://totp/' + encodeURIComponent(issuer) + ':' + encodeURIComponent(username) +
    '?secret=' + secret + '&issuer=' + encodeURIComponent(issuer) + '&digits=6&period=30';
}

// ─── Internal HOTP implementation ───
function hotpGenerate(secret, counter) {
  var key = base32Decode(secret);
  // Counter as 8-byte big-endian buffer
  var buf = Buffer.alloc(8);
  for (var i = 7; i >= 0; i--) {
    buf[i] = counter & 0xff;
    counter = Math.floor(counter / 256);
  }
  var hmac = crypto.createHmac('sha1', key);
  hmac.update(buf);
  var digest = hmac.digest();
  // Dynamic truncation
  var offset = digest[digest.length - 1] & 0x0f;
  var code = ((digest[offset] & 0x7f) << 24) |
             ((digest[offset + 1] & 0xff) << 16) |
             ((digest[offset + 2] & 0xff) << 8) |
             (digest[offset + 3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}

// ─── Base32 Encoding/Decoding ───
var BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  var result = '';
  var bits = 0;
  var value = 0;
  for (var i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      result += BASE32_CHARS[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) result += BASE32_CHARS[(value << (5 - bits)) & 0x1f];
  return result;
}

function base32Decode(str) {
  str = str.replace(/[=\s]/g, '').toUpperCase();
  var bits = 0;
  var value = 0;
  var bytes = [];
  for (var i = 0; i < str.length; i++) {
    var idx = BASE32_CHARS.indexOf(str[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

module.exports = { generateSecret, generateTOTP, verifyTOTP, generateOTPAuthURI };
