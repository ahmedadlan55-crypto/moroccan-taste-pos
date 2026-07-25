'use strict';
/**
 * middleware/posPortalScope.js — the cashier portal boundary.
 *
 * WHY THIS EXISTS
 *   The global /api gate in server.js AUTHENTICATES (it verifies the JWT and
 *   the session version) but does not AUTHORIZE — it sets req.user and calls
 *   next(). Every route file was implicitly trusted to add its own guard, and
 *   roughly 80 ERP endpoints never did. A cashier's token is therefore a fully
 *   valid ERP token: with nothing but curl, a cashier could read
 *   GET /api/dashboard/overview (whole-company P&L, bank balances, cash on
 *   hand), every financial statement and GL ledger, the full audit log, and
 *   could CLOSE OR REOPEN ACCOUNTING PERIODS (/erp/periods/:label/close) and
 *   POST VAT / CLOSE THE QUARTER (/erp/vat/post, /erp/vat/close-quarter).
 *   Hiding the links in the UI changed nothing: /app is static, the token is
 *   the same `pos_token` both apps read, and the ERP's RequireAuth only checks
 *   that a token exists.
 *
 *   Adding a guard to each of those ~80 endpoints one by one would fix today's
 *   list and silently miss tomorrow's new route. This is the chokepoint
 *   instead: for a POS-ONLY role, deny by default and allow exactly the
 *   endpoints the cashier app actually calls. A new ERP route is unreachable
 *   by a cashier the moment it is written, with no further action.
 *
 * SCOPE
 *   Only roles in POS_ONLY_ROLES are constrained. admin / manager / accountant
 *   / finance / auditor / … are untouched here and keep going through their own
 *   per-route requireRole / requireCapability gates.
 *
 * THE ALLOW-LIST IS DERIVED, NOT GUESSED
 *   It is the exact set of /api paths that frontend/pos/src calls, extracted
 *   from the source (every string/template literal starting with "/api/").
 *   Anything the cashier app does not call is not on it. If a POS feature is
 *   added, its endpoint must be added here in the same change — that is the
 *   intended friction.
 *
 * PATHS ARE MOUNT-RELATIVE
 *   This runs inside `app.use('/api/', …)`, so req.path is already stripped of
 *   the /api prefix ('/sales', not '/api/sales') — matching how the public-path
 *   checks above it are written.
 */

/**
 * Roles whose ONLY home is the cashier app. A user with one of these roles has
 * no business in the back office at all — see the owner's requirement: the
 * cashier does selling, stocktake and shortage requests, nothing else.
 */
const POS_ONLY_ROLES = Object.freeze(['cashier']);

/**
 * method: '*' or an array of upper-case verbs.
 * path:   RegExp anchored at both ends, matched against the mount-relative path.
 *
 * Grouped by the cashier surface each entry serves so a reviewer can tell at a
 * glance why a path is reachable.
 */
const ALLOW = [
  // ── Bootstrap / identity ────────────────────────────────────────────────
  // /auth/* and /version are already public in server.js and never reach this
  // middleware; listed anyway so the allow-list stays truthful if that changes.
  { method: '*', path: /^\/auth\/.*$/ },
  { method: '*', path: /^\/version$/ },
  { method: '*', path: /^\/i18n\/.*$/ },
  { method: ['GET'], path: /^\/inventory\/access-scope$/ },
  { method: ['GET'], path: /^\/cashier-readiness(\/.*)?$/ },

  // ── Selling: catalog, cart lifecycle, offline sync, checkout ────────────
  { method: '*', path: /^\/pos\/v2\/.*$/ },
  { method: ['GET'], path: /^\/menu(\/.*)?$/ },              // catalog reads (already public)
  { method: ['GET'], path: /^\/settings\/discounts-v2-full$/ }, // discount presets
  { method: ['POST'], path: /^\/sales$/ },                   // the money write

  // ── «فواتيري» — own invoices, reprint, void, return ─────────────────────
  // The owner asked for this to stay. The SERVER already scopes it to the
  // caller's own rows (routes/sales.js _canViewAllSales → sales.viewAll, which
  // a cashier is not granted), so allowing the path does not widen visibility.
  { method: ['GET'], path: /^\/sales$/ },
  { method: ['GET'], path: /^\/sales\/invoice\/[^/]+$/ },
  { method: ['POST'], path: /^\/sales\/[^/]+\/(void|return)$/ },
  { method: ['POST'], path: /^\/order-to-cash\/returns$/ },

  // ── Shift open / close / X-Z report ─────────────────────────────────────
  { method: ['GET'], path: /^\/shifts$/ },
  { method: ['POST'], path: /^\/shifts\/(open|close-v3)$/ },
  { method: ['GET'], path: /^\/shifts\/closing-data-v3\/[^/]+$/ },
  { method: ['GET'], path: /^\/shifts\/[^/]+\/full-report$/ },

  // ── Customers at the register (quick attach + history) ──────────────────
  { method: ['GET'], path: /^\/order-to-cash\/customers\/search$/ },
  { method: ['POST'], path: /^\/erp\/customers$/ },
  { method: ['GET'], path: /^\/erp\/customers\/[^/]+\/summary$/ },

  // ── جرد — stocktake ─────────────────────────────────────────────────────
  { method: ['GET'], path: /^\/inventory\/items$/ },
  { method: ['GET', 'POST'], path: /^\/inventory\/stocktakes$/ },
  { method: ['GET', 'POST'], path: /^\/inventory\/v2\/stocktakes$/ },
  { method: ['POST'], path: /^\/inventory\/v2\/stocktakes\/[^/]+\/(start|counts|submit)$/ },

  // ── نواقص — shortage requests + branch receiving ────────────────────────
  { method: ['GET', 'POST'], path: /^\/inventory\/shortage-requests$/ },
  { method: ['GET', 'PUT', 'DELETE'], path: /^\/inventory\/shortage-requests\/[^/]+$/ },
  { method: ['POST'], path: /^\/inventory\/receive-request$/ },
  { method: ['GET'], path: /^\/purchases$/ },                // the receive-flow picker list
];

/** True when `role` may only ever use the cashier app. */
function isPosOnlyRole(role) {
  return POS_ONLY_ROLES.indexOf(String(role || '').toLowerCase()) !== -1;
}

/**
 * The whole decision, as a pure function so it can be unit-tested without an
 * HTTP server. `path` is mount-relative (no /api prefix).
 */
function isAllowedForPosPortal(method, path) {
  const m = String(method || '').toUpperCase();
  // Query strings never reach req.path, but be defensive: a matcher that
  // accidentally saw "?..." would fail closed, which is the safe direction.
  const p = String(path || '').split('?')[0];
  for (const rule of ALLOW) {
    if (rule.method !== '*' && rule.method.indexOf(m) === -1) continue;
    if (rule.path.test(p)) return true;
  }
  return false;
}

/**
 * Express middleware. Must run AFTER req.user is populated by the JWT gate.
 * A non-POS-only role (or an anonymous request on a public path) passes
 * straight through — this middleware only ever REMOVES access from cashiers.
 */
function posPortalScope(req, res, next) {
  const role = req.user && req.user.role;
  if (!isPosOnlyRole(role)) return next();
  // A developer flag on a cashier row would be a misconfiguration, not a
  // reason to widen the boundary — deliberately not honoured here.
  if (isAllowedForPosPortal(req.method, req.path)) return next();

  return res.status(403).json({
    success: false,
    code: 'PORTAL_FORBIDDEN',
    error: 'هذه الوظيفة خارج صلاحيات بوابة الكاشير · Not available from the cashier portal',
  });
}

module.exports = posPortalScope;
module.exports.POS_ONLY_ROLES = POS_ONLY_ROLES;
module.exports.isPosOnlyRole = isPosOnlyRole;
module.exports.isAllowedForPosPortal = isAllowedForPosPortal;
