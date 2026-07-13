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
  // ── Overview / home ──
  "overview.view": EVERYONE,
  "overview.tasks.view": EVERYONE,
  "overview.approvals.view": FIN,
  "overview.kpis.view": FIN,
  // ── Sales section extras ──
  "sales.channels.view": [...ADM, "manager", "sales"],
  "sales.pricing.view": [...ADM, "manager", "sales", "accountant"],
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
  "inventory.transfers.view": READ_OPS,
  "inventory.receiving.view": READ_OPS,
  "inventory.issues.view": READ_OPS,
  "inventory.adjustments.view": READ_OPS,
  "inventory.stocktakes.view": READ_OPS,
  // ── Accounting ──
  "accounting.view": FIN,
  "accounting.journals.view": FIN,
  "accounting.reports.view": FIN_READ,
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
  // ── Reports center ──
  "reports.view": FIN_READ,
  // ── Administration ──
  "administration.companies": ADM,
  "administration.branches": MGR,
  "administration.warehouses": MGR,
  "administration.users": ADM,
  "administration.roles": ADM,
  "administration.settings": MGR,
  "administration.tax": FIN,
  "administration.payment-methods": MGR,
  "administration.security": ADM,
  "administration.audit": [...ADM, "manager", "auditor"],
  "administration.zatca.manage": [...ADM, "manager", "finance"],
  "administration.brands.wizard": MGR,
  // ── Sales section write caps ──
  "sales.channels.manage": [...ADM, "manager", "sales"],
  "sales.pricing.manage": [...ADM, "manager", "sales", "accountant"],
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
