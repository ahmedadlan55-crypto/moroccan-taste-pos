// Client-side permission mirror for Order-to-Cash — used ONLY to hide/disable
// actions in the UI. The backend `requireCapability` is the real security
// boundary; this keeps buttons honest and avoids dead controls. Mirrors
// db/migrations/order-to-cash/capabilities.js ROLE_GRANTS exactly.

export type Role = "admin" | "developer" | "manager" | "cashier" | "sales" | "accountant" | "finance" | "employee" | string;

export interface SessionUser {
  username: string;
  name?: string;
  role: Role;
  isDeveloper?: boolean;
}

export type O2CCapability =
  | "o2c.view" | "o2c.dashboard.view" | "ar_reports.view" | "o2c.export" | "o2c.data_quality"
  | "customers.view" | "customers.create" | "customers.edit" | "customers.deactivate" | "customers.merge"
  | "sales_orders.view" | "sales_orders.create" | "sales_orders.confirm" | "sales_orders.fulfill"
  | "invoices.view" | "invoices.create" | "invoices.issue" | "credit.override"
  | "payments.view" | "payments.create" | "payments.approve" | "payments.post" | "payments.reverse"
  | "returns.view" | "returns.create" | "returns.approve" | "returns.post" | "returns.reverse";

export const ALL_CAPS: O2CCapability[] = [
  "o2c.view", "o2c.dashboard.view", "ar_reports.view", "o2c.export", "o2c.data_quality",
  "customers.view", "customers.create", "customers.edit", "customers.deactivate", "customers.merge",
  "sales_orders.view", "sales_orders.create", "sales_orders.confirm", "sales_orders.fulfill",
  "invoices.view", "invoices.create", "invoices.issue", "credit.override",
  "payments.view", "payments.create", "payments.approve", "payments.post", "payments.reverse",
  "returns.view", "returns.create", "returns.approve", "returns.post", "returns.reverse",
];

const ROLE_GRANTS: Record<string, O2CCapability[]> = {
  manager: [...ALL_CAPS],
  cashier: [
    "o2c.view", "o2c.dashboard.view",
    "customers.view", "customers.create", "customers.edit",
    "sales_orders.view", "sales_orders.create",
    "invoices.view", "invoices.create",
    "payments.view", "payments.create",
    "returns.view", "returns.create",
  ],
  sales: [
    "o2c.view", "o2c.dashboard.view", "ar_reports.view",
    "customers.view", "customers.create", "customers.edit",
    "sales_orders.view", "sales_orders.create", "sales_orders.confirm",
    "invoices.view", "invoices.create",
    "payments.view", "payments.create",
    "returns.view", "returns.create",
  ],
  accountant: [
    "o2c.view", "o2c.dashboard.view", "ar_reports.view", "o2c.export", "o2c.data_quality",
    "customers.view",
    "invoices.view", "invoices.create", "invoices.issue",
    "credit.override",
    "payments.view", "payments.create", "payments.approve", "payments.post", "payments.reverse",
    "returns.view", "returns.approve", "returns.post", "returns.reverse",
  ],
  finance: [
    "o2c.view", "o2c.dashboard.view", "ar_reports.view", "o2c.export", "o2c.data_quality",
    "customers.view",
    "invoices.view", "invoices.issue", "credit.override",
    "payments.view", "payments.approve", "payments.post", "payments.reverse",
    "returns.approve", "returns.post", "returns.reverse",
  ],
};

export function isAdmin(user: SessionUser | null): boolean {
  if (!user) return false;
  const role = String(user.role || "").toLowerCase();
  return role === "admin" || role === "developer" || user.isDeveloper === true;
}

/** Client-side capability check (mirror). Server remains authoritative. */
export function can(user: SessionUser | null, cap: O2CCapability): boolean {
  if (!user) return false;
  if (isAdmin(user)) return true;
  const grants = ROLE_GRANTS[String(user.role || "").toLowerCase()];
  return !!grants && grants.includes(cap);
}
