/**
 * Shared Utilities — Enterprise Standard
 * Eliminates code duplication across all route files
 */

// ─── ID Generator ───
function generateId(prefix) {
  return prefix + '-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
}

// ─── Sequential Number Generator ───
async function getNextNumber(db, table, column, prefix, padLength) {
  padLength = padLength || 5;
  try {
    const [last] = await db.query('SELECT ' + column + ' FROM ' + table + ' ORDER BY created_at DESC LIMIT 1');
    var num = 1;
    if (last.length && last[0][column]) {
      var m = last[0][column].match(/(\d+)/);
      if (m) num = parseInt(m[1]) + 1;
    }
    return prefix + String(num).padStart(padLength, '0');
  } catch (e) {
    return prefix + String(Date.now()).slice(-padLength);
  }
}

// ─── Payment Method Detector ───
function detectPaymentMethod(methodStr) {
  var m = (methodStr || '').toLowerCase().trim();
  if (m.includes('kita') || m.includes('كيتا')) return 'kita';
  if (m.includes('card') || m.includes('mada') || m.includes('شبكة') || m.includes('مدى') || m.includes('visa') || m.includes('master')) return 'card';
  if (m.includes('transfer') || m.includes('تحويل') || m.includes('bank')) return 'transfer';
  return 'cash';
}

// ─── Format Currency ───
function formatCurrency(amount, decimals) {
  return Number(amount || 0).toFixed(decimals || 2);
}

// ─── Constants ───
const CONSTANTS = {
  VAT_RATE: 0.15,
  VAT_FACTOR: 1.15,
  MAX_LOGIN_ATTEMPTS: 5,
  LOCKOUT_DURATION_MS: 15 * 60 * 1000,
  SESSION_DURATION: '24h',
  PASSWORD_MIN_LENGTH: 6,
  PAYMENT_METHODS: { CASH: 'cash', CARD: 'card', KITA: 'kita', TRANSFER: 'transfer' },
  EMPLOYEE_STATUS: { ACTIVE: 'active', SUSPENDED: 'suspended', TERMINATED: 'terminated', ON_LEAVE: 'on_leave' },
  LEAVE_STATUS: { PENDING: 'pending', BRANCH_APPROVED: 'branch_approved', HR_APPROVED: 'hr_approved', REJECTED: 'rejected' },
  PAYROLL_STATUS: { DRAFT: 'draft', CALCULATED: 'calculated', APPROVED: 'approved', PAID: 'paid' }
};

// ─── Sanitize HTML (prevent XSS) ───
function sanitizeHtml(str) {
  if (!str || typeof str !== 'string') return str;
  return str.replace(/[<>]/g, function(c) { return { '<': '&lt;', '>': '&gt;' }[c]; });
}

// ─── Validate Email ───
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ─── Validate Password Strength ───
function validatePassword(password) {
  var errors = [];
  if (!password || password.length < 6) errors.push('6 أحرف على الأقل');
  if (!/[a-zA-Z]/.test(password)) errors.push('يجب أن تحتوي حروف');
  if (!/[0-9]/.test(password)) errors.push('يجب أن تحتوي أرقام');
  if (!/[!@#$%^&*()_+\-=\[\]{};':"|,.<>\/?]/.test(password)) errors.push('يجب أن تحتوي رمز خاص');
  return errors;
}

module.exports = {
  generateId,
  getNextNumber,
  detectPaymentMethod,
  formatCurrency,
  sanitizeHtml,
  isValidEmail,
  validatePassword,
  CONSTANTS
};
