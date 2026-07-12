// ── ADLAN Back-Office — THE navigation manifest (single source of truth) ─────
// Sidebar groups, MobileNav, route registration, breadcrumbs, the command
// palette AND the anti-duplication tests all derive from this one file. Every
// item has a UNIQUE id + UNIQUE path and a capability from the ONE catalog
// (@/app/permissions). `icon` is a lucide icon NAME (resolved in the shell), and
// `module` names the folder under src/modules/ the route renders into.

import type { Capability } from "@/app/permissions";

export interface NavItem {
  /** Unique, stable id (used for React keys + the uniqueness test). */
  id: string;
  /** Unique route path, under the /app basename via the router. */
  path: string;
  /** Arabic sidebar label. */
  label: string;
  /** lucide-react icon name (PascalCase), resolved to a component in the shell. */
  icon: string;
  /** Capability required to see/enter the item (from the ONE catalog). */
  cap?: Capability;
  /** Optional server feature-flag key; hidden until the flag is on. */
  flag?: string;
  /** The src/modules/<module> folder this item routes into. */
  module: string;
}

export interface NavGroup {
  /** Unique group id. */
  id: string;
  /** Arabic group heading. */
  label: string;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    id: "overview",
    label: "الرئيسية",
    items: [
      { id: "ov-overview", path: "/overview", label: "نظرة عامة", icon: "LayoutDashboard", cap: "overview.view", module: "overview" },
      { id: "ov-tasks", path: "/overview/tasks", label: "المهام والتنبيهات", icon: "ListTodo", cap: "overview.tasks.view", module: "overview" },
      { id: "ov-approvals", path: "/overview/approvals", label: "الموافقات المطلوبة", icon: "CheckCheck", cap: "overview.approvals.view", module: "overview" },
      { id: "ov-kpis", path: "/overview/kpis", label: "مؤشرات الأداء", icon: "Gauge", cap: "overview.kpis.view", module: "overview" },
    ],
  },
  {
    id: "sales",
    label: "المبيعات",
    items: [
      { id: "sl-orders", path: "/sales/orders", label: "الطلبات", icon: "ShoppingCart", cap: "sales_orders.view", module: "sales" },
      { id: "sl-invoices", path: "/sales/invoices", label: "الفواتير", icon: "FileText", cap: "invoices.view", module: "sales" },
      { id: "sl-returns", path: "/sales/returns", label: "المرتجعات", icon: "Undo2", cap: "returns.view", module: "sales" },
      { id: "sl-payments", path: "/sales/payments", label: "المدفوعات", icon: "Banknote", cap: "payments.view", module: "sales" },
      { id: "sl-customers", path: "/customers", label: "العملاء", icon: "Users", cap: "customers.view", module: "customers" },
      { id: "sl-channels", path: "/sales/channels", label: "قنوات البيع", icon: "Store", cap: "sales.channels.view", module: "sales" },
      { id: "sl-pricing", path: "/sales/pricing", label: "قوائم الأسعار والخصومات", icon: "Tags", cap: "sales.pricing.view", module: "sales" },
    ],
  },
  {
    id: "pos-admin",
    label: "نقاط البيع",
    items: [
      { id: "pa-register", path: "/pos-admin/register", label: "فتح الكاشير", icon: "Monitor", cap: "pos.register.view", module: "pos-admin" },
      { id: "pa-shifts", path: "/pos-admin/shifts", label: "الورديات", icon: "Clock", cap: "pos.shifts.view", module: "pos-admin" },
      { id: "pa-parked", path: "/pos-admin/parked-orders", label: "الطلبات المعلقة", icon: "PauseCircle", cap: "pos.parked.view", module: "pos-admin" },
      { id: "pa-devices", path: "/pos-admin/devices", label: "مزامنة الأجهزة", icon: "RefreshCw", cap: "pos.devices.view", module: "pos-admin" },
      { id: "pa-reports", path: "/pos-admin/reports", label: "تقارير الكاشير", icon: "Receipt", cap: "pos.reports.view", module: "pos-admin" },
    ],
  },
  {
    id: "inventory",
    label: "المخزون",
    items: [
      { id: "inv-overview", path: "/inventory", label: "نظرة عامة", icon: "LayoutDashboard", cap: "inventory.view", module: "inventory" },
      { id: "inv-items", path: "/inventory/items", label: "الأصناف", icon: "Package", cap: "item.view", module: "inventory" },
      { id: "inv-units", path: "/inventory/units-barcodes", label: "الوحدات والباركود", icon: "Barcode", cap: "inventory.units.view", module: "inventory" },
      { id: "inv-warehouses", path: "/inventory/warehouses", label: "المستودعات", icon: "Warehouse", cap: "warehouse.view", module: "inventory" },
      { id: "inv-balances", path: "/inventory/balances", label: "الأرصدة", icon: "Boxes", cap: "inventory.balances.view", module: "inventory" },
      { id: "inv-transfers", path: "/inventory/transfers", label: "التحويلات", icon: "Truck", cap: "inventory.transfers.view", module: "inventory" },
      { id: "inv-receiving", path: "/inventory/receiving", label: "الاستلام", icon: "PackageCheck", cap: "inventory.receiving.view", module: "inventory" },
      { id: "inv-issues", path: "/inventory/issues", label: "الصرف", icon: "PackageMinus", cap: "inventory.issues.view", module: "inventory" },
      { id: "inv-adjustments", path: "/inventory/adjustments", label: "التسويات", icon: "SlidersHorizontal", cap: "inventory.adjustments.view", module: "inventory" },
      { id: "inv-stocktakes", path: "/inventory/stocktakes", label: "الجرد", icon: "ClipboardCheck", cap: "inventory.stocktakes.view", module: "inventory" },
      { id: "inv-lots-expiry", path: "/inventory/lots-expiry", label: "التشغيلات والصلاحية", icon: "CalendarClock", cap: "expiry.view", module: "inventory" },
      { id: "inv-replenishment", path: "/inventory/replenishment", label: "إعادة الطلب", icon: "RefreshCcw", cap: "replenishment.view", module: "inventory" },
      { id: "inv-production", path: "/inventory/production", label: "الإنتاج", icon: "Factory", cap: "production.view", module: "production" },
    ],
  },
  {
    id: "purchasing",
    label: "المشتريات",
    items: [
      { id: "pu-suppliers", path: "/purchasing/suppliers", label: "الموردون", icon: "Contact", cap: "procurement.view", module: "purchasing" },
      { id: "pu-requisitions", path: "/purchasing/requisitions", label: "طلبات الشراء", icon: "ClipboardList", cap: "procurement.view", module: "purchasing" },
      { id: "pu-orders", path: "/purchasing/orders", label: "أوامر الشراء", icon: "ShoppingBag", cap: "procurement.view", module: "purchasing" },
      { id: "pu-receiving", path: "/purchasing/receiving", label: "استلام البضاعة", icon: "PackageOpen", cap: "procurement.view", module: "purchasing" },
      { id: "pu-invoices", path: "/purchasing/invoices", label: "فواتير الموردين", icon: "FileText", cap: "procurement.view", module: "purchasing" },
      { id: "pu-payments", path: "/purchasing/payments", label: "مدفوعات الموردين", icon: "Wallet", cap: "procurement.view", module: "purchasing" },
      { id: "pu-returns", path: "/purchasing/returns", label: "مرتجعات المشتريات", icon: "CornerUpLeft", cap: "procurement.view", module: "purchasing" },
    ],
  },
  {
    id: "accounting",
    label: "المحاسبة",
    items: [
      { id: "ac-coa", path: "/accounting/chart-of-accounts", label: "دليل الحسابات", icon: "BookText", cap: "accounting.view", module: "accounting" },
      { id: "ac-journals", path: "/accounting/journals", label: "القيود اليومية", icon: "BookOpen", cap: "accounting.journals.view", module: "accounting" },
      { id: "ac-gl", path: "/accounting/general-ledger", label: "الأستاذ العام", icon: "Layers", cap: "accounting.reports.view", module: "accounting" },
      { id: "ac-tb", path: "/accounting/trial-balance", label: "ميزان المراجعة", icon: "Scale", cap: "accounting.reports.view", module: "accounting" },
      { id: "ac-pnl", path: "/accounting/income-statement", label: "قائمة الدخل", icon: "TrendingUp", cap: "accounting.reports.view", module: "accounting" },
      { id: "ac-bs", path: "/accounting/balance-sheet", label: "الميزانية", icon: "Building2", cap: "accounting.reports.view", module: "accounting" },
      { id: "ac-cf", path: "/accounting/cash-flow", label: "التدفقات النقدية", icon: "LineChart", cap: "accounting.reports.view", module: "accounting" },
      { id: "ac-ar-aging", path: "/accounting/ar-aging", label: "أعمار الذمم المدينة", icon: "HandCoins", cap: "accounting.reports.view", module: "accounting" },
      { id: "ac-ap-aging", path: "/accounting/ap-aging", label: "أعمار الذمم الدائنة", icon: "PiggyBank", cap: "accounting.reports.view", module: "accounting" },
      { id: "ac-cost-centers", path: "/accounting/cost-centers", label: "مراكز التكلفة", icon: "Target", cap: "accounting.view", module: "accounting" },
      { id: "ac-dimensions", path: "/accounting/dimensions", label: "المشروعات والأبعاد", icon: "GitBranch", cap: "accounting.view", module: "accounting" },
    ],
  },
  {
    id: "banking",
    label: "النقد والبنوك",
    items: [
      { id: "bk-cashboxes", path: "/banking/cashboxes", label: "الخزائن", icon: "Vault", cap: "banking.view", module: "banking" },
      { id: "bk-accounts", path: "/banking/bank-accounts", label: "الحسابات البنكية", icon: "Landmark", cap: "banking.view", module: "banking" },
      { id: "bk-receipts", path: "/banking/receipts", label: "المقبوضات", icon: "Receipt", cap: "banking.view", module: "banking" },
      { id: "bk-payments", path: "/banking/payments", label: "المدفوعات", icon: "CreditCard", cap: "banking.view", module: "banking" },
      { id: "bk-transfers", path: "/banking/transfers", label: "التحويلات البنكية", icon: "ArrowLeftRight", cap: "banking.view", module: "banking" },
      { id: "bk-reconciliation", path: "/banking/reconciliation", label: "التسويات البنكية", icon: "Scale", cap: "banking.view", module: "banking" },
      { id: "bk-cash-closing", path: "/banking/cash-closing", label: "إقفال الصندوق", icon: "Lock", cap: "banking.view", module: "banking" },
    ],
  },
  {
    id: "people",
    label: "الموارد البشرية",
    items: [
      { id: "pe-employees", path: "/people/employees", label: "الموظفون", icon: "Users", cap: "people.employees.view", module: "people" },
      { id: "pe-attendance", path: "/people/attendance", label: "الحضور والانصراف", icon: "CalendarCheck", cap: "people.attendance.view", module: "people" },
      { id: "pe-shifts", path: "/people/shifts", label: "الورديات", icon: "Clock", cap: "people.shifts.view", module: "people" },
      { id: "pe-leaves", path: "/people/leaves", label: "الإجازات", icon: "Plane", cap: "people.leaves.view", module: "people" },
      { id: "pe-contracts", path: "/people/contracts", label: "العقود", icon: "FileSignature", cap: "people.contracts.view", module: "people" },
      { id: "pe-payroll", path: "/people/payroll", label: "الرواتب", icon: "Banknote", cap: "people.payroll.view", module: "people" },
      { id: "pe-custody", path: "/people/custody", label: "العهد والمستندات", icon: "Briefcase", cap: "people.custody.view", module: "people" },
      { id: "pe-self-service", path: "/people/self-service", label: "الخدمة الذاتية", icon: "UserCircle", cap: "people.selfservice.view", module: "people" },
    ],
  },
  {
    id: "workflow",
    label: "المعاملات والموافقات",
    items: [
      { id: "wf-inbox", path: "/workflow/inbox", label: "صندوق الوارد", icon: "Inbox", cap: "workflow.inbox.view", module: "workflow" },
      { id: "wf-outbox", path: "/workflow/outbox", label: "صندوق الصادر", icon: "Send", cap: "workflow.outbox.view", module: "workflow" },
      { id: "wf-my-requests", path: "/workflow/my-requests", label: "طلباتي", icon: "FileClock", cap: "workflow.myrequests.view", module: "workflow" },
      { id: "wf-approval-flows", path: "/workflow/approval-flows", label: "مسارات الاعتماد", icon: "GitBranch", cap: "workflow.approvals.view", module: "workflow" },
      { id: "wf-action-log", path: "/workflow/action-log", label: "سجل الإجراءات", icon: "ScrollText", cap: "workflow.audit.view", module: "workflow" },
    ],
  },
  {
    id: "reports",
    label: "التقارير",
    items: [
      { id: "rp-sales", path: "/reports/sales", label: "تقارير المبيعات", icon: "BarChart3", cap: "reports.view", module: "reports" },
      { id: "rp-inventory", path: "/reports/inventory", label: "تقارير المخزون", icon: "FileBarChart", cap: "reports.view", module: "reports" },
      { id: "rp-purchasing", path: "/reports/purchasing", label: "تقارير المشتريات", icon: "FileBarChart", cap: "reports.view", module: "reports" },
      { id: "rp-financial", path: "/reports/financial", label: "التقارير المالية", icon: "LineChart", cap: "reports.view", module: "reports" },
      { id: "rp-people", path: "/reports/people", label: "تقارير الموظفين", icon: "FileBarChart", cap: "reports.view", module: "reports" },
      { id: "rp-operations", path: "/reports/operations", label: "تقارير التشغيل", icon: "FileBarChart", cap: "reports.view", module: "reports" },
      { id: "rp-saved", path: "/reports/saved", label: "التقارير المحفوظة", icon: "Files", cap: "reports.view", module: "reports" },
    ],
  },
  {
    id: "administration",
    label: "الإدارة",
    items: [
      { id: "ad-companies", path: "/administration/companies", label: "الشركات والعلامات التجارية", icon: "Building2", cap: "administration.companies", module: "administration" },
      { id: "ad-branches", path: "/administration/branches", label: "الفروع", icon: "Building", cap: "administration.branches", module: "administration" },
      { id: "ad-warehouses", path: "/administration/warehouses", label: "المستودعات", icon: "Warehouse", cap: "administration.warehouses", module: "administration" },
      { id: "ad-users", path: "/administration/users", label: "المستخدمون", icon: "Users", cap: "administration.users", module: "administration" },
      { id: "ad-roles", path: "/administration/roles", label: "الأدوار والصلاحيات", icon: "ShieldCheck", cap: "administration.roles", module: "administration" },
      { id: "ad-settings", path: "/administration/settings", label: "الإعدادات", icon: "SlidersHorizontal", cap: "administration.settings", module: "administration" },
      { id: "ad-tax", path: "/administration/tax", label: "الضرائب", icon: "Percent", cap: "administration.tax", module: "administration" },
      { id: "ad-payment-methods", path: "/administration/payment-methods", label: "طرق الدفع", icon: "CreditCard", cap: "administration.payment-methods", module: "administration" },
      { id: "ad-security", path: "/administration/security", label: "الأمان", icon: "Lock", cap: "administration.security", module: "administration" },
      { id: "ad-audit-log", path: "/administration/audit-log", label: "سجل التدقيق", icon: "History", cap: "administration.audit", module: "administration" },
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
