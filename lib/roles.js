/**
 * lib/roles.js — the single backend catalog of user roles.
 *
 * There is deliberately no `roles` table: role identity lives in the
 * users.role ENUM (widened idempotently by db/migrations/order-to-cash/
 * schema.js §12) and as free text in role_permissions.role. Before this file
 * existed the assignable list was copy-pasted as literals in routes/auth.js
 * (create AND update, which had already drifted: create rejected an unknown
 * role, update silently ignored it) and routes/hr.js had no validation at
 * all. Every server-side role decision goes through here now.
 *
 * ASSIGNABLE_ROLES — storable in users.role and issuable in a JWT.
 *   accountant/finance/sales were granted capabilities in role_permissions
 *   (31/65/15 rows) long before the ENUM could hold them; the widen makes
 *   those grants reachable.
 *
 * GRANT_ONLY_ROLES — exist as role_permissions groupings seeded by other
 *   domains (procurement/HR/audit) but are NOT storable on a user. Kept so
 *   the permissions editor can keep managing their grants; making them
 *   assignable is a separate product decision, not a side effect here.
 */
'use strict';

const ASSIGNABLE_ROLES = Object.freeze([
  'admin', 'cashier', 'manager', 'custody', 'employee',
  'accountant', 'finance', 'sales',
]);

const GRANT_ONLY_ROLES = Object.freeze(['auditor', 'hr', 'inventory', 'purchasing']);

const ROLE_LABELS_AR = Object.freeze({
  admin: 'مدير النظام',
  manager: 'مدير',
  cashier: 'كاشير',
  custody: 'أمين عهدة',
  employee: 'موظف',
  accountant: 'محاسب',
  finance: 'مالية',
  sales: 'مبيعات',
  auditor: 'مدقق',
  hr: 'موارد بشرية',
  inventory: 'مخزون',
  purchasing: 'مشتريات',
});

function isAssignable(role) {
  return ASSIGNABLE_ROLES.indexOf(String(role || '')) >= 0;
}

/** Roles the permissions editor may write grants for (assignable ∪ grant-only). */
function isKnownGrantRole(role) {
  const r = String(role || '');
  return ASSIGNABLE_ROLES.indexOf(r) >= 0 || GRANT_ONLY_ROLES.indexOf(r) >= 0;
}

module.exports = { ASSIGNABLE_ROLES, GRANT_ONLY_ROLES, ROLE_LABELS_AR, isAssignable, isKnownGrantRole };
