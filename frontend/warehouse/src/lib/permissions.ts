// Client-side permission map — used ONLY to hide/disable actions in the UI.
// The Backend (middleware/auth.requireRole + the Phase 0 guards) is the real
// security boundary; this mirror keeps the UI honest and avoids dead buttons.

export type Role = "admin" | "manager" | "employee" | "custody" | "cashier" | "auditor";

export interface SessionUser {
  username: string;
  name?: string;
  role: Role;
  isDeveloper?: boolean;
}

export type WarehouseAction =
  | "warehouse.view"
  | "warehouse.create"
  | "warehouse.deactivate"
  | "transfer.create"
  | "transfer.approve"
  | "transfer.issue"
  | "transfer.receive"
  | "transfer.reverse"
  | "stocktake.create"
  | "stocktake.approve"
  | "stocktake.post"
  | "adjustment.create"
  | "adjustment.approve"
  | "adjustment.post"
  | "adjustment.reverse"
  | "receipt.create"
  | "receipt.approve"
  | "receipt.post"
  | "receipt.reverse"
  | "issue.create"
  | "issue.approve"
  | "issue.post"
  | "issue.reverse"
  | "waste.create"
  | "document.reverse"
  | "settings.edit";

// Roles allowed per action. Mirrors the blueprint §5 matrix and the backend
// requireRole gates established in Phase 0. `auditor` is read-only everywhere.
const MATRIX: Record<WarehouseAction, Role[]> = {
  "warehouse.view": ["admin", "manager", "employee", "custody", "cashier", "auditor"],
  "warehouse.create": ["admin", "manager"],
  "warehouse.deactivate": ["admin", "manager"],
  "transfer.create": ["admin", "manager", "employee", "custody"],
  "transfer.approve": ["admin", "manager"],
  "transfer.issue": ["admin", "manager", "employee", "custody"],
  "transfer.receive": ["admin", "manager", "employee", "custody"],
  "transfer.reverse": ["admin", "manager"],
  "stocktake.create": ["admin", "manager", "employee", "custody"],
  "stocktake.approve": ["admin", "manager"],
  "stocktake.post": ["admin", "manager", "employee", "custody"],
  "adjustment.create": ["admin", "manager", "employee", "custody"],
  "adjustment.approve": ["admin", "manager"],
  "adjustment.post": ["admin", "manager", "employee", "custody"],
  "adjustment.reverse": ["admin", "manager"],
  // Phase 3B — independent receipts / issues. create+post = back-office; approve
  // + reverse = managerial. Mirrors routes/inventory-transactions.js (BACKOFFICE/MGR).
  "receipt.create": ["admin", "manager", "employee", "custody"],
  "receipt.approve": ["admin", "manager"],
  "receipt.post": ["admin", "manager", "employee", "custody"],
  "receipt.reverse": ["admin", "manager"],
  "issue.create": ["admin", "manager", "employee", "custody"],
  "issue.approve": ["admin", "manager"],
  "issue.post": ["admin", "manager", "employee", "custody"],
  "issue.reverse": ["admin", "manager"],
  "waste.create": ["admin", "manager", "employee", "custody"],
  "document.reverse": ["admin", "manager"],
  "settings.edit": ["admin", "manager"],
};

export function can(user: SessionUser | null, action: WarehouseAction): boolean {
  if (!user) return false;
  if (user.isDeveloper) return true;
  const allowed = MATRIX[action];
  if (!allowed) return false;
  return allowed.includes(user.role);
}
