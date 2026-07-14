'use strict';
/*
 * lib/passwordPolicy.js — strong-password policy for self-service change.
 *
 * Rules are DRIVEN BY an admin-configurable policy (settings key
 * `SecurityPasswordPolicy`, managed by routes/security-policies.js). Until a
 * policy is stored — and in any pure/unit context that never loads settings —
 * validate() falls back to DEFAULT_POLICY, which mirrors the historically
 * hardcoded rules EXACTLY so existing behavior is unchanged:
 *   minimum 12 (recommend 16+), must include a letter + digit + special char,
 *   must NOT be a known-exposed/common password, and must not equal the username.
 *
 * validate() stays SYNCHRONOUS (so the existing auth.js call site is untouched):
 * it reads a process-wide cached policy that the security-policies route warms at
 * server startup (refresh()) and updates immediately after a save (setPolicy()).
 * Importing this module never touches the DB — db is lazy-required inside
 * refresh() only — so the pure unit tests remain pure and dependency-free.
 * (bcrypt.compare for "same as current" lives in the route.)
 */
const COMMON = new Set([
  'admin123', 'admin', 'password', 'password1', 'passw0rd', '123456', '1234567',
  '12345678', '123456789', '1234567890', 'qwerty', 'qwerty123', 'letmein',
  'welcome', 'welcome1', 'changeme', 'admin@123', 'admin1234', 'p@ssw0rd',
  'iloveyou', 'abc123', 'test1234', 'root', 'toor', 'moroccan', 'pos12345',
]);

const SPECIAL = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/;

// Default rules — mirror the historically hardcoded policy so behavior is
// unchanged until an admin stores a stricter one via /api/security-policies.
const DEFAULT_POLICY = Object.freeze({
  minLength: 12,
  requireUpper: false,   // current behavior only requires "a letter", not upper
  requireNumber: true,
  requireSymbol: true,
  expiryDays: 0,         // 0 = passwords never expire (informational for the UI)
});

// Process-wide cache of the admin-configured policy. Stays null until refresh()
// or setPolicy() succeeds; getPolicy() then falls back to DEFAULT_POLICY.
let _stored = null;

function _coercePolicy(raw) {
  const p = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const int = (v, d) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);
  return {
    minLength: Math.min(128, Math.max(6, int(p.minLength, DEFAULT_POLICY.minLength))),
    requireUpper: p.requireUpper == null ? DEFAULT_POLICY.requireUpper : !!p.requireUpper,
    requireNumber: p.requireNumber == null ? DEFAULT_POLICY.requireNumber : !!p.requireNumber,
    requireSymbol: p.requireSymbol == null ? DEFAULT_POLICY.requireSymbol : !!p.requireSymbol,
    expiryDays: Math.min(3650, Math.max(0, int(p.expiryDays, DEFAULT_POLICY.expiryDays))),
  };
}

/** The effective policy (stored config, or the hardcoded defaults). */
function getPolicy() { return _stored || DEFAULT_POLICY; }

/** Prime the in-process cache (called by the route right after a save). */
function setPolicy(raw) { _stored = _coercePolicy(raw); return _stored; }

/**
 * Best-effort load from the `settings` table. Lazy-requires db so importing this
 * module never opens a pool. Swallows every error (keeps DEFAULT_POLICY). The
 * security-policies route calls this once at server startup to warm the cache.
 */
async function refresh(dbArg) {
  try {
    const db = dbArg || require('../db/connection');
    const [rows] = await db.query(
      "SELECT setting_value FROM settings WHERE setting_key='SecurityPasswordPolicy' LIMIT 1"
    );
    if (rows && rows.length && rows[0].setting_value) {
      setPolicy(JSON.parse(rows[0].setting_value));
    }
  } catch (_) { /* keep DEFAULT_POLICY */ }
  return getPolicy();
}

function validate(newPassword, opts) {
  const o = opts || {};
  // A per-call `opts.policy` wins (tests / previews); otherwise the cached one.
  const policy = _coercePolicy(o.policy || getPolicy());
  const pw = String(newPassword == null ? '' : newPassword);
  const errors = [];
  if (pw.length < policy.minLength) {
    errors.push(`كلمة المرور يجب أن تكون ${policy.minLength} حرفًا على الأقل` + (policy.minLength < 16 ? ' (يُوصى بـ 16+)' : ''));
  }
  if (!/[a-zA-Z؀-ۿ]/.test(pw)) errors.push('يجب أن تحتوي على حرف');
  if (policy.requireUpper && !/[A-Z]/.test(pw)) errors.push('يجب أن تحتوي على حرف كبير (A-Z)');
  if (policy.requireNumber && !/[0-9]/.test(pw)) errors.push('يجب أن تحتوي على رقم');
  if (policy.requireSymbol && !SPECIAL.test(pw)) errors.push('يجب أن تحتوي على رمز خاص (!@#$…)');
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

module.exports = { validate, strength, COMMON, SPECIAL, DEFAULT_POLICY, getPolicy, setPolicy, refresh };
