// Assignable user roles — MIRRORS the backend catalog (lib/roles.js:
// ASSIGNABLE_ROLES) exactly. The server 400s any role outside this set, so
// `auditor`/`developer` (grant-only / not a role) are deliberately absent — the
// previous list included both and every save with them was silently rejected.
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
];

/** t() key for an assignable-role label → "administration.users.roleOpt.<role>". */
export function roleLabelKey(role: string): string {
  return `administration.users.roleOpt.${role}`;
}
