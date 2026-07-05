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
  | "item.view"
  | "item.create"
  | "item.edit"
  | "item.activate"
  | "replenishment.view"
  | "lot.view"
  | "lot.create"
  | "lot.edit"
  | "lot.quarantine"
  | "lot.recall"
  | "expiry.view"
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
  | "settings.edit"
  | "barcode.manage"
  | "negativePolicy.view"
  | "negativePolicy.edit"
  | "warehouse.edit"
  | "warehouse.scopeAssign"
  | "production.view"
  | "production.create"
  | "production.approve"
  | "production.issue"
  | "production.output"
  | "production.complete"
  | "production.close"
  | "production.cancel"
  | "production.reverse"
  | "production.delete"
  // Procurement / P2P — UI hints only; backend requireCapability(procurement.*)
  // is the real gate. view = everyone; manage = back-office document authoring;
  // approve = managerial (PO/receipt/invoice/payment/return sensitive actions).
  | "procurement.view"
  | "procurement.manage"
  | "procurement.approve";

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
  // Phase 4A — item master + replenishment. create/edit = back-office; activate/
  // deactivate = managerial (mirrors routes/inventory-items.js BACKOFFICE/MGR).
  "item.view": ["admin", "manager", "employee", "custody", "cashier", "auditor"],
  "item.create": ["admin", "manager", "employee", "custody"],
  "item.edit": ["admin", "manager", "employee", "custody"],
  "item.activate": ["admin", "manager"],
  "replenishment.view": ["admin", "manager", "employee", "custody", "auditor"],
  // Phase 4B — lots / expiry. view = everyone; create/edit = back-office;
  // quarantine/recall = managerial (mirrors routes/inventory-lots.js BACKOFFICE/MGR).
  "lot.view": ["admin", "manager", "employee", "custody", "cashier", "auditor"],
  "lot.create": ["admin", "manager", "employee", "custody"],
  "lot.edit": ["admin", "manager", "employee", "custody"],
  "lot.quarantine": ["admin", "manager"],
  "lot.recall": ["admin", "manager"],
  "expiry.view": ["admin", "manager", "employee", "custody", "auditor"],
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
  // Phase W4 — barcode list replacement is a MGR endpoint (PUT /items/:id/barcodes).
  "barcode.manage": ["admin", "manager"],
  // Phase W2 — negative-stock policy settings (mirrors routes/negative-policy.js:
  // read = managerial+auditor; edit = admin, allow-mode gated developer-side).
  "negativePolicy.view": ["admin", "manager", "auditor"],
  "negativePolicy.edit": ["admin"],
  // Phase W6 — warehouse management writes (mirrors routes MGR gates).
  "warehouse.edit": ["admin", "manager"],
  "warehouse.scopeAssign": ["admin"],
  // Phase P1 — production orders. create/issue/output/complete = back-office;
  // approve/close/cancel/reverse/delete = managerial (mirrors
  // routes/inventory-production.js BACKOFFICE/MGR gates).
  "production.view": ["admin", "manager", "employee", "custody", "auditor"],
  "production.create": ["admin", "manager", "employee", "custody"],
  "production.approve": ["admin", "manager"],
  "production.issue": ["admin", "manager", "employee", "custody"],
  "production.output": ["admin", "manager", "employee", "custody"],
  "production.complete": ["admin", "manager", "employee", "custody"],
  "production.close": ["admin", "manager"],
  "production.cancel": ["admin", "manager"],
  "production.reverse": ["admin", "manager"],
  "production.delete": ["admin", "manager"],
  "procurement.view": ["admin", "manager", "employee", "custody", "auditor"],
  "procurement.manage": ["admin", "manager", "employee", "custody"],
  "procurement.approve": ["admin", "manager"],
};

export function can(user: SessionUser | null, action: WarehouseAction): boolean {
  if (!user) return false;
  if (user.isDeveloper) return true;
  const allowed = MATRIX[action];
  if (!allowed) return false;
  return allowed.includes(user.role);
}
