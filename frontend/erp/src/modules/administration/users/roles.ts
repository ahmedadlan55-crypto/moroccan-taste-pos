// Assignable user roles — MIRRORS the backend catalog (lib/roles.js:
// ASSIGNABLE_ROLES) exactly. The server 400s any role outside this set, so
// `developer` (not a real role — a capability-only bypass) is deliberately
// absent.
//
// Tier A.2 corrective gate — `auditor` moved from lib/roles.js's
// GRANT_ONLY_ROLES to ASSIGNABLE_ROLES (it already had real capability grants —
// finance.reports.view/finance.gl.view/finance.bankrec.view — that no account
// could ever actually hold through this UI). Kept here so the role stays
// selectable in UserDialog.tsx, not just accepted by the server directly.
//
// i18n: role labels live in the "administration.users.roleOpt.*" namespace and
// are resolved at the React call sites via t(roleLabelKey(role)); this module
// stays free of UI copy so it can be imported by pre-React schema code too.

/** The bare role values the server accepts (for zod enum + guards + option lists). */
export const ASSIGNABLE_ROLES: readonly string[] = [
  "admin",
  "manager",
  "cashier",
  "custody",
  "accountant",
  "finance",
  "sales",
  "employee",
  "auditor",
];

/** t() key for an assignable-role label → "administration.users.roleOpt.<role>". */
export function roleLabelKey(role: string): string {
  return `administration.users.roleOpt.${role}`;
}
