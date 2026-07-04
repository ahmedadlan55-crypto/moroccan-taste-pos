'use strict';
/*
 * lib/passwordPolicy.js — strong-password policy for self-service change.
 * Minimum 12 (recommend 16+), must include a letter + digit + special char,
 * must NOT be a known-exposed/common password, and must not equal the username.
 * Pure + dependency-free (bcrypt.compare for "same as current" lives in the route).
 */
const COMMON = new Set([
  'admin123', 'admin', 'password', 'password1', 'passw0rd', '123456', '1234567',
  '12345678', '123456789', '1234567890', 'qwerty', 'qwerty123', 'letmein',
  'welcome', 'welcome1', 'changeme', 'admin@123', 'admin1234', 'p@ssw0rd',
  'iloveyou', 'abc123', 'test1234', 'root', 'toor', 'moroccan', 'pos12345',
]);

const SPECIAL = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/;

function validate(newPassword, opts) {
  const o = opts || {};
  const pw = String(newPassword == null ? '' : newPassword);
  const errors = [];
  if (pw.length < 12) errors.push('كلمة المرور يجب أن تكون 12 حرفًا على الأقل (يُوصى بـ 16+)');
  if (!/[a-zA-Z؀-ۿ]/.test(pw)) errors.push('يجب أن تحتوي على حرف');
  if (!/[0-9]/.test(pw)) errors.push('يجب أن تحتوي على رقم');
  if (!SPECIAL.test(pw)) errors.push('يجب أن تحتوي على رمز خاص (!@#$…)');
  if (COMMON.has(pw.toLowerCase().trim())) errors.push('كلمة مرور شائعة أو افتراضية — اختر كلمة أقوى');
  if (o.username && pw.toLowerCase().trim() === String(o.username).toLowerCase().trim()) errors.push('كلمة المرور لا يجب أن تساوي اسم المستخدم');
  return { ok: errors.length === 0, errors };
}

// 0..4 strength score for the UI meter (also usable server-side for telemetry).
function strength(pw) {
  const s = String(pw || '');
  let score = 0;
  if (s.length >= 12) score++;
  if (s.length >= 16) score++;
  if (/[a-z]/.test(s) && /[A-Z]/.test(s)) score++;
  if (/[0-9]/.test(s) && SPECIAL.test(s)) score++;
  if (COMMON.has(s.toLowerCase().trim())) score = 0;
  return Math.min(4, score);
}

module.exports = { validate, strength, COMMON, SPECIAL };
