// ── ADLAN Back-Office — ONE permission catalog ──────────────────────────────
// The single, namespaced capability key list for the unified app. It MERGES:
//   • the warehouse `WarehouseAction` keys (inventory / procurement / production)
//   • the sales `O2CCapability` keys (order-to-cash)
//   • NEW keys for the domains being converted (accounting, banking, people,
//     workflow, reports, administration, overview, pos-admin)
// Existing keys are kept intact (never renamed) so each domain's backend RBAC
// gates keep matching. This mirror is UI-only — the backend stays authoritative.

export type Role =
  | "admin"
  | "developer"
  | "manager"
  | "employee"
  | "custody"
  | "cashier"
  | "auditor"
  | "sales"
  | "accountant"
  | "finance";

export interface SessionUser {
  username: string;
  name?: string;
  role: Role | string;
  isDeveloper?: boolean;
}

// The full capability catalog. `Capability` is derived from this tuple so the
// list and the union type can never drift apart.
export const ALL_CAPS = [
  // ── Inventory / warehouse (existing WarehouseAction keys) ──
  "warehouse.view",
  "warehouse.create",
  "warehouse.deactivate",
  "warehouse.edit",
  "warehouse.scopeAssign",
  "transfer.create",
  "transfer.approve",
  "transfer.issue",
  "transfer.receive",
  "transfer.reverse",
  "stocktake.create",
  "stocktake.approve",
  "stocktake.post",
  "item.view",
  "item.create",
  "item.edit",
  "item.activate",
  "replenishment.view",
  "lot.view",
  "lot.create",
  "lot.edit",
  "lot.quarantine",
  "lot.recall",
  "expiry.view",
  "adjustment.create",
  "adjustment.approve",
  "adjustment.post",
  "adjustment.reverse",
  "receipt.create",
  "receipt.approve",
  "receipt.post",
  "receipt.reverse",
  "issue.create",
  "issue.approve",
  "issue.post",
  "issue.reverse",
  "waste.create",
  "document.reverse",
  "settings.edit",
  "barcode.manage",
  "negativePolicy.view",
  "negativePolicy.edit",
  "production.view",
  "production.create",
  "production.approve",
  "production.issue",
  "production.output",
  "production.complete",
  "production.close",
  "production.cancel",
  "production.reverse",
  "production.delete",
  "procurement.view",
  "procurement.manage",
  "procurement.approve",
  // ── Sales / order-to-cash (existing O2CCapability keys) ──
  "o2c.view",
  "o2c.dashboard.view",
  "ar_reports.view",
  "o2c.export",
  "o2c.data_quality",
  "customers.view",
  "customers.create",
  "customers.edit",
  "customers.deactivate",
  "customers.merge",
  "sales_orders.view",
  "sales_orders.create",
  "sales_orders.confirm",
  "sales_orders.fulfill",
  "invoices.view",
  "invoices.create",
  "invoices.issue",
  "credit.override",
  "payments.view",
  "payments.create",
  "payments.approve",
  "payments.post",
  "payments.reverse",
  "returns.view",
  "returns.create",
  "returns.approve",
  "returns.post",
  "returns.reverse",
  // ── Overview / home (new) ──
  "overview.view",
  "overview.tasks.view",
  "overview.approvals.view",
  "overview.kpis.view",
  // ── Sales section extras (new) ──
  "sales.channels.view",
  "sales.pricing.view",
  // ── POS administration (new) ──
  "pos.register.view",
  "pos.shifts.view",
  "pos.parked.view",
  "pos.devices.view",
  "pos.reports.view",
  // ── Inventory section view keys (new — pair with the existing action keys) ──
  "inventory.view",
  "inventory.units.view",
  "inventory.balances.view",
  "inventory.transfers.view",
  "inventory.receiving.view",
  "inventory.issues.view",
  "inventory.adjustments.view",
  "inventory.stocktakes.view",
  // ── Accounting (new) ──
  "accounting.view",
  "accounting.journals.view",
  "accounting.reports.view",
  // ── Accounting write caps (E1 — UI-only gating; backend stays authoritative) ──
  "accounting.accounts.manage",
  "accounting.journals.create",
  "accounting.journals.post",
  "accounting.journals.reverse",
  // ── Cash & banking (new) ──
  "banking.view",
  // ── Banking write caps (FC-P3) ──
  "banking.vouchers.create",
  "banking.vouchers.approve",
  "banking.reconciliation.manage",
  "banking.reconciliation.close",
  "banking.cashclose.manage",
  // ── People / HR (new) ──
  "people.employees.view",
  "people.attendance.view",
  "people.shifts.view",
  "people.leaves.view",
  "people.contracts.view",
  "people.payroll.view",
  "people.custody.view",
  "people.selfservice.view",
  // ── Payroll write caps (FC-P3) ──
  "people.payroll.manage",
  "people.payroll.approve",
  "people.payroll.pay",
  // ── Workflow / approvals (new) ──
  "workflow.inbox.view",
  "workflow.outbox.view",
  "workflow.myrequests.view",
  "workflow.approvals.view",
  "workflow.audit.view",
  // ── Workflow write caps (FC-P3) ──
  "workflow.actions.act",
  "workflow.builder.manage",
  // ── Reports center (new) ──
  "reports.view",
  // ── Administration (new) ──
  "administration.companies",
  "administration.branches",
  "administration.warehouses",
  "administration.users",
  "administration.roles",
  "administration.settings",
  "administration.tax",
  "administration.payment-methods",
  "administration.security",
  "administration.audit",
  // ── Administration write caps (FC-P3) ──
  "administration.zatca.manage",
  "administration.brands.wizard",
  // ── Sales section write caps (FC-P3) ──
  "sales.channels.manage",
  "sales.pricing.manage",
] as const;

/** The one capability union — every gate in the app keys off this. */
export type Capability = (typeof ALL_CAPS)[number];
