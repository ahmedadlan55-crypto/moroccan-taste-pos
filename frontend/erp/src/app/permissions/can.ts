// ── ADLAN Back-Office — ONE role→capability grant map + can() ────────────────
// Merges the warehouse MATRIX (action→roles) and the sales ROLE_GRANTS (inverted
// role→caps) into a single Record<Capability, Role[]>, plus grants for the new
// domains. admin/developer bypass everything in can(). This is a UI mirror; the
// backend requireRole/requireCapability gates remain the real security boundary.

import { ALL_CAPS, type Capability, type Role, type SessionUser } from "./catalog";

// Role groups (admin + developer are always included; can() also hard-bypasses).
const ADM: Role[] = ["admin", "developer"];
const MGR: Role[] = [...ADM, "manager"];
const BACKOFFICE: Role[] = [...ADM, "manager", "employee", "custody"];
const READ_OPS: Role[] = [...ADM, "manager", "employee", "custody", "auditor"];
const FIN: Role[] = [...ADM, "manager", "accountant", "finance"];
const FIN_READ: Role[] = [...ADM, "manager", "accountant", "finance", "auditor"];
const SALESROLES: Role[] = [...ADM, "manager", "cashier", "sales"];
const EVERYONE: Role[] = [
  ...ADM,
  "manager",
  "employee",
  "custody",
  "cashier",
  "auditor",
  "sales",
  "accountant",
  "finance",
];

// Typed as Record<Capability, …> so TypeScript FORCES every catalog capability
// to have a grant entry — a missing key is a compile error, not a silent hole.
export const ROLE_GRANTS: Record<Capability, readonly Role[]> = {
  // ── Inventory / warehouse (mirrors the warehouse MATRIX) ──
  "warehouse.view": EVERYONE,
  "warehouse.create": MGR,
  "warehouse.deactivate": MGR,
  "warehouse.edit": MGR,
  "warehouse.scopeAssign": ADM,
  "transfer.create": BACKOFFICE,
  "transfer.approve": MGR,
  "transfer.issue": BACKOFFICE,
  "transfer.receive": BACKOFFICE,
  "transfer.reverse": MGR,
  "stocktake.create": BACKOFFICE,
  "stocktake.approve": MGR,
  "stocktake.post": BACKOFFICE,
  "item.view": EVERYONE,
  "item.create": BACKOFFICE,
  "item.edit": BACKOFFICE,
  "item.activate": MGR,
  "replenishment.view": READ_OPS,
  "lot.view": EVERYONE,
  "lot.create": BACKOFFICE,
  "lot.edit": BACKOFFICE,
  "lot.quarantine": MGR,
  "lot.recall": MGR,
  "expiry.view": READ_OPS,
  "adjustment.create": BACKOFFICE,
  "adjustment.approve": MGR,
  "adjustment.post": BACKOFFICE,
  "adjustment.reverse": MGR,
  "receipt.create": BACKOFFICE,
  "receipt.approve": MGR,
  "receipt.post": BACKOFFICE,
  "receipt.reverse": MGR,
  "issue.create": BACKOFFICE,
  "issue.approve": MGR,
  "issue.post": BACKOFFICE,
  "issue.reverse": MGR,
  "waste.create": BACKOFFICE,
  "document.reverse": MGR,
  "settings.edit": MGR,
  "barcode.manage": MGR,
  "negativePolicy.view": [...ADM, "manager", "auditor"],
  "negativePolicy.edit": ADM,
  "production.view": READ_OPS,
  "production.create": BACKOFFICE,
  "production.approve": MGR,
  "production.issue": BACKOFFICE,
  "production.output": BACKOFFICE,
  "production.complete": BACKOFFICE,
  "production.close": MGR,
  "production.cancel": MGR,
  "production.reverse": MGR,
  "production.delete": MGR,
  "procurement.view": READ_OPS,
  "procurement.manage": BACKOFFICE,
  "procurement.approve": MGR,
  // ── Sales / order-to-cash (inverted from the sales ROLE_GRANTS) ──
  "o2c.view": [...ADM, "manager", "cashier", "sales", "accountant", "finance"],
  "o2c.dashboard.view": [...ADM, "manager", "cashier", "sales", "accountant", "finance"],
  "ar_reports.view": [...ADM, "manager", "sales", "accountant", "finance"],
  "o2c.export": FIN,
  "o2c.data_quality": FIN,
  "customers.view": [...ADM, "manager", "cashier", "sales", "accountant", "finance"],
  "customers.create": SALESROLES,
  "customers.edit": SALESROLES,
  "customers.deactivate": MGR,
  "customers.merge": MGR,
  "sales_orders.view": SALESROLES,
  "sales_orders.create": SALESROLES,
  "sales_orders.confirm": [...ADM, "manager", "sales"],
  "sales_orders.fulfill": MGR,
  "invoices.view": [...ADM, "manager", "cashier", "sales", "accountant", "finance"],
  "invoices.create": [...ADM, "manager", "cashier", "sales", "accountant"],
  "invoices.issue": FIN,
  "credit.override": FIN,
  "payments.view": [...ADM, "manager", "cashier", "sales", "accountant", "finance"],
  "payments.create": [...ADM, "manager", "cashier", "sales", "accountant"],
  "payments.approve": FIN,
  "payments.post": FIN,
  "payments.reverse": FIN,
  "returns.view": [...ADM, "manager", "cashier", "sales", "accountant"],
  "returns.create": SALESROLES,
  "returns.approve": FIN,
  "returns.post": FIN,
  "returns.reverse": FIN,
  // Cancelling voids a return a manager may already have approved, so it sits with
  // approve — not with create. Mirrors the server grant seeded in
  // db/migrations/order-to-cash/capabilities.js: a cashier is denied 403, so
  // showing them the button would only produce a permission error.
  "returns.cancel": FIN,
  // ── Overview / home ──
  "overview.view": EVERYONE,
  "overview.tasks.view": EVERYONE,
  "overview.approvals.view": FIN,
  "overview.kpis.view": FIN,
  // ── Sales section extras ──
  "sales.channels.view": [...ADM, "manager", "sales"],
  "sales.pricing.view": [...ADM, "manager", "sales", "accountant"],
  // Mirrors the live role_permissions seed (server.js): finance holds it
  // explicitly and manager via the nearly-everything seed. Accountant is NOT
  // granted live, so showing them the nav item would just 403.
  "sales.reports.advanced": [...ADM, "manager", "finance"],
  // ── POS administration ──
  "pos.register.view": [...ADM, "manager", "cashier"],
  "pos.shifts.view": [...ADM, "manager", "cashier"],
  "pos.parked.view": [...ADM, "manager", "cashier"],
  "pos.devices.view": MGR,
  "pos.reports.view": [...ADM, "manager", "cashier", "accountant"],
  // ── Inventory section view keys ──
  "inventory.view": EVERYONE,
  "inventory.units.view": READ_OPS,
  "inventory.balances.view": READ_OPS,
  // The valuation method is an accounting control (it decides how COGS is posted),
  // so reading it is finance-wide but changing it is manager-only — matching the
  // server-side inventory.method.manage grant.
  "inventory.method.view": FIN_READ,
  "inventory.method.manage": MGR,
  "inventory.transfers.view": READ_OPS,
  "inventory.receiving.view": READ_OPS,
  "inventory.issues.view": READ_OPS,
  "inventory.adjustments.view": READ_OPS,
  "inventory.stocktakes.view": READ_OPS,
  // ── Accounting ──
  "accounting.view": FIN,
  // Reading the org chart is normal operational context (the workflow inbox and
  // the forward-to picker need it); EDITING it grants approval rights, so it is
  // narrower. Mirrors the server-side grants seeded in server.js.
  // Mirrors the server grants seeded in server.js for every role this union
  // models — a cashier is denied 403 by requireCapability('workflow.view'), so
  // showing them the nav item would just link to a permission error.
  // NB: the server also grants both to the 'hr' role, which this Role union does
  // not model (pre-existing — no live user holds it). Add it here if 'hr' is ever
  // added to @/app/permissions/catalog.
  "workflow.view": [...MGR, "accountant", "finance", "employee"],
  "workflow.manage": [...ADM, "manager"],
  // Mirrors the live role_permissions grants (late-seeded in server.js):
  // view → manager/accountant/finance; manage → manager/finance. A role shown a
  // button the server answers with 403 is not a permission model.
  "royalty.view": [...ADM, "manager", "accountant", "finance"],
  "royalty.manage": [...ADM, "manager", "finance"],
  "accounting.journals.view": FIN,
  // Auditors may read the period register; closing/reopening posts and reverses
  // closing entries, so managing it is narrower than reading it.
  "accounting.periods.view": FIN_READ,
  "accounting.periods.manage": FIN,
  "accounting.reports.view": FIN_READ,
  // Tier A.1 corrective gate — matches routes/erp-core.js's actual
  // requireCapability('finance.reports.view') gate on trial-balance
  // (db/migrations/finance/capabilities.js grants it to
  // admin/manager/accountant/finance/auditor — same set as FIN_READ).
  "finance.reports.view": FIN_READ,
  // ── Accounting write caps (E1) — reverse is tighter (excludes plain accountant) ──
  "accounting.accounts.manage": FIN,
  "accounting.journals.create": FIN,
  "accounting.journals.post": FIN,
  "accounting.journals.reverse": [...ADM, "manager", "finance"],
  // ── Cash & banking ──
  "banking.view": [...ADM, "manager", "accountant", "finance", "cashier"],
  "banking.vouchers.create": [...ADM, "manager", "accountant", "finance", "cashier"],
  "banking.vouchers.approve": FIN,
  "banking.reconciliation.manage": FIN,
  "banking.reconciliation.close": [...ADM, "manager", "finance"],
  "banking.cashclose.manage": [...ADM, "manager", "finance", "cashier"],
  // ── People / HR ──
  "people.employees.view": MGR,
  "people.attendance.view": [...ADM, "manager", "employee"],
  "people.shifts.view": [...ADM, "manager", "employee"],
  "people.leaves.view": [...ADM, "manager", "employee"],
  "people.contracts.view": MGR,
  "people.payroll.view": FIN,
  "people.payroll.manage": [...ADM, "manager", "finance"],
  "people.payroll.approve": [...ADM, "manager", "finance"],
  "people.payroll.pay": [...ADM, "manager", "finance"],
  "people.custody.view": [...ADM, "manager", "custody"],
  "people.selfservice.view": EVERYONE,
  // ── Workflow / approvals ──
  "workflow.inbox.view": EVERYONE,
  "workflow.outbox.view": EVERYONE,
  "workflow.myrequests.view": EVERYONE,
  "workflow.approvals.view": FIN,
  "workflow.audit.view": [...ADM, "manager", "auditor"],
  "workflow.actions.act": EVERYONE,
  "workflow.builder.manage": ADM,
  "txn.create": EVERYONE,
  // ── Workflow txn actions — EXACT mirror of the live role_permissions rows
  //    (queried read-only on 2026-07-17):
  //      txn.approve → admin, finance, hr, manager
  //      txn.reject  → admin, finance, hr, manager
  //      txn.return  → admin, manager
  //    NB: the server also grants approve/reject to the 'hr' role, which this
  //    Role union does not model (same pre-existing note as workflow.view).
  //    'employee' deliberately absent: the live grants do not include it, and
  //    the G-wf guards will 403 an employee on these actions. ──
  "txn.approve": [...ADM, "manager", "finance"],
  "txn.reject": [...ADM, "manager", "finance"],
  "txn.return": [...ADM, "manager"],
  // ── Reports center ──
  "reports.view": FIN_READ,
  // ── Administration ──
  "administration.companies": ADM,
  "administration.branches": MGR,
  "administration.warehouses": MGR,
  "administration.users": ADM,
  "administration.roles": ADM,
  "administration.settings": MGR,
  "administration.invoice-settings": MGR,
  "administration.tax": FIN,
  "administration.payment-methods": MGR,
  "administration.security": ADM,
  "administration.audit": [...ADM, "manager", "auditor"],
  "administration.zatca.manage": [...ADM, "manager", "finance"],
  "administration.brands.wizard": MGR,
  // ── Sales section write caps ──
  "sales.channels.manage": [...ADM, "manager", "sales"],
  "sales.pricing.manage": [...ADM, "manager", "sales", "accountant"],
  // ── Menu / recipes domain (Closure Sprint v2) ──
  "menu.view": [...ADM, "manager", "accountant", "sales"],
  "menu.catalog.manage": MGR,
  "menu.pricing.manage": [...ADM, "manager", "accountant"],
  "menu.recipes.manage": [...ADM, "manager"],
  // Same role grant as menu.catalog.manage (MGR = admin/developer/manager) —
  // matches the backend seed (admin+manager) in
  // db/migrations/capability-seeds/g-menu-images.json exactly; admin/developer
  // are covered by can()'s hard bypass either way.
  "menu.image.manage": MGR,
  // ── Purchasing requisitions (Closure Sprint v2) ──
  "purchasing.requisitions.manage": BACKOFFICE,
  "purchasing.requisitions.approve": MGR,
  // ── Administration: advanced security policies (Closure Sprint v2) ──
  "administration.security.manage": ADM,
};

/** admin/developer see everything; otherwise the role must be granted the cap. */
export function can(user: SessionUser | null, cap: Capability): boolean {
  if (!user) return false;
  const role = String(user.role || "").toLowerCase();
  if (user.isDeveloper === true || role === "admin" || role === "developer") return true;
  const grants = ROLE_GRANTS[cap];
  return !!grants && grants.includes(role as Role);
}

export { ALL_CAPS };
export type { Capability, Role, SessionUser };
