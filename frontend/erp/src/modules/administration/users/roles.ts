// Assignable user roles — MIRRORS the backend catalog (lib/roles.js:
// ASSIGNABLE_ROLES + ROLE_LABELS_AR) exactly. The server 400s any role outside
// this set ("الدور غير صالح"), so `developer` (not a real role — a
// capability-only bypass) is deliberately absent. Labels are copied verbatim
// from ROLE_LABELS_AR — do not invent new Arabic copy here.
//
// Tier A.2 corrective gate — `auditor` moved from lib/roles.js's
// GRANT_ONLY_ROLES to ASSIGNABLE_ROLES (it already had real capability
// grants — finance.reports.view/finance.gl.view/finance.bankrec.view — that
// no account could ever actually hold through this UI). Added here so the
// role is actually selectable in UserDialog.tsx, not just accepted by the
// server if a caller somehow sent it directly.
export interface RoleOption {
  value: string;
  label: string;
}

export const ROLE_OPTS: RoleOption[] = [
  { value: "admin", label: "مدير النظام" },
  { value: "manager", label: "مدير" },
  { value: "cashier", label: "كاشير" },
  { value: "custody", label: "أمين عهدة" },
  { value: "accountant", label: "محاسب" },
  { value: "finance", label: "مالية" },
  { value: "sales", label: "مبيعات" },
  { value: "employee", label: "موظف" },
  { value: "auditor", label: "مدقق" },
];

/** The bare role values the server accepts (for zod enum + guards). */
export const ASSIGNABLE_ROLES = ROLE_OPTS.map((r) => r.value);

export const ROLE_LABEL = new Map(ROLE_OPTS.map((r) => [r.value, r.label]));
