'use strict';
/**
 * ─── warehouse-v2 Canary Allow-list (Phase 5C) ───────────────────────────────
 *
 * Pilot-rollout gate for the v2 surface. When a canary list is configured,
 * ONLY the listed usernames/roles may use warehouse-v2 (reads AND writes);
 * everyone else gets a generic 403 and keeps working on the legacy UI. This
 * is the progressive-enablement mechanism for production: flip
 * WAREHOUSE_V2_ENABLED=1 together with a small canary list, then widen the
 * list in waves, then open fully.
 *
 * Tunable via env (read once at load — same lifecycle as WAREHOUSE_V2_ENABLED;
 * changing a Railway variable restarts the service in seconds):
 *   WAREHOUSE_V2_CANARY_USERS   comma-separated usernames (case-insensitive)
 *   WAREHOUSE_V2_CANARY_ROLES   comma-separated roles     (case-insensitive)
 *
 * Semantics:
 *   • BOTH unset/empty  → canary OFF → pass-through (open to all; the flag
 *     and the list are always set together in the production runbook).
 *   • '*' in either list → explicit allow-all (useful as the "full open" step
 *     without deleting the variables).
 *   • Active → allow iff username ∈ USERS OR role ∈ ROLES; otherwise 403
 *     V2_CANARY_DENIED (generic Arabic body, no data leak — the SPA's
 *     existing 403 → PermissionDenied path renders it).
 *   • Runs AFTER the global /api JWT gate, so req.user is set. If a request
 *     somehow reaches an active canary without a user, it is denied
 *     (fail-closed inside an active canary). The public readiness probe
 *     GET /api/inventory/v2/ready is registered earlier in server.js and is
 *     never affected.
 */

function parseList(v) {
  return String(v == null ? '' : v)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const USERS = parseList(process.env.WAREHOUSE_V2_CANARY_USERS);
const ROLES = parseList(process.env.WAREHOUSE_V2_CANARY_ROLES);
const ACTIVE = USERS.length > 0 || ROLES.length > 0;
const ALLOW_ALL = USERS.includes('*') || ROLES.includes('*');

// Pure, unit-testable verdict. `lists` = { users: [...], roles: [...] }
// (already lowercased). Returns true when the user may use v2.
function isAllowed(user, lists) {
  const users = (lists && lists.users) || [];
  const roles = (lists && lists.roles) || [];
  if (users.length === 0 && roles.length === 0) return true; // canary OFF
  if (users.includes('*') || roles.includes('*')) return true; // full open
  if (!user) return false; // fail-closed inside an active canary
  const uname = String(user.username || '').trim().toLowerCase();
  const role = String(user.role || '').trim().toLowerCase();
  return (uname !== '' && users.includes(uname)) || (role !== '' && roles.includes(role));
}

function middleware(req, res, next) {
  if (!ACTIVE || ALLOW_ALL) return next();
  if (isAllowed(req.user, { users: USERS, roles: ROLES })) return next();
  return res.status(403).json({
    success: false,
    code: 'V2_CANARY_DENIED',
    error: 'نظام المستودعات الجديد (v2) متاح حاليًا لمجموعة تجريبية محدودة — يُرجى استخدام الواجهة القديمة.',
  });
}

module.exports = middleware;
module.exports.parseList = parseList;
module.exports.isAllowed = isAllowed;
module.exports.config = { USERS, ROLES, ACTIVE, ALLOW_ALL };
