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
  | "adjustment.create"
  | "adjustment.approve"
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
  "adjustment.create": ["admin", "manager", "employee", "custody"],
  "adjustment.approve": ["admin", "manager"],
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
