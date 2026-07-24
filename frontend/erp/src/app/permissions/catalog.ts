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
  "returns.cancel",
  // ── Overview / home (new) ──
  "overview.view",
  "overview.tasks.view",
  "overview.approvals.view",
  "overview.kpis.view",
  // ── Sales section extras (new) ──
  "sales.channels.view",
  "sales.pricing.view",
  // Advanced sales analytics — mirrors the LIVE legacy permission id seeded in
  // permissions_v3 (server.js): granted to finance explicitly + manager's
  // nearly-everything seed. Kept verbatim so the backend RBAC gate matches.
  "sales.reports.advanced",
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
  "inventory.method.view",
  "inventory.method.manage",
  "inventory.transfers.view",
  "inventory.receiving.view",
  "inventory.issues.view",
  "inventory.adjustments.view",
  "inventory.stocktakes.view",
  // ── Accounting (new) ──
  "accounting.view",
  "accounting.journals.view",
  "workflow.view",
  "workflow.manage",
  "royalty.view",
  "royalty.manage",
  "accounting.periods.view",
  "accounting.periods.manage",
  "accounting.reports.view",
  // Tier A.1 corrective gate — trial-balance's route (routes/erp-core.js)
  // is gated server-side by requireCapability('finance.reports.view')
  // specifically, not 'accounting.reports.view' (which no backend route
  // currently enforces under that exact name — see ADR 0002). Added as its
  // own key rather than renaming 'accounting.reports.view' everywhere,
  // per this file's own stated policy of never renaming existing keys.
  "finance.reports.view",
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
  "txn.create",
  // ── Workflow txn actions (close/f-people-writes) — mirrors the LIVE
  //    role_permissions rows (permission_id txn.approve/txn.reject/txn.return).
  //    The G-wf stream is adding requireCapability guards on the action route
  //    with this same family. NOTE: no txn.forward row exists server-side, so
  //    no capability is invented for forward (it stays under
  //    workflow.actions.act + the server's per-transaction flags). ──
  "txn.approve",
  "txn.reject",
  "txn.return",
  // ── Reports center (new) ──
  "reports.view",
  // ── Administration (new) ──
  "administration.companies",
  "administration.branches",
  "administration.warehouses",
  "administration.users",
  "administration.roles",
  "administration.settings",
  "administration.invoice-settings",
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
  // ── Menu / recipes domain (Closure Sprint v2 — new group) ──
  "menu.view",
  "menu.catalog.manage",
  "menu.pricing.manage",
  "menu.recipes.manage",
  // Cost & margin visibility on the menu screens (Sprint 3 · D2). Gates the
  // recipe/actual-cost + profit-margin columns on the list and the cost
  // breakdown on the product page via ColumnDef.requireCap. Sibling of the
  // inventory-side `item.cost.view` (D1); backend mirror for BOTH keys:
  // db/migrations/capability-seeds/g-cost-visibility.json (admin/manager/
  // accountant — NOT sales, which browses the catalog without cost).
  "menu.cost.view",
  // Bulk product-image management (bilingual-i18n-images) — backend
  // routes/product-images.js gates on requireCapability('menu.image.manage')
  // (MGR role-gate + this capability layered on top), seeded to admin+manager
  // in db/migrations/capability-seeds/g-menu-images.json. Kept as its own key
  // (not reused menu.catalog.manage) so a future non-manager role can be
  // granted/revoked image access independently, matching the backend's intent.
  "menu.image.manage",
  // ── Inventory-item cost / profit column visibility (Sprint 3 D3) ──
  // Gate the cost & margin columns in the inventory-items (D1) table via
  // ColumnDef.requireCap. Its menu-side sibling `menu.cost.view` is defined in
  // the menu group above (D2). Backend mirror for BOTH keys:
  // db/migrations/capability-seeds/g-cost-visibility.json (admin/manager/
  // accountant — NOT sales).
  "item.cost.view",
  // ── Purchasing requisitions (Closure Sprint v2 — new subsystem) ──
  "purchasing.requisitions.manage",
  "purchasing.requisitions.approve",
  // ── Administration: advanced security policies (Closure Sprint v2) ──
  "administration.security.manage",
  // ── Sales Analytics Hub (sales-hub sprint) — EXACT mirror of the backend
  //    seed db/migrations/capability-seeds/g-analytics.json. `analytics.view`
  //    gates the whole /reports/sales hub; the narrower keys gate specific
  //    tabs (cashiers → employees.view, profitability → cost.view) and
  //    actions (export / share / schedule / budget / reconciliation /
  //    anomaly). admin/developer bypass via can(); the grant arrays mirror
  //    the seed's role lists verbatim. ──
  "analytics.view",
  "analytics.cost.view",
  "analytics.customers.view",
  "analytics.employees.view",
  "analytics.export",
  "analytics.share",
  "analytics.schedule",
  "analytics.budget.manage",
  "analytics.reconciliation.view",
  "analytics.anomaly.manage",
] as const;

/** The one capability union — every gate in the app keys off this. */
export type Capability = (typeof ALL_CAPS)[number];
