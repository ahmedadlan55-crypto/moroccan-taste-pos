/**
 * routes/security-policies.js — Advanced security policies (settings-backed).
 *
 * Closure Sprint v2. Mounted at /api/security-policies (server.js). Persists three
 * policy blocks in the existing `settings` table (same get/set pattern as
 * routes/settings.js) as JSON under the keys below, and exposes them for the
 * unified Administration › Security screen:
 *
 *   SecurityPasswordPolicy         → { minLength, requireUpper, requireNumber, requireSymbol, expiryDays }
 *   SecuritySession                → { idleTimeoutMinutes, absoluteTimeoutHours }
 *   SecurityIpAllowlist            → { enabled, cidrs:[] }
 *   ProcurementSelfApprovalPolicy  → { enabled, thresholdAmount }
 *
 * RBAC (the global /api gate already set req.user):
 *   GET  → requireCapability('administration.security')
 *   PUT  → requireCapability('administration.security.manage')
 *
 * ENFORCEMENT wired here:
 *   • Password policy — WIRED. lib/passwordPolicy.validate() honors the stored
 *     policy (warmed at startup via passwordPolicy.refresh(); updated instantly
 *     after a save via setPolicy()). The change-password route already calls
 *     validate() → the policy is enforced end-to-end with NO edit to auth.js.
 *   • IP allowlist — a ready-to-mount Express middleware is EXPORTED
 *     (module.exports.ipAllowlistMiddleware). It fails OPEN on any error and is a
 *     no-op unless the allowlist is enabled AND non-empty, so it can never lock
 *     everyone out. It is intentionally NOT mounted here (that requires editing
 *     server.js). Wiring it is a 1-line central follow-up — see the report.
 *   • Session timeout — persisted + exposed for the client to honor; no
 *     server-side session store exists to safely enforce it here.
 *   • Purchase-order self-approval (فصل المهام) — WIRED. The block is stored
 *     here but READ and ENFORCED by routes/procurement/orders.js inside the
 *     approval transaction (lib/procurement/config.selfApprovalPolicy). The key
 *     name and the merge/normalisation live in that module so the writer here
 *     and the enforcer there can never drift apart. There is no cache to bust:
 *     the enforcer reads the row per approval, so a save takes effect at once
 *     across every server process.
 */
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db/connection');
const requireCapability = require('../middleware/requireCapability');
const passwordPolicy = require('../lib/passwordPolicy');
const procurementCfg = require('../lib/procurement/config');

// ── settings keys ────────────────────────────────────────────────────────────
const KEY_PW = 'SecurityPasswordPolicy';
const KEY_SESSION = 'SecuritySession';
const KEY_IP = 'SecurityIpAllowlist';
// Owned by lib/procurement/config.js — the module that enforces it.
const KEY_PROC_APPROVAL = procurementCfg.SELF_APPROVAL_KEY;

// ── sensible defaults returned when a block is unset ─────────────────────────
const DEFAULT_PW = { minLength: 12, requireUpper: false, requireNumber: true, requireSymbol: true, expiryDays: 0 };
const DEFAULT_SESSION = { idleTimeoutMinutes: 30, absoluteTimeoutHours: 12 };
const DEFAULT_IP = { enabled: false, cidrs: [] };

// ── settings table helpers (mirror routes/settings.js) ───────────────────────
async function readSetting(key) {
  try {
    const [rows] = await db.query('SELECT setting_value FROM settings WHERE setting_key = ? LIMIT 1', [key]);
    if (rows.length && rows[0].setting_value) return JSON.parse(rows[0].setting_value);
  } catch (_) { /* unset or unparsable → defaults */ }
  return null;
}
async function writeSetting(key, obj) {
  const val = JSON.stringify(obj);
  await db.query(
    'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
    [key, val, val]
  );
}

function _mergePw(v) { return Object.assign({}, DEFAULT_PW, (v && typeof v === 'object') ? v : {}); }
function _mergeSession(v) { return Object.assign({}, DEFAULT_SESSION, (v && typeof v === 'object') ? v : {}); }
function _mergeIp(v) {
  return {
    enabled: !!(v && v.enabled),
    cidrs: v && Array.isArray(v.cidrs) ? v.cidrs.map(String) : [],
  };
}
/**
 * Unset → whatever is ACTUALLY in force (the PROCUREMENT_MAKER_CHECKER env
 * default), never a hardcoded guess — a settings screen that showed "off" while
 * the server enforced "on" would be worse than no screen at all.
 */
function _mergeProcApproval(v) {
  return procurementCfg.normalizeSelfApprovalPolicy(v, procurementCfg.defaultSelfApprovalPolicy());
}

// ── validation ───────────────────────────────────────────────────────────────
function toInt(v, d) { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : d; }
const isObj = (o) => o != null && typeof o === 'object' && !Array.isArray(o);

function validatePasswordPolicy(raw) {
  if (!isObj(raw)) return { error: 'passwordPolicy غير صالحة' };
  const minLength = toInt(raw.minLength, NaN);
  if (!Number.isInteger(minLength) || minLength < 6 || minLength > 128) {
    return { error: 'الحد الأدنى لطول كلمة المرور يجب أن يكون رقمًا بين 6 و 128' };
  }
  const expiryDays = toInt(raw.expiryDays, 0);
  if (expiryDays < 0 || expiryDays > 3650) {
    return { error: 'مدة صلاحية كلمة المرور يجب أن تكون بين 0 و 3650 يومًا' };
  }
  return { value: {
    minLength,
    requireUpper: !!raw.requireUpper,
    requireNumber: !!raw.requireNumber,
    requireSymbol: !!raw.requireSymbol,
    expiryDays,
  } };
}

function validateSession(raw) {
  if (!isObj(raw)) return { error: 'session غير صالحة' };
  const idle = toInt(raw.idleTimeoutMinutes, NaN);
  if (!Number.isInteger(idle) || idle < 0 || idle > 1440) {
    return { error: 'مهلة الخمول يجب أن تكون بين 0 و 1440 دقيقة' };
  }
  const abs = toInt(raw.absoluteTimeoutHours, NaN);
  if (!Number.isInteger(abs) || abs < 0 || abs > 720) {
    return { error: 'المهلة المطلقة يجب أن تكون بين 0 و 720 ساعة' };
  }
  return { value: { idleTimeoutMinutes: idle, absoluteTimeoutHours: abs } };
}

// Accept bare IPv4, IPv4/prefix, and (loosely) IPv6 / IPv6/prefix.
function isValidCidr(s) {
  const str = String(s == null ? '' : s).trim();
  if (!str) return false;
  if (str.includes(':')) {
    const [addr, pfx] = str.split('/');
    if (!/^[0-9a-fA-F:.]+$/.test(addr) || addr.length < 2) return false;
    if (pfx !== undefined) { const p = Number(pfx); if (!Number.isInteger(p) || p < 0 || p > 128) return false; }
    return true;
  }
  const [addr, pfx] = str.split('/');
  const parts = addr.split('.');
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    if (n < 0 || n > 255) return false;
  }
  if (pfx !== undefined) { const p = Number(pfx); if (!Number.isInteger(p) || p < 0 || p > 32) return false; }
  return true;
}

function validateIpAllowlist(raw) {
  if (!isObj(raw)) return { error: 'ipAllowlist غير صالحة' };
  const enabled = !!raw.enabled;
  const list = Array.isArray(raw.cidrs) ? raw.cidrs : [];
  const cidrs = [];
  for (const c of list) {
    const s = String(c == null ? '' : c).trim();
    if (!s) continue;
    if (!isValidCidr(s)) return { error: `عنوان/نطاق غير صالح: ${s}` };
    if (!cidrs.includes(s)) cidrs.push(s);
  }
  // Foot-gun guard: an enabled-but-empty allowlist would (once enforced) block
  // every request. Refuse it so the admin can't accidentally lock everyone out.
  if (enabled && cidrs.length === 0) {
    return { error: 'لا يمكن تفعيل قائمة العناوين المسموح بها دون إضافة عنوان واحد على الأقل' };
  }
  return { value: { enabled, cidrs } };
}

// Segregation of duties on purchase-order approval. `enabled` is REQUIRED to be
// an explicit boolean: a payload that omitted it would otherwise silently keep
// the previous value while the admin believes they just flipped the switch.
const MAX_THRESHOLD = 1e9;
function validateProcApproval(raw) {
  if (!isObj(raw)) return { error: 'سياسة اعتماد أوامر الشراء غير صالحة' };
  if (typeof raw.enabled !== 'boolean') return { error: 'حالة فصل المهام في اعتماد أوامر الشراء مطلوبة (تفعيل/تعطيل)' };
  const amount = raw.thresholdAmount == null || raw.thresholdAmount === '' ? 0 : Number(raw.thresholdAmount);
  if (!Number.isFinite(amount) || amount < 0 || amount > MAX_THRESHOLD) {
    return { error: 'حد فصل المهام يجب أن يكون مبلغًا موجبًا لا يتجاوز 1000000000' };
  }
  return { value: { enabled: raw.enabled, thresholdAmount: Math.round(amount * 100) / 100 } };
}

// ── routes ───────────────────────────────────────────────────────────────────
router.get('/', requireCapability('administration.security'), async (req, res) => {
  try {
    const [pw, session, ip, procApproval] = await Promise.all([
      readSetting(KEY_PW), readSetting(KEY_SESSION), readSetting(KEY_IP), readSetting(KEY_PROC_APPROVAL),
    ]);
    res.json({
      passwordPolicy: _mergePw(pw),
      session: _mergeSession(session),
      ipAllowlist: _mergeIp(ip),
      procurementApproval: _mergeProcApproval(procApproval),
    });
  } catch (e) {
    res.status(500).json({ success: false, error: 'تعذّر قراءة سياسات الأمان' });
  }
});

router.put('/', requireCapability('administration.security.manage'), async (req, res) => {
  try {
    const body = req.body;
    if (!isObj(body)) return res.status(400).json({ success: false, error: 'حمولة غير صالحة' });
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k) && body[k] != null;
    if (!has('passwordPolicy') && !has('session') && !has('ipAllowlist') && !has('procurementApproval')) {
      return res.status(400).json({ success: false, error: 'لا توجد بيانات لحفظها' });
    }

    let savedPw = null;
    if (has('passwordPolicy')) {
      const r = validatePasswordPolicy(body.passwordPolicy);
      if (r.error) return res.status(400).json({ success: false, error: r.error });
      await writeSetting(KEY_PW, r.value);
      savedPw = r.value;
    }
    if (has('session')) {
      const r = validateSession(body.session);
      if (r.error) return res.status(400).json({ success: false, error: r.error });
      await writeSetting(KEY_SESSION, r.value);
    }
    if (has('ipAllowlist')) {
      const r = validateIpAllowlist(body.ipAllowlist);
      if (r.error) return res.status(400).json({ success: false, error: r.error });
      await writeSetting(KEY_IP, r.value);
      _ipCache.at = 0; // bust the enforcement cache so a change takes effect at once
    }
    if (has('procurementApproval')) {
      const r = validateProcApproval(body.procurementApproval);
      if (r.error) return res.status(400).json({ success: false, error: r.error });
      // No cache to bust — routes/procurement/orders.js reads this row per approval.
      await writeSetting(KEY_PROC_APPROVAL, r.value);
    }

    // Honor a new password policy immediately in this process (enforced by the
    // change-password route's synchronous validate()).
    if (savedPw) passwordPolicy.setPolicy(savedPw);

    const [pw, session, ip, procApproval] = await Promise.all([
      readSetting(KEY_PW), readSetting(KEY_SESSION), readSetting(KEY_IP), readSetting(KEY_PROC_APPROVAL),
    ]);
    res.json({
      success: true,
      passwordPolicy: _mergePw(pw),
      session: _mergeSession(session),
      ipAllowlist: _mergeIp(ip),
      procurementApproval: _mergeProcApproval(procApproval),
    });
  } catch (e) {
    res.status(500).json({ success: false, error: 'تعذّر حفظ سياسات الأمان' });
  }
});

// ── IP allowlist enforcement (exported middleware — NOT mounted here) ─────────
const _ipCache = { at: 0, data: null };
const IP_TTL_MS = 15000;

async function _loadIpConfig() {
  const now = Date.now();
  if (_ipCache.data && now - _ipCache.at < IP_TTL_MS) return _ipCache.data;
  const ip = await readSetting(KEY_IP);
  _ipCache.data = _mergeIp(ip);
  _ipCache.at = now;
  return _ipCache.data;
}

function _normalizeIp(ip) {
  let s = String(ip == null ? '' : ip).trim();
  if (s.startsWith('::ffff:')) s = s.slice(7); // IPv4-mapped IPv6
  return s;
}
function _ipv4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255) return null;
    n = (n * 256) + o;
  }
  return n >>> 0;
}

/** True when `ip` is inside `cidr` (IPv4 math; IPv6 = exact-string match). */
function ipInCidr(ip, cidr) {
  const nip = _normalizeIp(ip);
  const c = String(cidr == null ? '' : cidr).trim();
  if (!c) return false;
  if (c.includes(':')) return nip === c.split('/')[0];
  const [addr, pfxRaw] = c.split('/');
  const prefix = pfxRaw === undefined ? 32 : Number(pfxRaw);
  const a = _ipv4ToInt(addr);
  const b = _ipv4ToInt(nip);
  if (a == null || b == null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (a & mask) === (b & mask);
}

/**
 * Ready-to-mount Express middleware. No-op unless the allowlist is enabled AND
 * non-empty. Fails OPEN on any error (never locks everyone out on an infra blip).
 * Mount it in server.js AFTER `app.set('trust proxy', ...)` so req.ip is the real
 * client address, e.g.  app.use('/api', securityPolicies.ipAllowlistMiddleware());
 */
function ipAllowlistMiddleware(options) {
  const opts = options || {};
  const failOpen = opts.failOpen !== false; // default: fail open
  return async function (req, res, next) {
    try {
      const cfg = await _loadIpConfig();
      if (!cfg.enabled || !cfg.cidrs.length) return next();
      const ip = req.ip || (req.connection && req.connection.remoteAddress) || '';
      if (cfg.cidrs.some((c) => ipInCidr(ip, c))) return next();
      return res.status(403).json({ success: false, code: 'IP_NOT_ALLOWED', error: 'الوصول غير مسموح من هذا العنوان' });
    } catch (e) {
      if (failOpen) return next();
      return res.status(403).json({ success: false, code: 'IP_NOT_ALLOWED', error: 'الوصول غير مسموح من هذا العنوان' });
    }
  };
}

// Warm the password-policy cache at server startup (best-effort; this module is
// required by server.js, so this runs in the live server process only — never in
// the pure passwordPolicy unit test, which does not import this route).
passwordPolicy.refresh().catch(() => {});

module.exports = router;
module.exports.ipAllowlistMiddleware = ipAllowlistMiddleware;
module.exports.ipInCidr = ipInCidr; // exported for tests
