/**
 * Field-Level Encryption — Enterprise Data Protection
 * Encrypts sensitive fields (salary, national_id, bank_iban) at rest
 * Uses AES-256-CBC with a configurable secret key
 */
const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;

// Key derived from environment variable or fallback
function getKey() {
  const secret = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || 'moroccan-taste-default-key-change-me';
  // Ensure 32 bytes for AES-256
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypt a string value
 * @param {string} text - Plain text to encrypt
 * @returns {string} Encrypted string (iv:encrypted in hex)
 */
function encrypt(text) {
  if (!text || typeof text !== 'string') return text;
  // Don't double-encrypt
  if (text.indexOf(':enc:') === 0) return text;
  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return ':enc:' + iv.toString('hex') + ':' + encrypted;
  } catch (e) {
    return text; // Fail silently — return unencrypted
  }
}

/**
 * Decrypt a string value
 * @param {string} text - Encrypted string
 * @returns {string} Decrypted plain text
 */
function decrypt(text) {
  if (!text || typeof text !== 'string') return text;
  // Only decrypt if it's actually encrypted
  if (text.indexOf(':enc:') !== 0) return text;
  try {
    const parts = text.substring(5).split(':');
    if (parts.length < 2) return text;
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    return text; // If decryption fails, return as-is
  }
}

/**
 * Encrypt specific fields in an object
 * @param {object} obj - Data object
 * @param {string[]} fields - Field names to encrypt
 * @returns {object} Object with encrypted fields
 */
function encryptFields(obj, fields) {
  if (!obj) return obj;
  var result = Object.assign({}, obj);
  fields.forEach(function(f) {
    if (result[f] && typeof result[f] === 'string' && result[f].length > 0) {
      result[f] = encrypt(result[f]);
    }
  });
  return result;
}

/**
 * Decrypt specific fields in an object
 * @param {object} obj - Data object with encrypted fields
 * @param {string[]} fields - Field names to decrypt
 * @returns {object} Object with decrypted fields
 */
function decryptFields(obj, fields) {
  if (!obj) return obj;
  var result = Object.assign({}, obj);
  fields.forEach(function(f) {
    if (result[f] && typeof result[f] === 'string') {
      result[f] = decrypt(result[f]);
    }
  });
  return result;
}

// Fields that should be encrypted in each table
const SENSITIVE_FIELDS = {
  hr_employees: ['national_id', 'passport_number', 'iqama_number', 'bank_account', 'bank_iban'],
  users: ['email']
};

module.exports = { encrypt, decrypt, encryptFields, decryptFields, SENSITIVE_FIELDS };
