// Assignable user roles — MIRRORS the backend catalog (lib/roles.js:
// ASSIGNABLE_ROLES) exactly. The server 400s any role outside this set
// ("الدور غير صالح"), so `developer` (not a real role — a capability-only
// bypass) is deliberately absent.
//
// i18n: role labels live in the "administration.users.roleOpt.*" namespace and
// are resolved at the React call sites via t(roleLabelKey(role)); this module
// stays free of UI copy so it can be imported by pre-React schema code too.
//
// RELEASE INTEGRATION NOTE — `auditor` is present, and that is deliberate.
// The two branches merged here made directly opposite claims about this one
// value, each with a comment asserting it was right:
//   • the i18n sprint OMITTED auditor, commenting that it is "grant-only" and
//     that saves including it "were silently rejected". That was TRUE against
//     origin/main.
//   • the accounting gate MOVED auditor from lib/roles.js's GRANT_ONLY_ROLES
//     into ASSIGNABLE_ROLES, which is what made it a real, saveable role.
// The sprint's comment is therefore stale, not wrong-at-the-time: after the
// accounting change the backend accepts `auditor`, and omitting it here would
// silently remove a role that has real capability grants
// (finance.reports.view / finance.gl.view / finance.bankrec.view), is covered
// by tests/integration/auditorRole.test.js, and is exercised end-to-end by
// e2e/erp/trial-balance-rbac.spec.ts. Keep this list in sync with
// lib/roles.js#ASSIGNABLE_ROLES — that is the single source of truth.

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
