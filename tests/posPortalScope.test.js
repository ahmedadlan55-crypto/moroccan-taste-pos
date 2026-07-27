#!/usr/bin/env node
'use strict';
/**
 * tests/posPortalScope.test.js — the cashier portal boundary.
 *
 * This guards a REAL, live privilege escalation: before it existed, a cashier's
 * JWT was a fully valid back-office token. The global /api gate authenticated
 * and called next(); ~80 ERP endpoints had no guard of their own, so with curl
 * alone a cashier could read the company P&L and bank balances, every financial
 * statement, the full audit log — and could CLOSE OR REOPEN ACCOUNTING PERIODS
 * and POST VAT / CLOSE THE QUARTER.
 *
 * Two properties are asserted, and they pull in opposite directions:
 *   1. DENY — every one of those back-office paths is refused for a cashier.
 *   2. ALLOW — every endpoint frontend/pos actually calls still works, or the
 *      fix would take the registers down (worse than the bug).
 * A change that breaks either direction must fail here, not in production.
 */
const assert = require('assert');
const scope = require('../middleware/posPortalScope');

let pass = 0;
const failures = [];
function check(name, cond) {
  if (cond) { pass++; return; }
  failures.push(name);
  console.error('  ✗ ' + name);
}

// ── isPosOnlyRole ──────────────────────────────────────────────────────────
check('cashier is a POS-only role', scope.isPosOnlyRole('cashier') === true);
check('role matching is case-insensitive', scope.isPosOnlyRole('CASHIER') === true);
for (const role of ['admin', 'manager', 'accountant', 'finance', 'auditor', 'custody', 'employee', 'sales']) {
  check(`${role} is NOT constrained by the POS boundary`, scope.isPosOnlyRole(role) === false);
}
check('an absent role is not treated as POS-only', scope.isPosOnlyRole(undefined) === false);

// ── DENY: the endpoints that were reachable before this middleware ─────────
// Sourced from the audit of every ERP router with no requireRole/requireCapability.
const MUST_DENY = [
  ['GET', '/dashboard/overview'],              // company P&L, bank balances, cash on hand
  ['GET', '/erp/dashboard'],
  ['GET', '/erp/reports/income'],
  ['GET', '/erp/reports/balance-sheet-ifrs'],
  ['GET', '/erp/reports/cash-flow-ias7'],
  ['GET', '/erp/reports/gl-ledger-multi'],
  ['GET', '/erp/reports/ar-aging'],
  ['GET', '/erp/reports/ap-aging'],
  ['GET', '/erp/reports/trial-balance'],
  ['GET', '/erp/inventory-valuation'],
  ['GET', '/accounting/accounts/search'],
  ['GET', '/erp/audit-logs'],                  // full audit trail
  ['POST', '/erp/periods/2026-07/close'],      // state transitions on the books
  ['POST', '/erp/periods/2026-07/reopen'],
  ['POST', '/erp/vat/post'],                   // VAT filing
  ['POST', '/erp/vat/close-quarter'],
  ['POST', '/erp/vat/close-year'],
  ['POST', '/erp/suppliers'],                  // master-data writes
  ['DELETE', '/erp/suppliers/S-1'],
  ['POST', '/erp/brands'],
  ['DELETE', '/erp/cost-centers/CC-1'],
  ['POST', '/purchases'],                      // creating spend
  ['POST', '/purchases/orders'],
  ['PUT', '/purchases/orders/PO-1'],
  ['GET', '/erp/warehouses-list'],
  ['GET', '/warehouse-ops/abc-analysis'],
  ['POST', '/inventory/adjustments'],          // stock value writes
  ['GET', '/hr/employees'],
  ['GET', '/activity-log'],
  ['PUT', '/settings'],                        // GET /settings is public; writes are not
];
for (const [method, path] of MUST_DENY) {
  check(`DENY ${method} ${path}`, scope.isAllowedForPosPortal(method, path) === false);
}

// ── ALLOW: the exact surface frontend/pos calls ────────────────────────────
// Extracted from the POS source, not invented — every "/api/..." literal it uses.
const MUST_ALLOW = [
  // bootstrap
  ['POST', '/auth/login'],
  ['GET', '/auth/permissions/me'],
  ['POST', '/auth/change-password'],           // the in-POS forced change screen
  ['GET', '/version'],
  ['GET', '/inventory/access-scope'],
  // selling
  ['GET', '/pos/v2/catalog'],
  ['GET', '/pos/v2/item-image/ITM-77'],
  ['POST', '/pos/v2/orders'],
  ['POST', '/pos/v2/orders/01J/submit'],
  ['POST', '/pos/v2/orders/01J/complete'],
  ['POST', '/pos/v2/sync'],
  ['GET', '/pos/v2/orders'],
  ['GET', '/pos/v2/shift-summary/SH-1'],
  ['GET', '/menu/list'],
  ['GET', '/settings/discounts-v2-full'],
  ['POST', '/sales'],
  // own invoices / reprint / void / return
  ['GET', '/sales'],
  ['GET', '/sales/invoice/ORD-1'],
  ['POST', '/sales/ORD-1/void'],
  ['POST', '/sales/ORD-1/return'],
  ['POST', '/order-to-cash/returns'],
  // shift
  ['POST', '/shifts/open'],
  ['POST', '/shifts/close-v3'],
  ['GET', '/shifts'],
  ['GET', '/shifts/closing-data-v3/SH-1'],
  ['GET', '/shifts/SH-1/full-report'],
  // customers at the register
  ['GET', '/order-to-cash/customers/search'],
  ['POST', '/erp/customers'],
  ['GET', '/erp/customers/C-1/summary'],
  // جرد
  ['GET', '/inventory/items'],
  ['POST', '/inventory/stocktakes'],
  ['POST', '/inventory/v2/stocktakes'],
  ['POST', '/inventory/v2/stocktakes/ST-1/start'],
  // PUT, not POST — this list must mirror the VERB frontend/pos actually sends
  // (saveStocktakeCountsV2 issues PUT). Asserting POST here agreed with the
  // allow-list and with nothing else, so both were wrong together and every
  // real count autosave 403'd.
  ['PUT', '/inventory/v2/stocktakes/ST-1/counts'],
  ['POST', '/inventory/v2/stocktakes/ST-1/submit'],
  // نواقص
  ['POST', '/inventory/shortage-requests'],
  ['GET', '/inventory/shortage-requests'],
  ['GET', '/inventory/shortage-requests/SHR-1'],
  ['PUT', '/inventory/shortage-requests/SHR-1'],
  ['DELETE', '/inventory/shortage-requests/SHR-1'],
  ['POST', '/inventory/receive-request'],
  ['GET', '/purchases'],
];
for (const [method, path] of MUST_ALLOW) {
  check(`ALLOW ${method} ${path}`, scope.isAllowedForPosPortal(method, path) === true);
}

// ── The allow-list is METHOD-scoped, not just path-scoped ─────────────────
// A read-only allowance must not become a write allowance.
check('GET /purchases allowed but POST /purchases denied',
  scope.isAllowedForPosPortal('GET', '/purchases') === true &&
  scope.isAllowedForPosPortal('POST', '/purchases') === false);
check('GET /inventory/items allowed but POST denied',
  scope.isAllowedForPosPortal('GET', '/inventory/items') === true &&
  scope.isAllowedForPosPortal('POST', '/inventory/items') === false);
check('menu is readable but not writable from the register',
  scope.isAllowedForPosPortal('GET', '/menu/list') === true &&
  scope.isAllowedForPosPortal('POST', '/menu') === false &&
  scope.isAllowedForPosPortal('DELETE', '/menu/M-1') === false);
check('POST /erp/customers allowed but the customer LIST is not',
  scope.isAllowedForPosPortal('POST', '/erp/customers') === true &&
  scope.isAllowedForPosPortal('GET', '/erp/customers') === false);

// ── Patterns are anchored — no prefix-walking out of the allow-list ────────
// The /menu prefix bug in server.js's public list is exactly this class of
// mistake, so the matcher is asserted to be anchored at BOTH ends.
check('an allowed prefix does not open a deeper sibling path',
  scope.isAllowedForPosPortal('POST', '/sales/ORD-1/void/../../erp/vat/post') === false);
check('a path merely CONTAINING an allowed segment is denied',
  scope.isAllowedForPosPortal('GET', '/erp/reports/sales') === false &&
  scope.isAllowedForPosPortal('GET', '/xx/sales') === false);
check('/salesXYZ is not /sales', scope.isAllowedForPosPortal('GET', '/salesXYZ') === false);
check('an unknown path is denied by default', scope.isAllowedForPosPortal('GET', '/some/brand/new/route') === false);

// ── The middleware wiring itself ──────────────────────────────────────────
function runMw(user, method, path) {
  const req = { user, method, path };
  const out = { nexted: false, status: null, body: null };
  const res = {
    status(s) { out.status = s; return this; },
    json(b) { out.body = b; return this; },
  };
  scope({ ...req }, res, () => { out.nexted = true; });
  return out;
}

let r = runMw({ role: 'cashier' }, 'GET', '/dashboard/overview');
check('middleware blocks a cashier with 403', r.status === 403 && r.nexted === false);
// The canonical authorization code (what every client/RBAC test switches on)
// PLUS the portal discriminator — both are pinned so neither can drift away.
check('the 403 carries the canonical authorization code', r.body && r.body.code === 'PERMISSION_DENIED');
check('the 403 still names the portal boundary as the reason', r.body && r.body.reason === 'PORTAL_FORBIDDEN');

r = runMw({ role: 'cashier' }, 'POST', '/sales');
check('middleware lets a cashier check out', r.nexted === true && r.status === null);

r = runMw({ role: 'manager' }, 'GET', '/dashboard/overview');
check('middleware never constrains a manager', r.nexted === true);

r = runMw({ role: 'admin' }, 'POST', '/erp/vat/close-year');
check('middleware never constrains an admin', r.nexted === true);

r = runMw(null, 'GET', '/version');
check('an anonymous request on a public path passes through', r.nexted === true);

// A cashier row flagged isDeveloper must NOT escape the boundary — that would
// turn a data-entry mistake into a full back-office key.
r = runMw({ role: 'cashier', isDeveloper: true }, 'GET', '/erp/audit-logs');
check('isDeveloper does not widen the cashier boundary', r.status === 403);

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('\nFAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
assert.ok(pass > 90, 'expected the full matrix to run');
console.log('✅ posPortalScope: cashier portal boundary holds (deny-by-default + full POS surface intact)');
