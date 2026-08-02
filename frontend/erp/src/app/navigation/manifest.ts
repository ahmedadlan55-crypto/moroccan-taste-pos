// ── ADLAN Back-Office — THE navigation manifest (single source of truth) ─────
// Sidebar groups, MobileNav, route registration, breadcrumbs, the command
// palette AND the anti-duplication tests all derive from this one file. Every
// item has a UNIQUE id + UNIQUE path and a capability from the ONE catalog
// (@/app/permissions). `icon` is a lucide icon NAME (resolved in the shell), and
// `module` names the folder under src/modules/ the route renders into.
//
// i18n — labels are TRANSLATION KEYS, not literal text. This module is a plain
// data structure evaluated at import time (before React mounts), so it cannot
// call useT(). Each `label` is therefore a stable key into the `nav` dictionary
// namespace (nav.groups.<groupId> / nav.items.<itemId>, see
// src/i18n/dictionaries/{ar,en}/nav.ts) and every consumer resolves it with
// t(label) at its render site (Sidebar / MobileNav / Breadcrumbs /
// CommandPalette). Keys reuse the manifest's own unique ids, so this stays 1:1
// with the manifest and can never collide.

import type { Capability } from "@/app/permissions";

export interface NavItem {
  /** Unique, stable id (used for React keys + the uniqueness test). */
  id: string;
  /** Unique route path, under the /app basename via the router. */
  path: string;
  /** Translation key for the sidebar label (nav.items.<id>); resolved via t() at the render sites. */
  label: string;
  /** lucide-react icon name (PascalCase), resolved to a component in the shell. */
  icon: string;
  /** Capability required to see/enter the item (from the ONE catalog). */
  cap?: Capability;
  /** Optional server feature-flag key; hidden until the flag is on. */
  flag?: string;
  /** The src/modules/<module> folder this item routes into. */
  module: string;
  /**
   * Opt-in: the module OWNS this item's whole subtree. When true the router
   * registers a splat child (`<path>/*`) IN ADDITION to the exact route, so
   * full-page New/Details/Edit screens can live at real URLs
   * (e.g. `/inventory/items/new`, `/inventory/items/:id`, `.../:id/edit`) and
   * the module dispatches internally on the deeper pathname. Items WITHOUT this
   * flag register a single exact route exactly as before. Kept a plain boolean
   * (not a path list) so the sidebar/breadcrumbs/command-palette that derive
   * from the flat exact `path` are untouched — only the router reads it.
   */
  subRoutes?: boolean;
}

export interface NavGroup {
  /** Unique group id. */
  id: string;
  /** Translation key for the group heading (nav.groups.<id>); resolved via t() at the render sites. */
  label: string;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    id: "overview",
    label: "nav.groups.overview",
    items: [
      { id: "ov-overview", path: "/overview", label: "nav.items.ov-overview", icon: "LayoutDashboard", cap: "overview.view", module: "overview" },
      { id: "ov-tasks", path: "/overview/tasks", label: "nav.items.ov-tasks", icon: "ListTodo", cap: "overview.tasks.view", module: "overview" },
      { id: "ov-approvals", path: "/overview/approvals", label: "nav.items.ov-approvals", icon: "CheckCheck", cap: "overview.approvals.view", module: "overview" },
      { id: "ov-kpis", path: "/overview/kpis", label: "nav.items.ov-kpis", icon: "Gauge", cap: "overview.kpis.view", module: "overview" },
    ],
  },
  {
    id: "sales",
    label: "nav.groups.sales",
    items: [
      { id: "sl-invoices", path: "/sales/invoices", label: "nav.items.sl-invoices", icon: "FileText", cap: "invoices.view", module: "sales" },
      { id: "sl-returns", path: "/sales/returns", label: "nav.items.sl-returns", icon: "Undo2", cap: "returns.view", module: "sales" },
      { id: "sl-payments", path: "/sales/payments", label: "nav.items.sl-payments", icon: "Banknote", cap: "payments.view", module: "sales" },
      { id: "sl-customers", path: "/customers", label: "nav.items.sl-customers", icon: "Users", cap: "customers.view", module: "customers" },
    ],
  },
  {
    id: "menu",
    label: "nav.groups.menu",
    items: [
      { id: "mn-hub", path: "/menu/hub", label: "nav.items.mn-hub", icon: "LayoutGrid", cap: "menu.view", module: "menu" },
      { id: "mn-brand", path: "/menu/brand", label: "nav.items.mn-brand", icon: "BookOpen", cap: "menu.view", module: "menu", subRoutes: true },
      // The recipe catalog owns its subtree: /menu/recipes lists every product
      // (including the ones with NO recipe) and /menu/recipes/:source/:productId
      // is a real, deep-linkable full page rather than a query param. The old
      // /menu/recipes-bom path redirects — see REDIRECTS in app/router.tsx.
      { id: "mn-recipes", path: "/menu/recipes", label: "nav.items.mn-recipes", icon: "ChefHat", cap: "menu.view", module: "menu", subRoutes: true },
      { id: "mn-price-lists", path: "/menu/price-lists", label: "nav.items.mn-price-lists", icon: "Tags", cap: "menu.view", module: "menu" },
      { id: "mn-combos", path: "/menu/combos", label: "nav.items.mn-combos", icon: "Layers", cap: "menu.view", module: "menu" },
      { id: "mn-semi", path: "/menu/semi-finished", label: "nav.items.mn-semi", icon: "Soup", cap: "menu.view", module: "menu" },
      { id: "mn-images", path: "/menu/images", label: "nav.items.mn-images", icon: "Image", cap: "menu.view", module: "menu" },
      { id: "mn-categories", path: "/menu/categories", label: "nav.items.mn-categories", icon: "Languages", cap: "menu.view", module: "menu" },
    ],
  },
  {
    id: "pos-admin",
    label: "nav.groups.pos-admin",
    items: [
      { id: "pa-register", path: "/pos-admin/register", label: "nav.items.pa-register", icon: "Monitor", cap: "pos.register.view", module: "pos-admin" },
      { id: "pa-shifts", path: "/pos-admin/shifts", label: "nav.items.pa-shifts", icon: "Clock", cap: "pos.shifts.view", module: "pos-admin" },
      { id: "pa-parked", path: "/pos-admin/parked-orders", label: "nav.items.pa-parked", icon: "PauseCircle", cap: "pos.parked.view", module: "pos-admin" },
      { id: "pa-devices", path: "/pos-admin/devices", label: "nav.items.pa-devices", icon: "RefreshCw", cap: "pos.devices.view", module: "pos-admin" },
      // The pos-admin cashier-reports leaf was retired → /reports/sales/shifts
      // (analytics) + the shifts leaf above (operational drill). Redirect in app/router.tsx.
      // Channels + pricing sat under "sales" but never described a sales DOCUMENT:
      // they are the only UI for editing menu prices and channel commissions, which
      // is register configuration. They keep module:"sales" (the code still lives
      // in modules/sales) — only the nav home moved.
      { id: "sl-channels", path: "/sales/channels", label: "nav.items.sl-channels", icon: "Store", cap: "sales.channels.view", module: "sales" },
      { id: "sl-pricing", path: "/sales/pricing", label: "nav.items.sl-pricing", icon: "Tags", cap: "sales.pricing.view", module: "sales" },
    ],
  },
  {
    id: "inventory",
    label: "nav.groups.inventory",
    items: [
      { id: "inv-overview", path: "/inventory", label: "nav.items.inv-overview", icon: "LayoutDashboard", cap: "inventory.view", module: "inventory" },
      { id: "inv-items", path: "/inventory/items", label: "nav.items.inv-items", icon: "Package", cap: "item.view", module: "inventory", subRoutes: true },
      { id: "inv-warehouses", path: "/inventory/warehouses", label: "nav.items.inv-warehouses", icon: "Warehouse", cap: "warehouse.view", module: "inventory" },
      { id: "inv-balances", path: "/inventory/balances", label: "nav.items.inv-balances", icon: "Boxes", cap: "inventory.balances.view", module: "inventory" },
      { id: "inv-transfers", path: "/inventory/transfers", label: "nav.items.inv-transfers", icon: "Truck", cap: "inventory.transfers.view", module: "inventory" },
      { id: "inv-receiving", path: "/inventory/receiving", label: "nav.items.inv-receiving", icon: "PackageCheck", cap: "inventory.receiving.view", module: "inventory" },
      { id: "inv-issues", path: "/inventory/issues", label: "nav.items.inv-issues", icon: "PackageMinus", cap: "inventory.issues.view", module: "inventory" },
      { id: "inv-adjustments", path: "/inventory/adjustments", label: "nav.items.inv-adjustments", icon: "SlidersHorizontal", cap: "inventory.adjustments.view", module: "inventory" },
      { id: "inv-stocktakes", path: "/inventory/stocktakes", label: "nav.items.inv-stocktakes", icon: "ClipboardCheck", cap: "inventory.stocktakes.view", module: "inventory" },
      { id: "inv-waste", path: "/inventory/waste", label: "nav.items.inv-waste", icon: "PackageMinus", cap: "inventory.view", module: "inventory" },
      { id: "inv-lots-expiry", path: "/inventory/lots-expiry", label: "nav.items.inv-lots-expiry", icon: "CalendarClock", cap: "expiry.view", module: "inventory" },
      { id: "inv-replenishment", path: "/inventory/replenishment", label: "nav.items.inv-replenishment", icon: "RefreshCcw", cap: "replenishment.view", module: "inventory" },
      // ONE place to find every inventory DOCUMENT — generic inbound, purchase
      // receipts, transfers, production, issues/adjustments — with real detail
      // pages at /inventory/operations/:type/:id instead of a ?view= panel.
      { id: "inv-operations", path: "/inventory/operations", label: "nav.items.inv-operations", icon: "ListChecks", cap: "inventory.view", module: "inventory", subRoutes: true },
      // subRoutes so /inventory/production/new and /inventory/production/:id are
      // real URLs; the create flow was a ?new=1 query param that no one could
      // link to and that a refresh discarded.
      { id: "inv-production", path: "/inventory/production", label: "nav.items.inv-production", icon: "Factory", cap: "production.view", module: "production", subRoutes: true },
      { id: "inv-method", path: "/inventory/method", label: "nav.items.inv-method", icon: "Scale", cap: "inventory.method.view", module: "inventory" },
    ],
  },
  {
    id: "purchasing",
    label: "nav.groups.purchasing",
    items: [
      { id: "pu-suppliers", path: "/purchasing/suppliers", label: "nav.items.pu-suppliers", icon: "Contact", cap: "procurement.view", module: "purchasing" },
      { id: "pu-requisitions", path: "/purchasing/requisitions", label: "nav.items.pu-requisitions", icon: "ClipboardList", cap: "procurement.view", module: "purchasing" },
      { id: "pu-orders", path: "/purchasing/orders", label: "nav.items.pu-orders", icon: "ShoppingBag", cap: "procurement.view", module: "purchasing" },
      { id: "pu-receiving", path: "/purchasing/receiving", label: "nav.items.pu-receiving", icon: "PackageOpen", cap: "procurement.view", module: "purchasing" },
      { id: "pu-invoices", path: "/purchasing/invoices", label: "nav.items.pu-invoices", icon: "FileText", cap: "procurement.view", module: "purchasing" },
      { id: "pu-payments", path: "/purchasing/payments", label: "nav.items.pu-payments", icon: "Wallet", cap: "procurement.view", module: "purchasing" },
      { id: "pu-returns", path: "/purchasing/returns", label: "nav.items.pu-returns", icon: "CornerUpLeft", cap: "procurement.view", module: "purchasing" },
    ],
  },
  {
    id: "accounting",
    label: "nav.groups.accounting",
    items: [
      // Package H corrective gate — same precedent as 'finance.reports.view'
      // on ac-tb below. The Chart of Accounts screen fronts routes/erp.js,
      // whose list endpoint requires 'finance.gl.view' and whose every
      // mutation requires 'finance.accounts.manage'. It was gated here on
      // 'accounting.view', a key NO backend route enforces and which excludes
      // auditor — so an auditor the API happily serves could not see the item.
      // subRoutes: the module owns /new, /:id, /:id/edit, /:id/move, /health
      // and /import as real, refresh-survivable URLs.
      { id: "ac-coa", path: "/accounting/chart-of-accounts", label: "nav.items.ac-coa", icon: "BookText", cap: "finance.gl.view", module: "accounting", subRoutes: true },
      { id: "ac-journals", path: "/accounting/journals", label: "nav.items.ac-journals", icon: "BookOpen", cap: "accounting.journals.view", module: "accounting" },
      { id: "ac-gl", path: "/accounting/general-ledger", label: "nav.items.ac-gl", icon: "Layers", cap: "accounting.reports.view", module: "accounting" },
      // Tier A.1 corrective gate — this cap matches routes/erp-core.js's real
      // requireCapability('finance.reports.view') gate exactly. (The other
      // report nav items below still use 'accounting.reports.view', whose
      // matching backend gate has not been individually verified — see
      // ADR 0002 section 7; not changed here to avoid guessing.)
      // Release integration — the i18n sprint rewrote every label in this block
      // into a t() key and, doing so, carried this cap back to
      // 'accounting.reports.view'. Restored, because it is load-bearing:
      // e2e/erp/trial-balance-rbac.spec.ts asserts a cashier is never offered
      // this link, and that only holds while the nav cap matches the backend
      // gate. Nothing else in the block changed.
      { id: "ac-tb", path: "/accounting/trial-balance", label: "nav.items.ac-tb", icon: "Scale", cap: "finance.reports.view", module: "accounting" },
      { id: "ac-sales-posting", path: "/accounting/sales-posting", label: "nav.items.ac-sales-posting", icon: "Send", cap: "finance.reports.view", module: "accounting" },
      { id: "ac-pnl", path: "/accounting/income-statement", label: "nav.items.ac-pnl", icon: "TrendingUp", cap: "accounting.reports.view", module: "accounting" },
      { id: "ac-bs", path: "/accounting/balance-sheet", label: "nav.items.ac-bs", icon: "Building2", cap: "accounting.reports.view", module: "accounting" },
      { id: "ac-cf", path: "/accounting/cash-flow", label: "nav.items.ac-cf", icon: "LineChart", cap: "accounting.reports.view", module: "accounting" },
      { id: "ac-ar-aging", path: "/accounting/ar-aging", label: "nav.items.ac-ar-aging", icon: "HandCoins", cap: "accounting.reports.view", module: "accounting" },
      { id: "ac-ap-aging", path: "/accounting/ap-aging", label: "nav.items.ac-ap-aging", icon: "PiggyBank", cap: "accounting.reports.view", module: "accounting" },
      { id: "ac-ratios", path: "/accounting/financial-ratios", label: "nav.items.ac-ratios", icon: "Gauge", cap: "accounting.reports.view", module: "accounting" },
      { id: "ac-equity-changes", path: "/accounting/equity-changes", label: "nav.items.ac-equity-changes", icon: "Landmark", cap: "accounting.reports.view", module: "accounting" },
      { id: "ac-profitability", path: "/accounting/profitability", label: "nav.items.ac-profitability", icon: "TrendingUp", cap: "accounting.reports.view", module: "accounting" },
      { id: "ac-inventory-valuation", path: "/accounting/inventory-valuation", label: "nav.items.ac-inventory-valuation", icon: "Boxes", cap: "accounting.reports.view", module: "accounting" },
      // The accounting sales-analytics leaf was retired → the Sales Analytics Hub
      // (/reports/sales/executive). Redirect lives in app/router.tsx.
      { id: "ac-royalties", path: "/accounting/royalties", label: "nav.items.ac-royalties", icon: "Crown", cap: "royalty.view", module: "accounting" },
      { id: "ac-periods", path: "/accounting/periods", label: "nav.items.ac-periods", icon: "CalendarRange", cap: "accounting.periods.view", module: "accounting" },
      { id: "ac-cost-centers", path: "/accounting/cost-centers", label: "nav.items.ac-cost-centers", icon: "Target", cap: "accounting.view", module: "accounting" },
      { id: "ac-dimensions", path: "/accounting/dimensions", label: "nav.items.ac-dimensions", icon: "GitBranch", cap: "accounting.view", module: "accounting" },
    ],
  },
  {
    id: "banking",
    label: "nav.groups.banking",
    items: [
      { id: "bk-cashboxes", path: "/banking/cashboxes", label: "nav.items.bk-cashboxes", icon: "Vault", cap: "banking.view", module: "banking" },
      { id: "bk-accounts", path: "/banking/bank-accounts", label: "nav.items.bk-accounts", icon: "Landmark", cap: "banking.view", module: "banking" },
      { id: "bk-receipts", path: "/banking/receipts", label: "nav.items.bk-receipts", icon: "Receipt", cap: "banking.view", module: "banking" },
      { id: "bk-payments", path: "/banking/payments", label: "nav.items.bk-payments", icon: "CreditCard", cap: "banking.view", module: "banking" },
      { id: "bk-transfers", path: "/banking/transfers", label: "nav.items.bk-transfers", icon: "ArrowLeftRight", cap: "banking.view", module: "banking" },
      { id: "bk-reconciliation", path: "/banking/reconciliation", label: "nav.items.bk-reconciliation", icon: "Scale", cap: "banking.view", module: "banking" },
      { id: "bk-cash-closing", path: "/banking/cash-closing", label: "nav.items.bk-cash-closing", icon: "Lock", cap: "banking.view", module: "banking" },
    ],
  },
  {
    id: "people",
    label: "nav.groups.people",
    items: [
      { id: "pe-employees", path: "/people/employees", label: "nav.items.pe-employees", icon: "Users", cap: "people.employees.view", module: "people" },
      { id: "pe-attendance", path: "/people/attendance", label: "nav.items.pe-attendance", icon: "CalendarCheck", cap: "people.attendance.view", module: "people" },
      { id: "pe-shifts", path: "/people/shifts", label: "nav.items.pe-shifts", icon: "Clock", cap: "people.shifts.view", module: "people" },
      { id: "pe-leaves", path: "/people/leaves", label: "nav.items.pe-leaves", icon: "Plane", cap: "people.leaves.view", module: "people" },
      { id: "pe-contracts", path: "/people/contracts", label: "nav.items.pe-contracts", icon: "FileSignature", cap: "people.contracts.view", module: "people" },
      { id: "pe-payroll", path: "/people/payroll", label: "nav.items.pe-payroll", icon: "Banknote", cap: "people.payroll.view", module: "people" },
      { id: "pe-org-tree", path: "/people/org-tree", label: "nav.items.pe-org-tree", icon: "Network", cap: "workflow.view", module: "people" },
      { id: "pe-custody", path: "/people/custody", label: "nav.items.pe-custody", icon: "Briefcase", cap: "people.custody.view", module: "people" },
      { id: "pe-custody-officers", path: "/people/custody-officers", label: "nav.items.pe-custody-officers", icon: "Contact", cap: "people.employees.view", module: "people" },
      { id: "pe-self-service", path: "/people/self-service", label: "nav.items.pe-self-service", icon: "UserCircle", cap: "people.selfservice.view", module: "people" },
    ],
  },
  {
    id: "workflow",
    label: "nav.groups.workflow",
    items: [
      { id: "wf-new", path: "/workflow/new", label: "nav.items.wf-new", icon: "FileText", cap: "txn.create", module: "workflow" },
      { id: "wf-inbox", path: "/workflow/inbox", label: "nav.items.wf-inbox", icon: "Inbox", cap: "workflow.inbox.view", module: "workflow" },
      { id: "wf-outbox", path: "/workflow/outbox", label: "nav.items.wf-outbox", icon: "Send", cap: "workflow.outbox.view", module: "workflow" },
      { id: "wf-my-requests", path: "/workflow/my-requests", label: "nav.items.wf-my-requests", icon: "FileClock", cap: "workflow.myrequests.view", module: "workflow" },
      { id: "wf-approval-flows", path: "/workflow/approval-flows", label: "nav.items.wf-approval-flows", icon: "GitBranch", cap: "workflow.approvals.view", module: "workflow" },
      { id: "wf-action-log", path: "/workflow/action-log", label: "nav.items.wf-action-log", icon: "ScrollText", cap: "workflow.audit.view", module: "workflow" },
    ],
  },
  {
    id: "reports",
    label: "nav.groups.reports",
    items: [
      { id: "rp-sales", path: "/reports/sales", label: "nav.items.rp-sales", icon: "BarChart3", cap: "reports.view", module: "reports", subRoutes: true },
      { id: "rp-inventory", path: "/reports/inventory", label: "nav.items.rp-inventory", icon: "FileBarChart", cap: "reports.view", module: "reports" },
      { id: "rp-purchasing", path: "/reports/purchasing", label: "nav.items.rp-purchasing", icon: "FileBarChart", cap: "reports.view", module: "reports" },
      { id: "rp-financial", path: "/reports/financial", label: "nav.items.rp-financial", icon: "LineChart", cap: "reports.view", module: "reports" },
      { id: "rp-people", path: "/reports/people", label: "nav.items.rp-people", icon: "FileBarChart", cap: "reports.view", module: "reports" },
      { id: "rp-operations", path: "/reports/operations", label: "nav.items.rp-operations", icon: "FileBarChart", cap: "reports.view", module: "reports" },
      { id: "rp-saved", path: "/reports/saved", label: "nav.items.rp-saved", icon: "Files", cap: "reports.view", module: "reports" },
    ],
  },
  {
    id: "administration",
    label: "nav.groups.administration",
    items: [
      { id: "ad-companies", path: "/administration/companies", label: "nav.items.ad-companies", icon: "Building2", cap: "administration.companies", module: "administration" },
      { id: "ad-branches", path: "/administration/branches", label: "nav.items.ad-branches", icon: "Building", cap: "administration.branches", module: "administration" },
      { id: "ad-warehouses", path: "/administration/warehouses", label: "nav.items.ad-warehouses", icon: "Warehouse", cap: "administration.warehouses", module: "administration" },
      { id: "ad-users", path: "/administration/users", label: "nav.items.ad-users", icon: "Users", cap: "administration.users", module: "administration" },
      { id: "ad-roles", path: "/administration/roles", label: "nav.items.ad-roles", icon: "ShieldCheck", cap: "administration.roles", module: "administration" },
      { id: "ad-settings", path: "/administration/settings", label: "nav.items.ad-settings", icon: "SlidersHorizontal", cap: "administration.settings", module: "administration" },
      { id: "ad-invoice-settings", path: "/administration/invoice-settings", label: "nav.items.ad-invoice-settings", icon: "ReceiptText", cap: "administration.invoice-settings", module: "administration" },
      { id: "ad-tax", path: "/administration/tax", label: "nav.items.ad-tax", icon: "Percent", cap: "administration.tax", module: "administration" },
      { id: "ad-payment-methods", path: "/administration/payment-methods", label: "nav.items.ad-payment-methods", icon: "CreditCard", cap: "administration.payment-methods", module: "administration" },
      { id: "ad-security", path: "/administration/security", label: "nav.items.ad-security", icon: "Lock", cap: "administration.security", module: "administration" },
      { id: "ad-audit-log", path: "/administration/audit-log", label: "nav.items.ad-audit-log", icon: "History", cap: "administration.audit", module: "administration" },
    ],
  },
];

/** Flat list of every nav item (route registration + uniqueness tests). */
export const NAV_ITEMS: NavItem[] = NAV.flatMap((g) => g.items);

/** All items that route into a given module folder. */
export function navByModule(module: string): NavItem[] {
  return NAV_ITEMS.filter((i) => i.module === module);
}

/** Look up a nav item by its exact route path. */
export function navByPath(path: string): NavItem | undefined {
  return NAV_ITEMS.find((i) => i.path === path);
}

/** The group a given nav item belongs to (for breadcrumbs / placeholders). */
export function navGroupOf(item: NavItem): NavGroup | undefined {
  return NAV.find((g) => g.items.some((i) => i.id === item.id));
}

/** Distinct module folder names referenced by the manifest. */
export const NAV_MODULES: string[] = [...new Set(NAV_ITEMS.map((i) => i.module))];
